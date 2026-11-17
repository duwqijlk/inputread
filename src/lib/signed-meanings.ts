import { booksUrl } from "@/lib/books-base";
import { cleanCatalogRef } from "@/lib/catalog-id";
import type { Gloss } from "@/lib/book-db";
import type { ParagraphHelp, PhraseEntry, SentenceHelp } from "@/lib/glossary-extras";
import type { GlossaryAnchor, GlossarySense } from "@/lib/glossary-format";

export const SIGNED_MEANINGS_SCHEMA = "signed-meanings-v1";
export const SIGNED_MEANINGS_STORAGE_KEY = "cibian-signed-meanings-v1";
export const MAX_SIGNED_MEANINGS_BYTES = 192 * 1024;

const CREDIT_RE = /^[a-z0-9]{12}$/;
const PHRASE_POS = new Set(["phrasal verb", "idiom", "phrase"]);

export type SignedWordEntry = {
  key: string;
  forms?: string[];
  pos?: string;
  meaning: string;
  whyHard?: string;
  here?: string;
  coined?: boolean;
  trickyMeaning?: boolean;
  credit: string;
  anchors?: GlossaryAnchor[];
};

export type SignedPhraseEntry = {
  key: string;
  forms?: string[];
  pos?: PhraseEntry["pos"];
  meaning: string;
  whyHard?: string;
  here?: string;
  example?: string;
  credit: string;
};

export type SignedSentenceEntry = SentenceHelp & {
  credit: string;
};

export type SignedParagraphEntry = ParagraphHelp & {
  credit: string;
};

export type SignedMeaningsOverlay = {
  schema: typeof SIGNED_MEANINGS_SCHEMA;
  catalogId: string;
  updatedAt: number;
  words: SignedWordEntry[];
  phrases: SignedPhraseEntry[];
  sentences: SignedSentenceEntry[];
  paragraphs: SignedParagraphEntry[];
};

const pendingBooks = new Map<string, Promise<SignedMeaningsOverlay>>();
const settledBooks = new Map<string, SignedMeaningsOverlay>();
const activeBookOverlays = new Map<string, SignedMeaningsOverlay | null>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function cleanText(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  const trimmed = value.replace(/\s+/g, " ").trim();
  if (!trimmed || trimmed.length > max) return "";
  return trimmed;
}

function parseAnchors(raw: unknown): GlossaryAnchor[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 64) {
    throw new Error("Invalid signed word anchors");
  }
  const out: GlossaryAnchor[] = [];
  for (const item of raw) {
    if (!isRecord(item)) throw new Error("Invalid signed word anchor");
    const anchor: GlossaryAnchor = {};
    if (item.chapter !== undefined) {
      if (!Number.isSafeInteger(item.chapter) || (item.chapter as number) < 0) {
        throw new Error("Invalid signed anchor chapter");
      }
      anchor.chapter = item.chapter as number;
    }
    if (item.occurrence !== undefined) {
      if (!Number.isSafeInteger(item.occurrence) || (item.occurrence as number) < 1) {
        throw new Error("Invalid signed anchor occurrence");
      }
      anchor.occurrence = item.occurrence as number;
    }
    if (item.form !== undefined) {
      const form = cleanText(item.form, 120);
      if (!form) throw new Error("Invalid signed anchor form");
      anchor.form = form;
    }
    if (item.context !== undefined) {
      const context = cleanText(item.context, 300);
      if (!context) throw new Error("Invalid signed anchor context");
      anchor.context = context;
    }
    if (anchor.chapter === undefined && anchor.context === undefined) {
      throw new Error("Signed anchor needs chapter or context");
    }
    out.push(anchor);
  }
  return out;
}

function parseForms(raw: unknown, maxItems = 24): string[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || raw.length > maxItems) throw new Error("Invalid signed forms");
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    const form = cleanText(item, 120).toLowerCase();
    if (!form) throw new Error("Invalid signed form");
    if (!seen.has(form)) {
      seen.add(form);
      out.push(form);
    }
  }
  return out.length > 0 ? out : undefined;
}

