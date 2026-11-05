import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";
import * as cancel from "../src/lib/cancel-work.ts";

function client(deadline = 1000) {
  const src = readFileSync(new URL("../src/lib/glossary-fetch.ts", import.meta.url), "utf8");
  const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const stubs = {
    "@/lib/cancel-work": { ...cancel, requestScope: (signal) => cancel.requestScope(signal, deadline) },
    "@/lib/books-base": { DEFAULT_BOOKS_BASE: "https://books.test" },
    "@/lib/i18n": { tr: (key) => key },
    "@/lib/glossary-quota": { dayLabel: () => "Monday", useGlossaryQuota: { getState: () => ({ refresh: async () => {} }) } },
  };
  const module = { exports: {} };
  new Function("module", "exports", "require", js)(module, module.exports, (name) => stubs[name]);
  return module.exports.fetchProtectedGlossary;
}

test("protected glossary errors distinguish auth, rate, missing, blocked and server responses", async () => {
  const original = globalThis.fetch, download = client();
  try {
    for (const [status, code, key] of [
      [401, "unauthorized", "err.glossaryLogin"], [429, "rate", "err.glossaryRate"],
      [404, "no-list", "err.glossaryMissing"], [403, "blocked", "err.glossaryForbidden"],
      [500, "server", "err.glossaryServer"], [503, "server", "err.glossaryServer"],
      [403, "email-unverified", "err.emailUnverified"],
      [429, "glossary-week", "err.glossaryWeek"], [429, "glossary-week-speech", "err.glossaryWeekSpeech"],
      [400, "bad-id", "fallback"],
    ]) {
      globalThis.fetch = async () => new Response(JSON.stringify({ error: code }), { status });
      await assert.rejects(download("book", "fallback"), { message: key });
    }
    globalThis.fetch = async () => new Response("<html>Gateway failed</html>", { status: 502 });
    await assert.rejects(download("book", "fallback"), { message: "err.glossaryServer" });
    globalThis.fetch = async () => new Response(JSON.stringify({ error: "glossary-week", resetAt: 1000 }), { status: 429 });
    await assert.rejects(download("book", "fallback"), { message: "quota.fullNovel" });
  } finally { globalThis.fetch = original; }
});

test("network failure and interrupted response bodies are not reported as missing files", async () => {
  const original = globalThis.fetch, download = client();
  try {
    globalThis.fetch = async () => { throw new TypeError("Network error"); };
    await assert.rejects(download("book", "file-not-found"), { message: "err.glossaryNetwork" });
    globalThis.fetch = async () => ({ ok: true, arrayBuffer: async () => { throw Error("stream closed"); } });
    await assert.rejects(download("book", "file-not-found"), { message: "err.glossaryNetwork" });
    globalThis.fetch = async () => new Response(new Uint8Array([1, 2, 3]));
    assert.deepEqual(await download("book", "fallback"), new Uint8Array([1, 2, 3]));
  } finally { globalThis.fetch = original; }
});

test("deadline is visible as timeout but caller cancellation remains AbortError", async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Promise(() => {});
    await assert.rejects(client(5)("book", "fallback"), { message: "err.glossaryTimeout" });
    globalThis.fetch = async () => ({ ok: true, arrayBuffer: async () => new Promise(() => {}) });
    await assert.rejects(client(5)("book", "fallback"), { message: "err.glossaryTimeout" });
    const parent = new AbortController();
    const pending = client()("book", "fallback", parent.signal);
    parent.abort();
    await assert.rejects(pending, { name: "AbortError" });
    const scope = cancel.requestScope(undefined, 5);
    try { await assert.rejects(scope.run(new Promise(() => {}))); assert.equal(scope.timedOut, true); }
    finally { scope.dispose(); }
    const Controller = globalThis.AbortController;
    try {
      globalThis.AbortController = undefined;
      globalThis.fetch = async () => new Promise(() => {});
      await assert.rejects(client(5)("book", "fallback"), { message: "err.glossaryTimeout" });
    } finally { globalThis.AbortController = Controller; }
  } finally { globalThis.fetch = original; }
});

test("only glossary mismatches get the refresh hint; EPUB integrity checks remain distinct", () => {
  const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
  for (const path of ["src/lib/pair-epub.ts", "src/lib/word-list-update.ts", "src/lib/packs.ts"])
    assert.match(read(path), /err\.glossaryMismatch/);
  assert.match(read("src/lib/packs.ts"), /pack\.epub\.sha256[^]*?err\.damaged/);
  const en = read("src/lib/i18n-en.ts"), zh = read("src/lib/i18n-zh.ts");
  for (const key of ["Login", "Rate", "Missing", "Forbidden", "Server", "Network", "Timeout", "Mismatch"]) {
    assert.ok(en.includes(`"err.glossary${key}"`));
    assert.ok(zh.includes(`"err.glossary${key}"`));
  }
});
