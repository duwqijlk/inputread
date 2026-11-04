import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";
import { loadAppModules } from "./lib/app-modules.mjs";
const { wordListPlan: plan } = await loadAppModules();
import * as catalogId from "../src/lib/catalog-id.ts";

const source = readFileSync(new URL("../src/lib/word-list-update.ts", import.meta.url), "utf8");
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
function fixture() {
  let generation = 0, shared = 0, offline = false, fail = false, gate;
  let shelf = [{ id: "one" }];
  let summary = { source: "pack", catalog: "word-lists", glossaryWords: 10 };
  let record = { bookId: "one", packId: "pack", rev: "a".repeat(12), sha256: "" };
  let catalog = { id: "pack", words: 10, glossary: { sha256: "a".repeat(64) } };
  const calls = { records: 0, summary: 0, public: 0, lists: 0 };
  const create = () => (init) => {
    let state;
    const store = { getState: () => state, setState: (patch) => { state = { ...state, ...(typeof patch === "function" ? patch(state) : patch) }; } };
    state = init(store.setState);
    return store;
  };
  const stubs = {
    zustand: { create },
    "@/lib/catalog-id": catalogId,
    "@/lib/shared-fetch": { SHARED_TEXT_MS: 60_000, sharedFetchGeneration: () => shared },
    "@/lib/book-db": {
      bookDataGeneration: () => generation,
      listPackRecords: async () => { calls.records++; if (fail) throw Error("storage failure"); return [record]; },
      loadBookSummary: async () => { calls.summary++; const value = { ...summary }; if (gate) { const current = gate; gate = null; await current.promise; } return value; },
    },
    "@/lib/catalog-shelf-identity": { uniqueBookRecord: (rows, id) => rows.find((r) => r.bookId === id) },
    "@/lib/vocab-store": { useVocab: { getState: () => ({ books: shelf }) } },
    "@/lib/packs": { BUNDLED_CATALOG_URL: "https://fixture/catalog", getCatalogUrl: () => "https://fixture/catalog", loadCatalog: async () => { calls.public++; return { catalog: { packs: [] }, offline }; } },
    "@/lib/word-list-catalog": { loadWordListCatalog: async () => { calls.lists++; return [catalog]; } },
    "@/lib/word-list-plan": plan,
    "@/lib/i18n": { tr: (s) => s, errorText: (error) => error.message },
  };
  const module = { exports: {} };
  new Function("module", "exports", "require", js)(module, module.exports, (key) => stubs[key] ?? {});
  return {
    ...module.exports, calls,
    mutate: (patch) => { summary = { ...summary, ...patch }; generation++; },
    invalidate: () => { shared++; },
    shelf: (value) => { shelf = value; },
    fail: (value) => { fail = value; },
    offline: (value) => { offline = value; },
    gate: (value) => { gate = value; },
  };
}

test("unchanged navigation shares one scan, while mutations and catalog resets invalidate", async () => {
  const f = fixture();
  const a = f.autoUpdateWordLists(), b = f.autoUpdateWordLists();
  assert.equal(a, b);
  await a;
  await f.autoUpdateWordLists();
  assert.deepEqual(f.calls, { records: 1, summary: 1, public: 1, lists: 1 });
  f.mutate({ glossaryWords: 9 });
  await f.autoUpdateWordLists();
  assert.equal(f.useListUpdates.getState().holds["book:one"], "newList", "same revision still checks actual installed count");
  assert.equal(f.calls.records, 2);
  f.invalidate();
  await f.autoUpdateWordLists();
  assert.equal(f.calls.records, 3);
  f.shelf([]);
  await f.autoUpdateWordLists();
  assert.equal(f.useListUpdates.getState().waiting, 0);
  f.shelf([{ id: "one" }]);
  await f.autoUpdateWordLists();
  assert.equal(f.calls.records, 5);
});

test("a mid-flight edit drains one fresh check without publishing the obsolete result", async () => {
  const f = fixture(), hold = deferred();
  f.gate(hold);
  const run = f.autoUpdateWordLists();
  for (let i = 0; i < 20 && !f.calls.summary; i++) await Promise.resolve();
  assert.equal(f.calls.summary, 1);
  f.mutate({ glossaryWords: 9 });
  assert.equal(f.autoUpdateWordLists(), run);
  assert.equal(f.autoUpdateWordLists(), run);
  hold.resolve();
  await run;
  assert.equal(f.calls.records, 2);
  assert.equal(f.useListUpdates.getState().holds["book:one"], "newList");
  assert.equal(f.useListUpdates.getState().finished, 1, "stale scan never publishes UI state");
});

test("read failures and offline catalogs remain immediately retryable", async () => {
  const f = fixture();
  f.fail(true);
  await f.autoUpdateWordLists();
  f.fail(false);
  f.offline(true);
  await f.autoUpdateWordLists();
  f.offline(false);
  await f.autoUpdateWordLists();
  assert.equal(f.calls.records, 3);
  assert.equal(f.useListUpdates.getState().finished, 2, "offline fallback may display safe known-catalog results but does not establish a cooldown");
});

test("startup repair reuses provided summaries and refuses destructive planning after identity failure", async () => {
  const text = readFileSync(new URL("../src/lib/shelf-repair.ts", import.meta.url), "utf8");
  const code = ts.transpileModule(text, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  let reads = 0, plans = 0;
  let books = [];
  const stubs = {
    "@/lib/book-db": {
      listBookSummaries: async () => { reads++; return []; },
      listPackRecords: async () => [],
      loadBookSummary: async () => { throw Error("identity unavailable"); },
    },
    "@/lib/vocab-store": { useVocab: { getState: () => ({ books }) } },
    "@/lib/progress-store": { useProgress: { getState: () => ({ items: {} }) } },
    "@/lib/catalog-shelf-identity": { planSafeShelfMerges: () => { plans++; return []; } },
  };
  const module = { exports: {} };
  new Function("module", "exports", "require", code)(module, module.exports, (key) => stubs[key] ?? {});
  await module.exports.repairShelf([]);
  assert.equal(reads, 0, "boot listing is reused even when empty");
  await module.exports.repairShelf();
  assert.equal(reads, 1, "other callers retain the authoritative fallback");
  books = [{ id: "one" }];
  await assert.rejects(module.exports.repairShelf([]), /identity unavailable/);
  assert.equal(plans, 2, "unknown identity never reaches merge planning");
});

test("successful scan expiry is bounded by the original one-minute freshness window", async () => {
  const f = fixture(), original = Date.now;
  let now = 100_000;
  Date.now = () => now;
  try {
    await f.autoUpdateWordLists();
    now += 59_999;
    await f.autoUpdateWordLists();
    assert.equal(f.calls.records, 1);
    now += 2;
    await f.autoUpdateWordLists();
    assert.equal(f.calls.records, 2);
  } finally { Date.now = original; }
});
