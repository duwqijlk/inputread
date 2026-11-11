// Real handlers and migration SQL, Node's built-in TypeScript stripping + sqlite standing in for D1.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { handleDictionaryChoices, onRequest } from "../functions/api/dictionary/choices.ts";
import { handleExport } from "../functions/lib/handlers.ts";
import { choicePosition, parseChoiceRequest, saveChoice } from "../functions/lib/dictionary-choice.ts";
import { sha256Hex } from "../functions/lib/password.ts";
import { DAILY_WRITE_BUDGET, RATE_LIMITS, setPruneRoll } from "../functions/lib/rate-limit.ts";

setPruneRoll(() => 1);
const NOW = 1_800_000_000_000;
const RELEASE = "oewn-2025-809369f31478";
const CHOICE = { id: "opaque-source-id/one", lemma: "café", release: RELEASE };
const SECOND = { ...CHOICE, id: "opaque-source-id/two" };
const TARGET = { bookId: "device-book", catalogId: "word-lists:book", chapter: 0, chapters: 12,
  paragraph: 3, occurrence: 1, word: "Cafés", sentence: "The Cafés were busy.", context: "Raw context.", glossaryRev: "rev-1" };
const payload = (choice = CHOICE, target = TARGET) => ({ action: "set", target, choice });
const get = (target = TARGET) => ({ action: "get", target });
const pathFor = (lemma, release = RELEASE) => {
  const hex = Buffer.from(lemma, "utf8").toString("hex");
  return `dictionary/releases/${release}/words/${hex.slice(0, 2)}/${hex}.json`;
};
const entry = (lemma = CHOICE.lemma) => ({ schema: "oewn-r2-entry-v1", release: RELEASE, lookupKey: lemma,
  senses: [CHOICE, SECOND].map(({ id }) => ({ id, pos: "n", meaning: "a small place to eat", originalMeaning: "a small restaurant selling drinks", learningMeaning: "a small place to eat" })) });

async function fixture() {
  const raw = new DatabaseSync(":memory:");
  raw.exec("PRAGMA foreign_keys = ON");
  for (const name of readdirSync(new URL("../migrations/", import.meta.url)).filter((name) => name.endsWith(".sql")).sort()) {
    raw.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
  }
  raw.prepare("INSERT INTO users (id,email,password_hash,password_salt,password_iters,created_at,email_verified_at) VALUES (?,?,?,?,?,?,?)")
    .run("reader", "reader@example.test", "unused", "unused", 10000, NOW - 100, NOW - 1);
  raw.prepare("INSERT INTO sessions (token_hash,user_id,created_at,expires_at) VALUES (?,?,?,?)")
    .run(await sha256Hex("token"), "reader", NOW - 100, NOW + 86_400_000);
  const writes = [], gets = [];
  let batchTail = Promise.resolve();
  const DB = { prepare(sql) {
    const stmt = raw.prepare(sql);
    let args = [];
    const api = { bind(...values) { args = values; return api; }, async first() { if (!/^\s*SELECT/i.test(sql)) writes.push(sql); return stmt.get(...args) ?? null; },
      async all() { if (!/^\s*SELECT/i.test(sql)) writes.push(sql); return { results: stmt.all(...args) }; },
      async run() { writes.push(sql); stmt.run(...args); return { success: true }; } };
    return api;
  }, batch(statements) {
    const work = batchTail.then(async () => {
      raw.exec("BEGIN");
      try { const result = []; for (const statement of statements) result.push(await statement.all()); raw.exec("COMMIT"); return result; }
      catch (error) { raw.exec("ROLLBACK"); throw error; }
    });
    batchTail = work.catch(() => {});
    return work;
  } };
  const files = new Map([
    ["dictionary/current.json", { schema: "oewn-r2-current-v1", release: RELEASE, caseIndex: "case-v1-123456789abc", formsIndex: "forms-v1-123456789abc" }],
    [pathFor(CHOICE.lemma), entry()],
  ]);
  let failR2 = false;
  const BOOKS = { async get(key) {
    gets.push(key);
    if (failR2) throw new Error("private R2 failure");
    if (!files.has(key)) return null;
    const file = files.get(key);
    const bytes = typeof file === "string" ? Buffer.from(file) : Buffer.from(JSON.stringify(file));
    return { size: bytes.length, body: new Response(bytes).body, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length) };
  } };
  const env = { DB, BOOKS };
  const call = (body = get(), options = {}) => {
    const { cookie = "mw_session=token", method = "POST", headers = {}, now = NOW } = options;
    return handleDictionaryChoices(new Request("https://inputread.test/api/dictionary/choices", {
      method, headers: { cookie, origin: "https://inputread.test", "sec-fetch-site": "same-origin", ...headers },
      ...(["GET", "HEAD"].includes(method) ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
    }), env, { now });
  };
  const rows = () => raw.prepare("SELECT * FROM dictionary_choices ORDER BY target_hash").all();
  const budget = () => raw.prepare("SELECT COALESCE(SUM(hits),0) AS hits FROM rate_limits WHERE bucket LIKE 'budget:choices:%'").get().hits;
  return { raw, env, files, writes, gets, call, rows, budget, failR2(value = true) { failR2 = value; } };
}
const error = async (response, status, code) => { assert.equal(response.status, status); assert.deepEqual(await response.json(), { error: code }); };
const success = async (response, selected = null) => {
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { ok: true, selectedId: selected?.id ?? null, selected, status: "pending-review", positionValidated: false });
};

