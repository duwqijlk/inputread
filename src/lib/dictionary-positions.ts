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
export type ChapterPositionMapping = Omit<PositionMapping, "positionKey"> & {
  positionKey?: string;
};

export type CompactPositionRowMeta = {
  /** Reader credits (max 3 unique 12-hex public IDs). */
  m?: string[];
  /** Per-row release override when different from book default. */
  r?: string;
  /** Per-row reviewedAt override when different from book default. */
  t?: number;
};

export type CompactPositionRow =
  | [paragraphIndex: number, offset: number, surface: string, senseIndex: number]
  | [paragraphIndex: number, offset: number, surface: string, senseIndex: number, meta: CompactPositionRowMeta];

export type CompactPositionMappingsV2 = {
  schema: "oewn-position-mappings-v2";
  catalogId: string;
  release: string;
  reviewedAt: number;
  senses: Array<[lemma: string, senseId: string]>;
  chapters: Record<
    string,
    {
      p: Record<string, string>;
      r: CompactPositionRow[];
    }
  >;
};

export type PositionMappingsCacheRecord = {
  text: string;
  etag?: string;
  savedAt: number;
};

export type PositionMappingsCacheAdapter = {
  load: (catalogId: string) => Promise<PositionMappingsCacheRecord | null>;
  save: (catalogId: string, record: PositionMappingsCacheRecord) => Promise<void>;
};

export const MAX_MAPPINGS_V1_BYTES = 192 * 1024;
export const MAX_MAPPINGS_V2_BYTES = 8 * 1024 * 1024;
const CACHE_FRESH_MS = 5 * 60 * 1000;
const PROTECTED_BOOKS_ORIGIN = "https://books.inputread.site/";
const HEX = /^[0-9a-f]{64}$/;
const RELEASE_RE = /^[a-z0-9][a-z0-9-]{0,79}$/;
const CREDIT_RE = /^[0-9a-f]{12}$/;

type StoredRow = Omit<PositionMapping, "positionKey"> & { positionKey?: string };
type ChapterIndex = {
  pHashes: Map<number, string>;
  byToken: Map<string, StoredRow>;
};
type BookMappingStore = {
  catalogId: string;
  byChapter: Map<string, ChapterIndex>;
  byParagraph: Map<string, StoredRow[]>;
  byPositionKey: Map<string, StoredRow>;
  rows: StoredRow[];
};

const chapterHashes = new WeakMap<object, Promise<string | null>>();
const books = new Map<string, Promise<BookMappingStore>>();
const revalidating = new Set<string>();
let cacheAdapter: PositionMappingsCacheAdapter | null = null;

function emptyStore(catalogId: string): BookMappingStore {
  return {
    catalogId,
    byChapter: new Map(),
    byParagraph: new Map(),
    byPositionKey: new Map(),
    rows: [],
  };
}

/** Register an optional persistent offline cache (e.g. IndexedDB `cibian-books` notes store). */
export function setPositionMappingsCache(adapter: PositionMappingsCacheAdapter | null): void {
  cacheAdapter = adapter;
}

/** Clear in-memory cached book mappings (e.g. after sign-in unlocks protected books). */
export function clearPositionMappingsMemoryCache(): void {
  books.clear();
  revalidating.clear();
}