export function emptySignedMeanings(catalogId: string): SignedMeaningsOverlay {
  return {
    schema: SIGNED_MEANINGS_SCHEMA,
    catalogId,
    updatedAt: 0,
    words: [],
    phrases: [],
    sentences: [],
    paragraphs: [],
  };
}

export function signedMeaningsPath(catalogId: string): string {
  if (!cleanCatalogRef(catalogId)) throw new Error("Invalid catalog identity");
  const [catalog, id] = catalogId.split(":");
  return `dictionary/credits/${catalog}/${id}/credits.json`;
}

export function parseSignedMeaningsOverlay(
  raw: unknown,
  expectedCatalogId?: string,
): SignedMeaningsOverlay {
  if (!isRecord(raw) || raw.schema !== SIGNED_MEANINGS_SCHEMA) {
    throw new Error("Signed meanings schema mismatch");
  }
  const catalogId = typeof raw.catalogId === "string" ? cleanCatalogRef(raw.catalogId) : "";
  if (!catalogId || (expectedCatalogId && catalogId !== expectedCatalogId)) {
    throw new Error("Signed meanings identity mismatch");
  }
  if (!Number.isSafeInteger(raw.updatedAt) || (raw.updatedAt as number) < 0) {
    throw new Error("Invalid signed meanings timestamp");
  }
  if (
    !Array.isArray(raw.words) ||
    !Array.isArray(raw.phrases) ||
    !Array.isArray(raw.sentences) ||
    (raw.paragraphs !== undefined && !Array.isArray(raw.paragraphs))
  ) {
    throw new Error("Invalid signed meanings sections");
  }

  const words: SignedWordEntry[] = [];
  for (const item of raw.words) {
    if (!isRecord(item)) throw new Error("Invalid signed word row");
    const key = cleanText(item.key, 120).toLowerCase();
    const meaning = cleanText(item.meaning, 600);
    const credit = typeof item.credit === "string" ? item.credit : "";
    if (!key || !meaning || !CREDIT_RE.test(credit)) {
      throw new Error("Invalid signed word fields");
    }
    const pos = item.pos !== undefined ? cleanText(item.pos, 40) : "";
    if (item.pos !== undefined && !pos) throw new Error("Invalid signed word pos");
    const whyHard = item.whyHard !== undefined ? cleanText(item.whyHard, 400) : "";
    if (item.whyHard !== undefined && !whyHard) throw new Error("Invalid signed word whyHard");
    const here = item.here !== undefined ? cleanText(item.here, 300) : "";
    if (item.here !== undefined && !here) throw new Error("Invalid signed word here");
    if (item.coined !== undefined && typeof item.coined !== "boolean") {
      throw new Error("Invalid signed word coined");
    }
    if (item.trickyMeaning !== undefined && typeof item.trickyMeaning !== "boolean") {
      throw new Error("Invalid signed word trickyMeaning");
    }
    const forms = parseForms(item.forms);
    const anchors = parseAnchors(item.anchors);
    words.push({
      key,
      ...(forms ? { forms } : {}),
      ...(pos ? { pos } : {}),
      meaning,
      ...(whyHard ? { whyHard } : {}),
      ...(here ? { here } : {}),
      ...(item.coined === true ? { coined: true } : {}),
      ...(item.trickyMeaning === true ? { trickyMeaning: true } : {}),
      credit,
      ...(anchors ? { anchors } : {}),
    });
  }

  const phrases: SignedPhraseEntry[] = [];
  const seenPhrases = new Set<string>();
  for (const item of raw.phrases) {
    if (!isRecord(item)) throw new Error("Invalid signed phrase row");
    const key = cleanText(item.key, 160).toLowerCase().replace(/[\u2018\u2019\u02bc]/g, "'");
    const meaning = cleanText(item.meaning, 600);
    const credit = typeof item.credit === "string" ? item.credit : "";
    if (!key || !meaning || !CREDIT_RE.test(credit) || seenPhrases.has(key)) {
      throw new Error("Invalid signed phrase fields");
    }
    seenPhrases.add(key);
    let pos: PhraseEntry["pos"];
    if (item.pos !== undefined) {
      if (typeof item.pos !== "string" || !PHRASE_POS.has(item.pos)) {
        throw new Error("Invalid signed phrase pos");
      }
      pos = item.pos as PhraseEntry["pos"];
    }
    const whyHard = item.whyHard !== undefined ? cleanText(item.whyHard, 400) : "";
    if (item.whyHard !== undefined && !whyHard) throw new Error("Invalid signed phrase whyHard");
    const here = item.here !== undefined ? cleanText(item.here, 300) : "";
    if (item.here !== undefined && !here) throw new Error("Invalid signed phrase here");
    const example = item.example !== undefined ? cleanText(item.example, 400) : "";
    if (item.example !== undefined && !example) throw new Error("Invalid signed phrase example");
    const forms = parseForms(item.forms);
    phrases.push({
      key,
      ...(forms ? { forms } : {}),
      ...(pos ? { pos } : {}),
      meaning,
      ...(whyHard ? { whyHard } : {}),
      ...(here ? { here } : {}),
      ...(example ? { example } : {}),
      credit,
    });
  }

  const sentences: SignedSentenceEntry[] = [];
  for (const item of raw.sentences) {
    if (!isRecord(item)) throw new Error("Invalid signed sentence row");
    const chapter = item.chapter;
    const validChapter =
      (Number.isSafeInteger(chapter) && (chapter as number) >= 0) ||
      (typeof chapter === "string" && /^x\d+$/.test(chapter));
    if (!validChapter) throw new Error("Invalid signed sentence chapter");
    let paragraph: number | undefined;
    if (item.paragraph !== undefined) {
      if (!Number.isSafeInteger(item.paragraph) || (item.paragraph as number) < 0) {
        throw new Error("Invalid signed sentence paragraph");
      }
      paragraph = item.paragraph as number;
    }
    const context = cleanText(item.context, 300);
    const simple = cleanText(item.simple, 800);
    const credit = typeof item.credit === "string" ? item.credit : "";
    if (!context || !simple || !CREDIT_RE.test(credit)) {
      throw new Error("Invalid signed sentence fields");
    }
    const grammar = item.grammar !== undefined ? cleanText(item.grammar, 400) : "";
    if (item.grammar !== undefined && !grammar) throw new Error("Invalid signed sentence grammar");
    const core = item.core !== undefined ? cleanText(item.core, 240) : "";
    if (item.core !== undefined && !core) throw new Error("Invalid signed sentence core");
    const pattern = item.pattern !== undefined ? cleanText(item.pattern, 280) : "";
    if (item.pattern !== undefined && !pattern) throw new Error("Invalid signed sentence pattern");
    let chunks: string[] | undefined;
    if (item.chunks !== undefined) {
      if (!Array.isArray(item.chunks) || item.chunks.length > 8) {
        throw new Error("Invalid signed sentence chunks");
      }
      chunks = item.chunks.map((c) => {
        const line = cleanText(c, 320);
        if (!line) throw new Error("Invalid signed sentence chunk");
        return line;
      });
    }
    sentences.push({
      chapter: chapter as number | string,
      ...(paragraph !== undefined ? { paragraph } : {}),
      context,
      simple,
      ...(core ? { core } : {}),
      ...(chunks?.length ? { chunks } : {}),
      ...(pattern ? { pattern } : {}),
      ...(grammar ? { grammar } : {}),
      credit,
    });
  }

  const paragraphs: SignedParagraphEntry[] = [];
  for (const item of raw.paragraphs ?? []) {
    if (!isRecord(item)) throw new Error("Invalid signed paragraph row");
    const chapter = item.chapter;
    const validChapter =
      (Number.isSafeInteger(chapter) && (chapter as number) >= 0) ||
      (typeof chapter === "string" && /^x\d+$/.test(chapter));
    if (!validChapter) throw new Error("Invalid signed paragraph chapter");
    if (!Number.isSafeInteger(item.paragraph) || (item.paragraph as number) < 0) {
      throw new Error("Invalid signed paragraph index");
    }
    const context = cleanText(item.context, 300);
    const mainIdea = cleanText(item.mainIdea, 600);
    const simple = cleanText(item.simple, 1200);
    const credit = typeof item.credit === "string" ? item.credit : "";
    if (!context || !mainIdea || !simple || !CREDIT_RE.test(credit)) {
      throw new Error("Invalid signed paragraph fields");
    }
    let clues: string[] | undefined;
    if (item.clues !== undefined) {
      if (!Array.isArray(item.clues) || item.clues.length > 8) {
        throw new Error("Invalid signed paragraph clues");
      }
      clues = item.clues.map((c) => {
        const line = cleanText(c, 320);
        if (!line) throw new Error("Invalid signed paragraph clue");
        return line;
      });
    }
    let hardWords: string[] | undefined;
    if (item.hardWords !== undefined) {
      if (!Array.isArray(item.hardWords) || item.hardWords.length > 16) {
        throw new Error("Invalid signed paragraph hardWords");
      }
      hardWords = item.hardWords.map((w) => {
        const token = cleanText(w, 80);
        if (!token) throw new Error("Invalid signed paragraph hardWord");
        return token;
      });
    }
    paragraphs.push({
      chapter: chapter as number | string,
      paragraph: item.paragraph as number,
      context,
      mainIdea,
      simple,
      ...(clues?.length ? { clues } : {}),
      ...(hardWords?.length ? { hardWords } : {}),
      credit,
    });
  }

  return {
    schema: SIGNED_MEANINGS_SCHEMA,
    catalogId,
    updatedAt: raw.updatedAt as number,
    words,
    phrases,
    sentences,
    paragraphs,
  };
}

