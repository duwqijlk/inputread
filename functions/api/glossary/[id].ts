import { effectiveRole } from "../../lib/admin.ts";
import type { Env } from "../../lib/db.ts";
import { errorResponse, HttpError, json } from "../../lib/http.ts";
import type { HandlerOptions } from "../../lib/handlers.ts";
import { assertUserRateLimit } from "../../lib/rate-limit.ts";
import { requireUser } from "../../lib/session.ts";
import { shelfGrantsBook } from "../../lib/shelf-grant.ts";
import { speechIds } from "../../lib/book-category.ts";
import { glossaryWeekReset, glossaryWeekStart, GLOSSARY_WEEK_BOOKS, GLOSSARY_WEEK_SPEECHES } from "../../lib/trust.ts";

/**
 * One word list, for a signed-in reader.
 * A plain reader may open 7 new novels and 7 new speeches each week. The week resets every
 * Monday at 00:00 China time, both counts together. A book already opened, or already on the
 * shelf before the cap, does not take another place.
 * Trusted and admin readers are not counted. A plain reader must have checked their email first.
 * There is no route that returns every list at once.
 *
 *   GET /api/glossary/:id
 *   DELETE /api/glossary/:id  (give back a place when the book never reached the shelf)
 */
export const onRequestGet = (context: { request: Request; env: Env; params: { id: string } }) =>
  handleGlossary(context.request, context.env, context.params.id);

export const onRequestDelete = (context: { request: Request; env: Env; params: { id: string } }) =>
  handleGlossaryRefund(context.request, context.env, context.params.id);

/**
 * A place is taken as soon as the list is served, before the reader's device has stored the book.
 * If the download or the local save then fails, the reader has no book to show for the place.
 * This gives a place taken moments ago back. A place the reader has had longer, and a book that
 * was already on the shelf before the cap (created_at 0), stays.
 */
export const GLOSSARY_REFUND_MS = 15 * 60 * 1000;

