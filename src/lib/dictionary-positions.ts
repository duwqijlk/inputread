import { booksUrl } from "@/lib/books-base";
import { cleanCatalogRef } from "@/lib/catalog-id";

export type DictionaryPosition = {
  chapterSha256: string;
  paragraphIndex: number;
  paragraphSha256: string;
  offset: number;
  surface: string;
};
export type PositionMapping = DictionaryPosition & {
  positionKey: string;
  senseId: string;
  lemma: string;
  release: string;
  reviewedAt: number;
  matchedBy?: string[];
};
const HEX = /^[0-9a-f]{64}$/;
const chapterHashes = new WeakMap<object, Promise<string | null>>();
const books = new Map<string, Promise<PositionMapping[]>>();

export async function textSha256(text: string): Promise<string | null> {
  if (!globalThis.crypto?.subtle) return null;
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, "0")).join("");
}

/** Exact parsed chapter fingerprint, not a catalog's possibly unverified EPUB hash. */
export async function dictionaryPosition(paragraphs: string[], paragraphIndex: number, offset: number, surface: string): Promise<DictionaryPosition | null> {
  const paragraph = paragraphs[paragraphIndex];
  if (typeof paragraph !== "string" || !Number.isSafeInteger(offset) || offset < 0 || !surface ||
    Array.from(paragraph).slice(offset, offset + Array.from(surface).length).join("") !== surface) return null;
  let hash = chapterHashes.get(paragraphs);
  if (!hash) { hash = textSha256(JSON.stringify(paragraphs)); chapterHashes.set(paragraphs, hash); }
  const [chapterSha256, paragraphSha256] = await Promise.all([hash, textSha256(paragraph)]);
  return chapterSha256 && paragraphSha256 ? { chapterSha256, paragraphIndex, paragraphSha256, offset, surface } : null;
}

export function mappingPath(catalogId: string): string {
  if (!cleanCatalogRef(catalogId)) throw new Error("Invalid catalog identity");
  const [catalog, id] = catalogId.split(":");
  return `dictionary/positions/${catalog}/${id}/mappings.json`;
}
export function positionKey(catalogId: string, p: DictionaryPosition): Promise<string | null> {
  return textSha256(JSON.stringify([catalogId, p.chapterSha256, p.paragraphIndex, p.paragraphSha256, p.offset, p.surface]));
}

/** One shared static mapping file per book/page, independent of the number of thumbs or readers. */
function loadMappings(catalogId: string): Promise<PositionMapping[]> {
  if (!cleanCatalogRef(catalogId)) return Promise.resolve([]);
  let pending = books.get(catalogId);
  if (!pending) {
    pending = fetch(booksUrl(mappingPath(catalogId))).then(async response => {
      if (response.status === 404) return [];
      if (!response.ok) throw new Error("Position mappings unavailable");
      if (Number(response.headers.get("content-length")) > 192 * 1024) throw new Error("Mapping file too large");
      const text = await response.text();
      if (new TextEncoder().encode(text).length > 192 * 1024) throw new Error("Mapping file too large");
      const raw = JSON.parse(text);
      if (raw?.schema !== "oewn-position-mappings-v1" || raw.catalogId !== catalogId || !Array.isArray(raw.entries)) throw new Error("Mapping identity mismatch");
      const seen = new Set<string>();
      for (const item of raw.entries) {
        if (!item || !HEX.test(item.chapterSha256) || !HEX.test(item.paragraphSha256) || !HEX.test(item.positionKey) ||
          !Number.isSafeInteger(item.paragraphIndex) || item.paragraphIndex < 0 || !Number.isSafeInteger(item.offset) || item.offset < 0 ||
          typeof item.surface !== "string" || !item.surface || typeof item.senseId !== "string" || !item.senseId ||
          typeof item.lemma !== "string" || !item.lemma || typeof item.release !== "string" || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(item.release) ||
          !Number.isSafeInteger(item.reviewedAt) || item.reviewedAt <= 0 || seen.has(item.positionKey)) throw new Error("Invalid mapping row");
        if (item.matchedBy !== undefined && (!Array.isArray(item.matchedBy) || item.matchedBy.length > 3 || item.matchedBy.some((id: unknown) => typeof id !== "string" || !/^[0-9a-f]{12}$/.test(id)) || new Set(item.matchedBy).size !== item.matchedBy.length)) throw new Error("Invalid match credit");
        seen.add(item.positionKey);
      }
      return raw.entries as PositionMapping[];
    });
    books.set(catalogId, pending);
    if (books.size > 16) books.delete(books.keys().next().value!);
    void pending.catch(() => { if (books.get(catalogId) === pending) books.delete(catalogId); });
  }
  return pending;
}

/** Best-effort static prewarm: failures remain retryable, without background retries. */
export async function warmDictionaryMappings(catalogId: string): Promise<void> {
  try { await loadMappings(catalogId); } catch { /* A later lookup can retry. */ }
}

export async function mappedPosition(catalogId: string, position: DictionaryPosition): Promise<PositionMapping | null> {
  if (!cleanCatalogRef(catalogId)) return null;
  const [entries, key] = await Promise.all([loadMappings(catalogId), positionKey(catalogId, position)]);
  const row = entries.find(item => item.positionKey === key);
  if (row) {
    return row.chapterSha256 === position.chapterSha256 && row.paragraphIndex === position.paragraphIndex &&
      row.paragraphSha256 === position.paragraphSha256 && row.offset === position.offset && row.surface === position.surface ? row : null;
  }
  // Cross-edition fallback: when another EPUB edition alters a different paragraph in the chapter
  // (changing chapterSha256 and possibly shifting paragraphIndex), an unchanged paragraph still has
  // the exact same paragraphSha256 + code-point offset + surface. Require self-consistent row keys
  // and fail closed if identical paragraphs in the book map that token to different senses.
  const candidates = entries.filter(
    item =>
      item.chapterSha256 !== position.chapterSha256 &&
      item.paragraphSha256 === position.paragraphSha256 &&
      item.offset === position.offset &&
      item.surface === position.surface,
  );
  if (candidates.length === 0) return null;
  const verified: PositionMapping[] = [];
  for (const item of candidates) {
    if ((await positionKey(catalogId, item)) === item.positionKey) verified.push(item);
  }
  const first = verified[0];
  if (!first) return null;
  if (verified.some(item => item.senseId !== first.senseId || item.lemma !== first.lemma)) return null;
  verified.sort((a, b) => Math.abs(a.paragraphIndex - position.paragraphIndex) - Math.abs(b.paragraphIndex - position.paragraphIndex));
  return verified[0] ?? null;
}
