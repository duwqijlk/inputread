/**
 * Word-list updates the reader chooses. When the app loads the catalogs (app start, and when
 * Discover opens), every installed book whose catalog revision changed is marked, for public-domain
 * packs and word-list books alike. Nothing is replaced until the reader taps Update on that card.
 * The tap replaces only the list: the EPUB, the reading place, saved words and settings stay.
 * The decisions are pure and live in src/lib/word-list-plan.ts:
 *   - a list the reader added or edited by hand is never replaced, not even by Update:
 *     the card says the edited list is kept and does not offer that button;
 *   - a classic whose BOOK file changed keeps Update, and the card says why;
 *   - a word-list book on the reader's own EPUB keeps its old list when the new one does not
 *     match that EPUB (the same edition check as the own-EPUB dialog), with the reason shown.
 * A hold stays on the shelf card and the Discover card. A banner says how many books are waiting.
 */
import { create } from "zustand";
import { sharedFetchGeneration, SHARED_TEXT_MS } from "@/lib/shared-fetch";
import {
  listPackRecords,
  loadBookExtras,
  loadBookSummary,
  bookDataGeneration,
  loadStoredBook,
  savePackRecord,
  type PackRecord,
  type StoredChapter,
} from "@/lib/book-db";
import { bookCatalogRef } from "@/lib/catalog-id";
import { uniqueBookRecord } from "@/lib/catalog-shelf-identity";
import { flowText } from "@/lib/flow-text";
import { fetchProtectedGlossary, remoteGlossaryId } from "@/lib/glossary-fetch";
import { errorText, tr } from "@/lib/i18n";
import { paragraphBlocks } from "@/lib/help-match";
import { applyPackGlossary, hashBytes } from "@/lib/pack-glossary";
import {
  BUNDLED_CATALOG_URL,
  downloadPack,
  getCatalogUrl,
  loadCatalog,
  resolveAgainst,
  type CatalogPack,
} from "@/lib/packs";
import { storeWordListText } from "@/lib/pair-epub";
import { useVocab } from "@/lib/vocab-store";
import {
  loadWordListCatalog,
  WORD_LIST_CATALOG_URL,
  type WordListPack,
} from "@/lib/word-list-catalog";
import {
  checkListAgainstBook,
  planListUpdate,
  wordListUpdateActions,
  type ListHoldWhy,
} from "@/lib/word-list-plan";

export { planListUpdate, checkListAgainstBook, wordListUpdateActions };

/** A new list that must not replace the stored one. `mismatch` is the under-80% edition check. */
export class ListUpdateBlock extends Error {
  readonly why: "mismatch" | "unreadable";
  constructor(why: "mismatch" | "unreadable", message: string) {
    super(message);
    this.name = "ListUpdateBlock";
    this.why = why;
  }
}

export type ListUpdateToast = {
  id: number;
  /** titles whose list was replaced */
  updated: string[];
  /** how many tapped books kept their old list (the card says why) */
  failed: number;
};

type ListUpdateState = {
  /** pack id -> plain-language reason its list was NOT replaced (shown under the Update button) */
  failures: Record<string, string>;
  /**
   * pack id -> why this book was left for the reader.
   * `ownList` is a note, not an Update button. The others keep the button.
   */
  holds: Record<string, ListHoldWhy>;
  /** how many installed books are waiting for Update (0 = say nothing) */
  waiting: number;
  /** goes up after every run, so Discover re-reads the pack records */
  finished: number;
  /** The last Update the reader tapped: what changed, for the message at the bottom of the screen. */
  toast: ListUpdateToast | null;
  dismiss: () => void;
  dismissToast: () => void;
  clearFailure: (packId: string) => void;
};

export const useListUpdates = create<ListUpdateState>()((set) => ({
  failures: {},
  holds: {},
  waiting: 0,
  finished: 0,
  toast: null,
  dismiss: () => set({ waiting: 0 }),
  dismissToast: () => set({ toast: null }),
  clearFailure: (packId) =>
    set((state) => {
      if (!(packId in state.failures) && !(packId in state.holds)) return state;
      const failures = { ...state.failures };
      const holds = { ...state.holds };
      delete failures[packId];
      delete holds[packId];
      return { failures, holds };
    }),
}));

function rememberFailure(packId: string, reason: unknown): void {
  const text = errorText(reason, "err.downloadFailed");
  useListUpdates.setState((prev) => ({
    failures: { ...prev.failures, [packId]: text },
    holds:
      reason instanceof ListUpdateBlock && reason.why === "mismatch"
        ? { ...prev.holds, [packId]: "mismatch" }
        : prev.holds,
  }));
}