export async function handleGlossary(
  request: Request,
  env: Env,
  id: string,
  options?: HandlerOptions,
): Promise<Response> {
  try {
    const now = options?.now ?? Date.now();
    const user = await requireUser(env.DB, request, now);
    await assertUserRateLimit(env.DB, "glossary", user.id, now);
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id)) throw new HttpError(400, "bad-id");
    const bucket = env.BOOKS;
    if (!bucket) throw new HttpError(500, "no-books-bucket");
    const open = effectiveRole(user, now) !== "user";
    // A new account opens word lists only after it typed the code sent to its email: a free
    // account per made-up address was the cheap way around the weekly cap.
    if (!open && !user.email_verified_at) throw new HttpError(403, "email-unverified");
    // The list must exist before a place is taken: a missing book costs nothing.
    const object =
      (await bucket.get(`word-lists/${id}/glossary.json`)) ??
      (await bucket.get(`public-books/${id}/glossary.json`));
    if (!object) throw new HttpError(404, "no-list");
    let fresh = false;
    if (!open) {
      const place = await takePlace(env.DB, bucket, user.id, id, now);
      // A full week also says when the next place comes back, so the page can name the day.
      if (place.refused) return json(place.refused, 429);
      fresh = place.fresh;
    }
    let body: ArrayBuffer;
    try {
      body = await object.arrayBuffer();
    } catch (error) {
      // A place was taken for a file that cannot be read. Give back only the row this request
      // wrote: an older place for the same book, or a shelf grant (created_at 0), stays.
      if (fresh) {
        await env.DB.prepare(
          "DELETE FROM glossary_reads WHERE user_id = ? AND book_id = ? AND created_at = ?",
        )
          .bind(user.id, id, now)
          .run();
      }
      throw error;
    }
    return new Response(body, {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        "content-length": String(body.byteLength),
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function handleGlossaryRefund(
  request: Request,
  env: Env,
  id: string,
  options?: HandlerOptions,
): Promise<Response> {
  try {
    const now = options?.now ?? Date.now();
    const user = await requireUser(env.DB, request, now);
    await assertUserRateLimit(env.DB, "glossary", user.id, now);
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id)) throw new HttpError(400, "bad-id");
    // Only the oldest place taken moments ago can come back. A book kept for longer, or granted
    // by the shelf snapshot (created_at 0), is never returned by a failed download. If a retry
    // already took a newer place, that newer row stays.
    await env.DB.prepare(
      `DELETE FROM glossary_reads
        WHERE user_id = ?1 AND book_id = ?2
          AND created_at = (SELECT MIN(created_at) FROM glossary_reads
                             WHERE user_id = ?1 AND book_id = ?2 AND created_at > ?3)`,
    )
      .bind(user.id, id, now - GLOSSARY_REFUND_MS)
      .run();
    return json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}

type Refused = { error: "glossary-week" | "glossary-week-speech"; resetAt: number };

/** Whether this request wrote the place (`fresh`), so a body that cannot be read can return it. */
type Place = { refused: Refused | null; fresh: boolean };

/**
 * Give a plain reader this book's place, or say why not. `refused` null means the reader may have
 * the list.
 *
 * - A book opened before (on any device, in any week) is free again.
 * - A book on the shelf before the cap is free and is recorded outside the weekly count
 *   (created_at 0), so it never takes a place.
 * - Any other book takes a place. The place is written and the limit checked in ONE statement:
 *   the row goes in only while fewer than the limit of this kind (novel or speech) were opened in
 *   the current week. Requests sent at the same moment cannot all pass a count each read before
 *   any of them wrote (D1 runs one statement at a time).
 */
async function takePlace(
  db: Env["DB"],
  bucket: NonNullable<Env["BOOKS"]>,
  userId: string,
  bookId: string,
  now: number,
): Promise<Place> {
  const again = await db
    .prepare("SELECT 1 AS yes FROM glossary_reads WHERE user_id = ? AND book_id = ? LIMIT 1")
    .bind(userId, bookId)
    .first<{ yes: number }>();
  if (again) return { refused: null, fresh: false };
  if (await shelfGrantsBook(db, bucket, userId, bookId)) {
    await db
      .prepare(
        "INSERT INTO glossary_reads (user_id, book_id, created_at) SELECT ?1, ?2, 0 WHERE NOT EXISTS (SELECT 1 FROM glossary_reads WHERE user_id = ?1 AND book_id = ?2)",
      )
      .bind(userId, bookId)
      .run();
    return { refused: null, fresh: false };
  }
  const speeches = await speechIds(bucket);
  const isSpeech = speeches.has(bookId);
  const limit = isSpeech ? GLOSSARY_WEEK_SPEECHES : GLOSSARY_WEEK_BOOKS;
  const start = glossaryWeekStart(now);
  // ?4 is the list of speech ids; ?5 = 1 counts speeches, 0 counts every other book.
  const inserted = await db
    .prepare(
      `INSERT INTO glossary_reads (user_id, book_id, created_at)
       SELECT ?1, ?2, ?3
        WHERE NOT EXISTS (SELECT 1 FROM glossary_reads WHERE user_id = ?1 AND book_id = ?2)
          AND (SELECT COUNT(DISTINCT r.book_id) FROM glossary_reads r
                WHERE r.user_id = ?1 AND r.created_at >= ?6
                  AND ((r.book_id IN (SELECT value FROM json_each(?4))) = (?5 = 1))) < ?7
       RETURNING created_at`,
    )
    .bind(userId, bookId, now, JSON.stringify([...speeches]), isSpeech ? 1 : 0, start, limit)
    .first<{ created_at: number }>();
  if (inserted) return { refused: null, fresh: true };
  // Written by a request for the same book a moment ago: either way it is the reader's now.
  // Not there: the week was full when the statement ran. Both counts reset at the same time.
  const again2 = await db
    .prepare("SELECT 1 AS yes FROM glossary_reads WHERE user_id = ? AND book_id = ? LIMIT 1")
    .bind(userId, bookId)
    .first<{ yes: number }>();
  if (again2) return { refused: null, fresh: false };
  return {
    refused: isSpeech
      ? { error: "glossary-week-speech", resetAt: glossaryWeekReset(now) }
      : { error: "glossary-week", resetAt: glossaryWeekReset(now) },
    fresh: false,
  };
}