test("POST only, live authenticated session and strictly positive verified timestamp", async () => {
  const f = await fixture();
  await error(await f.call(get(), { method: "GET" }), 405, "method");
  await error(await onRequest({ request: new Request("https://inputread.test/api/dictionary/choices"), env: f.env }), 405, "method");
  await error(await f.call(get(), { cookie: "" }), 401, "unauthorized");
  await error(await f.call(get(), { cookie: "mw_session=missing" }), 401, "unauthorized");
  for (const verified of [null, 0, -1]) {
    f.raw.prepare("UPDATE users SET email_verified_at = ?").run(verified);
    await error(await f.call(), 403, "email-unverified");
  }
  f.raw.prepare("UPDATE users SET email_verified_at = ?").run(NOW - 1);
  f.raw.prepare("UPDATE sessions SET expires_at = ?").run(NOW);
  await error(await f.call(), 401, "unauthorized");
  assert.equal(f.rows().length, 0);
  assert.equal(f.gets.length, 0);
});

test("CSRF rejects foreign/null Origins and cross-site fetch metadata, same origin passes", async () => {
  const f = await fixture();
  for (const headers of [{ origin: "https://foreign.test" }, { origin: "null" }, { "sec-fetch-site": "cross-site" }, { origin: "https://inputread.test.evil.test" }]) {
    await error(await f.call(get(), { headers }), 403, "origin");
  }
  await success(await f.call());
  assert.equal(f.rows().length, 0);
  assert.equal(f.budget(), 0);
});

test("strict payload, fields, lengths, NFC surface and integer coordinate ranges", async () => {
  const f = await fixture();
  for (const body of [null, [], 5, {}, { ...get(), extra: true }, { action: "vote", target: TARGET },
    { action: "set", target: TARGET }, { ...get(), choice: CHOICE },
    payload({ ...CHOICE, extra: true }), payload({ ...CHOICE, release: "../escape" }),
    payload({ ...CHOICE, id: "x".repeat(241) }), payload({ ...CHOICE, lemma: "café" }),
    payload({ ...CHOICE, lemma: "é".repeat(121) }), payload({ ...CHOICE, lemma: "\ud800" })]) {
    const response = await f.call(body); assert.equal(response.status, 400, JSON.stringify(body));
  }
  for (const change of [{ bookTitle: "not identity" }, { bookId: "../x" }, { catalogId: "wrong:book" }, { chapter: -1 }, { chapter: 12 },
    { chapter: "0" }, { chapter: 0.5 }, { chapters: 0 }, { chapters: 2001 }, { paragraph: -1 }, { paragraph: 1_000_001 },
    { occurrence: 0 }, { occurrence: Number.MAX_SAFE_INTEGER + 1 }, { word: "café" }, { word: "" },
    { sentence: "" }, { context: "x".repeat(2001) }, { glossaryRev: "x".repeat(101) }]) {
    await error(await f.call(payload(CHOICE, { ...TARGET, ...change })), 400, "bad-target");
  }
  await error(await f.call("{broken"), 400, "bad-json");
  assert.equal(f.rows().length, 0);
  assert.equal(f.budget(), 0);
});

