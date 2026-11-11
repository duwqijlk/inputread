import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { PublicationError, withPublicationAudit } from "../functions/lib/publication-audit.ts";
import { publishObject, publishWithCatalog } from "../functions/lib/catalog-lock.ts";

const text = (value) => new TextEncoder().encode(value);
const key = "word-lists/catalog.json";
function database(fail = () => false) {
  const raw = new DatabaseSync(":memory:");
  raw.exec(readFileSync(new URL("../migrations/0028_publication_audit.sql", import.meta.url), "utf8"));
  return {
    raw,
    prepare(sql) {
      let args = [];
      const statement = {
        bind(...values) { args = values; return statement; },
        async run() { if (fail(sql)) throw new Error("database unavailable"); return raw.prepare(sql).run(...args); },
      };
      return statement;
    },
  };
}
function bucket() {
  const objects = new Map();
  let puts = 0;
  return {
    objects,
    get puts() { return puts; },
    async get(name) {
      const stored = objects.get(name);
      if (!stored) return null;
      return { ...stored, size: stored.bytes.length, body: new Blob([stored.bytes]).stream(), arrayBuffer: async () => stored.bytes.slice().buffer };
    },
    async put(name, value, options) {
      puts++;
      const old = objects.get(name);
      if (options?.onlyIf?.etagMatches && options.onlyIf.etagMatches !== old?.httpEtag && options.onlyIf.etagMatches !== old?.etag) return null;
      if (options?.onlyIf?.etagDoesNotMatch === "*" && old) return null;
      const bytes = new Uint8Array(value);
      const etag = createHash("sha256").update(bytes).digest("hex");
      const stored = { bytes, etag, httpEtag: `"${etag}"`, httpMetadata: options?.httpMetadata, customMetadata: options?.customMetadata };
      objects.set(name, stored);
      return stored;
    },
  };
}
const auditRow = (db) => db.raw.prepare("SELECT * FROM publication_audit").get();

test("migration bounds receipts and indexes object key/time without changing existing tables", () => {
  const db = database();
  assert(db.raw.prepare("PRAGMA index_list(publication_audit)").all().some((row) => row.name === "publication_audit_key_time"));
  assert.throws(() => db.raw.prepare("INSERT INTO publication_audit (id, object_key, operation, status, started_at) VALUES ('x', ?, 'publish', 'started', 0)").run("x".repeat(257)));
});

test("audit records actor, baseline and published R2 version after exact readback", async () => {
  const db = database();
  const b = bucket();
  await b.put(key, text("OLD"));
  const baseline = await b.get(key);
  await publishWithCatalog(b, [], key, text("NEW"), { baseline, db, actorId: "internal-admin-id" });
  const row = auditRow(db);
  assert.equal(row.status, "published");
  assert.equal(row.actor_id, "internal-admin-id");
  assert.equal(row.baseline_etag, baseline.httpEtag);
  assert.equal(row.new_etag, (await b.get(key)).httpEtag);
  assert(row.finished_at >= row.started_at);
  assert.equal(row.affected_keys, "[]");
});

test("audit insert failure prevents all object writes", async () => {
  const db = database(() => true);
  const b = bucket();
  await assert.rejects(publishObject(b, key, text("NEW"), null, { db, operation: "metadata" }),
    (error) => error.code === "publication-audit-unavailable");
  assert.equal(b.puts, 0);
});

test("terminal audit failure after a conflict retains original failure, never retries", async () => {
  const db = database((sql) => sql.includes("UPDATE"));
  let calls = 0;
  const original = new PublicationError("publication-conflict", "conflict", [key]);
  await assert.rejects(withPublicationAudit(db, key, "publish", async () => { calls++; throw original; }),
    (error) => error === original);
  assert.equal(calls, 1);
  assert.equal(auditRow(db).status, "started");
});

test("completion audit failure reports committed-uncertain, without retry or rollback", async () => {
  const db = database((sql) => sql.includes("SET status = 'published'"));
  const b = bucket();
  await assert.rejects(publishObject(b, key, text("NEW"), null, { db, operation: "metadata" }),
    (error) => error.code === "publication-committed-audit-failed" && error.publicationStatus === "committed-uncertain");
  assert.equal(b.puts, 1);
  assert.equal(new TextDecoder().decode(b.objects.get(key).bytes), "NEW");
  assert.equal(auditRow(db).status, "committed-uncertain");
  assert.equal(auditRow(db).new_etag, (await b.get(key)).httpEtag);
});

test("readback failure after catalog commit records uncertain and never restores content", async () => {
  const db = database();
  const b = bucket();
  const content = "word-lists/x/glossary.json";
  await b.put(key, text("OLD"));
  await b.put(content, text("OLD"));
  const baseline = await b.get(key);
  const get = b.get;
  b.get = async (name) => {
    if (b.puts >= 4 && name === content) throw new Error("readback failed");
    return get(name);
  };
  await assert.rejects(publishWithCatalog(b, [{ key: content, bytes: text("NEW") }], key, text("NEW"), { baseline, db }),
    (error) => error.publicationStatus === "uncertain");
  assert.equal(auditRow(db).status, "uncertain");
  assert(JSON.parse(auditRow(db).affected_keys).includes(content));
  assert.equal(b.puts, 4);
  assert.equal(new TextDecoder().decode(b.objects.get(content).bytes), "NEW");
});

for (const fault of ["missing", "bytes", "metadata", "version"]) {
  test(`single object readback ${fault} mismatch is not audited as success`, async () => {
    const db = database();
    const b = bucket();
    await b.put(key, text("OLD"), { httpMetadata: { contentType: "application/json", cacheControl: "no-cache" } });
    const baseline = await b.get(key);
    const get = b.get;
    b.get = async (name) => {
      const object = await get(name);
      if (b.puts < 2) return object;
      if (fault === "missing") return null;
      if (fault === "bytes") return { ...object, arrayBuffer: async () => text("BAD").buffer };
      if (fault === "metadata") return { ...object, httpMetadata: {} };
      return { ...object, httpEtag: '"other-version"' };
    };
    await assert.rejects(publishObject(b, key, text("NEW"), baseline, { db, operation: "metadata" }),
      (error) => error.code === "publication-readback-uncertain");
    assert.equal(auditRow(db).status, "uncertain");
    assert.equal(b.puts, 2);
  });
}

test("partial recovery receipt names the orphan without bodies or tokens", async () => {
  const db = database();
  const b = bucket();
  await b.put(key, text("OLD"));
  const baseline = await b.get(key);
  const content = "word-lists/x/glossary.json";
  const put = b.put;
  b.put = async (name, value, options) => name === key ? null : put(name, value, options);
  await assert.rejects(publishWithCatalog(b, [{ key: content, bytes: text("PRIVATE-CONTENT") }], key, text("NEW"), { baseline, db }),
    (error) => error.code === "publication-partial-recovery");
  const row = auditRow(db);
  assert.equal(row.status, "partial-recovery");
  assert.deepEqual(JSON.parse(row.affected_keys), [content]);
  assert(!JSON.stringify(row).includes("PRIVATE-CONTENT"));
});
