// Accounting only: literal, operator-verified receipts; no automatic review or source writes.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { bookMaintainers } from "../functions/lib/book-maintainers.ts";
import { CONTRIBUTORS_KEY, contributorRows, isContributor, publishContributors } from "../functions/lib/contributors.ts";
import { handleDelete, handleExport, handleNickname } from "../functions/lib/handlers.ts";
import { hashPassword, sha256Hex } from "../functions/lib/password.ts";
import { preparePositional } from "./lib/sqlite-positional.mjs";

const NOW = 1_800_000_000_000;
const CATALOG = "word-lists:book";
const RELEASE = "oewn-2025-test";
const SENSE = "exact-source-id";
const sha = (value) => createHash("sha256").update(value).digest("hex");
const CHAPTER = ["The bank was steep.", "The bank was steep."];
const TEXT = sha(JSON.stringify(CHAPTER));
const POSITION = { chapterSha256: TEXT, paragraphIndex: 0, paragraphSha256: sha(CHAPTER[0]), offset: 4, surface: "bank" };
const keyFor = (position, catalog = CATALOG) => sha(JSON.stringify([
  catalog, position.chapterSha256, position.paragraphIndex, position.paragraphSha256, position.offset, position.surface,
]));
const MAPPING_KEY = "dictionary/positions/word-lists/book/mappings.json";
const MAPPING_SHA = sha(JSON.stringify({ schema: "oewn-position-mappings-v1", catalogId: CATALOG, entries: [{ positionKey: keyFor(POSITION), ...POSITION, senseId: SENSE, lemma: "bank", release: RELEASE, reviewedAt: NOW }] }));

function fixture(t) {
  const raw = new DatabaseSync(":memory:");
  t.after(() => raw.close());
  raw.exec("PRAGMA foreign_keys = ON");
  for (const name of readdirSync(new URL("../migrations/", import.meta.url)).filter((name) => name.endsWith(".sql")).sort())
    raw.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
  const DB = { prepare(sql) {
    const statement = preparePositional(raw, sql);
    let values = [];
    const api = {
      bind(...args) { values = args; return api; },
      async first() { return statement.get(...values) ?? null; },
      async all() { return { results: statement.all(...values) }; },
      async run() { return { meta: { changes: statement.run(...values).changes } }; },
    };
    return api;
  } };
  const files = new Map();
  const BOOKS = {
    async get(key) { throw new Error(`Canonical credits must not need title lookup: ${key}`); },
    async put(key, value) { files.set(key, value); },
  };
  const user = (id, publicId = id, nickname = id) => raw.prepare(
    "INSERT INTO users(id,email,password_hash,password_salt,password_iters,created_at,email_verified_at,public_id,nickname) VALUES(?,?,'unused','unused',10000,?,?,?,?)",
  ).run(id, `${id}@example.test`, NOW - 10, NOW - 1, publicId, nickname);
  const choice = (userId = "reader", targetHash = "device-one", selected = SENSE, updated = NOW) => raw.prepare(
    "INSERT INTO dictionary_choices VALUES (?,?,?,?,?,?,?,?)",
  ).run(userId, targetHash, JSON.stringify({ bookId: targetHash, chapter: 42, word: "bank" }), selected, "bank", RELEASE, NOW, updated);
  const credit = (userId = "reader", position = POSITION, acceptedAt = NOW, positionKey = keyFor(position), catalog = CATALOG) => raw.prepare(
    "INSERT INTO dictionary_choice_credits VALUES (?,?,?,?,?,?,?,?,?)",
  ).run(userId, positionKey, catalog, position.chapterSha256, JSON.stringify(position), SENSE, acceptedAt, MAPPING_KEY, MAPPING_SHA);
  const review = (overrides = {}) => {
    const row = { user_id: "reader", target_hash: "device-one", reviewed_updated_at: NOW, reviewed_choice_id: SENSE,
      reviewed_choice_lemma: "bank", reviewed_choice_release: RELEASE, outcome: "accepted", reason: "Exact original text and adopted mapping read back.",
      catalog_id: CATALOG, text_sha256: TEXT, canonical_position: JSON.stringify(POSITION), verified_sense_id: SENSE,
      evidence_sha256: MAPPING_SHA, mapping_key: MAPPING_KEY, accepted_at: NOW, reviewed_at: NOW, ...overrides };
    return raw.prepare(`INSERT INTO dictionary_choice_reviews (${Object.keys(row).join(",")}) VALUES (${Object.keys(row).map(() => "?").join(",")})`).run(...Object.values(row));
  };
  return { raw, DB, BOOKS, files, user, choice, credit, review, env: { DB, BOOKS } };
}
const request = (path, body) => new Request(`https://inputread.test${path}`, {
  method: body ? "POST" : "GET", headers: { cookie: "mw_session=token", "content-type": "application/json" },
  ...(body ? { body: JSON.stringify(body) } : {}),
});
async function session(f, userId = "reader") {
  f.raw.prepare("INSERT INTO sessions VALUES (?,?,?,?)").run(await sha256Hex("token"), userId, NOW - 1, NOW + 10000);
}