test("streaming request byte bound ignores understated Content-Length and cancels early", async () => {
  const f = await fixture();
  await error(await f.call("é".repeat(4097), { headers: { "content-length": "1" } }), 413, "too-large");
  let pulls = 0, cancelled = false;
  const body = new ReadableStream({ pull(controller) { pulls++; controller.enqueue(new Uint8Array(3000)); }, cancel() { cancelled = true; } });
  const response = await handleDictionaryChoices(new Request("https://inputread.test/api/dictionary/choices", {
    method: "POST", headers: { cookie: "mw_session=token" }, body, duplex: "half",
  }), f.env, { now: NOW });
  await error(response, 413, "too-large");
  assert.equal(cancelled, true);
  assert.ok(pulls <= 4);
  assert.equal(f.rows().length, 0);
});

test("get never creates evidence, set repeats skip mutations/budget, switch and withdraw one row", async () => {
  const f = await fixture();
  await success(await f.call());
  await success(await f.call({ ...get(), choice: null }));
  assert.equal(f.gets.length, 0);
  assert.equal(f.rows().length, 0);
  assert.equal(f.budget(), 0);
  await success(await f.call(payload()), CHOICE);
  assert.deepEqual(f.gets, ["dictionary/current.json", pathFor(CHOICE.lemma)]);
  const initial = f.rows()[0];
  assert.equal(JSON.parse(initial.target_json).word, "Cafés"); // exact surface, not lowercase lemma
  assert.equal(f.budget(), 1);
  const mutations = f.writes.filter((sql) => /(?:INTO|FROM) dictionary_choices/.test(sql)).length;
  await success(await f.call(payload(), { now: NOW + 1 }), CHOICE);
  assert.equal(f.writes.filter((sql) => /(?:INTO|FROM) dictionary_choices/.test(sql)).length, mutations);
  assert.equal(f.budget(), 1);
  assert.deepEqual(f.rows()[0], initial);
  await success(await f.call(payload(SECOND), { now: NOW + 2 }), SECOND);
  assert.equal(f.rows().length, 1);
  assert.equal(f.rows()[0].created_at, NOW);
  assert.equal(f.rows()[0].updated_at, NOW + 2);
  assert.equal(f.budget(), 2);
  f.failR2();
  await success(await f.call(), SECOND); // get does not depend on current dictionary publication
  await success(await f.call(payload(null)));
  assert.equal(f.rows().length, 0);
  assert.equal(f.budget(), 3);
  await success(await f.call(payload(null)));
  assert.equal(f.budget(), 3);
});

test("whole canonical target evidence isolates positions and users; property order is not identity", async () => {
  const f = await fixture();
  const targets = [TARGET, ...[
    { occurrence: 2 }, { bookId: "other-device-book" }, { catalogId: "public-books:book" }, { glossaryRev: "rev-2" },
    { chapter: 1 }, { chapters: 13 }, { paragraph: 4 }, { word: "cafés" }, { sentence: "Another sentence." }, { context: "Other context." },
  ].map((change) => ({ ...TARGET, ...change }))];
  for (const target of targets) await success(await f.call(payload(CHOICE, target)), CHOICE);
  assert.equal(f.rows().length, targets.length);
  assert.equal(f.budget(), targets.length);
  const reverse = Object.fromEntries(Object.entries(TARGET).reverse());
  await success(await f.call(payload(CHOICE, reverse)), CHOICE);
  assert.equal(f.budget(), targets.length);
  const first = parseChoiceRequest(get({ ...TARGET, context: undefined, glossaryRev: undefined, catalogId: undefined }));
  const second = parseChoiceRequest(get({ ...TARGET, context: "", glossaryRev: "", catalogId: "" }));
  assert.deepEqual(await choicePosition(first.target), await choicePosition(second.target));
  f.raw.prepare("INSERT INTO users (id,email,password_hash,password_salt,password_iters,created_at,email_verified_at) SELECT 'other','other@example.test',password_hash,password_salt,password_iters,created_at,email_verified_at FROM users WHERE id='reader'").run();
  f.raw.prepare("INSERT INTO sessions (token_hash,user_id,created_at,expires_at) VALUES (?,?,?,?)").run(await sha256Hex("other"), "other", NOW, NOW + 10000);
  await success(await f.call(get(), { cookie: "mw_session=other" }));
  await success(await f.call(payload(SECOND), { cookie: "mw_session=other" }), SECOND);
  await success(await f.call(), CHOICE);
});