/** The catalog revision of a word-list pack (place-word-list.ts stores the same value). */
export function wordListRev(pack: Pick<WordListPack, "id" | "glossary">): string {
  return pack.glossary.sha256.slice(0, 12) || pack.id;
}

/** The text of every paragraph of a stored book, for the edition check. */
function bookParagraphs(chapters: StoredChapter[]): string[] {
  const out: string[] = [];
  for (const chapter of chapters) {
    if (chapter.html && typeof DOMParser !== "undefined") {
      const doc = new DOMParser().parseFromString(`<div>${chapter.html}</div>`, "text/html");
      for (const block of paragraphBlocks(doc.body)) out.push(flowText(block));
    } else {
      out.push(...(chapter.paragraphs ?? []));
    }
  }
  return out;
}

async function readDirectList(url: string): Promise<Uint8Array> {
  const response = await fetch(url, { cache: "no-cache" });
  if (!response.ok) throw new Error(tr("err.downloadFailed"));
  return new Uint8Array(await response.arrayBuffer());
}

async function fetchListText(pack: WordListPack): Promise<string> {
  const glossaryUrl = resolveAgainst(WORD_LIST_CATALOG_URL, pack.glossary.url);
  const remoteId = remoteGlossaryId(glossaryUrl);
  const bytes = remoteId
    ? await fetchProtectedGlossary(pack.id, tr("err.downloadFailed"))
    : await readDirectList(glossaryUrl);
  const sha = await hashBytes(bytes);
  if (pack.glossary.sha256 && sha && pack.glossary.sha256 !== sha)
    throw new Error(tr("err.damaged"));
  return new TextDecoder().decode(bytes);
}

/**
 * Give one word-list book its new list. A card still waiting for the reader's e-book only
 * refreshes the saved list text; a book with the reader's own EPUB first passes the edition
 * check, and a list that does not fit stays out (the thrown Error says why).
 */
async function updateWordListBook(record: PackRecord, pack: WordListPack): Promise<void> {
  const rev = wordListRev(pack);
  const text = await fetchListText(pack);
  const stored = await loadStoredBook(record.bookId).catch(() => null);
  // A list the reader added or edited by hand stays theirs, also from the manual Update button
  // (the same rule installPack follows for classics): only the saved copy and the revision move on.
  const source = stored
    ? (await loadBookExtras(record.bookId).catch(() => null))?.source
    : undefined;
  const actions = wordListUpdateActions({ hasStoredBook: Boolean(stored), listSource: source });
  if (actions.applyGlossary && stored) {
    const check = checkListAgainstBook(text, bookParagraphs(stored.chapters));
    if (!check.ok)
      throw new ListUpdateBlock(
        check.problem === "unreadable" ? "unreadable" : "mismatch",
        check.problem === "unreadable"
          ? tr("err.packListUnreadable")
          : tr("lists.matchWarn", { n: check.percent }),
      );
    await applyPackGlossary(record.bookId, text, record.packId, rev, "word-lists");
    useVocab.getState().setBookDetails([{ id: record.bookId, matchRate: check.percent }]);
  }
  if (actions.saveText) await storeWordListText(pack.id, text);
  if (actions.saveRev) await savePackRecord({ ...record, rev });
}

function markUpdated(packId: string): void {
  useListUpdates.getState().clearFailure(packId);
  useListUpdates.setState((prev) => ({
    finished: prev.finished + 1,
    waiting: Math.max(0, prev.waiting - 1),
  }));
}

/** Retry one word-list book from its Discover card (the Update button). Throws on failure. */
export async function retryWordListUpdate(pack: WordListPack): Promise<void> {
  const records = await listPackRecords();
  const live = new Set(useVocab.getState().books.map((book) => book.id));
  const targets = new Set(records.filter((item) => item.packId === pack.id && live.has(item.bookId)).map((item) => item.bookId));
  const record = targets.size === 1 ? uniqueBookRecord(records, [...targets][0]!) : undefined;
  if (!record) throw new Error(tr("err.bookGone"));
  try {
    const maps = await loadCatalogMaps();
    const extras = await loadBookExtras(record.bookId).catch(() => null);
    const target = await catalogTarget(record, extras, maps);
    if (target.list?.id !== pack.id) throw new Error(tr("discover.missingCatalogIdentity"));
    await updateWordListBook(record, pack);
    markUpdated(pack.id);
  } catch (reason) {
    rememberFailure(pack.id, reason);
    throw reason;
  }
}

type CatalogMaps = {
  classics: Map<string, { pack: CatalogPack; url: string }>;
  lists: Map<string, WordListPack>;
  complete: boolean;
};

