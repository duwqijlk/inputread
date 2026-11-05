import { checkAbort, requestScope } from "@/lib/cancel-work";
/**
 * Word lists on the public books host are fetched through the account API,
 * which counts seven distinct books per week for a plain reader with a checked email.
 * A list on any other host (local dev, a catalog the reader typed) stays a direct fetch.
 */
import { DEFAULT_BOOKS_BASE } from "@/lib/books-base";
import { tr } from "@/lib/i18n";
import { dayLabel, useGlossaryQuota } from "@/lib/glossary-quota";

const BOOKS_HOST = new URL(DEFAULT_BOOKS_BASE).hostname;

/** Book id when this address is a glossary on the public books host, else null. */
export function remoteGlossaryId(absoluteUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(absoluteUrl);
  } catch {
    return null;
  }
  if (url.hostname !== BOOKS_HOST) return null;
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length !== 3 || parts[2] !== "glossary.json") return null;
  if (parts[0] !== "word-lists" && parts[0] !== "public-books") return null;
  const id = parts[1] ?? "";
  return /^[a-z0-9][a-z0-9_-]{0,63}$/.test(id) ? id : null;
}

/** The bytes of one word list. `fallback` is for an unrecognized API error only. */
export async function fetchProtectedGlossary(
  bookId: string,
  fallback: string,
  signal?: AbortSignal,
  catalog?: "public-books" | "word-lists",
): Promise<Uint8Array> {
  const scope = requestScope(signal);
  try {
    return await scope.run(fetchProtectedGlossaryNow(bookId, fallback, scope.signal, catalog));
  } catch (error) {
    checkAbort(signal);
    if (scope.timedOut) throw new Error(tr("err.glossaryTimeout"));
    throw error;
  } finally { scope.dispose(); }
}

async function fetchProtectedGlossaryNow(bookId: string, fallback: string, signal?: AbortSignal, catalog?: "public-books" | "word-lists"): Promise<Uint8Array> {
  let response: Response;
  try {
    const query = catalog ? `?catalog=${catalog}` : "";
    response = await fetch(`/api/glossary/${encodeURIComponent(bookId)}${query}`, {
      credentials: "same-origin",
      cache: "no-store", signal,
    });
  } catch {
    checkAbort(signal);
    throw new Error(tr("err.glossaryNetwork"));
  }
  // The weekly count changed (a new place used) or the server refused one: show the new numbers.
  void useGlossaryQuota.getState().refresh(true);
  if (response.ok) {
    try {
      return new Uint8Array(await response.arrayBuffer());
    } catch {
      checkAbort(signal);
      throw new Error(tr("err.glossaryNetwork"));
    }
  }
  // These statuses are conclusive without reading a possibly stalled proxy error body.
  if (response.status === 401) throw new Error(tr("err.glossaryLogin"));
  if (response.status === 404) throw new Error(tr("err.glossaryMissing"));
  if (response.status >= 500) throw new Error(tr("err.glossaryServer"));
  let code = "";
  let resetAt = 0;
  // Only these responses need a body to distinguish account/quota errors from generic refusal.
  if (response.status === 403 || response.status === 429) {
    const details = requestScope(signal, 1500);
    let read = false;
    try {
      const body = (await details.run(response.json())) as { error?: unknown; resetAt?: unknown };
      read = true;
      code = typeof body.error === "string" ? body.error : "";
      resetAt = typeof body.resetAt === "number" && Number.isFinite(body.resetAt) ? body.resetAt : 0;
    } catch {
      checkAbort(signal);
    } finally {
      details.dispose();
      if (!read) void response.body?.cancel().catch(() => undefined);
    }
  }
  if (code === "glossary-week")
    throw new Error(resetAt ? tr("quota.fullNovel", { day: dayLabel(resetAt) }) : tr("err.glossaryWeek"));
  if (code === "glossary-week-speech")
    throw new Error(resetAt ? tr("quota.fullSpeech", { day: dayLabel(resetAt) }) : tr("err.glossaryWeekSpeech"));
  if (code === "email-unverified") throw new Error(tr("err.emailUnverified"));
  if (response.status === 429) throw new Error(tr("err.glossaryRate"));
  if (response.status === 403) throw new Error(tr("err.glossaryForbidden"));
  throw new Error(fallback);
}

/**
 * Give back a weekly place taken moments ago, when the list downloaded but the book never
 * reached the shelf. Best effort: offline the place stays, and the next try at this same book
 * is free anyway. The server ignores a place older than its short refund window.
 */
export async function refundGlossaryPlace(bookId: string): Promise<void> {
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), 8000);
  try {
    await fetch(`/api/glossary/${encodeURIComponent(bookId)}`, {
      method: "DELETE",
      credentials: "same-origin",
      cache: "no-store",
      keepalive: true,
      signal: stop.signal,
    });
  } catch {
    // Keep the place. A retry of the same book does not take another one.
  } finally {
    clearTimeout(timer);
    void useGlossaryQuota.getState().refresh(true);
  }
}