test("source exact UTF8 hex, nominated provenance and exact ID membership only (no ID parsing/stemming)", async () => {
  const f = await fixture();
  await success(await f.call(payload()), CHOICE);
  assert.ok(f.gets.includes(`dictionary/releases/${RELEASE}/words/63/636166c3a9.json`));
  await error(await f.call(payload({ ...CHOICE, id: "opaque-source-id/one-nearby" })), 400, "dictionary-choice");
  await error(await f.call(payload({ ...CHOICE, lemma: "Café" })), 400, "dictionary-choice");
  await error(await f.call(payload({ ...CHOICE, release: "oewn-2025-old" })), 409, "dictionary-release");
  f.files.set("dictionary/current.json", { schema: "oewn-r2-current-v1", release: "oewn-2026-new" });
  await success(await f.call(), CHOICE); // stored provenance survives release changes
  await error(await f.call(payload()), 409, "dictionary-release");
  assert.equal(f.budget(), 1);
});

test("mutable existing uploaded paths validate latest IDs without a new directory or release switch", async () => {
  const f=await fixture();
  f.files.set('dictionary/current.json',{...f.files.get('dictionary/current.json'),wordsMutable:true});
  f.files.set(pathFor(CHOICE.lemma),{...entry(),release:'oewn-word-edit'});
  const oldChoice={...CHOICE,release:'oewn-old-client'};
  await success(await f.call(payload(oldChoice)),oldChoice);
  assert.ok(f.gets.includes(pathFor(CHOICE.lemma)));
  assert.equal(f.gets.some(key=>key.startsWith('dictionary/words/')),false);
  f.files.set(pathFor(CHOICE.lemma),{...entry(),release:'oewn-word-edit-two',senses:[entry().senses[1]]});
  await error(await f.call(payload(oldChoice)),400,'dictionary-choice');
  assert.equal(f.rows()[0].choice_id,CHOICE.id);
  for(const wordsMutable of [false,'true',1,null]) {
    f.files.set('dictionary/current.json',{schema:'oewn-r2-current-v1',release:RELEASE,wordsMutable});
    await error(await f.call(payload()),503,'dictionary-unavailable');
  }
});

test("stable per-lemma entries accept edited release provenance and preserve submitted evidence", async () => {
  const f = await fixture();
  const manifest = { ...f.files.get("dictionary/current.json"), wordsMutable: true };
  f.files.set("dictionary/current.json", manifest);
  f.files.set(pathFor(CHOICE.lemma), entry());
  await success(await f.call(payload()), CHOICE);
  const initial = f.rows()[0];
  // An edited entry's release differs from both the index publication and old browser metadata.
  f.files.set(pathFor(CHOICE.lemma), { ...entry(), release: "oewn-2026-entry-edit" });
  await success(await f.call(payload(), { now: NOW + 1 }), CHOICE);
  await success(await f.call(), CHOICE);
  assert.deepEqual(f.rows()[0], initial);
  assert.equal(f.rows()[0].choice_release, RELEASE);
  assert.equal(f.budget(), 1);
  assert.deepEqual(f.gets, ["dictionary/current.json", "dictionary/releases/oewn-2025-809369f31478/words/63/636166c3a9.json",
    "dictionary/current.json", "dictionary/releases/oewn-2025-809369f31478/words/63/636166c3a9.json"]);
  // Release still belongs to recorded evidence: sameChoice is deliberately unchanged.
  const refreshed = { ...CHOICE, release: "oewn-2026-entry-edit" };
  await success(await f.call(payload(refreshed), { now: NOW + 2 }), refreshed);
  assert.equal(f.rows()[0].choice_release, refreshed.release);
  assert.equal(f.budget(), 2);
});

test("stable membership rejects removed, nearby and foreign IDs, even with old immutable entries", async () => {
  const f = await fixture();
  f.files.set("dictionary/current.json", { ...f.files.get("dictionary/current.json"), wordsMutable: true });
  f.files.set(pathFor(CHOICE.lemma), entry());
  await success(await f.call(payload()), CHOICE);
  const foreignId = "opaque-source-id/foreign";
  f.files.set(pathFor("tea"), { ...entry("tea"), senses: [{ ...entry().senses[0], id: foreignId }] });
  f.files.set(pathFor(CHOICE.lemma), { ...entry(), release: "oewn-2026-edited", senses: [entry().senses[1]] });
  for (const id of [CHOICE.id, `${SECOND.id}-nearby`, foreignId]) {
    await error(await f.call(payload({ ...CHOICE, id })), 400, "dictionary-choice");
  }
  await error(await f.call(payload({ ...CHOICE, lemma: "Café" })), 400, "dictionary-choice");
  assert.equal(f.rows()[0].choice_id, CHOICE.id);
  assert.equal(f.budget(), 1);
  assert.equal(f.gets.some((key) => key.startsWith("dictionary/words/")), false);
});