// Acceptance SQL belongs in the operator handbook. These tests exercise its source-snapshot
// boundary literally, not any semantic decision about whether a sense should be adopted.
test("migration checks reject incomplete, mismatched or unadopted acceptance", (t) => {
  const f = fixture(t); f.user("reader"); f.choice();
  for (const field of ["reviewed_choice_id", "reviewed_choice_lemma", "reviewed_choice_release", "catalog_id", "text_sha256", "verified_sense_id", "evidence_sha256", "mapping_key", "reason"]) {
    assert.throws(() => f.review({ [field]: " " }), /CHECK constraint/);
  }
  for (const canonical_position of ["", "bad json", "null", "{}", "[]", JSON.stringify({ ...POSITION, chapterSha256: "other" }),
    JSON.stringify({ ...POSITION, paragraphIndex: -1 }), JSON.stringify({ ...POSITION, paragraphIndex: null }),
    JSON.stringify({ ...POSITION, paragraphSha256: "g".repeat(64) }), JSON.stringify({ ...POSITION, paragraphSha256: "abc" }),
    JSON.stringify({ ...POSITION, offset: -1 }), JSON.stringify({ ...POSITION, offset: 0.5 }), JSON.stringify({ ...POSITION, surface: "" })]) {
    assert.throws(() => f.review({ canonical_position }), /CHECK constraint/);
  }
  for (const text_sha256 of ["g".repeat(64), "abc", "A".repeat(64)]) {
    assert.throws(() => f.review({ text_sha256, canonical_position: JSON.stringify({ ...POSITION, chapterSha256: text_sha256 }) }), /CHECK constraint/);
    assert.throws(() => f.credit("reader", { ...POSITION, chapterSha256: text_sha256 }), /CHECK constraint/);
  }
  assert.throws(() => f.review({ accepted_at: 0 }), /CHECK constraint/);
  assert.throws(() => f.review({ verified_sense_id: "operator-picked-different-id" }), /CHECK constraint/);
  assert.throws(() => f.review({ outcome: "rejected" }), /CHECK constraint/);
  assert.throws(() => f.review({ outcome: "needs-context" }), /CHECK constraint/);
  assert.throws(() => f.review({ outcome: "unknown", accepted_at: 0 }), /CHECK constraint/);
  assert.throws(() => f.review({ reviewed_at: 0 }), /CHECK constraint/);
  f.review();
  assert.equal(f.raw.prepare("SELECT COUNT(*) AS n FROM dictionary_choice_credits").get().n, 0, "accepted review alone is not a point");
  for (const field of ["position_key", "catalog_id", "text_sha256", "sense_id", "mapping_key", "mapping_sha256"]) {
    const valid = { user_id: "reader", position_key: keyFor(POSITION), catalog_id: CATALOG, text_sha256: TEXT,
      position_json: JSON.stringify(POSITION), sense_id: SENSE, accepted_at: NOW, mapping_key: MAPPING_KEY, mapping_sha256: MAPPING_SHA, [field]: " " };
    assert.throws(() => f.raw.prepare(`INSERT INTO dictionary_choice_credits (${Object.keys(valid)}) VALUES (${Object.keys(valid).map(() => "?")})`).run(...Object.values(valid)), /CHECK constraint/);
  }
  assert.throws(() => f.credit("reader", POSITION, 0), /CHECK constraint/);
  assert.throws(() => f.credit("reader", { chapterSha256: TEXT }), /CHECK constraint/);
});

