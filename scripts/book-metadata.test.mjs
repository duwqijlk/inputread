import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import ts from "typescript";
import { handleGet, handlePatch } from "../functions/api/admin/book-metadata.ts";
import { applyMetadata, metadataRow } from "../functions/lib/book-metadata.ts";
import { handlePublish } from "../functions/api/admin/word-lists.ts";
import { mergeWordListCatalog as mergeLive } from "../functions/lib/word-list-publish.ts";
import { updatePublicRow } from "../functions/lib/public-book-publish.ts";
import { mergeWordListCatalog as mergeRetired } from "./lib/publish-word-list.mjs";
import { mergePublicCatalog } from "./lib/publish-public-book.mjs";
import { BOOK_GENRES, readBookGenres } from "../src/lib/book-genres.ts";
import { previewBookMetadata, readBookMetadataRequest } from "../src/lib/book-metadata.ts";
import { sha256Hex } from "../functions/lib/password.ts";
import { preparePositional } from "./lib/sqlite-positional.mjs";

const NOW = 1_800_000_000_000;
const baseline = 'm1:["fixture"]';
const row = (id = "same") => ({ id, title: "Example", author: "Writer", genres: ["fantasy"], series: "Full Series", seriesNumber: 2,
  updated: "2026-01-01", added: "2025-01-01", rev: "123456789abc", words: 10,
  glossary: { url: "same/glossary.json", bytes: 7, sha256: "b".repeat(64), rev: "bbb", credit: "keep" },
  epub: { url: "same/book.epub", bytes: 4, sha256: "c".repeat(64) }, unknown: { keep: true } });

async function fixture(role = "admin") {
  const raw = new DatabaseSync(":memory:");
  for (const name of readdirSync(new URL("../migrations/", import.meta.url)).filter((name) => name.endsWith(".sql")).sort()) raw.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
  raw.prepare("INSERT INTO users (id,email,password_hash,password_salt,password_iters,created_at,role) VALUES (?,?,?,?,?,?,?)")
    .run("user", "test@example.com", "hash", "salt", 10000, NOW, role);
  raw.prepare("INSERT INTO sessions (token_hash,user_id,created_at,expires_at) VALUES (?,?,?,?)").run(await sha256Hex("test-token"), "user", NOW, NOW + 100_000);
  const sqlCalls = [];
  const DB = { prepare(sql) {
    sqlCalls.push(sql);
    const stmt = preparePositional(raw, sql);
    let args = [];
    const api = { bind(...values) { args = values; return api; }, async first() { return stmt.get(...args) ?? null; }, async all() { return { results: stmt.all(...args) }; }, async run() { stmt.run(...args); return { success: true }; } };
    return api;
  } };
  const files = new Map([
    ["word-lists/catalog.json", { format: 1, updated: "top-old", extra: { stay: 1 }, lists: [row(), row("second"), { ...row("talk"), category: "speech", genres: [] }] }],
    ["public-books/catalog.json", { format: 1, updated: "public-old", packs: [{ ...row(), title: "Other catalog book" }] }],
  ]);
  const puts = [], gets = [];
  const metadata = new Map();
  const contents = new Map();
  const bytesOf = (key, value) => {
    const serialized = JSON.stringify(value);
    const stored = contents.get(key);
    return stored?.serialized === serialized ? stored.bytes : new TextEncoder().encode(serialized);
  };
  const etagOf = (bytes) => `"${createHash("sha256").update(bytes).digest("hex")}"`;
  let onGet;
  const BOOKS = {
    async get(key) {
      gets.push(key);
      onGet?.(key);
      const file = files.get(key);
      if (!file) return null;
      const bytes = bytesOf(key, file);
      const etag = etagOf(bytes);
      return { body: new Response(bytes).body, arrayBuffer: async () => bytes.buffer, size: bytes.length, etag, httpEtag: etag,
        httpMetadata: { contentType: "application/json", cacheControl: "no-cache" }, customMetadata: { owner: "catalog" }, ...metadata.get(key) };
    },
    async put(key, bytes, options = {}) {
      const current = files.get(key);
      const tag = current ? etagOf(bytesOf(key, current)) : null;
      if (options.onlyIf?.etagMatches && options.onlyIf.etagMatches !== tag) return null;
      if (options.onlyIf?.etagDoesNotMatch === "*" && current) return null;
      puts.push({ key, options });
      const value = JSON.parse(new TextDecoder().decode(bytes));
      files.set(key, value);
      contents.set(key, { serialized: JSON.stringify(value), bytes: bytes.slice() });
      metadata.set(key, { httpMetadata: options.httpMetadata, customMetadata: options.customMetadata });
      const etag = etagOf(bytes);
      return { etag, httpEtag: etag };
    },
  };
  const env = { DB, BOOKS };
  const call = (handler, body, cookie = true) => handler(new Request("https://example.test/api/admin/book-metadata", {
    method: handler === handleGet ? "GET" : handler === handlePublish ? "POST" : "PATCH", headers: cookie ? { cookie: "mw_session=test-token" } : {},
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  }), env, { now: NOW });
  const edit = async (changes, catalog = "word-lists") => {
    const books = (await (await call(handleGet)).json()).books;
    return call(handlePatch, { catalog, changes: changes.map((change) => ({ baseline: books.find((book) => book.catalog === catalog && book.id === change.id).baseline, ...change })) });
  };
  return { raw, env, files, puts, gets, sqlCalls, call, edit, setOnGet(fn) { onGet = fn; } };
}

