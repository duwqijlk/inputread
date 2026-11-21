import { useEffect, useMemo, useState } from "react";
import { loadStoredBook } from "@/lib/book-db";
import { bookListSnapshot, glossSettled, glossSnapshot, requestBookGloss, requestGloss, subscribeGloss } from "@/lib/gloss-cache";
import { bookGlossKey, glossCacheKey } from "@/lib/gloss-point";
import { presentWord, readPoint, type GlossFileView } from "@/lib/gloss-ref";
import { lookupStandardWord } from "@/lib/standard-dictionary";
import { restoreParagraph } from "@/lib/text";
import type { Book, VocabEntry, WordSource } from "@/lib/vocab-model";
import { useVocab } from "@/lib/vocab-store";
import { bookForSource } from "@/lib/wordbook";

type StandardSenseText = { meaning: string; pos: string };
const liveStandardCache = new Map<string, Map<string, StandardSenseText>>();
const liveStandardPending = new Set<string>();
const liveStandardListeners = new Set<() => void>();

function notifyLiveStandard(): void {
  for (const listener of liveStandardListeners) listener();
}

function requestLiveStandardLemma(standardLemma: string): void {
  const key = standardLemma.normalize("NFC").trim();
  if (!key || liveStandardCache.has(key) || liveStandardPending.has(key)) return;
  liveStandardPending.add(key);
  void lookupStandardWord(key)
    .then((result) => {
      if (!result) return;
      if (result.kind === "unmapped" && result.senses.length > 0) {
        const bySense = new Map<string, StandardSenseText>();
        for (const sense of result.senses) {
          if (sense.id && sense.meaning) bySense.set(sense.id, { meaning: sense.meaning, pos: sense.pos });
        }
        liveStandardCache.set(key, bySense);
        notifyLiveStandard();
      } else if (result.kind === "missing" || result.kind === "ambiguous") {
        liveStandardCache.set(key, new Map());
      }
    })
    .catch(() => {
      // Offline or transient failure: fall back cleanly to the saved meaning string.
    })
    .finally(() => {
      liveStandardPending.delete(key);
    });
}

function applyLiveStandard(word: VocabEntry): VocabEntry {
  const cardLemma = (word.standardLemma ?? "").normalize("NFC").trim();
  const cardSense = (word.senseId ?? "").trim();
  const cardLive = cardLemma && cardSense ? liveStandardCache.get(cardLemma)?.get(cardSense) : undefined;
  let sourcesChanged = false;
  const sources = word.sources.map((source) => {
    if (source.ref) return source;
    const sLemma = (source.standardLemma ?? cardLemma).normalize("NFC").trim();
    const sId = (source.senseId ?? cardSense).trim();
    const live = sLemma && sId ? liveStandardCache.get(sLemma)?.get(sId) : undefined;
    if (!live || (source.meaning === live.meaning && (!live.pos || source.pos === live.pos))) return source;
    sourcesChanged = true;
    return { ...source, meaning: live.meaning, ...(live.pos ? { pos: live.pos } : {}) };
  });
  const hasAnyRef = word.sources.some((source) => Boolean(source.ref));
  const nextMeaning = !hasAnyRef && cardLive ? cardLive.meaning : word.meaning;
  const nextPos = !hasAnyRef && cardLive?.pos ? cardLive.pos : word.pos;
  if (!sourcesChanged && nextMeaning === word.meaning && nextPos === word.pos) return word;
  return { ...word, meaning: nextMeaning, pos: nextPos, sources };
}

/** The word lists loaded for the notebook. A later edit to a list replaces the copy. */
export function useGlossFiles(): ReadonlyMap<string, GlossFileView> {
  const [tick, setTick] = useState(0);
  useEffect(() => subscribeGloss(() => setTick((value) => value + 1)), []);
  return useMemo(() => glossSnapshot(), [tick]);
}

