import { effectiveRole } from "../../../../lib/admin.ts";
import type { Env } from "../../../../lib/db.ts";
import { errorResponse, HttpError } from "../../../../lib/http.ts";
import type { HandlerOptions } from "../../../../lib/handlers.ts";
import { assertUserRateLimit } from "../../../../lib/rate-limit.ts";
import { requireUser } from "../../../../lib/session.ts";
import { shelfGrantsBook } from "../../../../lib/shelf-grant.ts";

/**
 * Protected L1 OEWN position mappings for one catalog book (`oewn-position-mappings-v1` or `v2`).
 *
 * Aligned with the weekly 7-book glossary cap (`GET /api/glossary/:id`):
 * - Requires a signed-in account.
 * - Trusted and admin accounts may read any book's mappings.
 * - Plain readers must have verified their email AND already unlocked this book (recorded in
 *   `glossary_reads` when installed via `/api/glossary/:id`, or covered by the pre-cap shelf
 *   snapshot via `shelfGrantsBook`). Reading mappings never spends or mints a weekly slot.
 * - Streams bytes directly from R2 with `ETag` / `If-None-Match` 304 support and zero JSON parsing.
 *
 *   GET /api/dictionary/positions/:catalog/:id
 */
export const onRequestGet = (context: {
  request: Request;
  env: Env;
  params: { catalog: string; id: string };
}) => handlePositionMappings(context.request, context.env, context.params.catalog, context.params.id);

function etagMatches(header: string | null, current: string): boolean {
  if (!header || !current) return false;
  const strip = (tag: string) => tag.trim().replace(/^W\//i, "");
  const want = strip(current);
  return header.split(",").some((part) => {
    const token = part.trim();
    return token === "*" || strip(token) === want;
  });
}

export async function handlePositionMappings(
  request: Request,
  env: Env,
  catalog: string,
  id: string,
  options?: HandlerOptions,
): Promise<Response> {
  try {
    const now = options?.now ?? Date.now();
    const user = await requireUser(env.DB, request, now);
    await assertUserRateLimit(env.DB, "glossary", user.id, now);
    if (catalog !== "word-lists" && catalog !== "public-books") throw new HttpError(400, "bad-catalog");
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id)) throw new HttpError(400, "bad-id");
    const bucket = env.BOOKS;
    if (!bucket) throw new HttpError(500, "no-books-bucket");

    const open = effectiveRole(user, now) !== "user";
    if (!open) {
      if (!user.email_verified_at) throw new HttpError(403, "email-unverified");
      const unlocked = await env.DB.prepare(
        "SELECT 1 AS yes FROM glossary_reads WHERE user_id = ? AND book_id = ? LIMIT 1",
      )
        .bind(user.id, id)
        .first<{ yes: number }>();
      if (!unlocked) {
        const granted = await shelfGrantsBook(env.DB, bucket, user.id, id);
        if (!granted) throw new HttpError(403, "book-not-unlocked");
      }
    }

    const object = await bucket.get(`dictionary/positions/${catalog}/${id}/mappings.json`);
    if (!object) throw new HttpError(404, "no-mappings");

    const etag = object.httpEtag || (object.etag ? `"${object.etag}"` : "");
    if (etag && etagMatches(request.headers.get("if-none-match"), etag)) {
      await object.body?.cancel?.().catch(() => undefined);
      return new Response(null, {
        status: 304,
        headers: {
          "cache-control": "private, max-age=300",
          etag,
          vary: "Cookie",
        },
      });
    }

    const headers: Record<string, string> = {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "private, max-age=300",
      vary: "Cookie",
    };
    if (etag) headers.etag = etag;
    if (typeof object.size === "number" && object.size >= 0) headers["content-length"] = String(object.size);
    return new Response(object.body, { status: 200, headers });
  } catch (error) {
    return errorResponse(error);
  }
}