function catalogParser(file, name) {
  const source = readFileSync(new URL(`../src/lib/${file}.ts`, import.meta.url), "utf8");
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  const stubs = {
    "@/lib/books-base": { booksUrl: (path) => `https://books.test/${path}` },
    "@/lib/book-genres": { readBookGenres },
    "@/lib/content-category": { readContentCategory: (value) => value === "speech" ? "speech" : "novel" },
    "@/lib/book-meta": { isbnDigits: () => "", readSeries: () => ({ series: "", seriesNumber: 0 }) },
    "@/lib/lexile": { lexileMeasure: () => "" },
    "@/lib/list-updated": { readUpdated: () => "" },
  };
  new Function("module", "exports", "require", js)(module, module.exports, (key) => stubs[key] ?? {});
  return module.exports[name];
}

test("both real catalog parsers keep old rows and tolerate unknown genres", () => {
  const parseLists = catalogParser("word-list-catalog", "parseWordListCatalog");
  const parsePublic = catalogParser("packs", "parseCatalog");
  for (const [parse, wrap, unwrap] of [[parseLists, (rows) => ({ lists: rows }), (value) => value], [parsePublic, (rows) => ({ packs: rows }), (value) => value.packs]]) {
    const before = row();
    delete before.genres;
    const parsed = unwrap(parse(wrap([before, { ...row("other"), genres: ["fantasy", "bad", "realistic", "realistic"] }])));
    assert.equal(parsed.length, 2);
    assert.deepEqual(parsed[0].genres, []);
    assert.deepEqual(parsed[1].genres, ["fantasy", "realistic"]);
  }
});

