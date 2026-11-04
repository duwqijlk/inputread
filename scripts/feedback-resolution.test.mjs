import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

const migrations = new URL("../migrations/", import.meta.url);
const filename = "0025_feedback_resolution.sql";
const migration = readFileSync(new URL(filename, migrations), "utf8");
const patrol = readFileSync(new URL("../docs/GLOSSARY_PATROL.md", import.meta.url), "utf8");
function openDb(legacy = false) {
  const db = new DatabaseSync(":memory:");
  for (const name of readdirSync(migrations).filter((name) => name.endsWith(".sql")).sort())
    if (!legacy || name < filename) db.exec(readFileSync(new URL(name, migrations), "utf8"));
  return db;
}
function sql(pattern) {
  const query = patrol.match(pattern)?.[0];
  assert.ok(query, "documented SQL exists");
  const count = Math.max(...[...query.matchAll(/\?(\d+)/g)].map((m) => Number(m[1])));
  return `WITH bound_params AS (SELECT ${Array.from({ length: count }, (_, i) => `? AS p${i + 1}`).join(",")}) ` +
    query.replace(/\?(\d+)/g, "(SELECT p$1 FROM bound_params)");
}
const wordResolve = sql(/UPDATE word_feedback SET status = 'resolved'[^;]*;/);
const passageResolve = sql(/UPDATE passage_feedback SET status = 'resolved'[^;]*;/);
const wordAccept = sql(/UPDATE word_feedback SET accepted_at[^;]*;/);
const passageAccept = sql(/UPDATE passage_feedback SET accepted_at[^;]*;/);

function seed(db) {
  for (const table of ["word_feedback", "passage_feedback"]) {
    const field = table === "word_feedback" ? "word" : "selected";
    db.exec(`INSERT INTO ${table} (book_id, ${field}, reason, suggestion, status, created_at, accepted_at, accepted_rev, ip)
      VALUES ('device', 'lantern', 'hard', 'A light.', 'resolved', 1, 5, 'legacy', '192.0.2.1'),
             ('device', 'other', 'hard', 'New explanation.', 'pending', 2, 0, '', '192.0.2.1'),
             ('different-device', 'unseen', 'hard', 'Unseen explanation.', 'pending', 3, 0, '', '192.0.2.1')`);
  }
}

test("0025 adds only unknown resolution defaults, preserving historical reports and acceptance", () => {
  const db = openDb(true);
  try {
    seed(db);
    const before = ["word_feedback", "passage_feedback"].map((table) => db.prepare(`SELECT * FROM ${table} ORDER BY id`).all());
    db.exec(migration);
    for (const [index, table] of ["word_feedback", "passage_feedback"].entries()) {
      const after = db.prepare(`SELECT * FROM ${table} ORDER BY id`).all();
      assert.deepEqual(after.map(({ resolution, ...row }) => row), before[index].map((row) => ({ ...row })));
      assert.ok(after.every((row) => row.resolution === ""));
      assert.throws(() => db.prepare(`UPDATE ${table} SET resolution = 'cannot_locate' WHERE id = 2`).run(), /CHECK constraint/);
      assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE accepted_at > 0`).get().n, 1);
    }
  } finally { db.close(); }
});

test("documented outcomes require verified revision and retain individual id/topic/cutoff guards", () => {
  const db = openDb();
  try {
    seed(db);
    const word = db.prepare(wordResolve), passage = db.prepare(passageResolve);
    assert.equal(word.run(10, "", 2, "no_change").changes, 0, "no empty live revision");
    assert.equal(word.run(10, "live", 2, "dismissed").changes, 0);
    assert.equal(word.run(10, "live", 2, "no_change").changes, 1);
    assert.equal(db.prepare("SELECT status FROM word_feedback WHERE id=3").get().status, "pending", "unseen sibling remains open");
    assert.equal(word.run(11, "live", 2, "fixed").changes, 0, "cannot overwrite a recorded outcome");
    const topic = db.prepare("SELECT topic FROM passage_feedback WHERE id=2").get().topic;
    assert.equal(passage.run(10, "live", 2, topic + 10, 2, "fixed").changes, 0);
    assert.equal(passage.run(10, "live", 3, 3, 2, "fixed").changes, 0, "post-cutoff id stays pending");
    assert.equal(passage.run(10, "live", 2, topic, 2, "already_covered").changes, 1);
    assert.equal(db.prepare("SELECT resolution FROM passage_feedback WHERE id=2").get().resolution, "already_covered");
    assert.equal(db.prepare("SELECT status FROM passage_feedback WHERE id=3").get().status, "pending");
    assert.equal(db.prepare(wordAccept).run(12, "live", 2).changes, 0, "no_change cannot earn new acceptance");
    assert.equal(db.prepare(passageAccept).run(12, "live", 2).changes, 0, "already_covered cannot earn new acceptance");
    assert.equal(word.run(10, "live", 3, "fixed").changes, 1);
    assert.equal(db.prepare(wordAccept).run(12, "wrong-rev", 3).changes, 0);
    assert.equal(db.prepare(wordAccept).run(12, "live", 3).changes, 1);
    assert.equal(db.prepare(wordAccept).run(13, "live", 3).changes, 0, "preserve first acceptance");
    assert.equal(db.prepare("SELECT accepted_at FROM word_feedback WHERE id=1").get().accepted_at, 5, "legacy accepted history unchanged");
  } finally { db.close(); }
});

test("patrol authority and triage stay minimal without hidden queues or deleting token-only rebuilding", () => {
  assert.match(patrol, /hosted patrol and maintenance originals read for this run are the operational authority/);
  assert.match(patrol, /No local\/hosted\s+hash-equality ceremony/);
  assert.match(patrol, /current list already answers/);
  assert.match(patrol, /no_change/);
  assert.match(patrol, /missing evidence/);
  assert.match(patrol, /temporary compatible\s+copy/);
  assert.match(patrol, /Cloudflare API token does not supply/);
  assert.doesNotMatch(migration, /CREATE TABLE|UPDATE /i);
});
