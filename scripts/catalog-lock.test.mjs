import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { publishWithCatalog, withCatalogLock } from "../functions/lib/catalog-lock.ts";
import { preparePositional } from "./lib/sqlite-positional.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function openDb() {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(join(ROOT, "migrations", "0017_catalog_locks.sql"), "utf8"));
  const wrap = (sql) => {
    const stmt = preparePositional(db, sql);
    let args = [];
    const api = {
      bind(...values) { args = values; return api; },
      async first() { return stmt.get(...args) ?? null; },
      async all() { return { results: stmt.all(...args) }; },
      async run() { stmt.run(...args); return {}; },
    };
    return api;
  };
  return { prepare: wrap, async batch(list) { return Promise.all(list.map((s) => s.run())); }, raw: db };
}

const etag = (value) => value ? createHash("sha256").update(value).digest("hex") : null;
function bucket(failOn = new Set()) {
  const files = new Map();
  const metadata = new Map();
  const writes = [];
  return {
    files, metadata, writes,
    async get(key) {
      const value = files.get(key);
      if (!value) return null;
      const tag = etag(value);
      return { body: new Blob([value]).stream(), arrayBuffer: async () => value.slice().buffer, size: value.byteLength,
        etag: tag, httpEtag: `"${tag}"`, ...metadata.get(key) };
    },
    async put(key, value, options) {
      writes.push({ key, options });
      const matches = options?.onlyIf?.etagMatches?.replace(/^"|"$/g, "");
      if (failOn.has(key) || (matches && matches !== etag(files.get(key))) ||
        (options?.onlyIf?.etagDoesNotMatch === "*" && files.has(key))) return null;
      const bytes = typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value);
      files.set(key, bytes);
      metadata.set(key, { httpMetadata: options?.httpMetadata, customMetadata: options?.customMetadata });
      const tag = etag(bytes);
      return { etag: tag, httpEtag: `"${tag}"` };
    },
  };
}

const text = (value) => new TextEncoder().encode(value);
const read = (b, key) => new TextDecoder().decode(b.files.get(key));

test("two publishes at the same moment both keep their catalog row", async () => {
  const db = openDb();
  const b = bucket();
  b.files.set("word-lists/catalog.json", text(JSON.stringify({ lists: [] })));
  // Each one reads the catalog, waits (as a real request does between R2 calls), adds its row, writes.
  const publish = (id) =>
    withCatalogLock(db, "word-lists/catalog.json", async () => {
      const baseline = await b.get("word-lists/catalog.json");
      const live = JSON.parse(new TextDecoder().decode(await baseline.arrayBuffer()));
      await new Promise((r) => setTimeout(r, 20));
      live.lists.push({ id });
      await publishWithCatalog(b, [], "word-lists/catalog.json", text(JSON.stringify(live)), { baseline });
    });
  await Promise.all([publish("one"), publish("two"), publish("three")]);
  const ids = JSON.parse(read(b, "word-lists/catalog.json")).lists.map((row) => row.id).sort();
  assert.deepEqual(ids, ["one", "three", "two"], "no row was overwritten");
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM catalog_locks").get().n, 0, "the lock is released");
});

test("a lock left by a request that died ends by itself", async () => {
  const db = openDb();
  db.raw.prepare("INSERT INTO catalog_locks (name, owner, expires_at) VALUES ('word-lists/catalog.json', 'gone', ?)").run(Date.now() - 1);
  let ran = false;
  await withCatalogLock(db, "word-lists/catalog.json", async () => { ran = true; });
  assert.equal(ran, true);
});

test("a held lock that does not end refuses with catalog-busy, and the work does not run", async () => {
  const db = openDb();
  db.raw.prepare("INSERT INTO catalog_locks (name, owner, expires_at) VALUES ('word-lists/catalog.json', 'other', ?)").run(Date.now() + 60_000);
  let clock = Date.now();
  // A clock that jumps past the wait, so the test does not sleep 15 seconds.
  const now = () => (clock += 20_000);
  let ran = false;
  await assert.rejects(
    withCatalogLock(db, "word-lists/catalog.json", async () => { ran = true; }, now),
    (error) => error.code === "catalog-busy",
  );
  assert.equal(ran, false);
  assert.equal(db.raw.prepare("SELECT owner FROM catalog_locks").get().owner, "other", "the other writer keeps its lock");
});