test("raw choices and rejected or needs-context reviews never earn points; changed snapshots only rerun", async (t) => {
  const f = fixture(t); f.user("reader");
  for (const target of ["pending", "rejected", "context", "changed"]) f.choice("reader", target);
  for (const [target_hash, outcome] of [["rejected", "rejected"], ["context", "needs-context"], ["changed", "needs-context"]])
    f.review({ target_hash, outcome, accepted_at: 0, catalog_id: "", text_sha256: "", canonical_position: "", verified_sense_id: "", evidence_sha256: "", mapping_key: "" });
  f.raw.prepare("UPDATE dictionary_choices SET updated_at = ? WHERE target_hash='changed'").run(NOW + 1);
  const candidates = f.raw.prepare(`SELECT c.target_hash FROM dictionary_choices c LEFT JOIN dictionary_choice_reviews r
    ON r.user_id=c.user_id AND r.target_hash=c.target_hash
    WHERE r.user_id IS NULL OR r.reviewed_updated_at != c.updated_at ORDER BY c.target_hash`).all();
  assert.deepEqual(candidates.map((r) => r.target_hash), ["changed", "pending"]);
  assert.equal(await isContributor(f.DB, "reader"), false);
  assert.deepEqual(await contributorRows(f.DB), []);
  assert.deepEqual((await bookMaintainers(f.DB, f.BOOKS)).books, {});
});

test("original patrol handbook acceptance SQL runs atomically and credits each canonical position once", (t) => {
  const f = fixture(t); f.user('reader'); f.choice();
  const snapshot = f.raw.prepare('SELECT * FROM dictionary_choices').get();
  const manual = readFileSync(new URL('../docs/GLOSSARY_PATROL.md', import.meta.url), 'utf8');
  const block = [...manual.matchAll(/```sql\r?\n([\s\S]*?)```/g)].map(m => m[1]).find(sql => sql.includes('INSERT INTO dictionary_choice_reviews'));
  assert.ok(block, 'existing patrol handbook contains the full acceptance procedure');
  const values = ['reader','device-one',NOW,SENSE,'bank',RELEASE,snapshot.target_json,'accepted','Verified source and mapping readback',CATALOG,TEXT,JSON.stringify(POSITION),SENSE,MAPPING_SHA,MAPPING_KEY,NOW,NOW,keyFor(POSITION)];
  const execute = () => {
    f.raw.exec('BEGIN');
    try {
      for (const sql of block.split(';').filter(s => s.trim())) {
        const args = [];
        const positional = sql.replace(/\?(\d+)/g, (_, n) => { args.push(values[Number(n)-1]); return '?'; });
        f.raw.prepare(positional).run(...args);
      }
      f.raw.exec('COMMIT');
    } catch(e) { f.raw.exec('ROLLBACK'); throw e; }
  };
  execute(); execute();
  assert.equal(f.raw.prepare('SELECT COUNT(*) AS n FROM dictionary_choice_credits').get().n, 1);
  assert.equal(f.raw.prepare('SELECT outcome FROM dictionary_choice_reviews').get().outcome, 'accepted');
  f.raw.exec('DELETE FROM dictionary_choices'); execute();
  assert.equal(f.raw.prepare('SELECT COUNT(*) AS n FROM dictionary_choice_credits').get().n, 1);
});

