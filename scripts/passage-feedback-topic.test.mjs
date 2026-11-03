import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { handlePassageFeedbackPost } from "../functions/api/feedback/passage.ts";
import { createSession } from "../functions/lib/session.ts";
import { setPruneRoll } from "../functions/lib/rate-limit.ts";

const migrations = new URL("../migrations/", import.meta.url);
const repair = "0024_passage_feedback_topic.sql";
const migration = readFileSync(new URL(repair, migrations), "utf8");
function openDb(legacy = false) {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  for (const name of readdirSync(migrations).filter((name) => name.endsWith(".sql")).sort()) {
    if (!legacy || name < repair) db.exec(readFileSync(new URL(name, migrations), "utf8"));
  }
  return db;
}
const rows = (db) => db.prepare("SELECT * FROM passage_feedback ORDER BY id").all().map((row) => ({ ...row }));

test("migration repairs every zero root without regrouping positive topics or changing report data", () => {
  const db = openDb(true);
  try {
    db.exec(`INSERT INTO passage_feedback
      (id, book_id, catalog_id, selected, reason, suggestion, topic, status, resolved_at, resolved_rev, accepted_at, accepted_rev, created_at)
      VALUES (21, 'device-a', 'word-lists:one', 'Some text.', 'hard', 'A suggestion.', 0, 'pending', 0, '', 0, '', 10),
             (22, 'device-a', 'word-lists:one', 'Some text.', 'hard', '', 21, 'pending', 0, '', 0, '', 11),
             (23, 'device-b', 'word-lists:two', 'Other text.', 'hard', 'Keep this.', 0, 'resolved', 12, 'oldrev', 13, 'oldrev', 12),
             (24, 'device-c', 'word-lists:three', 'Third text.', 'hard', '', 24, 'pending', 0, '', 0, '', 13)`);
    const before = rows(db);
    db.exec(migration);
    assert.deepEqual(rows(db), before.map((row) => ({ ...row, topic: row.topic || row.id })));
    assert.deepEqual(db.prepare("SELECT id FROM passage_feedback WHERE topic = 21 ORDER BY id").all().map((r) => r.id), [21, 22]);
    db.exec(migration);
    assert.deepEqual(rows(db), before.map((row) => ({ ...row, topic: row.topic || row.id })), "safe to recheck on a repaired database");
  } finally { db.close(); }
});

test("the insert trigger self-roots default and explicit zero but preserves positive topics", () => {
  const db = openDb();
  try {
    const first = db.prepare("INSERT INTO passage_feedback (book_id, selected, reason, created_at) VALUES ('a', 'Text.', 'hard', 1) RETURNING id, topic").get();
    const second = db.prepare("INSERT INTO passage_feedback (book_id, selected, reason, topic, created_at) VALUES ('b', 'Text.', 'hard', 0, 1) RETURNING id, topic").get();
    db.prepare("INSERT INTO passage_feedback (book_id, selected, reason, topic, created_at) VALUES ('a', 'More text.', 'hard', ?, 1)").run(first.id);
    assert.equal(first.topic, 0, "RETURNING sees the pre-AFTER-trigger value, not persisted topic");
    assert.equal(second.topic, 0);
    assert.deepEqual(rows(db).map(({ id, topic }) => [id, topic]), [[first.id, first.id], [second.id, second.id], [second.id + 1, first.id]]);
  } finally { db.close(); }
});

test("failure inside the self-topic trigger rolls back the report INSERT", () => {
  const db = openDb();
  try {
    db.exec(`CREATE TRIGGER fail_topic_update BEFORE UPDATE OF topic ON passage_feedback
      BEGIN SELECT RAISE(ABORT, 'injected topic update failure'); END;`);
    assert.throws(() => db.prepare("INSERT INTO passage_feedback (book_id, selected, reason, created_at) VALUES ('a', 'Text.', 'hard', 1) RETURNING id").get(), /injected topic update failure/);
    assert.equal(rows(db).length, 0, "no committed orphan after the internal update fails");
  } finally { db.close(); }
});

function adapter(raw) {
  return {
    prepare(sql) {
      assert.doesNotMatch(sql, /^\s*UPDATE passage_feedback SET topic/i, "the handler must not issue a separate repair write");
      const stmt = raw.prepare(sql);
      let args = [];
      const wrapped = {
        bind(...values) { args = values; return wrapped; },
        async first() { return stmt.get(...args) ?? null; },
        async all() { return { results: stmt.all(...args) }; },
        async run() { return stmt.run(...args); },
      };
      return wrapped;
    },
    async batch() { throw new Error("Unexpected batch; atomicity belongs to the SQLite trigger"); },
  };
}

test("the real endpoint creates, joins and deduplicates topics without a follow-up update", async () => {
  const raw = openDb();
  const previousRoll = setPruneRoll(() => 1);
  try {
    const DB = adapter(raw), now = Date.now();
    raw.prepare("INSERT INTO users (id, email, password_hash, password_salt, password_iters, created_at) VALUES ('test-user', 'test@example.com', 'hash', 'salt', 1, ?)").run(now);
    const cookie = (await createSession(DB, "test-user", new Request("https://test.invalid/"), now)).split(";")[0];
    const send = (body) => handlePassageFeedbackPost(new Request("https://test.invalid/api/feedback/passage", {
      method: "POST", headers: { "content-type": "application/json", cookie, "cf-connecting-ip": "192.0.2.12" },
      body: JSON.stringify({ bookId: "device-a", chapter: 1, paragraph: 2, selected: "Some words.", reason: "hard", ...body }),
    }), { DB }, { now });
    const first = await send({});
    assert.equal(first.status, 200);
    assert.deepEqual(await first.json(), { ok: true, saved: true });
    const root = rows(raw)[0];
    assert.equal(root.topic, root.id);
    const duplicate = await send({});
    assert.deepEqual(await duplicate.json(), { ok: true, duplicate: true });
    assert.equal(rows(raw).length, 1);
    const joined = await send({ suggestion: "An easier explanation." });
    assert.deepEqual(await joined.json(), { ok: true, saved: true, joined: true });
    assert.equal(rows(raw)[1].topic, root.id);
    const disjoint = await send({ selected: "Different selection." });
    assert.equal(disjoint.status, 200);
    const third = rows(raw)[2];
    assert.equal(third.topic, third.id);
    assert.equal(rows(raw).filter((row) => row.topic === 0).length, 0);
  } finally { setPruneRoll(previousRoll); raw.close(); }
});