function readStoredMap(): Record<string, SignedMeaningsOverlay> {
  try {
    if (typeof localStorage === "undefined") return {};
    const raw = localStorage.getItem(SIGNED_MEANINGS_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return isRecord(parsed) ? (parsed as Record<string, SignedMeaningsOverlay>) : {};
  } catch {
    return {};
  }
}

function writeStoredOverlay(catalogId: string, overlay: SignedMeaningsOverlay): void {
  try {
    if (typeof localStorage === "undefined") return;
    const map = readStoredMap();
    delete map[catalogId];
    const hasContent =
      overlay.words.length > 0 ||
      overlay.phrases.length > 0 ||
      overlay.sentences.length > 0 ||
      overlay.paragraphs.length > 0;
    if (hasContent) {
      map[catalogId] = overlay;
      const keys = Object.keys(map);
      while (keys.length > 16) {
        const oldest = keys.shift();
        if (oldest) delete map[oldest];
      }
    }
    if (Object.keys(map).length === 0) localStorage.removeItem(SIGNED_MEANINGS_STORAGE_KEY);
    else localStorage.setItem(SIGNED_MEANINGS_STORAGE_KEY, JSON.stringify(map));
  } catch {
    // Blocked or full storage leaves in-memory resolution working.
  }
}

function rememberSettled(catalogId: string, overlay: SignedMeaningsOverlay): void {
  settledBooks.delete(catalogId);
  settledBooks.set(catalogId, overlay);
  if (settledBooks.size > 16) settledBooks.delete(settledBooks.keys().next().value!);
}

/** Synchronous first-frame lookup from memory or validated localStorage cache. */
export function peekSignedMeanings(catalogId: string): SignedMeaningsOverlay | null {
  const clean = cleanCatalogRef(catalogId);
  if (!clean) return null;
  const mem = settledBooks.get(clean);
  if (mem) return mem;
  const candidate = readStoredMap()[clean];
  if (!candidate) return null;
  try {
    const valid = parseSignedMeaningsOverlay(candidate, clean);
    rememberSettled(clean, valid);
    return valid;
  } catch {
    return null;
  }
}

/** One shared static overlay fetch per catalog book; 404 means no signed overrides yet. */
export function loadSignedMeanings(catalogId: string): Promise<SignedMeaningsOverlay> {
  const clean = cleanCatalogRef(catalogId);
  if (!clean) return Promise.resolve(emptySignedMeanings(""));
  let pending = pendingBooks.get(clean);
  if (!pending) {
    pending = fetch(booksUrl(signedMeaningsPath(clean))).then(async (response) => {
      if (response.status === 404) {
        const empty = emptySignedMeanings(clean);
        rememberSettled(clean, empty);
        writeStoredOverlay(clean, empty);
        return empty;
      }
      if (!response.ok) throw new Error("Signed meanings unavailable");
      if (Number(response.headers.get("content-length")) > MAX_SIGNED_MEANINGS_BYTES) {
        throw new Error("Signed meanings file too large");
      }
      const text = await response.text();
      if (new TextEncoder().encode(text).length > MAX_SIGNED_MEANINGS_BYTES) {
        throw new Error("Signed meanings file too large");
      }
      const valid = parseSignedMeaningsOverlay(JSON.parse(text), clean);
      rememberSettled(clean, valid);
      writeStoredOverlay(clean, valid);
      return valid;
    });
    pendingBooks.set(clean, pending);
    if (pendingBooks.size > 16) pendingBooks.delete(pendingBooks.keys().next().value!);
    void pending.catch(() => {
      if (pendingBooks.get(clean) === pending) pendingBooks.delete(clean);
    });
  }
  return pending;
}

/** Best-effort static prewarm with offline cache fallback. */
export async function readSignedMeanings(catalogId: string): Promise<SignedMeaningsOverlay | null> {
  const clean = cleanCatalogRef(catalogId);
  if (!clean) return null;
  try {
    return await loadSignedMeanings(clean);
  } catch {
    return peekSignedMeanings(clean);
  }
}

export async function warmSignedMeanings(catalogId: string): Promise<void> {
  await readSignedMeanings(catalogId);
}

/** Bind the open book's signed overlay so hook-free paragraph/sentence/phrase helpers read it synchronously. */
export function shareBookSignedMeanings(
  bookId: string,
  overlay: SignedMeaningsOverlay | null,
): void {
  if (!bookId) return;
  activeBookOverlays.delete(bookId);
  if (overlay) {
    activeBookOverlays.set(bookId, overlay);
    if (activeBookOverlays.size > 8) {
      activeBookOverlays.delete(activeBookOverlays.keys().next().value!);
    }
  }
}

export function signedMeaningsForBook(bookId: string): SignedMeaningsOverlay | null {
  return activeBookOverlays.get(bookId) ?? null;
}

export function clearSignedMeaningsCache(): void {
  pendingBooks.clear();
  settledBooks.clear();
  activeBookOverlays.clear();
}

/**
 * Layer 3 over Layer 2 for words:
 * - Anchored signed senses are prepended ahead of L2 senses so `pickSense` chooses the reader's
 *   signed meaning at that exact anchor while preserving L2 meanings at every other occurrence.
 * - Unanchored signed entries override the book-wide base meaning while keeping unrelated L2 anchors.
 * - Words present only in L3 become `senseOnly: true` (when anchored) or book-wide entries.
 */
export function mergeSignedGlossary(
  base: Record<string, Gloss>,
  overlay: SignedMeaningsOverlay | null | undefined,
): Record<string, Gloss> {
  if (!overlay || overlay.words.length === 0) return base;
  const grouped = new Map<string, SignedWordEntry[]>();
  for (const item of overlay.words) {
    const list = grouped.get(item.key);
    if (list) list.push(item);
    else grouped.set(item.key, [item]);
  }
  const next: Record<string, Gloss> = { ...base };
  for (const [key, items] of grouped) {
    const existing = base[key];
    const anchoredSenses: GlossarySense[] = [];
    let unanchored: SignedWordEntry | undefined;
    const formSet = new Set<string>(existing?.forms ?? []);
    for (const item of items) {
      for (const form of item.forms ?? []) formSet.add(form);
      if (item.anchors && item.anchors.length > 0) {
        anchoredSenses.push({
          meaning: item.meaning,
          ...(item.pos ? { pos: item.pos } : {}),
          ...(item.whyHard ? { whyHard: item.whyHard } : {}),
          ...(item.here ? { here: item.here } : {}),
          ...(item.trickyMeaning ? { trickyMeaning: true } : {}),
          credit: item.credit,
          anchors: item.anchors,
        });
      } else {
        unanchored = item;
      }
    }
    const forms = formSet.size > 0 ? [...formSet] : undefined;
    const coined = existing?.coined === true || items.some((item) => item.coined === true);
    const claimedPlaces = new Set<string>();
    const claimedContexts = new Set<string>();
    for (const sense of anchoredSenses) {
      for (const anchor of sense.anchors ?? []) {
        if (anchor.chapter !== undefined && anchor.occurrence !== undefined) {
          claimedPlaces.add(`${anchor.chapter}/${(anchor.form ?? key).toLowerCase()}/${anchor.occurrence}`);
        }
        if (anchor.context) {
          claimedContexts.add(`${anchor.chapter ?? "*"}\0${anchor.context.trim().toLowerCase().replace(/\s+/g, " ")}`);
        }
      }
    }
    if (existing) {
      const baseSenses = (existing.senses ?? [])
        .map((sense) => {
          const nextSense = unanchored && sense.default ? { ...sense, default: undefined } : sense;
          if (!nextSense.anchors || nextSense.anchors.length === 0) return nextSense;
          const kept = nextSense.anchors.filter((anchor) => {
            if (anchor.chapter !== undefined && anchor.occurrence !== undefined) {
              if (claimedPlaces.has(`${anchor.chapter}/${(anchor.form ?? key).toLowerCase()}/${anchor.occurrence}`)) {
                return false;
              }
            }
            if (anchor.context) {
              const ctxKey = `${anchor.chapter ?? "*"}\0${anchor.context.trim().toLowerCase().replace(/\s+/g, " ")}`;
              if (claimedContexts.has(ctxKey)) return false;
            }
            return true;
          });
          if (kept.length === 0) return null;
          return kept.length === nextSense.anchors.length ? nextSense : { ...nextSense, anchors: kept };
        })
        .filter((sense): sense is GlossarySense => sense !== null);
      const mergedSenses =
        anchoredSenses.length > 0 || baseSenses.length > 0
          ? [...anchoredSenses, ...baseSenses]
          : undefined;
      const nextEntry: Gloss = {
        ...existing,
        pos: unanchored ? (unanchored.pos ?? existing.pos) : existing.pos,
        meaning: unanchored ? unanchored.meaning : existing.meaning,
        whyHard: unanchored ? (unanchored.whyHard ?? existing.whyHard) : existing.whyHard,
        ...(coined ? { coined: true } : {}),
        ...(forms ? { forms } : {}),
      };
      if (unanchored) {
        nextEntry.credit = unanchored.credit;
        delete nextEntry.senseOnly;
        if (unanchored.here) nextEntry.here = unanchored.here;
        else delete nextEntry.here;
      } else if (existing.senseOnly) {
        nextEntry.senseOnly = true;
      }
      if (mergedSenses) nextEntry.senses = mergedSenses;
      else delete nextEntry.senses;
      next[key] = nextEntry;
    } else if (unanchored) {
      next[key] = {
        pos: unanchored.pos ?? "",
        meaning: unanchored.meaning,
        whyHard: unanchored.whyHard ?? "",
        ...(coined ? { coined: true } : {}),
        ...(unanchored.here ? { here: unanchored.here } : {}),
        credit: unanchored.credit,
        ...(forms ? { forms } : {}),
        ...(anchoredSenses.length > 0 ? { senses: anchoredSenses } : {}),
      };
    } else if (anchoredSenses.length > 0) {
      const first = items[0]!;
      next[key] = {
        pos: first.pos ?? "",
        meaning: first.meaning,
        whyHard: first.whyHard ?? "",
        ...(coined ? { coined: true } : {}),
        ...(forms ? { forms } : {}),
        senseOnly: true,
        senses: anchoredSenses,
      };
    }
  }
  return next;
}

/** Layer 3 over Layer 2 for phrases: signed reader phrases override base phrases with the same key. */
export function mergeSignedPhrases(
  base: Record<string, PhraseEntry>,
  overlay: SignedMeaningsOverlay | null | undefined,
): Record<string, PhraseEntry> {
  if (!overlay || overlay.phrases.length === 0) return base;
  const next: Record<string, PhraseEntry> = { ...base };
  for (const item of overlay.phrases) {
    const prev = base[item.key];
    const forms = item.forms ?? prev?.forms;
    next[item.key] = {
      meaning: item.meaning,
      ...(item.pos ?? prev?.pos ? { pos: item.pos ?? prev?.pos } : {}),
      ...(forms?.length ? { forms } : {}),
      ...(item.example ?? prev?.example ? { example: item.example ?? prev?.example } : {}),
      ...(item.here ? { here: item.here } : {}),
      ...(item.whyHard ? { whyHard: item.whyHard } : {}),
      credit: item.credit,
    };
  }
  return next;
}

function sentenceKey(chapter: number | string, context: string): string {
  return `${chapter}\0${context.trim().toLowerCase().replace(/\s+/g, " ")}`;
}

/** Layer 3 over Layer 2 for sentence notes: signed reader notes override matching context notes or add new ones. */
export function mergeSignedSentences(
  base: readonly SentenceHelp[],
  overlay: SignedMeaningsOverlay | null | undefined,
): SentenceHelp[] {
  if (!overlay || overlay.sentences.length === 0) return base as SentenceHelp[];
  const byKey = new Map<string, SignedSentenceEntry>();
  for (const item of overlay.sentences) {
    byKey.set(sentenceKey(item.chapter, item.context), item);
  }
  const replaced = new Set<string>();
  const mergedBase = base.map((note) => {
    const key = sentenceKey(note.chapter, note.context);
    const override = byKey.get(key);
    if (!override) return note;
    replaced.add(key);
    return override;
  });
  const added = overlay.sentences.filter(
    (item) => !replaced.has(sentenceKey(item.chapter, item.context)),
  );
  return added.length > 0 ? [...added, ...mergedBase] : mergedBase;
}

function paragraphKey(chapter: number | string, paragraph: number): string {
  return `${chapter}\0${paragraph}`;
}

/** Layer 3 over Layer 2 for paragraph notes: signed reader notes override matching paragraphs or add new ones. */
export function mergeSignedParagraphs(
  base: readonly ParagraphHelp[],
  overlay: SignedMeaningsOverlay | null | undefined,
): ParagraphHelp[] {
  if (!overlay || overlay.paragraphs.length === 0) return base as ParagraphHelp[];
  const byPlace = new Map<string, SignedParagraphEntry>();
  const byContext = new Map<string, SignedParagraphEntry>();
  for (const item of overlay.paragraphs) {
    byPlace.set(paragraphKey(item.chapter, item.paragraph), item);
    byContext.set(sentenceKey(item.chapter, item.context), item);
  }
  const used = new Set<SignedParagraphEntry>();
  const mergedBase = base.map((note) => {
    const override =
      byPlace.get(paragraphKey(note.chapter, note.paragraph)) ??
      byContext.get(sentenceKey(note.chapter, note.context));
    if (!override) return note;
    used.add(override);
    return override;
  });
  const added = overlay.paragraphs.filter((item) => !used.has(item));
  return added.length > 0 ? [...added, ...mergedBase] : mergedBase;
}