test("CAS source snapshots prevent stale review and receipt writes", (t) => {
  const f = fixture(t); f.user("reader"); f.choice();
  const snapshot = f.raw.prepare("SELECT * FROM dictionary_choices").get();
  const sql = `INSERT INTO dictionary_choice_reviews
    (user_id,target_hash,reviewed_updated_at,reviewed_choice_id,reviewed_choice_lemma,reviewed_choice_release,
     outcome,reason,catalog_id,text_sha256,canonical_position,verified_sense_id,evidence_sha256,mapping_key,accepted_at,reviewed_at)
    SELECT user_id,target_hash,updated_at,choice_id,choice_lemma,choice_release,
     'accepted','Verified source and readback',?,?,?,?,?,?,?,? FROM dictionary_choices
    WHERE user_id=? AND target_hash=? AND updated_at=? AND target_json=? AND choice_id=? AND choice_lemma=? AND choice_release=?
    ON CONFLICT(user_id,target_hash) DO UPDATE SET reviewed_updated_at=excluded.reviewed_updated_at
    WHERE dictionary_choice_reviews.reviewed_updated_at <= excluded.reviewed_updated_at`;
  const run = () => f.raw.prepare(sql).run(CATALOG, TEXT, JSON.stringify(POSITION), SENSE, MAPPING_SHA, MAPPING_KEY, NOW, NOW,
    snapshot.user_id, snapshot.target_hash, snapshot.updated_at, snapshot.target_json, snapshot.choice_id, snapshot.choice_lemma, snapshot.choice_release);
  f.raw.prepare("UPDATE dictionary_choices SET choice_id='different',updated_at=?").run(NOW + 1);
  assert.equal(run().changes, 0);
  f.raw.prepare("UPDATE dictionary_choices SET choice_id=?,updated_at=?").run(SENSE, NOW);
  f.raw.exec("BEGIN");
  try {
    assert.equal(run().changes, 1);
    const receiptSql = `INSERT INTO dictionary_choice_credits
      SELECT r.user_id,?,r.catalog_id,r.text_sha256,r.canonical_position,r.verified_sense_id,r.accepted_at,r.mapping_key,r.evidence_sha256
      FROM dictionary_choice_reviews r JOIN dictionary_choices c ON c.user_id=r.user_id AND c.target_hash=r.target_hash
      WHERE r.user_id=? AND r.target_hash=? AND r.outcome='accepted' AND r.reviewed_at=? AND r.evidence_sha256=?
      AND c.updated_at=? AND c.target_json=? AND c.choice_id=? AND c.choice_lemma=? AND c.choice_release=?
      AND r.reviewed_updated_at=c.updated_at AND r.reviewed_choice_id=c.choice_id AND r.verified_sense_id=c.choice_id
      ON CONFLICT DO NOTHING`;
    const receiptArgs = [keyFor(POSITION), "reader", "device-one", NOW, MAPPING_SHA, NOW, snapshot.target_json, SENSE, "bank", RELEASE];
    assert.equal(f.raw.prepare(receiptSql).run(...receiptArgs).changes, 1);
    assert.equal(f.raw.prepare(receiptSql).run(...receiptArgs).changes, 0);
    f.raw.exec("COMMIT");
  } catch (error) { f.raw.exec("ROLLBACK"); throw error; }
  f.raw.exec("DELETE FROM dictionary_choices");
  assert.equal(run().changes, 0, "withdrawn snapshots cannot be accepted again");
  assert.equal(f.raw.prepare("SELECT COUNT(*) AS n FROM dictionary_choice_credits").get().n, 1);
});

test("canonical shared position dedupes device evidence, repeated paragraphs stay distinct, history survives changes", async (t) => {
  const f = fixture(t); f.user("reader"); f.user("other");
  f.choice(); f.choice("reader", "other-device"); f.review(); f.review({ target_hash: "other-device" });
  f.credit();
  assert.throws(() => f.credit(), /UNIQUE constraint/);
  assert.throws(() => f.credit("reader", POSITION, NOW + 5, "alternate-key"), /UNIQUE constraint/);
  const repeated = { ...POSITION, paragraphIndex: 1 };
  assert.notEqual(keyFor(repeated), keyFor(POSITION));
  f.credit("reader", repeated);
  f.credit("other"); // Same position may credit another reader who actually chose it.
  f.raw.prepare("UPDATE dictionary_choices SET choice_id='new-choice',updated_at=? WHERE target_hash='device-one'").run(NOW + 1);
  f.raw.prepare("UPDATE dictionary_choice_reviews SET outcome='rejected',accepted_at=0,reason='Later source changed' WHERE target_hash='device-one'").run();
  f.raw.exec("DELETE FROM dictionary_choices; DELETE FROM dictionary_choice_reviews");
  assert.equal(await isContributor(f.DB, "reader"), true);
  assert.deepEqual((await contributorRows(f.DB)).map(({ id, helped }) => [id, helped]), [["reader", 2], ["other", 1]]);
});