async function loadCatalogMaps(): Promise<CatalogMaps> {
  const custom = getCatalogUrl();
  const [bundled, extra, wordLists] = await Promise.all([
    loadCatalog(BUNDLED_CATALOG_URL).catch(() => null),
    custom !== BUNDLED_CATALOG_URL ? loadCatalog(custom).catch(() => null) : Promise.resolve(null),
    loadWordListCatalog().catch(() => null),
  ]);
  const classics = new Map<string, { pack: CatalogPack; url: string }>();
  for (const pack of bundled?.catalog.packs ?? []) classics.set(pack.id, { pack, url: BUNDLED_CATALOG_URL });
  // Preserve the custom catalog's precedence even though the downloads are concurrent.
  for (const pack of extra?.catalog.packs ?? []) classics.set(pack.id, { pack, url: custom });
  const lists = new Map<string, WordListPack>();
  for (const pack of wordLists ?? []) lists.set(pack.id, pack);
  const complete = Boolean(bundled && !bundled.offline && wordLists &&
    (custom === BUNDLED_CATALOG_URL || (extra && !extra.offline)));
  return { classics, lists, complete };
}

/** Stored catalog identity wins; a legacy bare id shared by both catalogs is not evidence. */
async function catalogTarget(record: PackRecord, extras: { source?: string; catalog?: "word-lists" | "public-books" } | null, maps: CatalogMaps) {
  const source = extras?.source === "custom" ? undefined : extras?.source;
  const id = source || record.packId;
  const ref = await bookCatalogRef({
    source, recorded: extras?.catalog, packId: record.packId,
    catalogOf: async (candidate) => {
      const classic = maps.classics.has(candidate);
      const list = maps.lists.has(candidate);
      return classic === list ? null : classic ? "public-books" : "word-lists";
    },
  });
  if (!ref) throw new Error(tr("discover.missingCatalogIdentity"));
  return {
    classic: ref === `public-books:${id}` ? maps.classics.get(id) : undefined,
    list: ref === `word-lists:${id}` ? maps.lists.get(id) : undefined,
  };
}

/**
 * Apply the current catalog list to one book already on the shelf. The reader tapped Update.
 * Throws on failure. A hand-edited list is left as it is.
 */
export async function updateInstalledBook(bookId: string): Promise<void> {
  const records = await listPackRecords();
  const record = uniqueBookRecord(records, bookId);
  if (!useVocab.getState().books.some((book) => book.id === bookId) || !record) throw new Error(tr("err.bookGone"));
  const extras = await loadBookExtras(bookId).catch(() => null);
  if (extras?.source === "custom") return;
  const maps = await loadCatalogMaps();
  try {
    const { classic, list } = await catalogTarget(record, extras, maps);
    if (classic) await downloadPack(classic.url, classic.pack, () => undefined, bookId);
    else if (list) await updateWordListBook({ ...record, packId: list.id }, list);
    else throw new Error(tr("err.downloadFailed"));
    useListUpdates.getState().clearFailure(`book:${record.bookId}`);
    markUpdated(record.packId);
  } catch (reason) {
    rememberFailure(record.packId, reason);
    rememberFailure(`book:${record.bookId}`, reason);
    throw reason;
  }
}

let toastId = 0;

/** The message at the bottom of the screen after the reader tapped Update. */
export function announceListUpdate(updated: string[], failed: number): void {
  if (updated.length === 0 && failed === 0) return;
  toastId += 1;
  useListUpdates.setState({ toast: { id: toastId, updated, failed } });
}

/**
 * The reader tapped Update (one card) or Update all (the shelf card). Books go one at a time,
 * so a slow or failing list does not hold up the others. `onStep` reports how many are done.
 * Never throws: a book that kept its old list is counted, and its card shows the reason.
 */
export async function updateInstalledBooks(
  books: readonly { bookId: string; title: string }[],
  onStep?: (done: number) => void,
): Promise<{ updated: string[]; failed: number }> {
  const updated: string[] = [];
  let failed = 0;
  for (const [index, book] of books.entries()) {
    try {
      await updateInstalledBook(book.bookId);
      updated.push(book.title);
    } catch {
      failed += 1;
    }
    onStep?.(index + 1);
  }
  announceListUpdate(updated, failed);
  return { updated, failed };
}

let running: Promise<void> | null = null;
let lastCheck: { key: string; at: number } | null = null;
function checkKey(): string {
  return JSON.stringify([bookDataGeneration(), sharedFetchGeneration(), getCatalogUrl(),
    useVocab.getState().books.map((book) => book.id).sort()]);
}

