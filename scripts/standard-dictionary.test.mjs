import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import ts from "typescript";

const require = createRequire(import.meta.url);
const source = readFileSync(new URL("../src/lib/standard-dictionary.ts", import.meta.url), "utf8");
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const load = () => {
  const module = { exports: {} };
  new Function("module", "exports", "require", js)(module, module.exports, (id) => id === "@/lib/books-base" ? { booksUrl: (path) => `https://books.test.invalid/${path}` } : require(id));
  return module.exports;
};

function response(body, status = 200) {
  return { status, ok: status >= 200 && status < 300, headers: { get() { return null; } }, text: async () => JSON.stringify(body) };
}
const manifest = response({ schema: "oewn-r2-current-v1", release: "oewn-2025-test" });
const entry = (word) => response({ schema: "oewn-r2-entry-v1", release: "oewn-2025-test", lookupKey: word, senses: [
  { id: "bank%1:14:00::", pos: "n", meaning: "a place for money", originalMeaning: "a financial institution", learningMeaning: "a place for money" },
  { id: "bank%1:17:00::", pos: "n", meaning: "the land beside a river", originalMeaning: "sloping land by a stream" },
] });

test("exact NFC UTF-8 hex lookup path preserves case and separators", () => {
  const { dictionaryWordPath } = load();
  assert.equal(dictionaryWordPath("oewn-2025-test", "Bank"), "dictionary/releases/oewn-2025-test/words/42/42616e6b.json");
  assert.equal(dictionaryWordPath("oewn-2025-test", "bank"), "dictionary/releases/oewn-2025-test/words/62/62616e6b.json");
  assert.equal(dictionaryWordPath("oewn-2025-test", "km/h"), "dictionary/releases/oewn-2025-test/words/6b/6b6d2f68.json");
  assert.equal(dictionaryWordPath("oewn-2025-test", "é"), dictionaryWordPath("oewn-2025-test", "é"));
  assert.throws(() => dictionaryWordPath("../bad", "bank"));
});

test("manifest gates requests, duplicate lookup coalesces, and sense IDs are never guessed", async () => {
  const { lookupStandardWord } = load();
  const original = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (url) => { urls.push(url); return url.endsWith("current.json") ? manifest : entry("bank"); };
  try {
    const [first, second] = await Promise.all([lookupStandardWord("bank"), lookupStandardWord("bank")]);
    assert.deepEqual(first, second);
    assert.equal(first.kind, "unmapped");
    assert.equal(first.senses.length, 2);
    assert.equal(first.senses[0].id, "bank%1:14:00::");
    assert.deepEqual(urls, ["https://books.test.invalid/dictionary/current.json", "https://books.test.invalid/dictionary/releases/oewn-2025-test/words/62/62616e6b.json"]);
  } finally { globalThis.fetch = original; }
});

const indexedManifest = response({ schema: "oewn-r2-current-v1", release: "oewn-2025-test", caseIndex: "case-v1-0123456789ab" });
function caseResponse(api, word, entries, changes = {}) {
  return response({ schema: "oewn-case-index-v1", release: "oewn-2025-test", indexVersion: "case-v1-0123456789ab", shard: api.dictionaryCaseShard(word), entries, ...changes });
}

test("case fallback is unique, exact-first and does not merge conflicting identities", async () => {
  const original = globalThis.fetch;
  try {
    for (const word of ["Bank", "BANK", "bank"]) {
      const api = load(); const urls = [];
      globalThis.fetch = async (url) => {
        urls.push(url);
        if (url.endsWith("current.json")) return indexedManifest;
        if (url.includes("case-indexes")) return caseResponse(api, word, { bank: ["bank"] });
        return url.endsWith("/62616e6b.json") ? entry("bank") : response({}, 404);
      };
      assert.equal((await api.lookupStandardWord(word)).kind, "unmapped");
      assert.equal(urls.filter(u => u.includes("case-indexes")).length, word === "bank" ? 0 : 1);
    }
    for (const word of ["US", "us", "Us"]) {
      const api = load();
      globalThis.fetch = async (url) => {
        if (url.endsWith("current.json")) return indexedManifest;
        if (url.includes("case-indexes")) return caseResponse(api, word, { us: ["US", "us"] });
        return word === "Us" ? response({}, 404) : entry(word);
      };
      assert.equal((await api.lookupStandardWord(word)).kind, word === "Us" ? "ambiguous" : "unmapped");
    }
    const api = load();
    globalThis.fetch = async (url) => url.endsWith("current.json") ? indexedManifest : url.includes("case-indexes") ? caseResponse(api, "london", { london: ["London"] }) : url.endsWith("/4c6f6e646f6e.json") ? entry("London") : response({}, 404);
    assert.equal((await api.lookupStandardWord("london")).kind, "unmapped");
  } finally { globalThis.fetch = original; }
});

test("case index errors, mismatches and ambiguity fail closed; no stemming", async () => {
  const original = globalThis.fetch;
  try {
    for (const kind of ["network", "release", "candidate", "missing", "duplicate"]) {
      const api = load();
      globalThis.fetch = async url => {
        if (url.endsWith("current.json")) return indexedManifest;
        if (!url.includes("case-indexes")) return response({}, 404);
        if (kind === "network") return response({}, 503);
        return caseResponse(api, "BANK", kind === "candidate" ? { bank: ["river"] } : kind === "duplicate" ? { bank: ["bank", "bank"] } : kind === "missing" ? {} : { bank: ["bank"] }, kind === "release" ? { release: "other" } : {});
      };
      assert.equal((await api.lookupStandardWord("BANK")).kind, kind === "missing" ? "missing" : "error");
    }
    const api = load();
    globalThis.fetch = async url => url.endsWith("current.json") ? indexedManifest : url.includes("case-indexes") ? caseResponse(api, "walked", {}) : response({}, 404);
    assert.equal((await api.lookupStandardWord("walked")).kind, "missing");
    assert.equal(api.dictionaryCaseShard("İ"), api.dictionaryCaseShard("i̇"));
  } finally { globalThis.fetch = original; }
});

test("failed requests retry and old missing manifest expires", async () => {
  const original = globalThis.fetch; const now = Date.now;
  try {
    const api = load(); let clock = 0; let phase = 0; let count = 0;
    Date.now = () => clock;
    globalThis.fetch = async url => {
      count++;
      if (phase === 0) return response({}, 404);
      if (url.endsWith("current.json")) return manifest;
      return phase === 1 ? response({}, 503) : entry("bank");
    };
    assert.equal(await api.lookupStandardWord("bank"), null);
    phase = 1; clock = 61_000;
    assert.equal((await api.lookupStandardWord("bank")).kind, "error");
    phase = 2;
    assert.equal((await api.lookupStandardWord("bank")).kind, "unmapped");
    assert.equal(count, 4, "the successful manifest is reused while only the failed entry retries");
  } finally { globalThis.fetch = original; Date.now = now; }
});

test("absent manifest leaves legacy reader alone and mismatched entry fails closed", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => response({}, 404);
  try { assert.equal(await load().lookupStandardWord("bank"), null); }
  finally { globalThis.fetch = original; }
  globalThis.fetch = async (url) => url.endsWith("current.json") ? manifest : entry("wrong-key");
  try { assert.deepEqual(await load().lookupStandardWord("bank"), { kind: "error" }); }
  finally { globalThis.fetch = original; }
});