test("genre reads are tolerant while metadata edits are strict and bounded", () => {
  assert.deepEqual([...BOOK_GENRES], ["fantasy", "adventure", "mystery", "science-fiction", "realistic", "historical", "romance", "animals", "horror-thriller", "nonfiction"]);
  assert.deepEqual(readBookGenres(["fantasy", "bad", "fantasy", "adventure", "realistic", "mystery"]), ["fantasy", "adventure", "realistic"]);
  assert.deepEqual(readBookGenres(null), []);
  const valid = { catalog: "word-lists", changes: [{ id: "book", baseline, genres: [] }] };
  assert.ok(readBookMetadataRequest(valid));
  assert.ok(readBookMetadataRequest({ ...valid, changes: [{ id: "book", baseline, series: "", seriesNumber: 0 }] }));
  assert.ok(readBookMetadataRequest({ ...valid, changes: [{ id: "book", baseline, series: "Series", seriesNumber: 0 }] }));
  for (const change of [{ genres: ["bad"] }, { genres: ["fantasy", "fantasy"] }, { genres: BOOK_GENRES.slice(0, 4) }, { seriesNumber: -1 }, { series: "x".repeat(81) }, { series: "bad\nname" }, { updated: "today" }]) {
    assert.equal(readBookMetadataRequest({ ...valid, changes: [{ id: "book", baseline, ...change }] }), null);
  }
  assert.equal(readBookMetadataRequest({ ...valid, extra: true }), null);
  assert.equal(readBookMetadataRequest({ ...valid, changes: Array(61).fill(valid.changes[0]) }), null);
  assert.equal(readBookMetadataRequest({ ...valid, changes: [valid.changes[0], valid.changes[0]] }), null);
});

test("raw baselines distinguish absent, null and empty fields but ignore content-only changes", async () => {
  const original = { id: "book" };
  const refs = await Promise.all([original, { ...original, genres: [] }, { ...original, genres: null }, { ...original, series: "" }].map((value) => metadataRow("word-lists", value)));
  assert.equal(new Set(refs.map((value) => value.baseline)).size, 4);
  assert.equal(refs[0].baseline, (await metadataRow("word-lists", { ...original, glossary: { sha256: "new" }, updated: "new" })).baseline);
  assert.notEqual(refs[0].baseline, (await metadataRow("public-books", original)).baseline);
});

test("257 metadata rows use no per-row WebCrypto and speech genres are always empty", async () => {
  const f = await fixture();
  const digest = crypto.subtle.digest;
  let calls = 0;
  try {
    f.files.get("word-lists/catalog.json").lists = Array.from({ length: 256 }, (_, i) => ({ ...row(`book-${i}`), ...(i === 0 ? { category: "speech" } : {}) }));
    crypto.subtle.digest = function (...args) { calls++; return digest.apply(this, args); };
    const response = await f.call(handleGet);
    assert.equal(response.status, 200);
    const { books } = await response.json();
    assert.equal(books.length, 257);
    assert.deepEqual(books[0].genres, []);
    assert.equal(calls, 1, "only the real session token is hashed");
    assert.ok(books.every((book) => book.baseline.startsWith("m1:")));
  } finally { crypto.subtle.digest = digest; f.raw.close(); }
});

test("metadata GET and PATCH require the real admin session before any object access", async () => {
  for (const role of ["admin", "user"]) {
    const f = await fixture(role);
    try {
      for (const handler of [handleGet, handlePatch]) {
        assert.equal((await f.call(handler, undefined, false)).status, 401);
        if (role === "user") assert.equal((await f.call(handler)).status, 403);
      }
      assert.equal(f.gets.length, 0);
      assert.equal(f.puts.length, 0);
    } finally { f.raw.close(); }
  }
});