/** The word as the notebook shows it: the saved paragraph stays, and meanings refresh live from the word list or R2 OEWN. */
export function usePresentedWord(word: VocabEntry | undefined, books: readonly Book[]): VocabEntry | undefined {
  const files = useGlossFiles();
  const [stdTick, setStdTick] = useState(0);
  useEffect(() => {
    const bump = () => setStdTick((value) => value + 1);
    liveStandardListeners.add(bump);
    return () => {
      liveStandardListeners.delete(bump);
    };
  }, []);
  useEffect(() => {
    if (!word) return;
    if (word.senseId && word.standardLemma) requestLiveStandardLemma(word.standardLemma);
    for (const source of word.sources) {
      if (source.ref) requestGloss(source.ref, source.book, books);
      else {
        requestBookGloss(source.book, books);
        if (source.senseId && (source.standardLemma || word.standardLemma)) {
          requestLiveStandardLemma(source.standardLemma ?? word.standardLemma ?? "");
        }
      }
    }
  }, [word, books, files]);
  return useMemo(() => {
    if (!word) return undefined;
    return applyLiveStandard(presentWord(word, files));
  }, [word, files, stdTick]);
}

/**
 * Load each saved word's list and, once it is here, store a pointer.
 * The sentence stays. The meaning is not stored: the card reads the list again every time it is shown.
 * A sentence that was already dropped is filled from the book file on this device.
 */
export function useLiveGlossMeanings(words: readonly VocabEntry[], books: readonly Book[]): void {
  const files = useGlossFiles();
  const adopt = useVocab((state) => state.adoptGlossPointers);
  useEffect(() => {
    const seen = new Set<string>();
    for (const word of words) {
      for (const source of word.sources) {
        if (source.ref) requestGloss(source.ref, source.book, books);
        else if (!seen.has(source.book)) {
          seen.add(source.book);
          requestBookGloss(source.book, books);
        }
      }
    }
  }, [words, books, files]);
  useEffect(() => {
    adopt(bookListSnapshot());
  }, [files, words, books, adopt]);
  useRestoreParagraphs(words, books, files);
}

function useRestoreParagraphs(
  words: readonly VocabEntry[],
  books: readonly Book[],
  files: ReadonlyMap<string, GlossFileView>,
): void {
  const fill = useVocab((state) => state.fillSourceSentence);
  useEffect(() => {
    const pending: { lemma: string; source: WordSource; bookId: string }[] = [];
    for (const word of words) {
      for (const source of word.sources) {
        if (source.sentence?.trim()) continue;
        const book = bookForSource(source, books);
        if (!book) continue;
        pending.push({ lemma: word.lemma, source, bookId: book.id });
      }
    }
    if (pending.length === 0) return;
    let alive = true;
    void (async () => {
      const byId = new Map<string, typeof pending>();
      for (const item of pending) {
        const list = byId.get(item.bookId) ?? [];
        list.push(item);
        byId.set(item.bookId, list);
      }
      for (const [id, list] of byId) {
        const stored = await loadStoredBook(id).catch(() => null);
        if (!alive || !stored) continue;
        for (const item of list) {
          const surface = item.source.ref?.form || item.source.surface || item.lemma;
          const key = item.source.ref
            ? glossCacheKey(item.source.ref, item.source.book)
            : bookGlossKey(item.source.book);
          const file = files.get(key);
          const hint = file && item.source.ref ? (readPoint(item.source.ref, item.lemma, file)?.sentence ?? "") : "";
          const settled = Boolean(file) || glossSettled(key);
          const sentence = restoreParagraph({
            surface,
            phrase: item.source.ref?.phrase === true || /\s/.test(item.source.surface),
            chapter: item.source.ref?.chapter ?? item.source.chapter,
            occurrence: item.source.ref?.occurrence,
            hint: settled ? hint : "",
            guess: settled,
            chapters: stored.chapters,
            extras: stored.extras,
          });
          if (!alive || !sentence) continue;
          fill(item.lemma, item.source.book, item.source.savedAt, sentence);
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [words, books, files, fill]);
}
