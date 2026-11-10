import { booksUrl } from "@/lib/books-base";
import type { StandardSense } from "@/components/word-sense-panel";

export type DictionaryLookup =
  | { kind: "unmapped"; senses: StandardSense[] }
  | { kind: "ambiguous" }
  | { kind: "missing" }
  | { kind: "error" };

type Publication = { release: string; caseIndex?: string };
const RELEASE = /^[a-z0-9][a-z0-9-]{0,79}$/;
const CASE_INDEX = /^case-v1-[0-9a-f]{12}$/;
const MAX_ENTRY_BYTES = 192 * 1024;
const MAX_INDEX_BYTES = 192 * 1024;
const MAX_CACHED_WORDS = 64;
const CURRENT_TTL = 60_000;
let current: { request: Promise<Publication | null>; expires: number } | undefined;
const entries = new Map<string, Promise<DictionaryLookup>>();
const requests = new Map<string, Promise<DictionaryLookup>>();
const indexes = new Map<string, Promise<Record<string, string[]>>>();

function keyHex(lookupKey: string): string {
  const bytes = new TextEncoder().encode(lookupKey.normalize("NFC"));
  if (bytes.length === 0 || bytes.length > 240) throw new Error("Invalid dictionary lookup key");
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Lossless, case-preserving path; no stemming, slash splitting, or sense-ID guessing. */
export function dictionaryWordPath(release: string, lookupKey: string): string {
  if (!RELEASE.test(release)) throw new Error("Invalid dictionary release");
  const hex = keyHex(lookupKey);
  return `dictionary/releases/${release}/words/${hex.slice(0, 2)}/${hex}.json`;
}

/** Must match the index builder's locale-independent JavaScript lowercase and UTF-8 hash. */
export function dictionaryCaseShard(word: string): string {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(word.normalize("NFC").toLowerCase().normalize("NFC"))) {
    hash = Math.imul(hash ^ byte, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0").slice(0, 2);
}

async function jsonResponse(response: Response, max: number): Promise<unknown> {
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > max) throw new Error("Dictionary resource too large");
  const text = await response.text();
  if (new TextEncoder().encode(text).length > max) throw new Error("Dictionary resource too large");
  return JSON.parse(text) as unknown;
}

async function activeRelease(): Promise<Publication | null> {
  if (!current || Date.now() >= current.expires) {
    const request = fetch(booksUrl("dictionary/current.json"), { cache: "no-cache" })
      .then(async (response) => {
        if (response.status === 404) return null;
        if (!response.ok) throw new Error("Dictionary manifest unavailable");
        const raw = await jsonResponse(response, 4096);
        if (!raw || typeof raw !== "object") throw new Error("Invalid dictionary manifest");
        const manifest = raw as Record<string, unknown>;
        if (manifest.schema !== "oewn-r2-current-v1" || typeof manifest.release !== "string" || !RELEASE.test(manifest.release) ||
          (manifest.caseIndex !== undefined && (typeof manifest.caseIndex !== "string" || !CASE_INDEX.test(manifest.caseIndex)))) {
          throw new Error("Invalid dictionary manifest");
        }
        return { release: manifest.release, caseIndex: manifest.caseIndex as string | undefined };
      });
    current = { request, expires: Date.now() + CURRENT_TTL };
    void request.catch(() => { if (current?.request === request) current = undefined; });
  }
  return current.request;
}

function parseEntry(value: unknown, release: string, lookupKey: string): DictionaryLookup {
  if (!value || typeof value !== "object") throw new Error("Invalid dictionary entry");
  const entry = value as Record<string, unknown>;
  if (entry.schema !== "oewn-r2-entry-v1" || entry.release !== release || entry.lookupKey !== lookupKey || !Array.isArray(entry.senses)) {
    throw new Error("Dictionary entry identity mismatch");
  }
  const seen = new Set<string>();
  const senses: StandardSense[] = entry.senses.map((item: unknown) => {
    if (!item || typeof item !== "object") throw new Error("Invalid dictionary sense");
    const sense = item as Record<string, unknown>;
    if (typeof sense.id !== "string" || !sense.id || seen.has(sense.id) || typeof sense.pos !== "string" ||
      typeof sense.meaning !== "string" || !sense.meaning.trim() || typeof sense.originalMeaning !== "string" || !sense.originalMeaning.trim() ||
      (sense.learningMeaning !== undefined && typeof sense.learningMeaning !== "string")) {
      throw new Error("Invalid dictionary sense");
    }
    seen.add(sense.id);
    return { id: sense.id, pos: sense.pos, meaning: sense.meaning };
  });
  return senses.length ? { kind: "unmapped", senses } : { kind: "missing" };
}

function trimCache<T>(cache: Map<string, T>): void {
  if (cache.size > MAX_CACHED_WORDS) cache.delete(cache.keys().next().value!);
}

function exactEntry(release: string, lookupKey: string): Promise<DictionaryLookup> {
  const path = dictionaryWordPath(release, lookupKey);
  let pending = entries.get(path);
  if (!pending) {
    pending = fetch(booksUrl(path)).then(async (response): Promise<DictionaryLookup> => {
      if (response.status === 404) return { kind: "missing" };
      if (!response.ok) throw new Error("Dictionary entry unavailable");
      return parseEntry(await jsonResponse(response, MAX_ENTRY_BYTES), release, lookupKey);
    }).catch((): DictionaryLookup => ({ kind: "error" }));
    entries.set(path, pending);
    trimCache(entries);
    void pending.then((result) => {
      if (result.kind === "error" && entries.get(path) === pending) entries.delete(path);
    });
  }
  return pending;
}

async function caseCandidates(publication: Publication, word: string): Promise<string[]> {
  const shard = dictionaryCaseShard(word);
  const path = `dictionary/case-indexes/${publication.caseIndex}/${shard}.json`;
  let pending = indexes.get(path);
  if (!pending) {
    pending = fetch(booksUrl(path)).then(async (response) => {
      if (!response.ok) throw new Error("Dictionary case index unavailable");
      const raw = await jsonResponse(response, MAX_INDEX_BYTES);
      if (!raw || typeof raw !== "object") throw new Error("Invalid case index");
      const index = raw as Record<string, unknown>;
      if (index.schema !== "oewn-case-index-v1" || index.release !== publication.release || index.indexVersion !== publication.caseIndex || index.shard !== shard ||
        !index.entries || typeof index.entries !== "object" || Array.isArray(index.entries)) throw new Error("Case index identity mismatch");
      for (const [lower, candidates] of Object.entries(index.entries)) {
        if (lower !== lower.normalize("NFC").toLowerCase().normalize("NFC") || dictionaryCaseShard(lower) !== shard ||
          !Array.isArray(candidates) || candidates.length === 0 || new Set(candidates).size !== candidates.length) throw new Error("Invalid case group");
        for (const candidate of candidates) {
          if (typeof candidate !== "string" || candidate !== candidate.normalize("NFC") || candidate.toLowerCase().normalize("NFC") !== lower) throw new Error("Invalid case candidate");
          keyHex(candidate);
        }
      }
      return index.entries as Record<string, string[]>;
    });
    indexes.set(path, pending);
    trimCache(indexes);
    void pending.catch(() => { if (indexes.get(path) === pending) indexes.delete(path); });
  }
  const groups = await pending;
  const lower = word.toLowerCase().normalize("NFC");
  return Object.prototype.hasOwnProperty.call(groups, lower) ? groups[lower] : [];
}

/** Exact first. Only a unique source lemma may resolve a non-exact case variant. */
export async function lookupStandardWord(word: string): Promise<DictionaryLookup | null> {
  const lookupKey = word.normalize("NFC");
  try { keyHex(lookupKey); } catch { return { kind: "missing" }; }
  let publication: Publication | null;
  try { publication = await activeRelease(); } catch { return { kind: "error" }; }
  if (!publication) return null;
  const { release } = publication;
  const cacheKey = `${release}/${publication.caseIndex ?? "exact"}/${lookupKey}`;
  let pending = requests.get(cacheKey);
  if (!pending) {
    pending = (async (): Promise<DictionaryLookup> => {
      const exact = await exactEntry(release, lookupKey);
      if (exact.kind !== "missing" || !publication.caseIndex) return exact;
      const candidates = await caseCandidates(publication, lookupKey);
      if (candidates.length > 1) return { kind: "ambiguous" };
      if (candidates.length === 0) return { kind: "missing" };
      return exactEntry(release, candidates[0]);
    })().catch((): DictionaryLookup => ({ kind: "error" }));
    requests.set(cacheKey, pending);
    trimCache(requests);
    void pending.then((result) => { if (result.kind === "error" && requests.get(cacheKey) === pending) requests.delete(cacheKey); });
  }
  return pending;
}
