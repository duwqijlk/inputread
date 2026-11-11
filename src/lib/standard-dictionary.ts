import { booksUrl } from "@/lib/books-base";
import type { StandardSense } from "@/components/word-sense-panel";

export type DictionaryLookup =
  | { kind: "unmapped"; senses: StandardSense[] }
  | { kind: "ambiguous" }
  | { kind: "missing" }
  | { kind: "error" };

type Publication = { release: string; caseIndex?: string; formsIndex?: string; wordsMutable?: true };
type FormCandidate = { lemma: string; pos: string };
const formIndexes = new Map<string, Promise<Record<string, FormCandidate[]>>>();
const FORMS_INDEX = /^forms-v1-[0-9a-f]{12}$/;
const RELEASE = /^[a-z0-9][a-z0-9-]{0,79}$/;
const CASE_INDEX = /^case-v1-[0-9a-f]{12}$/;
const MAX_ENTRY_BYTES = 192 * 1024;
const MAX_INDEX_BYTES = 192 * 1024;
const MAX_CACHED_WORDS = 64;
const CURRENT_TTL = 60_000;
let current: { request: Promise<Publication | null>; expires: number } | undefined;
const WORD_TTL = 60_000;
type EntryRequest = { request: Promise<DictionaryLookup>; expires: number };
const entries = new Map<string, EntryRequest>();
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
          (manifest.caseIndex !== undefined && (typeof manifest.caseIndex !== "string" || !CASE_INDEX.test(manifest.caseIndex))) ||
          (manifest.formsIndex !== undefined && (typeof manifest.formsIndex !== "string" || !FORMS_INDEX.test(manifest.formsIndex) || !manifest.caseIndex)) ||
          Object.prototype.hasOwnProperty.call(manifest, "wordBase") ||
          (manifest.wordsMutable !== undefined && manifest.wordsMutable !== true)) {
          throw new Error("Invalid dictionary manifest");
        }
        return { release: manifest.release, caseIndex: manifest.caseIndex as string | undefined, formsIndex: manifest.formsIndex as string | undefined, wordsMutable: manifest.wordsMutable as Publication["wordsMutable"] };
      });
    current = { request, expires: Date.now() + CURRENT_TTL };
    void request.catch(() => { if (current?.request === request) current = undefined; });
  }
  return current.request;
}

// OEWN stores POS codes; expose learner-facing names without rewriting source data.
const POS_NAMES: Readonly<Record<string, string>> = {
  n: "noun",
  v: "verb",
  a: "adjective",
  s: "adjective", // adjective satellite is still an adjective for the reader
  r: "adverb",
};

function parseEntry(value: unknown, publication: Publication, lookupKey: string): DictionaryLookup {
  if (!value || typeof value !== "object") throw new Error("Invalid dictionary entry");
  const entry = value as Record<string, unknown>;
  if (entry.schema !== "oewn-r2-entry-v1" || typeof entry.release !== "string" || !RELEASE.test(entry.release) ||
    (!publication.wordsMutable && entry.release !== publication.release) || entry.lookupKey !== lookupKey || !Array.isArray(entry.senses)) {
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
    const pos = sense.pos.trim();
    return { id: sense.id, pos: Object.prototype.hasOwnProperty.call(POS_NAMES, pos) ? POS_NAMES[pos] : pos, meaning: sense.meaning, source: { lemma: lookupKey, release: entry.release as string } };
  });
  return senses.length ? { kind: "unmapped", senses } : { kind: "missing" };
}

function trimCache<T>(cache: Map<string, T>): void {
  if (cache.size > MAX_CACHED_WORDS) cache.delete(cache.keys().next().value!);
}