test("union accounting counts distinct word, passage and dictionary places with matching maintainer metrics", async (t) => {
  const f = fixture(t);
  for (const id of ["a", "b", "c", "d", "raw"]) f.user(id, `public-${id}`, `Nickname ${id}`);
  f.credit("a"); f.credit("b", POSITION, NOW - 1); f.credit("c", POSITION, NOW - 2); f.credit("d", POSITION, NOW - 3);
  f.choice("raw");
  for (let i = 0; i < 2; i++) {
    f.raw.prepare("INSERT INTO word_feedback(book_id,word,reason,created_at,ip,user_id,accepted_at,catalog_id) VALUES('device','bank','wrong_meaning',?,'',?,?,?)").run(NOW, "a", NOW, CATALOG);
    f.raw.prepare("INSERT INTO passage_feedback(book_id,selected,reason,created_at,user_id,accepted_at,catalog_id) VALUES('device','The bank','help',?,?,?,?)").run(NOW, "a", NOW, CATALOG);
  }
  assert.equal(await publishContributors(f.DB, f.BOOKS, NOW), 4);
  const published = f.files.get(CONTRIBUTORS_KEY);
  const file = JSON.parse(published);
  assert.deepEqual(file.people.map(({ id, helped }) => [id, helped]), [["public-a", 3], ["public-d", 1], ["public-c", 1], ["public-b", 1]]);
  assert.deepEqual(file.books, { [CATALOG]: { count: 4, top: ["public-a", "public-d", "public-c"] } });
  assert.doesNotMatch(published, /example\.test|user_id|device|target_hash/);
  const { readers } = await bookMaintainers(f.DB, f.BOOKS);
  assert.deepEqual([...readers.values()], file.people);
});

test("cover-only dictionary maintainers beyond top 500 retain true global rank", async (t) => {
  const f = fixture(t);
  for (let i = 0; i < 502; i++) {
    const id = `public-${String(i).padStart(3, "0")}`;
    f.user(id);
    f.credit(id, POSITION, NOW + i, keyFor(POSITION), i < 500 ? CATALOG : "public-books:other");
  }
  await publishContributors(f.DB, f.BOOKS, NOW);
  const file = JSON.parse(f.files.get(CONTRIBUTORS_KEY));
  assert.equal(file.people.length, 502);
  assert.equal(file.people.find((p) => p.id === "public-500").rank, 501);
  assert.equal(file.people.find((p) => p.id === "public-501").rank, 502);
  assert.deepEqual(file.books["public-books:other"], { count: 2, top: ["public-500", "public-501"] });
});

test("credited accounts refresh nicknames and export durable receipts after withdrawal; deletion cascades", async (t) => {
  const f = fixture(t); f.user("reader", "abc123def456", "Old name"); f.user("other", "def456abc123");
  f.choice(); f.review(); f.credit(); f.credit("other"); await session(f);
  const renamed = await handleNickname(request("/api/auth/nickname", { nickname: "New name" }), f.env, { now: NOW });
  assert.equal(renamed.status, 200);
  assert.equal(JSON.parse(f.files.get(CONTRIBUTORS_KEY)).people.find((p) => p.id === "abc123def456").name, "New name");
  f.raw.exec("DELETE FROM dictionary_choices");
  const response = await handleExport(request("/api/auth/export"), f.env, { now: NOW });
  assert.equal(response.status, 200);
  const exported = await response.json();
  assert.deepEqual(exported.dictionaryChoices, []);
  assert.deepEqual(exported.dictionaryChoiceCredits, [{ positionKey: keyFor(POSITION), catalogId: CATALOG, textSha256: TEXT,
    position: POSITION, senseId: SENSE, acceptedAt: NOW, mappingKey: MAPPING_KEY, mappingSha256: MAPPING_SHA }]);
  const password = "correct horse";
  const credentials = await hashPassword(password);
  f.raw.prepare("UPDATE users SET password_hash=?,password_salt=?,password_iters=? WHERE id='reader'").run(credentials.hash, credentials.salt, credentials.iterations);
  const deleted = await handleDelete(request("/api/auth/delete", { password }), f.env, { now: NOW });
  assert.equal(deleted.status, 200);
  assert.equal(f.raw.prepare("SELECT COUNT(*) AS n FROM dictionary_choice_reviews WHERE user_id='reader'").get().n, 0);
  assert.equal(f.raw.prepare("SELECT COUNT(*) AS n FROM dictionary_choice_credits WHERE user_id='reader'").get().n, 0);
  assert.equal(f.raw.prepare("SELECT COUNT(*) AS n FROM dictionary_choice_credits WHERE user_id='other'").get().n, 1);
  assert.equal((await handleExport(request("/api/auth/export"), f.env, { now: NOW })).status, 401);
});
