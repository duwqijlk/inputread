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

test("absent manifest leaves legacy reader alone and mismatched entry fails closed", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => response({}, 404);
  try { assert.equal(await load().lookupStandardWord("bank"), null); }
  finally { globalThis.fetch = original; }
  globalThis.fetch = async (url) => url.endsWith("current.json") ? manifest : entry("wrong-key");
  try { assert.deepEqual(await load().lookupStandardWord("bank"), { kind: "error" }); }
  finally { globalThis.fetch = original; }
});