/** Unchanged navigation shares one check; mutations during it drain into the latest state. */
export function autoUpdateWordLists(): Promise<void> {
  if (running) return running;
  if (lastCheck?.key === checkKey() && Date.now() - lastCheck.at < SHARED_TEXT_MS) return Promise.resolve();
  running = (async () => {
    // Yield before scanning so every overlapping caller receives the draining promise.
    await Promise.resolve();
    for (;;) {
      const key = checkKey();
      const at = Date.now();
      const complete = await runUpdates(key).catch(() => false);
      if (key !== checkKey()) continue;
      if (complete) lastCheck = { key, at };
      break;
    }
  })().finally(() => { running = null; });
  return running;
}

async function runUpdates(key: string): Promise<boolean> {
  if (typeof navigator !== "undefined" && navigator.onLine === false) return false;
  const records = await listPackRecords();
  const onShelf = new Set(useVocab.getState().books.map((book) => book.id));
  const live = [...onShelf].map((id) => uniqueBookRecord(records, id)).filter((record): record is PackRecord => Boolean(record));
  if (live.length === 0) {
    if (key === checkKey()) useListUpdates.setState((prev) => ({ waiting: 0, finished: prev.finished + 1 }));
    return true;
  }

  const maps = await loadCatalogMaps();
  const { classics, lists } = maps;
  if (classics.size === 0 && lists.size === 0) return false;

  const holds: Record<string, ListHoldWhy> = {};
  const failures: Record<string, string> = {};
  const clear = new Set<string>();
  let complete = maps.complete;
  const unresolved = new Set<string>();
  const checked = new Set<string>();
  const waitingBooks = new Set<string>();
  for (const record of live) {
    const extras = await loadBookSummary(record.bookId, true);
    // A partial catalog cannot establish a legacy book's identity by absence.
    if (!maps.complete && !extras?.catalog) { unresolved.add(record.bookId); continue; }
    let target: Awaited<ReturnType<typeof catalogTarget>>;
    try { target = await catalogTarget(record, extras, maps); }
    catch (reason) {
      failures[`book:${record.bookId}`] = errorText(reason, "err.downloadFailed");
      complete = false;
      unresolved.add(record.bookId);
      continue;
    }
    const { classic, list } = target;
    if (!classic && !list) { complete = false; unresolved.add(record.bookId); continue; }
    checked.add(record.bookId);
    const catalogRev = classic ? classic.pack.rev : wordListRev(list as WordListPack);
    const catalogWords = list?.words ?? 0;
    // The revision string can already match while the stored list is an older file
    // (a cached copy paired under the new revision). The word count tells them apart.
    let installedWords: number | undefined;
    if (list && record.rev === catalogRev && catalogWords > 0) {
      installedWords = extras?.glossaryWords;
    }
    const countsMightDiffer =
      typeof installedWords === "number" && catalogWords > 0 && installedWords !== catalogWords;
    const shaDiffers = Boolean(classic?.pack.epub.sha256 && record.sha256 !== classic.pack.epub.sha256);
    if (record.rev === catalogRev && !countsMightDiffer && !shaDiffers) {
      clear.add(record.packId);
      clear.add(`book:${record.bookId}`);
      continue;
    }
    const plan = shaDiffers
      ? { kind: "manual" as const, why: extras?.source === "custom" ? "ownList" as const : "bookChanged" as const }
      : planListUpdate({
      installedRev: record.rev,
      catalogRev,
      listSource: extras?.source,
      installedSha: classic ? record.sha256 : "",
      catalogSha: classic ? classic.pack.epub.sha256 : "",
      installedWords,
      catalogWords,
    });
    if (plan.kind !== "manual") {
      if (record.rev === catalogRev) clear.add(record.packId);
      continue;
    }
    holds[record.packId] = plan.why;
    holds[`book:${record.bookId}`] = plan.why;
    if (plan.why !== "ownList") waitingBooks.add(record.bookId);
  }
  if (key !== checkKey()) return false;
  useListUpdates.setState((prev) => {
    const nextHolds = { ...prev.holds };
    const nextFailures = { ...prev.failures };
    for (const id of checked) delete nextHolds[`book:${id}`];
    for (const id of clear) { delete nextHolds[id]; delete nextFailures[id]; }
    for (const id of unresolved) {
      const why = prev.holds[`book:${id}`];
      if (why && why !== "ownList") waitingBooks.add(id);
    }
    return { holds: { ...nextHolds, ...holds }, failures: { ...nextFailures, ...failures }, finished: prev.finished + 1, waiting: waitingBooks.size };
  });
  return complete;
}
