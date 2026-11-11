import type { D1Database } from "./db.ts";
import { HttpError } from "./http.ts";

export type PublicationStatus = "published" | "failed" | "conflict" | "partial-recovery" | "uncertain" | "committed-uncertain";
export class PublicationError extends HttpError {
  readonly publicationStatus: PublicationStatus;
  readonly affectedKeys: string[];
  constructor(code: string, publicationStatus: PublicationStatus, affectedKeys: string[] = []) {
    super(409, code);
    this.publicationStatus = publicationStatus;
    this.affectedKeys = affectedKeys;
  }
}

export type PublicationReceipt = { actorId?: string; baselineEtag?: string | null; newEtag?: string };

/** No bytes, credentials, request bodies, emails or arbitrary exception messages are stored. */
export async function withPublicationAudit<T>(
  db: D1Database | undefined,
  key: string,
  operation: string,
  work: () => Promise<T>,
  receipt: PublicationReceipt = {},
): Promise<T> {
  // Only callers without a DB (isolated helper tests) may omit audit. Real handlers pass env.DB.
  if (!db) return work();
  if (!key.length || key.length > 256 || !/^[a-z][a-z0-9-]{0,47}$/.test(operation)) {
    throw new HttpError(500, "bad-publication-audit");
  }
  const id = crypto.randomUUID();
  try {
    await db.prepare(`INSERT INTO publication_audit (id, object_key, operation, status, started_at, actor_id, baseline_etag)
      VALUES (?, ?, ?, 'started', ?, ?, ?)`).bind(id, key, operation, Date.now(), receipt.actorId ?? null, receipt.baselineEtag ?? null).run();
  } catch {
    // Fail before any object writes if the migration/store is unavailable.
    throw new HttpError(503, "publication-audit-unavailable");
  }
  let result: T;
  try {
    result = await work();
  } catch (error) {
    const status = error instanceof PublicationError ? error.publicationStatus : "failed";
    const code = error instanceof HttpError ? error.code : "storage-error";
    try {
      const keys = error instanceof PublicationError ? error.affectedKeys : [];
      await db.prepare(`UPDATE publication_audit SET status = ?, finished_at = ?, error_code = ?, affected_keys = ?, new_etag = ? WHERE id = ?`)
        .bind(status, Date.now(), code.slice(0, 80), JSON.stringify(keys.slice(0, 13).map((key) => key.slice(0, 256))), receipt.newEtag ?? null, id).run();
    } catch {
      // Retain the started row and the original failure. Never turn a failed PUT into success,
      // and never retry work because a completion record failed.
      console.error("publication-audit-terminal-failed", id);
    }
    throw error;
  }
  try {
    await db.prepare(`UPDATE publication_audit SET status = 'published', finished_at = ?, new_etag = ? WHERE id = ?`)
      .bind(Date.now(), receipt.newEtag ?? null, id).run();
  } catch {
    // Objects already landed: do not roll back or silently retry the publication.
    try {
      await db.prepare(`UPDATE publication_audit SET status = 'committed-uncertain', finished_at = ?, new_etag = ?, error_code = 'publication-committed-audit-failed' WHERE id = ?`)
        .bind(Date.now(), receipt.newEtag ?? null, id).run();
    } catch { console.error("publication-audit-committed-uncertain", id); }
    throw new PublicationError("publication-committed-audit-failed", "committed-uncertain", [key]);
  }
  return result;
}