export async function textSha256(text: string): Promise<string | null> {
  if (!globalThis.crypto?.subtle) return null;
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Exact parsed chapter fingerprint, not a catalog's possibly unverified EPUB hash. */
export async function dictionaryPosition(
  paragraphs: string[],
  paragraphIndex: number,
  offset: number,
  surface: string,
): Promise<DictionaryPosition | null> {
  const paragraph = paragraphs[paragraphIndex];
  if (
    typeof paragraph !== "string" ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !surface ||
    Array.from(paragraph).slice(offset, offset + Array.from(surface).length).join("") !== surface
  ) {
    return null;
  }
  let hash = chapterHashes.get(paragraphs);
  if (!hash) {
    hash = textSha256(JSON.stringify(paragraphs));
    chapterHashes.set(paragraphs, hash);
  }
  const [chapterSha256, paragraphSha256] = await Promise.all([hash, textSha256(paragraph)]);
  return chapterSha256 && paragraphSha256
    ? { chapterSha256, paragraphIndex, paragraphSha256, offset, surface }
    : null;
}

export function mappingPath(catalogId: string): string {
  if (!cleanCatalogRef(catalogId)) throw new Error("Invalid catalog identity");
  const [catalog, id] = catalogId.split(":");
  return `dictionary/positions/${catalog}/${id}/mappings.json`;
}

export function positionKey(catalogId: string, p: DictionaryPosition): Promise<string | null> {
  return textSha256(
    JSON.stringify([catalogId, p.chapterSha256, p.paragraphIndex, p.paragraphSha256, p.offset, p.surface]),
  );
}

function mappingFetchTarget(catalogId: string): { url: string; protectedApi: boolean } {
  const direct = booksUrl(mappingPath(catalogId));
  if (direct.startsWith(PROTECTED_BOOKS_ORIGIN)) {
    const [catalog, id] = catalogId.split(":");
    return {
      url: `/api/dictionary/positions/${encodeURIComponent(catalog!)}/${encodeURIComponent(id!)}`,
      protectedApi: true,
    };
  }
  return { url: direct, protectedApi: false };
}

function validateMatchedBy(matchedBy: unknown): string[] | undefined {
  if (matchedBy === undefined) return undefined;
  if (
    !Array.isArray(matchedBy) ||
    matchedBy.length > 3 ||
    matchedBy.some((id: unknown) => typeof id !== "string" || !CREDIT_RE.test(id)) ||
    new Set(matchedBy).size !== matchedBy.length
  ) {
    throw new Error("Invalid match credit");
  }
  return matchedBy;
}

function addRowToStore(store: BookMappingStore, row: StoredRow): void {
  store.rows.push(row);
  if (row.positionKey) store.byPositionKey.set(row.positionKey, row);
  let ch = store.byChapter.get(row.chapterSha256);
  if (!ch) {
    ch = { pHashes: new Map(), byToken: new Map() };
    store.byChapter.set(row.chapterSha256, ch);
  }
  ch.pHashes.set(row.paragraphIndex, row.paragraphSha256);
  ch.byToken.set(`${row.paragraphIndex}:${row.offset}:${row.surface}`, row);
  let byPara = store.byParagraph.get(row.paragraphSha256);
  if (!byPara) {
    byPara = [];
    store.byParagraph.set(row.paragraphSha256, byPara);
  }
  byPara.push(row);
}

export function parsePositionMappingsText(
  catalogId: string,
  text: string,
  headerContentLength = 0,
): BookMappingStore {
  const byteLen = new TextEncoder().encode(text).length;
  const effectiveBytes = Math.max(byteLen, Number.isFinite(headerContentLength) ? headerContentLength : 0);
  if (effectiveBytes > MAX_MAPPINGS_V2_BYTES) throw new Error("Mapping file too large");
  const raw = JSON.parse(text);
  if (!raw || typeof raw !== "object" || raw.catalogId !== catalogId) {
    throw new Error("Mapping identity mismatch");
  }

  const store = emptyStore(catalogId);

  if (raw.schema === "oewn-position-mappings-v1") {
    if (effectiveBytes > MAX_MAPPINGS_V1_BYTES) throw new Error("Mapping file too large");
    if (!Array.isArray(raw.entries)) throw new Error("Mapping identity mismatch");
    const seen = new Set<string>();
    for (const item of raw.entries) {
      if (
        !item ||
        !HEX.test(item.chapterSha256) ||
        !HEX.test(item.paragraphSha256) ||
        !HEX.test(item.positionKey) ||
        !Number.isSafeInteger(item.paragraphIndex) ||
        item.paragraphIndex < 0 ||
        !Number.isSafeInteger(item.offset) ||
        item.offset < 0 ||
        typeof item.surface !== "string" ||
        !item.surface ||
        typeof item.senseId !== "string" ||
        !item.senseId ||
        typeof item.lemma !== "string" ||
        !item.lemma ||
        typeof item.release !== "string" ||
        !RELEASE_RE.test(item.release) ||
        !Number.isSafeInteger(item.reviewedAt) ||
        item.reviewedAt <= 0 ||
        seen.has(item.positionKey)
      ) {
        throw new Error("Invalid mapping row");
      }
      const matchedBy = validateMatchedBy(item.matchedBy);
      seen.add(item.positionKey);
      addRowToStore(store, {
        positionKey: item.positionKey,
        chapterSha256: item.chapterSha256,
        paragraphIndex: item.paragraphIndex,
        paragraphSha256: item.paragraphSha256,
        offset: item.offset,
        surface: item.surface,
        senseId: item.senseId,
        lemma: item.lemma,
        release: item.release,
        reviewedAt: item.reviewedAt,
        ...(matchedBy !== undefined ? { matchedBy } : {}),
      });
    }
    return store;
  }

  if (raw.schema === "oewn-position-mappings-v2") {
    if (
      typeof raw.release !== "string" ||
      !RELEASE_RE.test(raw.release) ||
      !Number.isSafeInteger(raw.reviewedAt) ||
      raw.reviewedAt <= 0 ||
      !Array.isArray(raw.senses) ||
      !raw.chapters ||
      typeof raw.chapters !== "object" ||
      Array.isArray(raw.chapters)
    ) {
      throw new Error("Mapping identity mismatch");
    }
    const senses: Array<[string, string]> = [];
    for (const pair of raw.senses) {
      if (
        !Array.isArray(pair) ||
        pair.length !== 2 ||
        typeof pair[0] !== "string" ||
        !pair[0] ||
        typeof pair[1] !== "string" ||
        !pair[1]
      ) {
        throw new Error("Invalid mapping row");
      }
      senses.push([pair[0], pair[1]]);
    }
    for (const [chHash, chObj] of Object.entries(raw.chapters as Record<string, unknown>)) {
      if (
        !HEX.test(chHash) ||
        !chObj ||
        typeof chObj !== "object" ||
        Array.isArray(chObj)
      ) {
        throw new Error("Invalid mapping row");
      }
      const ch = chObj as { p?: unknown; r?: unknown };
      if (!ch.p || typeof ch.p !== "object" || Array.isArray(ch.p) || !Array.isArray(ch.r)) {
        throw new Error("Invalid mapping row");
      }
      const pHashes = new Map<number, string>();
      for (const [pKey, pHash] of Object.entries(ch.p as Record<string, unknown>)) {
        const pIdx = Number(pKey);
        if (
          !/^(0|[1-9]\d*)$/.test(pKey) ||
          !Number.isSafeInteger(pIdx) ||
          typeof pHash !== "string" ||
          !HEX.test(pHash)
        ) {
          throw new Error("Invalid mapping row");
        }
        pHashes.set(pIdx, pHash);
      }
      const seenCoords = new Set<string>();
      for (const tuple of ch.r) {
        if (!Array.isArray(tuple) || (tuple.length !== 4 && tuple.length !== 5)) {
          throw new Error("Invalid mapping row");
        }
        const [pIdx, offset, surface, senseIdx, meta] = tuple as [
          unknown,
          unknown,
          unknown,
          unknown,
          unknown,
        ];
        if (
          typeof pIdx !== "number" ||
          !Number.isSafeInteger(pIdx) ||
          pIdx < 0 ||
          typeof offset !== "number" ||
          !Number.isSafeInteger(offset) ||
          offset < 0 ||
          typeof surface !== "string" ||
          !surface ||
          typeof senseIdx !== "number" ||
          !Number.isSafeInteger(senseIdx) ||
          senseIdx < 0 ||
          senseIdx >= senses.length
        ) {
          throw new Error("Invalid mapping row");
        }
        const pHash = pHashes.get(pIdx);
        if (!pHash) throw new Error("Invalid mapping row");
        const coordKey = `${pIdx}:${offset}:${surface}`;
        if (seenCoords.has(coordKey)) throw new Error("Invalid mapping row");
        seenCoords.add(coordKey);

        let release: string = raw.release;
        let reviewedAt: number = raw.reviewedAt;
        let matchedBy: string[] | undefined;
        if (meta !== undefined) {
          if (!meta || typeof meta !== "object" || Array.isArray(meta)) throw new Error("Invalid mapping row");
          const m = meta as CompactPositionRowMeta;
          if (m.r !== undefined) {
            if (typeof m.r !== "string" || !RELEASE_RE.test(m.r)) throw new Error("Invalid mapping row");
            release = m.r;
          }
          if (m.t !== undefined) {
            if (typeof m.t !== "number" || !Number.isSafeInteger(m.t) || m.t <= 0) {
              throw new Error("Invalid mapping row");
            }
            reviewedAt = m.t;
          }
          matchedBy = validateMatchedBy(m.m);
        }
        const [lemma, senseId] = senses[senseIdx]!;
        addRowToStore(store, {
          chapterSha256: chHash,
          paragraphIndex: pIdx,
          paragraphSha256: pHash,
          offset,
          surface,
          senseId,
          lemma,
          release,
          reviewedAt,
          ...(matchedBy !== undefined ? { matchedBy } : {}),
        });
      }
    }
    return store;
  }

  throw new Error("Mapping identity mismatch");
}

async function fetchStore(
  catalogId: string,
  etag?: string,
): Promise<{ status: "ok"; store: BookMappingStore; text: string; etag?: string } | { status: "not-modified" } | { status: "empty"; cacheable: boolean }> {
  const { url, protectedApi } = mappingFetchTarget(catalogId);
  const headers: Record<string, string> = {};
  if (etag) headers["if-none-match"] = etag;
  const init: RequestInit | undefined =
    protectedApi || etag
      ? {
          ...(protectedApi ? { credentials: "same-origin" as const } : {}),
          ...(etag ? { headers } : {}),
        }
      : undefined;
  const response = init ? await fetch(url, init) : await fetch(url);
  if (response.status === 304) return { status: "not-modified" };
  if (response.status === 404) return { status: "empty", cacheable: true };
  if (protectedApi && (response.status === 401 || response.status === 403)) {
    return { status: "empty", cacheable: false };
  }
  if (!response.ok) throw new Error("Position mappings unavailable");
  const headerLen = Number(response.headers.get("content-length")) || 0;
  if (headerLen > MAX_MAPPINGS_V2_BYTES) throw new Error("Mapping file too large");
  const text = await response.text();
  const store = parsePositionMappingsText(catalogId, text, headerLen);
  const nextEtag = response.headers.get("etag") || undefined;
  return { status: "ok", store, text, etag: nextEtag };
}

function revalidateInBackground(catalogId: string, cached: PositionMappingsCacheRecord): void {
  if (!cacheAdapter || revalidating.has(catalogId)) return;
  revalidating.add(catalogId);
  const adapter = cacheAdapter;
  void fetchStore(catalogId, cached.etag)
    .then(async (res) => {
      if (res.status === "not-modified") {
        await adapter.save(catalogId, { ...cached, savedAt: Date.now() }).catch(() => undefined);
      } else if (res.status === "ok") {
        books.set(catalogId, Promise.resolve(res.store));
        await adapter
          .save(catalogId, { text: res.text, etag: res.etag, savedAt: Date.now() })
          .catch(() => undefined);
      }
    })
    .catch(() => undefined)
    .finally(() => {
      revalidating.delete(catalogId);
    });
}

/** One shared mapping load per book, served via protected API in production with optional offline IDB cache. */
function loadStore(catalogId: string): Promise<BookMappingStore> {
  if (!cleanCatalogRef(catalogId)) return Promise.resolve(emptyStore(""));
  let pending = books.get(catalogId);
  if (!pending) {
    const adapter = cacheAdapter;
    if (!adapter) {
      pending = fetchStore(catalogId).then((res) => {
        if (res.status === "ok") return res.store;
        if (res.status === "empty") {
          if (!res.cacheable && books.get(catalogId) === pending) books.delete(catalogId);
          return emptyStore(catalogId);
        }
        return emptyStore(catalogId);
      });
    } else {
      pending = (async () => {
        const cached = await adapter.load(catalogId).catch(() => null);
        if (cached?.text) {
          try {
            const parsed = parsePositionMappingsText(catalogId, cached.text);
            if (Date.now() - cached.savedAt >= CACHE_FRESH_MS) {
              revalidateInBackground(catalogId, cached);
            }
            return parsed;
          } catch {
            // Corrupt cache entry: ignore and re-fetch cleanly.
          }
        }
        const res = await fetchStore(catalogId);
        if (res.status === "ok") {
          void adapter
            .save(catalogId, { text: res.text, etag: res.etag, savedAt: Date.now() })
            .catch(() => undefined);
          return res.store;
        }
        if (res.status === "empty" && !res.cacheable && books.get(catalogId) === pending) {
          books.delete(catalogId);
        }
        return emptyStore(catalogId);
      })();
    }
    books.set(catalogId, pending);
    if (books.size > 16) books.delete(books.keys().next().value!);
    void pending.catch(() => {
      if (books.get(catalogId) === pending) books.delete(catalogId);
    });
  }
  return pending;
}

async function materializeMapping(catalogId: string, row: StoredRow, knownKey?: string | null): Promise<PositionMapping | null> {
  const key = row.positionKey ?? knownKey ?? (await positionKey(catalogId, row));
  if (!key) return null;
  return {
    positionKey: key,
    chapterSha256: row.chapterSha256,
    paragraphIndex: row.paragraphIndex,
    paragraphSha256: row.paragraphSha256,
    offset: row.offset,
    surface: row.surface,
    senseId: row.senseId,
    lemma: row.lemma,
    release: row.release,
    reviewedAt: row.reviewedAt,
    ...(row.matchedBy !== undefined ? { matchedBy: row.matchedBy } : {}),
  };
}

/** Best-effort prewarm: failures remain retryable, without background retries. */
export async function warmDictionaryMappings(catalogId: string): Promise<void> {
  try {
    await loadStore(catalogId);
  } catch {
    /* A later lookup can retry. */
  }
}

/**
 * O(1) per-chapter L1 mapping lookup (`"${paragraphIndex}:${offset}:${surface}" -> ChapterPositionMapping`),
 * avoiding O(book) scans and upfront per-row hashing even on 100k-row books. Never throws.
 */
export async function loadChapterMappings(
  catalogId: string,
  paragraphs: readonly string[],
): Promise<{ hasBookMappings: boolean; byToken: Map<string, ChapterPositionMapping> }> {
  const byToken = new Map<string, ChapterPositionMapping>();
  if (!cleanCatalogRef(catalogId)) return { hasBookMappings: false, byToken };
  let store: BookMappingStore;
  let chHash: string | null;
  try {
    [store, chHash] = await Promise.all([
      loadStore(catalogId),
      paragraphs.length > 0 ? textSha256(JSON.stringify(paragraphs)) : Promise.resolve(null),
    ]);
  } catch {
    return { hasBookMappings: false, byToken };
  }
  const hasBookMappings = store.rows.length > 0;
  if (!hasBookMappings || !chHash) return { hasBookMappings, byToken };
  const chapter = store.byChapter.get(chHash);
  if (chapter) {
    for (const [tokenKey, row] of chapter.byToken) {
      byToken.set(tokenKey, row);
    }
    return { hasBookMappings, byToken };
  }
  // Cross-edition fallback: match unchanged paragraphs by paragraphSha256, failing closed on conflicting senses.
  const hashes = await Promise.all(paragraphs.map((p) => textSha256(p)));
  hashes.forEach((pHash, pIdx) => {
    if (!pHash) return;
    const rows = store.byParagraph.get(pHash);
    if (!rows || rows.length === 0) return;
    const byLocal = new Map<string, StoredRow[]>();
    for (const row of rows) {
      const k = `${pIdx}:${row.offset}:${row.surface}`;
      const list = byLocal.get(k) ?? [];
      list.push(row);
      byLocal.set(k, list);
    }
    for (const [k, group] of byLocal) {
      const first = group[0];
      if (!first) continue;
      if (group.some((r) => r.senseId !== first.senseId || r.lemma !== first.lemma)) continue;
      group.sort((a, b) => Math.abs(a.paragraphIndex - pIdx) - Math.abs(b.paragraphIndex - pIdx));
      byToken.set(k, group[0]!);
    }
  });
  return { hasBookMappings, byToken };
}

/**
 * O(1) per-chapter sense lookup map (`"${paragraphIndex}:${offset}:${surface}" -> senseId`). Never throws.
 */
export async function loadChapterSenseMap(
  catalogId: string,
  paragraphs: readonly string[],
): Promise<Map<string, string>> {
  const { byToken } = await loadChapterMappings(catalogId, paragraphs);
  const out = new Map<string, string>();
  for (const [k, row] of byToken) out.set(k, row.senseId);
  return out;
}

/** Read-only access to the cached book-level L1 position mappings (never throws). */
export async function loadBookMappings(catalogId: string): Promise<readonly PositionMapping[]> {
  if (!cleanCatalogRef(catalogId)) return [];
  try {
    const store = await loadStore(catalogId);
    const out: PositionMapping[] = [];
    for (const row of store.rows) {
      const mat = await materializeMapping(catalogId, row);
      if (mat) out.push(mat);
    }
    return out;
  } catch {
    return [];
  }
}

export async function mappedPosition(
  catalogId: string,
  position: DictionaryPosition,
): Promise<PositionMapping | null> {
  if (!cleanCatalogRef(catalogId)) return null;
  const [store, key] = await Promise.all([loadStore(catalogId), positionKey(catalogId, position)]);
  if (!key) return null;

  // Fast exact lookup: v1 checks stored positionKey directly; v2 checks O(1) chapter + token map.
  const byKey = store.byPositionKey.get(key);
  if (byKey) {
    return byKey.chapterSha256 === position.chapterSha256 &&
      byKey.paragraphIndex === position.paragraphIndex &&
      byKey.paragraphSha256 === position.paragraphSha256 &&
      byKey.offset === position.offset &&
      byKey.surface === position.surface
      ? materializeMapping(catalogId, byKey, key)
      : null;
  }
  const ch = store.byChapter.get(position.chapterSha256);
  if (ch) {
    const row = ch.byToken.get(`${position.paragraphIndex}:${position.offset}:${position.surface}`);
    if (row && !row.positionKey && row.paragraphSha256 === position.paragraphSha256) {
      return materializeMapping(catalogId, row, key);
    }
  }

  // Cross-edition fallback: when another EPUB edition alters a different paragraph in the chapter
  // (changing chapterSha256 and possibly shifting paragraphIndex), an unchanged paragraph still has
  // the exact same paragraphSha256 + code-point offset + surface. Require self-consistent row keys
  // and fail closed if identical paragraphs in the book map that token to different senses.
  const paraRows = store.byParagraph.get(position.paragraphSha256);
  if (!paraRows || paraRows.length === 0) return null;
  const candidates = paraRows.filter(
    (item) =>
      item.chapterSha256 !== position.chapterSha256 &&
      item.offset === position.offset &&
      item.surface === position.surface,
  );
  if (candidates.length === 0) return null;
  const verified: PositionMapping[] = [];
  for (const item of candidates) {
    const computed = await positionKey(catalogId, item);
    if (!computed) continue;
    if (item.positionKey && item.positionKey !== computed) continue;
    const mat = await materializeMapping(catalogId, item, computed);
    if (mat) verified.push(mat);
  }
  const first = verified[0];
  if (!first) return null;
  if (verified.some((item) => item.senseId !== first.senseId || item.lemma !== first.lemma)) return null;
  verified.sort((a, b) => Math.abs(a.paragraphIndex - position.paragraphIndex) - Math.abs(b.paragraphIndex - position.paragraphIndex));
  return verified[0] ?? null;
}