test("a failed catalog write puts the old files back, so they match the catalog", async () => {
  const b = bucket(new Set(["word-lists/catalog.json"]));
  b.files.set("word-lists/x/glossary.json", text("OLD"));
  b.files.set("word-lists/catalog.json", text("CATALOG-OLD"));
  await assert.rejects(publishWithCatalog(b, [{ key: "word-lists/x/glossary.json", bytes: text("NEW") }], "word-lists/catalog.json", text("CATALOG-NEW"), { baseline: await b.get("word-lists/catalog.json") }), (error) => error.code === "publication-conflict");
  assert.equal(read(b, "word-lists/x/glossary.json"), "OLD");
  assert.equal(read(b, "word-lists/catalog.json"), "CATALOG-OLD");
});

test("a failed file write also puts back the files written before it", async () => {
  const b = bucket(new Set(["public-books/x/glossary.json"]));
  b.files.set("public-books/x/book.epub", text("OLD-EPUB"));
  await assert.rejects(
    publishWithCatalog(
      b,
      [
        { key: "public-books/x/book.epub", bytes: text("NEW-EPUB") },
        { key: "public-books/x/glossary.json", bytes: text("NEW-LIST") },
      ],
      "public-books/catalog.json",
      text("CATALOG-NEW"),
      { baseline: null },
    ),
  );
  assert.equal(read(b, "public-books/x/book.epub"), "OLD-EPUB");
  assert.equal(b.files.has("public-books/catalog.json"), false, "the catalog was never written");
});

const catalog = "word-lists/catalog.json";
const glossary = "word-lists/x/glossary.json";
const publish = (b, baseline, value = "NEW") => publishWithCatalog(b,
  [{ key: glossary, bytes: text(value) }], catalog, text(`CATALOG-${value}`), { baseline });

// No lock in these cases: emulate direct writers / expired leases with actual conditional PUTs.
test("two stale writers race on an existing catalog; exactly one commits", async () => {
  const b = bucket();
  b.files.set(catalog, text("OLD"));
  const baseline = await b.get(catalog);
  let ready = 0;
  let release;
  const barrier = new Promise((resolve) => { release = resolve; });
  const original = b.put;
  b.put = async (key, bytes, options) => {
    if (key === catalog) { if (++ready === 2) release(); await barrier; }
    return original(key, bytes, options);
  };
  const results = await Promise.allSettled(["ONE", "TWO"].map((value) =>
    publishWithCatalog(b, [], catalog, text(value), { baseline })));
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.find((result) => result.status === "rejected").reason.status, 409);
  assert(b.writes.every(({ options }) => options.onlyIf.etagMatches === baseline.httpEtag));
});

test("initial catalog creation uses if-none-match star, never clobbers a racing creator", async () => {
  const b = bucket();
  const put = b.put;
  b.put = async (key, bytes, options) => {
    if (key === catalog) b.files.set(key, text("OTHER"));
    return put(key, bytes, options);
  };
  await assert.rejects(publishWithCatalog(b, [], catalog, text("NEW"), { baseline: null }),
    (error) => error.code === "publication-conflict");
  assert.equal(read(b, catalog), "OTHER");
  assert.deepEqual(b.writes[0].options.onlyIf, { etagDoesNotMatch: "*" });
});

test("stale merged catalog is refused before writing content", async () => {
  const b = bucket();
  b.files.set(catalog, text("OLD"));
  const baseline = await b.get(catalog);
  b.files.set(catalog, text("OTHER"));
  await assert.rejects(publish(b, baseline), (error) => error.code === "publication-conflict");
  assert.equal(b.writes.length, 0);
});

test("existing content CAS rejects a direct writer after the snapshot", async () => {
  const b = bucket();
  b.files.set(catalog, text("OLD-CATALOG"));
  b.files.set(glossary, text("OLD"));
  const put = b.put;
  b.put = async (key, bytes, options) => {
    if (key === glossary) b.files.set(key, text("CONCURRENT"));
    return put(key, bytes, options);
  };
  await assert.rejects(publish(b, await b.get(catalog)), (error) => error.code === "publication-conflict");
  assert.equal(read(b, glossary), "CONCURRENT");
  assert.equal(read(b, catalog), "OLD-CATALOG");
});

test("rollback race refuses to overwrite a concurrent content edit", async () => {
  const b = bucket();
  b.files.set(catalog, text("OLD-CATALOG"));
  b.files.set(glossary, text("OLD"));
  const put = b.put;
  b.put = async (key, bytes, options) => {
    if (key === catalog) {
      b.files.set(catalog, text("OTHER-CATALOG"));
      b.files.set(glossary, text("CONCURRENT"));
    }
    return put(key, bytes, options);
  };
  await assert.rejects(publish(b, await b.get(catalog)), (error) => {
    assert.deepEqual(error.affectedKeys, [glossary]);
    return error.code === "publication-partial-recovery";
  });
  assert.equal(read(b, glossary), "CONCURRENT");
  assert.equal(read(b, catalog), "OTHER-CATALOG");
  const recovery = b.writes.at(-1);
  assert.equal(recovery.options.onlyIf.etagMatches.replaceAll('"', ''), etag(text("NEW")));
});

