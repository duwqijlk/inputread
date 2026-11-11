/**
 * One writer at a time for each catalog file on the books host.
 *
 * A catalog is a single JSON file: a publish reads it, changes one row and writes all of it back.
 * Two publishes at the same moment would each write a copy that lacks the other's row. Each
 * writer holds this lock (a row in D1) from reading the catalog to writing it back, so a second
 * writer waits for the first instead of overwriting it.
 *
 * A lock left by a request that died ends by itself after LOCK_MS.
 */
import type { D1Database, R2BucketLike, R2ObjectLike, R2PutOptions } from "./db.ts";
import { PublicationError, withPublicationAudit, type PublicationReceipt } from "./publication-audit.ts";
import { HttpError } from "./http.ts";

export const CATALOG_LOCK_MS = 60_000;
const WAIT_MS = 15_000;
const STEP_MS = 250;

export type CatalogName = "word-lists/catalog.json" | "public-books/catalog.json";

/** Take the lock on `catalog`, waiting up to WAIT_MS for another writer to finish. */
async function lock(db: D1Database, catalog: CatalogName, owner: string, now: () => number): Promise<void> {
  const deadline = now() + WAIT_MS;
  for (;;) {
    const at = now();
    // One statement: take a free or expired lock, never one another writer holds.
    const taken = await db
      .prepare(
        `INSERT INTO catalog_locks (name, owner, expires_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(name) DO UPDATE SET owner = excluded.owner, expires_at = excluded.expires_at
           WHERE catalog_locks.expires_at <= ?4
         RETURNING owner`,
      )
      .bind(catalog, owner, at + CATALOG_LOCK_MS, at)
      .first<{ owner: string }>();
    if (taken?.owner === owner) return;
    if (now() >= deadline) throw new HttpError(409, "catalog-busy");
    await new Promise((resolve) => setTimeout(resolve, STEP_MS));
  }
}

async function unlock(db: D1Database, catalog: CatalogName, owner: string): Promise<void> {
  await db.prepare("DELETE FROM catalog_locks WHERE name = ? AND owner = ?").bind(catalog, owner).run();
}

type FileWrite = { key: string; bytes: Uint8Array; options?: Omit<R2PutOptions, "onlyIf"> };
type ObjectVersion = Pick<R2ObjectLike, "etag" | "httpEtag" | "httpMetadata" | "customMetadata">;

/** R2 onlyIf accepts an entity tag; use its HTTP form when available. Missing is not absent. */
export function objectEtag(object: ObjectVersion): string {
  const etag = object.httpEtag || object.etag;
  if (!etag || etag === "*" || etag.startsWith("W/")) throw new PublicationError("publication-etag-required", "conflict");
  return etag;
}

function objectOptions(object: ObjectVersion | null): Omit<R2PutOptions, "onlyIf"> {
  return {
    ...(object?.httpMetadata ? { httpMetadata: object.httpMetadata } : {}),
    ...(object?.customMetadata ? { customMetadata: object.customMetadata } : {}),
  };
}

/** A single real R2 CAS. A throw is an unknown commit, unlike R2's null precondition result. */
export async function putIfCurrent(
  bucket: R2BucketLike,
  key: string,
  bytes: Uint8Array,
  baseline: ObjectVersion | null,
  options?: Omit<R2PutOptions, "onlyIf">,
): Promise<string> {
  const onlyIf = baseline ? { etagMatches: objectEtag(baseline) } : { etagDoesNotMatch: "*" };
  let result: unknown;
  try {
    result = await bucket.put(key, bytes, { ...objectOptions(baseline), ...options, onlyIf });
  } catch {
    throw new PublicationError("publication-uncertain", "uncertain", [key]);
  }
  if (result === null) throw new PublicationError("publication-conflict", "conflict", [key]);
  try {
    return objectEtag((result ?? {}) as ObjectVersion);
  } catch {
    // A successful-looking PUT without its version cannot authorize any rollback.
    throw new PublicationError("publication-uncertain", "uncertain", [key]);
  }
}

/** Readback is exact bytes, size, version and expected metadata, never a public cached response. */
export async function verifyPublication(
  bucket: R2BucketLike, key: string, bytes: Uint8Array, etag: string,
  options: Omit<R2PutOptions, "onlyIf">,
): Promise<void> {
  try {
    const current = await bucket.get(key);
    if (!current || objectEtag(current) !== etag || current.size !== bytes.byteLength) throw new Error("version");
    const stored = new Uint8Array(await current.arrayBuffer());
    if (stored.length !== bytes.length) throw new Error("bytes");
    for (let index = 0; index < bytes.length; index++) {
      if (stored[index] !== bytes[index]) throw new Error("bytes");
    }
    for (const [name, value] of Object.entries(options.httpMetadata ?? {})) {
      const actual = current.httpMetadata?.[name as keyof NonNullable<R2PutOptions["httpMetadata"]>];
      if (value instanceof Date ? !(actual instanceof Date) || value.getTime() !== actual.getTime() : actual !== value) throw new Error("metadata");
    }
    if (options.customMetadata) {
      const actual = current.customMetadata ?? {};
      if (Object.keys(actual).length !== Object.keys(options.customMetadata).length ||
        Object.entries(options.customMetadata).some(([name, value]) => actual[name] !== value)) throw new Error("metadata");
    }
  } catch {
    throw new PublicationError("publication-readback-uncertain", "uncertain", [key]);
  }
}