test("metadata patch holds the catalog lock and preserves every unrelated field and object metadata", async () => {
  const f = await fixture();
  try {
    const before = structuredClone(f.files.get("word-lists/catalog.json"));
    const publicBefore = structuredClone(f.files.get("public-books/catalog.json"));
    let lockedRead = false;
    f.setOnGet((key) => { if (key === "word-lists/catalog.json" && f.raw.prepare("SELECT COUNT(*) AS n FROM catalog_locks").get().n) lockedRead = true; });
    const response = await f.edit([{ id: "same", genres: ["adventure", "fantasy"], series: " New   Series " }]);
    assert.equal(response.status, 200);
    const result = (await response.json()).books[0];
    assert.equal(result.series, "New Series");
    assert.equal(result.seriesNumber, 2);
    const after = f.files.get("word-lists/catalog.json");
    const expected = structuredClone(before);
    expected.lists[0].genres = ["adventure", "fantasy"];
    expected.lists[0].series = "New Series";
    assert.deepEqual(after, expected);
    assert.deepEqual(f.files.get("public-books/catalog.json"), publicBefore);
    assert.equal(lockedRead, true);
    assert.equal(f.raw.prepare("SELECT COUNT(*) AS n FROM catalog_locks").get().n, 0);
    const baselineEtag = `"${createHash("sha256").update(JSON.stringify(before)).digest("hex")}"`;
    assert.deepEqual(f.puts, [{ key: "word-lists/catalog.json", options: { httpMetadata: { contentType: "application/json", cacheControl: "no-cache" }, customMetadata: { owner: "catalog" }, onlyIf: { etagMatches: baselineEtag } } }]);
    assert.equal(f.gets.every((key) => key.endsWith("catalog.json")), true);
  } finally { f.raw.close(); }
});

test("a held catalog lock returns catalog-busy without reading or writing the catalog", async () => {
  const f = await fixture();
  const dateNow = Date.now;
  try {
    const book = (await (await f.call(handleGet)).json()).books[0];
    f.raw.prepare("INSERT INTO catalog_locks (name,owner,expires_at) VALUES (?,?,?)").run("word-lists/catalog.json", "another-writer", Number.MAX_SAFE_INTEGER);
    f.gets.length = 0;
    let time = NOW;
    Date.now = () => (time += 16_000);
    const response = await f.call(handlePatch, { catalog: "word-lists", changes: [{ id: book.id, baseline: book.baseline, genres: ["realistic"] }] });
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { error: "catalog-busy" });
    assert.equal(f.gets.length, 0);
    assert.equal(f.puts.length, 0);
    assert.equal(f.raw.prepare("SELECT owner FROM catalog_locks").get().owner, "another-writer");
  } finally { Date.now = dateNow; f.raw.close(); }
});

test("same ids in two catalogs stay separate; no-op writes do not PUT", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.edit([{ id: "same", genres: ["fantasy"] }])).status, 200);
    assert.equal(f.puts.length, 0);
    assert.equal((await f.edit([{ id: "same", genres: ["realistic"] }], "public-books")).status, 200);
    assert.deepEqual(f.files.get("word-lists/catalog.json").lists[0].genres, ["fantasy"]);
    assert.deepEqual(f.files.get("public-books/catalog.json").packs[0].genres, ["realistic"]);
  } finally { f.raw.close(); }
});

test("all batch baselines and semantics are checked before any PUT", async () => {
  const f = await fixture();
  try {
    const before = structuredClone([...f.files]);
    const conflict = await f.edit([{ id: "same", genres: ["realistic"] }, { id: "second", baseline: 'm1:["stale"]', series: "Changed" }]);
    assert.equal(conflict.status, 409);
    assert.deepEqual(await conflict.json(), { error: "metadata-conflict", ids: ["second"] });
    assert.equal((await f.edit([{ id: "same", genres: ["realistic"] }, { id: "talk", genres: ["fantasy"] }])).status, 400);
    assert.equal((await f.call(handlePatch, { catalog: "word-lists", changes: [{ id: "missing", baseline, genres: [] }] })).status, 404);
    assert.equal(f.puts.length, 0);
    assert.deepEqual([...f.files], before);
    assert.equal(f.raw.prepare("SELECT COUNT(*) AS n FROM catalog_locks").get().n, 0);
  } finally { f.raw.close(); }
});