test("unsupported wordBase routing is rejected without selecting another directory", async () => {
  for (const wordBase of [null, false, 0, [], {}, "", "dictionary/words/", "Dictionary/words", " dictionary/words",
    "dictionary/words/../releases", "../dictionary/words", "dictionary/releases/other/words", "/dictionary/words",
    "https://foreign.test/dictionary/words", "//foreign.test/dictionary/words", "dictionary\\words"]) {
    const f = await fixture();
    f.files.set("dictionary/current.json", { ...f.files.get("dictionary/current.json"), wordBase });
    // Even a valid stable object cannot rescue malformed manifest routing.
    f.files.set(pathFor(CHOICE.lemma), entry());
    await error(await f.call(payload()), 503, "dictionary-unavailable");
    assert.deepEqual(f.gets, ["dictionary/current.json"]);
    assert.equal(f.rows().length, 0); assert.equal(f.budget(), 0);
  }
});

test("missing mutable word fails at the original path without trying a new directory", async () => {
  const f=await fixture();f.files.set('dictionary/current.json',{...f.files.get('dictionary/current.json'),wordsMutable:true});
  f.files.delete(pathFor(CHOICE.lemma));await error(await f.call(payload()),400,'dictionary-choice');
  assert.deepEqual(f.gets,['dictionary/current.json',pathFor(CHOICE.lemma)]);
});

test("stable entries retain exact lookupKey, complete sense validation, schema and byte bounds", async () => {
  for (const bad of ["x".repeat(32769), "{broken", { ...entry(), schema: "wrong" }, { ...entry(), lookupKey: "Café" },
    ...[undefined, null, 7, "", "../bad", "UPPER", "x".repeat(81)].map((release) => ({ ...entry(), release })),
    { ...entry(), senses: [{ id: CHOICE.id }] },
    { ...entry(), senses: [entry().senses[0], entry().senses[0]] },
    { ...entry(), senses: [entry().senses[0], { ...entry().senses[1], meaning: "" }] }]) {
    const f = await fixture();
    f.files.set("dictionary/current.json", { ...f.files.get("dictionary/current.json"), wordsMutable: true });
    f.files.set(pathFor(CHOICE.lemma), bad);
    await error(await f.call(payload()), 503, "dictionary-unavailable");
    assert.deepEqual(f.gets, ["dictionary/current.json", pathFor(CHOICE.lemma)]);
    assert.equal(f.rows().length, 0); assert.equal(f.budget(), 0);
  }
});

test("invalid/oversize source objects and entry schema fail closed before any write", async () => {
  for (const bad of ["x".repeat(32769), { ...entry(), schema: "wrong" }, { ...entry(), release: "other" },
    { ...entry(), lookupKey: "Cafe" }, { ...entry(), senses: [{ id: CHOICE.id }] },
    { ...entry(), senses: [entry().senses[0], entry().senses[0]] }, "{broken"]) {
    const f = await fixture(); f.files.set(pathFor(CHOICE.lemma), bad);
    await error(await f.call(payload()), 503, "dictionary-unavailable");
    assert.equal(f.rows().length, 0); assert.equal(f.budget(), 0);
  }
  for (const bad of [{ schema: "wrong", release: RELEASE }, { schema: "oewn-r2-current-v1", release: "../bad" }, "x".repeat(4097)]) {
    const f = await fixture(); f.files.set("dictionary/current.json", bad);
    await error(await f.call(payload()), 503, "dictionary-unavailable");
    assert.equal(f.budget(), 0);
  }
  const f = await fixture();
  f.env.BOOKS = { async get() { return { size: 1, body: new Response("x".repeat(4097)).body }; } };
  await error(await f.call(payload()), 503, "dictionary-unavailable"); // actual stream bound, not size alone
  assert.equal(f.budget(), 0);
});