/** Single-object publishing shares audit and readback with catalog batches. */
export async function publishObject(
  bucket: R2BucketLike, key: string, bytes: Uint8Array, baseline: ObjectVersion | null,
  context: { db?: D1Database; actorId?: string; operation: string },
): Promise<void> {
  const receipt: PublicationReceipt = { actorId: context.actorId, baselineEtag: baseline ? objectEtag(baseline) : null };
  await withPublicationAudit(context.db, key, context.operation, async () => {
    receipt.newEtag = await putIfCurrent(bucket, key, bytes, baseline);
    await verifyPublication(bucket, key, bytes, receipt.newEtag, objectOptions(baseline));
  }, receipt);
}

/**
 * Targeted coverage: admin word-list/public-book batches use this helper; metadata/blurb use
 * publishObject. Blurb's baseline is server read-time only, not a client draft version. The D1 lock remains cooperative, not an R2 multi-object transaction.
 * Pass the EXACT catalog object used to build catalogBytes, never a newly fetched replacement.
 * Confirmed precondition failure restores only existing files, conditional on our own PUT ETag.
 * New files remain (R2 delete has no conditional version guard); unknown PUT results are retained
 * for readback/reconciliation, especially a catalog timeout that might already have committed.
 */
export async function publishWithCatalog(
  bucket: R2BucketLike,
  files: FileWrite[],
  catalog: CatalogName,
  catalogBytes: Uint8Array,
  context: { baseline: ObjectVersion | null; db?: D1Database; actorId?: string; operation?: string },
): Promise<void> {
  const receipt: PublicationReceipt = { actorId: context.actorId, baselineEtag: context.baseline ? objectEtag(context.baseline) : null };
  await withPublicationAudit(context.db, catalog, context.operation ?? "catalog-publish", async () => {
    if (files.length > 12 || new Set(files.map((file) => file.key)).size !== files.length || files.some((file) => file.key === catalog)) {
      throw new HttpError(400, "bad-publication-files");
    }
    const expected = context.baseline ? objectEtag(context.baseline) : null;
    const live = await bucket.get(catalog);
    if ((live ? objectEtag(live) : null) !== expected) throw new PublicationError("publication-conflict", "conflict", [catalog]);
    const before = [];
    // Snapshot ALL files and versions before the first side effect, including original metadata.
    for (const file of files) {
      const old = await bucket.get(file.key);
      if (old) objectEtag(old);
      before.push({ file, old, bytes: old ? new Uint8Array(await old.arrayBuffer()) : null });
    }
    const written: { snapshot: (typeof before)[number]; etag: string }[] = [];
    try {
      for (const snapshot of before) {
        const etag = await putIfCurrent(bucket, snapshot.file.key, snapshot.file.bytes, snapshot.old, snapshot.file.options);
        written.push({ snapshot, etag });
      }
      receipt.newEtag = await putIfCurrent(bucket, catalog, catalogBytes, context.baseline);
      for (const { snapshot, etag } of written) {
        await verifyPublication(bucket, snapshot.file.key, snapshot.file.bytes, etag, { ...objectOptions(snapshot.old), ...snapshot.file.options });
      }
      await verifyPublication(bucket, catalog, catalogBytes, receipt.newEtag, objectOptions(context.baseline));
    } catch (error) {
      if (!(error instanceof PublicationError) || error.publicationStatus !== "conflict") {
        // Never roll back files when the catalog might have landed. No automated retry.
        throw new PublicationError("publication-uncertain", "uncertain", [...written.map(({ snapshot }) => snapshot.file.key), ...(error instanceof PublicationError ? error.affectedKeys : [catalog])]);
      }
      const unrecovered: string[] = [];
      for (const { snapshot, etag } of written.reverse()) {
        if (!snapshot.old || snapshot.bytes === null) {
          unrecovered.push(snapshot.file.key);
          continue;
        }
        try {
          const restored = await putIfCurrent(bucket, snapshot.file.key, snapshot.bytes, { etag }, objectOptions(snapshot.old));
          await verifyPublication(bucket, snapshot.file.key, snapshot.bytes, restored, objectOptions(snapshot.old));
        } catch {
          unrecovered.push(snapshot.file.key);
        }
      }
      if (unrecovered.length) throw new PublicationError("publication-partial-recovery", "partial-recovery", unrecovered);
      throw error;
    }
  }, receipt);
}

/** Run `work` while holding the lock on `catalog`. The lock is released even when `work` throws. */
export async function withCatalogLock<T>(
  db: D1Database,
  catalog: CatalogName,
  work: () => Promise<T>,
  now: () => number = Date.now,
): Promise<T> {
  const owner = crypto.randomUUID();
  await lock(db, catalog, owner, now);
  try {
    return await work();
  } finally {
    await unlock(db, catalog, owner);
  }
}