test("clearing series clears its number; number-only edits require a series; body validation has no writes", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.edit([{ id: "same", seriesNumber: 7 }])).status, 200);
    assert.equal((await f.edit([{ id: "same", seriesNumber: 0 }])).status, 200);
    assert.equal(f.files.get("word-lists/catalog.json").lists[0].series, "Full Series");
    assert.equal(f.files.get("word-lists/catalog.json").lists[0].seriesNumber, 0);
    assert.equal((await f.edit([{ id: "same", series: "New Series", seriesNumber: 0 }])).status, 200);
    assert.equal(f.files.get("word-lists/catalog.json").lists[0].seriesNumber, 0);
    assert.equal((await f.edit([{ id: "same", series: "", seriesNumber: 0, genres: [] }])).status, 200);
    const book = f.files.get("word-lists/catalog.json").lists[0];
    assert.equal(Object.hasOwn(book, "series"), false);
    assert.equal(Object.hasOwn(book, "seriesNumber"), false);
    assert.deepEqual(book.genres, []);
    const puts = f.puts.length;
    assert.equal((await f.edit([{ id: "same", seriesNumber: 3 }])).status, 400);
    for (const body of ["{broken", "x".repeat(32_001), { catalog: "elsewhere", changes: [] }, { catalog: "word-lists", changes: [{ id: "same", baseline, genres: [], glossary: {} }] }]) assert.equal((await f.call(handlePatch, body)).status, 400);
    assert.equal(f.puts.length, puts);
    const current = await metadataRow("word-lists", row());
    assert.equal(previewBookMetadata(current, { id: "same", baseline: current.baseline, series: "" }).seriesNumber, 0);
  } finally { f.raw.close(); }
});

test("legacy object series accepts number-only edits and explicit empty genres normalize bad raw tags", async () => {
  const source = { id: "legacy", series: { name: "Legacy Series", number: 2 }, genres: ["unknown"] };
  const current = await metadataRow("word-lists", source);
  applyMetadata(source, current, { id: source.id, baseline: current.baseline, series: "Legacy Series", seriesNumber: 4, genres: [] });
  assert.equal(source.series, "Legacy Series");
  assert.equal(source.seriesNumber, 4);
  assert.deepEqual(source.genres, []);
  assert.equal((await metadataRow("word-lists", source)).seriesNumber, 4);
  const orphan = { id: "orphan", seriesNumber: 7 };
  const orphanCurrent = metadataRow("word-lists", orphan);
  applyMetadata(orphan, orphanCurrent, { id: orphan.id, baseline: orphanCurrent.baseline, series: "", seriesNumber: 0 });
  assert.deepEqual(orphan, { id: "orphan" });
});

test("real word-list upload retains live genres when the uploaded glossary has no metadata tags", async () => {
  const f = await fixture();
  try {
    const response = await handlePublish(new Request("https://example.test/api/admin/word-lists?id=same", {
      method: "POST", headers: { cookie: "mw_session=test-token" },
      body: JSON.stringify({ title: "Example", glossary: { lantern: { meaning: "A light." } } }),
    }), f.env, { now: NOW });
    assert.equal(response.status, 200);
    assert.deepEqual(f.files.get("word-lists/catalog.json").lists[0].genres, ["fantasy"]);
  } finally { f.raw.close(); }
});

test("content publishers and retired helpers preserve live genres without reviving workflows", async () => {
  const original = row();
  const incoming = { ...row(), genres: undefined, glossary: { sha256: "d".repeat(64) } };
  delete incoming.genres;
  assert.deepEqual(mergeLive({ updated: "old", lists: [original] }, incoming).lists[0].genres, original.genres);
  assert.deepEqual(mergeRetired({ lists: [original] }, { ...incoming, genres: ["realistic"] }).lists[0].genres, original.genres);
  assert.deepEqual(mergePublicCatalog({ packs: [original] }, { ...incoming, genres: ["realistic"] }).packs[0].genres, original.genres);
  const publicRow = structuredClone(original);
  await updatePublicRow(publicRow, { title: "Example" }, { words: 12, paragraphs: 0, sentences: 0, phrases: 0, bytes: 9, sha256: "f".repeat(64) });
  assert.deepEqual(publicRow.genres, original.genres);
});