test("request limit is strict 120 per user/window including repeats/get; separate daily 5000 fuse", async () => {
  assert.equal(RATE_LIMITS["choices:user"], 120);
  assert.equal(DAILY_WRITE_BUDGET.choices, 5000);
  const f = await fixture();
  for (let i = 0; i < 120; i++) await success(await f.call());
  await error(await f.call(), 429, "rate");
  assert.equal(f.budget(), 0);
  await success(await f.call(payload(), { now: NOW + 900000 }), CHOICE);
  const day = Math.floor(NOW / 86400000) * 86400000;
  f.raw.prepare("UPDATE rate_limits SET hits = 5000 WHERE bucket = ?").run(`budget:choices:${day}`);
  await success(await f.call(payload(), { now: NOW + 900001 }), CHOICE); // identical set costs no budget
  await success(await f.call(get(), { now: NOW + 900002 }), CHOICE);
  await error(await f.call(payload(SECOND), { now: NOW + 900003 }), 429, "choices-budget");
  await error(await f.call(payload(null), { now: NOW + 900004 }), 429, "choices-budget");
  assert.equal(f.rows()[0].choice_id, CHOICE.id);
  assert.equal(f.budget(), 5000);
});

test("atomic budget charges actual changes only, including stale concurrent prechecks", async () => {
  const f = await fixture();
  const position = await choicePosition(parseChoiceRequest(payload()).target);
  await Promise.all([saveChoice(f.env.DB, "reader", position, CHOICE, NOW), saveChoice(f.env.DB, "reader", position, CHOICE, NOW)]);
  assert.equal(f.rows().length, 1); assert.equal(f.budget(), 1);
  await saveChoice(f.env.DB, "reader", position, CHOICE, NOW + 1);
  assert.equal(f.budget(), 1);
  await saveChoice(f.env.DB, "reader", position, null, NOW + 2);
  await saveChoice(f.env.DB, "reader", position, null, NOW + 3);
  assert.equal(f.rows().length, 0); assert.equal(f.budget(), 2);
});

test("storage/source failure is safe, no raw errors, budget and mutation roll back together", async () => {
  const f = await fixture();
  f.failR2();
  await error(await f.call(payload()), 500, "server");
  assert.equal(f.budget(), 0);
  f.failR2(false);
  const realBatch = f.env.DB.batch;
  f.env.DB.batch = async (statements) => {
    f.raw.exec("BEGIN");
    try { await statements[0].all(); throw new Error("private D1 failure"); }
    finally { f.raw.exec("ROLLBACK"); }
  };
  await error(await f.call(payload()), 500, "server");
  assert.equal(f.rows().length, 0); assert.equal(f.budget(), 0);
  f.env.DB.batch = realBatch;
  f.env.DB.prepare = () => { throw new Error("private database failure"); };
  await error(await f.call(), 500, "server");
});

test("paragraph evidence rejects mismatched hashes and fixed mappings reject stale choices", async () => {
  const f = await fixture();
  const paragraphText = 'The Cafés were busy.';
  const position = { chapterSha256: await sha256Hex(JSON.stringify([paragraphText])), paragraphIndex: 3,
    paragraphSha256: await sha256Hex(paragraphText), offset: 4, surface: 'Cafés' };
  const target = { ...TARGET, paragraphText, position };
  await success(await f.call(payload(CHOICE, target)), CHOICE);
  await error(await f.call(payload(CHOICE, { ...target, paragraphText: 'The Cafés were quiet.' })), 400, 'bad-position-evidence');
  const key = await sha256Hex(JSON.stringify([target.catalogId, position.chapterSha256, position.paragraphIndex, position.paragraphSha256, position.offset, position.surface]));
  f.files.set('dictionary/positions/word-lists/book/mappings.json', {schema:'oewn-position-mappings-v1',catalogId:target.catalogId,
    entries:[{...position,positionKey:key,senseId:CHOICE.id,lemma:CHOICE.lemma,release:RELEASE,reviewedAt:NOW}]});
  await error(await f.call(payload(SECOND,target)),409,'fixed');
  assert.equal(f.rows()[0].choice_id,CHOICE.id);
});

test("account export includes pending raw choices and account deletion cascades", async () => {
  const f = await fixture();
  await success(await f.call(payload()), CHOICE);
  const response = await handleExport(new Request("https://inputread.test/api/auth/export", { headers: { cookie: "mw_session=token" } }), f.env, { now: NOW });
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.dictionaryChoices.length, 1);
  const saved = data.dictionaryChoices[0];
  assert.deepEqual(saved.target, TARGET);
  assert.deepEqual(saved.choice, CHOICE);
  assert.equal(saved.status, "pending-review"); assert.equal(saved.positionValidated, false);
  assert.equal(saved.createdAt, NOW); assert.equal(saved.updatedAt, NOW);
  assert.match(saved.targetHash, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(data).includes("password_hash"), false);
  f.raw.prepare("DELETE FROM users WHERE id = 'reader'").run();
  assert.equal(f.rows().length, 0);
});
