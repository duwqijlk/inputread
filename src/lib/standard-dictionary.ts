import { booksUrl } from "@/lib/books-base";
import type { StandardSense } from "@/components/word-sense-panel";

export type DictionaryLookup =
  | { kind: "unmapped"; senses: StandardSense[] }
  | { kind: "missing" }
  | { kind: "error" };

const RELEASE = /^[a-z0-9][a-z0-9-]{0,79}$/;
const MAX_ENTRY_BYTES = 192 * 1024;
const MAX_CACHED_WORDS = 64;
let current: Promise<string | null> | undefined;
const requests = new Map<string, Promise<DictionaryLookup>>();

/** Lossless, case-preserving URL component. A slash in a lemma never becomes a path separator. */
export function dictionaryWordPath(release: string, lookupKey: string): string {
  if (!RELEASE.test(release)) throw new Error("Invalid dictionary release");
  const bytes = new TextEncoder().encode(lookupKey.normalize("NFC"));
  if (bytes.length === 0 || bytes.length > 240) throw new Error("Invalid dictionary lookup key");
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `dictionary/releases/${release}/words/${hex.slice(0, 2)}/${hex}.json`;
}

async function jsonResponse(response: Response, max: number): Promise<unknown> {
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > max) throw new Error("Dictionary resource too large");
  const text = await response.text();
  if (new TextEncoder().encode(text).length > max) throw new Error("Dictionary resource too large");
  return JSON.parse(text) as unknown;
}

async function activeRelease(): Promise<string | null> {
  if (!current) {
    current = fetch(booksUrl("dictionary/current.json"), { cache: "no-cache" })
      .then(async (response) => {
        // A staged reader can run safely before the dictionary publication exists.
        if (response.status === 404) return null;
        if (!response.ok) throw new Error("Dictionary manifest unavailable");
        const raw = await jsonResponse(response, 4096);
        if (!raw || typeof raw !== "object") throw new Error("Invalid dictionary manifest");
        const manifest = raw as Record<string, unknown>;
        if (manifest.schema !== "oewn-r2-current-v1" || typeof manifest.release !== "string" || !RELEASE.test(manifest.release)) {
          throw new Error("Invalid dictionary manifest");
        }
        return manifest.release;
      })
      .catch((error: unknown) => {
        current = undefined;
        throw error;
      });
  }
  return current;
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

/** Lookup is exact; arbitrary stemming, case folding, and guessing a sense ID are forbidden. */
export async function lookupStandardWord(word: string): Promise<DictionaryLookup | null> {
  let release: string | null;
  try {
    release = await activeRelease();
  } catch {
    return { kind: "error" };
  }
  if (!release) return null;
  const lookupKey = word.normalize("NFC");
  let path: string;
  try {
    path = dictionaryWordPath(release, lookupKey);
  } catch {
    return { kind: "missing" };
  }
  let pending = requests.get(path);
  if (!pending) {
    pending = fetch(booksUrl(path))
      .then(async (response): Promise<DictionaryLookup> => {
        if (response.status === 404) return { kind: "missing" };
        if (!response.ok) throw new Error("Dictionary entry unavailable");
        return parseEntry(await jsonResponse(response, MAX_ENTRY_BYTES), release, lookupKey);
      })
      .catch((): DictionaryLookup => ({ kind: "error" }));
    requests.set(path, pending);
    if (requests.size > MAX_CACHED_WORDS) requests.delete(requests.keys().next().value!);
    void pending.then((result) => {
      if (result.kind === "error" && requests.get(path) === pending) requests.delete(path);
    });
  }
  return pending;
}