function exactEntry(publication: Publication, lookupKey: string): Promise<DictionaryLookup> {
  const path = dictionaryWordPath(publication.release, lookupKey);
  const mutable = !!publication.wordsMutable;
  const entryCacheKey = `${mutable ? "mutable" : "immutable"}/${path}`;
  const cached = entries.get(entryCacheKey);
  let pending = cached && Date.now() < cached.expires ? cached.request : undefined;
  if (!pending) {
    pending = fetch(booksUrl(path), mutable ? { cache: "no-cache" } : undefined).then(async (response): Promise<DictionaryLookup> => {
      if (response.status === 404) return { kind: "missing" };
      if (!response.ok) throw new Error("Dictionary entry unavailable");
      return parseEntry(await jsonResponse(response, MAX_ENTRY_BYTES), publication, lookupKey);
    }).catch((): DictionaryLookup => ({ kind: "error" }));
    const entryRequest = { request: pending, expires: Infinity };
    entries.set(entryCacheKey, entryRequest);
    trimCache(entries);
    void pending.then((result) => {
      if (result.kind === "error" && entries.get(entryCacheKey) === entryRequest) entries.delete(entryCacheKey);
      else entryRequest.expires = mutable ? Date.now() + WORD_TTL : Infinity;
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

// WordNet Morphy detachment rules propose candidates, never fabricate entries or senses.
// Explicit source forms take precedence. Every proposal must exist with the matching POS.
export function dictionaryRegularForms(word: string): FormCandidate[] {
  const lower = word.normalize("NFC").toLowerCase().normalize("NFC");
  if (!/^[a-z]+$/.test(lower)) return [];
  const rules: Array<[string, string, string]> = [
    ["s", "", "n"], ["ses", "s", "n"], ["xes", "x", "n"], ["zes", "z", "n"],
    ["ches", "ch", "n"], ["shes", "sh", "n"], ["men", "man", "n"], ["ies", "y", "n"],
    ["s", "", "v"], ["ies", "y", "v"], ["es", "e", "v"], ["es", "", "v"],
    ["ed", "e", "v"], ["ed", "", "v"], ["ing", "e", "v"], ["ing", "", "v"],
    ["er", "", "a"], ["est", "", "a"], ["er", "e", "a"], ["est", "e", "a"],
  ];
  const candidates = new Map<string, FormCandidate>();
  for (const [suffix, replacement, pos] of rules) {
    if (!lower.endsWith(suffix)) continue;
    const lemma = lower.slice(0, -suffix.length) + replacement;
    if (lemma.length < 2 || lemma === lower) continue;
    candidates.set(`${lemma}/${pos}`, { lemma, pos });
  }
  return [...candidates.values()];
}

async function explicitForms(publication: Publication, word: string): Promise<FormCandidate[]> {
  const shard = dictionaryCaseShard(word);
  const path = `dictionary/form-indexes/${publication.formsIndex}/${shard}.json`;
  let pending = formIndexes.get(path);
  if (!pending) {
    pending = fetch(booksUrl(path)).then(async response => {
      if (!response.ok) throw new Error("Dictionary form index unavailable");
      const raw = await jsonResponse(response, MAX_INDEX_BYTES);
      if (!raw || typeof raw !== "object") throw new Error("Invalid form index");
      const index = raw as Record<string, unknown>;
      if (index.schema !== "oewn-form-index-v1" || index.release !== publication.release || index.indexVersion !== publication.formsIndex || index.shard !== shard ||
        !index.entries || typeof index.entries !== "object" || Array.isArray(index.entries)) throw new Error("Form index identity mismatch");
      for (const [form, candidates] of Object.entries(index.entries)) {
        if (form !== form.normalize("NFC").toLowerCase().normalize("NFC") || dictionaryCaseShard(form) !== shard || !Array.isArray(candidates) || !candidates.length) throw new Error("Invalid form group");
        const seen = new Set<string>();
        for (const item of candidates) {
          if (!item || typeof item !== "object" || typeof item.lemma !== "string" || item.lemma !== item.lemma.normalize("NFC") || !["n", "v", "a", "s", "r"].includes(item.pos)) throw new Error("Invalid form candidate");
          keyHex(item.lemma);
          const id = `${item.lemma}/${item.pos}`;
          if (seen.has(id)) throw new Error("Duplicate form candidate");
          seen.add(id);
        }
      }
      return index.entries as Record<string, FormCandidate[]>;
    });
    formIndexes.set(path, pending);
    trimCache(formIndexes);
    void pending.catch(() => { if (formIndexes.get(path) === pending) formIndexes.delete(path); });
  }
  const groups = await pending;
  const lower = word.toLowerCase().normalize("NFC");
  return Object.prototype.hasOwnProperty.call(groups, lower) ? groups[lower] : [];
}

async function lookupForms(publication: Publication, word: string): Promise<DictionaryLookup> {
  const explicit = await explicitForms(publication, word);
  let proposals = explicit;
  if (!proposals.length) {
    // Resolve candidate spelling against the full source inventory before any entry request.
    const regular = dictionaryRegularForms(word);
    const resolved = await Promise.all(regular.map(async candidate => {
      const lemmas = await caseCandidates(publication, candidate.lemma);
      return lemmas.map(lemma => ({ lemma, pos: candidate.pos }));
    }));
    proposals = resolved.flat();
  }
  const byLemma = new Map<string, Set<string>>();
  for (const { lemma, pos } of proposals) {
    if (!byLemma.has(lemma)) byLemma.set(lemma, new Set());
    byLemma.get(lemma)!.add(POS_NAMES[pos]);
  }
  const matches: StandardSense[][] = [];
  for (const [lemma, parts] of byLemma) {
    const result = await exactEntry(publication, lemma);
    if (result.kind === "error") return result;
    if (result.kind !== "unmapped") {
      if (explicit.length) return { kind: "error" };
      continue;
    }
    const senses = result.senses.filter(sense => parts.has(sense.pos));
    if (!senses.length && explicit.length) return { kind: "error" };
    if (senses.length) matches.push(senses);
  }
  if (matches.length > 1) return { kind: "ambiguous" };
  return matches.length ? { kind: "unmapped", senses: matches[0] } : { kind: "missing" };
}

/** Exact, then unique case match, then source-backed morphology; ambiguity never selects a lemma. */
export async function lookupStandardWord(word: string): Promise<DictionaryLookup | null> {
  const lookupKey = word.normalize("NFC");
  try { keyHex(lookupKey); } catch { return { kind: "missing" }; }
  let publication: Publication | null;
  try { publication = await activeRelease(); } catch { return { kind: "error" }; }
  if (!publication) return null;
  const { release } = publication;
  const cacheKey = `${publication.wordsMutable ? "mutable" : "immutable"}/${release}/${publication.caseIndex ?? "exact"}/${publication.formsIndex ?? "no-forms"}/${lookupKey}`;
  let pending = requests.get(cacheKey);
  if (!pending) {
    pending = (async (): Promise<DictionaryLookup> => {
      const withForms = async (base: DictionaryLookup): Promise<DictionaryLookup> => {
        if (!publication.formsIndex || base.kind === "error" || base.kind === "ambiguous") return base;
        const forms = await lookupForms(publication, lookupKey);
        if (base.kind !== "unmapped") return forms;
        // Inflections can also be independent nouns/adjectives (running, learned, stopped).
        // Keep every exact sense and append only a uniquely resolved, source-backed form's POS senses.
        if (forms.kind !== "unmapped") return base;
        const seen = new Set(base.senses.map(sense => sense.id));
        return { kind: "unmapped", senses: [...base.senses, ...forms.senses.filter(sense => !seen.has(sense.id))] };
      };
      const exact = await exactEntry(publication, lookupKey);
      if (exact.kind !== "missing" || !publication.caseIndex) return withForms(exact);
      const candidates = await caseCandidates(publication, lookupKey);
      if (candidates.length > 1) return { kind: "ambiguous" };
      if (candidates.length === 0) return withForms({ kind: "missing" });
      return withForms(await exactEntry(publication, candidates[0]));
    })().catch((): DictionaryLookup => ({ kind: "error" }));
    requests.set(cacheKey, pending);
    trimCache(requests);
    // Stable results are only coalesced while in flight. Keeping a second result TTL could
    // outlive a constituent word TTL (especially a case/inflection alias) and hide an edit.
    void pending.then((result) => { if ((publication.wordsMutable || result.kind === "error") && requests.get(cacheKey) === pending) requests.delete(cacheKey); });
  }
  return pending;
}
