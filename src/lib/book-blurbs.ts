import { useEffect, useState } from "react";
import { booksUrl } from "@/lib/books-base";
import type { Locale } from "@/lib/i18n";
import { blurbKey, parseBlurbFile, type BlurbKind, type BookBlurb } from "@/lib/book-blurb-file";

/**
 * Summaries read this session, by object key. A book with no file (404) is remembered as empty,
 * so reopening its sheet does not ask again. A failed read is forgotten and tried next time.
 */
const seen = new Map<string, Promise<BookBlurb>>();
const resolved = new Map<string, BookBlurb>();

function loadBlurb(kind: BlurbKind, id: string): Promise<BookBlurb> {
  const key = blurbKey(kind, id);
  const hit = resolved.get(key);
  if (hit) return Promise.resolve(hit);
  let blurb = seen.get(key);
  if (!blurb) {
    // no-cache: an edit in the admin shows up on the next open, as the catalogs do.
    blurb = fetch(booksUrl(key), { cache: "no-cache" })
      .then((response) => {
        if (response.status === 404) return { zh: "", en: "" };
        if (!response.ok) throw new Error("blurb");
        // A host that answers a missing file with a page (status 200, HTML) means "no summary" too,
        // not a failure to retry on every open. Not "must be JSON": the books host sends files
        // written by the admin with no content type at all.
        if (/html/i.test(response.headers.get("content-type") ?? "")) return { zh: "", en: "" };
        return response.json().then(parseBlurbFile);
      })
      .then((value) => {
        resolved.set(key, value);
        return value;
      })
      .catch(() => {
        seen.delete(key);
        return { zh: "", en: "" };
      });
    seen.set(key, blurb);
  }
  return blurb;
}

/** Warm a summary into memory ahead of time (for example, upcoming carousel slides). */
export function preloadBookBlurb(kind: BlurbKind, id: string): void {
  if (kind && id) void loadBlurb(kind, id);
}

/** Forget a cached summary, so the admin sees a save at once. */
export function forgetBlurb(kind: BlurbKind, id: string): void {
  const key = blurbKey(kind, id);
  seen.delete(key);
  resolved.delete(key);
}

/**
 * The summary of one book in the interface language, or "" while it loads and when there is none.
 * There is no fallback to the other language: a Chinese screen shows Chinese or nothing.
 */
export function useBookBlurb(book: { kind: BlurbKind; id: string } | null, locale: Locale): string {
  const kind = book?.kind;
  const id = book?.id;
  const key = kind && id ? blurbKey(kind, id) : "";
  const cached = key ? resolved.get(key) : undefined;
  const [loaded, setLoaded] = useState<{ key: string; value: BookBlurb } | null>(() =>
    cached ? { key, value: cached } : null,
  );
  useEffect(() => {
    if (!kind || !id || !key) return;
    const hit = resolved.get(key);
    if (hit) {
      setLoaded((prev) => (prev?.key === key && prev.value === hit ? prev : { key, value: hit }));
      return;
    }
    let alive = true;
    void loadBlurb(kind, id).then((value) => {
      if (alive) setLoaded({ key, value });
    });
    return () => {
      alive = false;
    };
  }, [kind, id, key]);
  if (!key) return "";
  if (cached) return cached[locale];
  return loaded?.key === key ? loaded.value[locale] : "";
}