test("confirmed catalog conflict restores exact original metadata, not upload options", async () => {
  const b = bucket(new Set([catalog]));
  b.files.set(catalog, text("OLD-CATALOG"));
  b.files.set(glossary, text("OLD"));
  const metadata = { httpMetadata: { contentType: "application/json", cacheControl: "private", contentLanguage: "en" }, customMetadata: { source: "original" } };
  b.metadata.set(glossary, metadata);
  await assert.rejects(publishWithCatalog(b, [{ key: glossary, bytes: text("NEW"), options: { httpMetadata: { contentType: "text/plain" } } }],
    catalog, text("NEW-CATALOG"), { baseline: await b.get(catalog) }));
  assert.deepEqual(b.metadata.get(glossary), metadata);
  assert.equal(read(b, glossary), "OLD");
});

test("new content left by catalog conflict is an explicit orphan receipt, never deleted", async () => {
  const b = bucket(new Set([catalog]));
  b.files.set(catalog, text("OLD-CATALOG"));
  await assert.rejects(publish(b, await b.get(catalog)), (error) => {
    assert.deepEqual(error.affectedKeys, [glossary]);
    return error.code === "publication-partial-recovery";
  });
  assert.equal(read(b, glossary), "NEW");
  assert.deepEqual(b.writes[0].options.onlyIf, { etagDoesNotMatch: "*" });
});

test("catalog PUT that commits then throws does not restore old content", async () => {
  const b = bucket();
  b.files.set(catalog, text("OLD-CATALOG"));
  b.files.set(glossary, text("OLD"));
  const put = b.put;
  b.put = async (key, bytes, options) => {
    const result = await put(key, bytes, options);
    if (key === catalog) throw new Error("timeout after commit");
    return result;
  };
  await assert.rejects(publish(b, await b.get(catalog)), (error) => error.code === "publication-uncertain");
  assert.equal(read(b, glossary), "NEW");
  assert.equal(read(b, catalog), "CATALOG-NEW");
  assert.equal(b.writes.length, 2, "no blind retry or restoration");
});

test("existing objects without an ETag fail closed before writes", async () => {
  const b = bucket();
  const noTag = { arrayBuffer: async () => text("OLD").buffer, size: 3 };
  await assert.rejects(publish(b, noTag), (error) => error.code === "publication-etag-required");
  b.files.set(catalog, text("OLD-CATALOG"));
  const get = b.get;
  b.get = async (key) => key === glossary ? noTag : get(key);
  await assert.rejects(publish(b, await b.get(catalog)), (error) => error.code === "publication-etag-required");
  assert.equal(b.writes.length, 0);
});

test("rollback readback failure is explicit partial recovery even after restoration PUT", async () => {
  const b = bucket(new Set([catalog]));
  b.files.set(catalog, text("OLD-CATALOG"));
  b.files.set(glossary, text("OLD"));
  const get = b.get;
  b.get = async (key) => {
    if (key === glossary && b.writes.length >= 3) return null;
    return get(key);
  };
  await assert.rejects(publish(b, await b.get(catalog)), (error) => error.code === "publication-partial-recovery");
  assert.equal(read(b, glossary), "OLD", "PUT alone is not claimed as verified recovery");
});

test("raw R2 etag without optional httpEtag still supports real CAS", async () => {
  const b = bucket();
  b.files.set(catalog, text("OLD-CATALOG"));
  const get = b.get;
  const put = b.put;
  b.get = async (key) => {
    const value = await get(key);
    if (value) delete value.httpEtag;
    return value;
  };
  b.put = async (...args) => {
    const value = await put(...args);
    if (value) delete value.httpEtag;
    return value;
  };
  await publish(b, await b.get(catalog));
  assert.equal(read(b, catalog), "CATALOG-NEW");
});

test("successful readback checks bytes and original catalog metadata", async () => {
  const b = bucket();
  b.files.set(catalog, text("OLD-CATALOG"));
  b.metadata.set(catalog, { httpMetadata: { contentType: "application/json", cacheControl: "no-cache" }, customMetadata: { keep: "yes" } });
  await publish(b, await b.get(catalog));
  assert.equal(read(b, glossary), "NEW");
  assert.equal(read(b, catalog), "CATALOG-NEW");
  assert.equal(b.metadata.get(catalog).httpMetadata.cacheControl, "no-cache");
});
