import { sameCatalogBook, uniqueBookRecord } from "@/lib/catalog-shelf-identity";
import type { Identity } from "@/lib/shelf-identity";
import type { CatalogName } from "@/lib/catalog-id";

type ShelfBook = Identity & { id: string; source?: string; needsEpub?: boolean };
type InstallRecord = { bookId: string; packId: string; catalog?: CatalogName; listSource?: string };
type Wanted = Identity & { id: string; catalog?: CatalogName; catalogCollision?: boolean };

const ABSENT = { book: undefined, record: undefined } as const;
const AMBIGUOUS = { book: undefined, record: undefined, ambiguous: true } as const;

type ShelfIndex<B extends ShelfBook, R extends InstallRecord> = {
  live: Map<string, B>;
  liveList: B[];
  byTargetId: Map<string, R[]>;
  byBookId: Map<string, R[]>;
  uniqueByBookId: Map<string, R | undefined>;
  known: Set<string>;
};

function buildShelfIndex<B extends ShelfBook, R extends InstallRecord>(shelf: B[], records: R[]): ShelfIndex<B, R> {
  const live = new Map<string, B>();
  for (const book of shelf) live.set(book.id, book);
  const liveList = [...live.values()];
  const byTargetId = new Map<string, R[]>();
  const byBookId = new Map<string, R[]>();
  const known = new Set<string>();
  for (const record of records) {
    const own = byBookId.get(record.bookId);
    if (own) own.push(record);
    else byBookId.set(record.bookId, [record]);
    if (!live.has(record.bookId)) continue;
    known.add(record.bookId);
    const targetId = record.listSource && record.listSource !== "custom" ? record.listSource : record.packId;
    const list = byTargetId.get(targetId);
    if (list) list.push(record);
    else byTargetId.set(targetId, [record]);
  }
  const uniqueByBookId = new Map<string, R | undefined>();
  for (const bookId of live.keys()) {
    uniqueByBookId.set(bookId, uniqueBookRecord(byBookId.get(bookId) ?? [], bookId));
  }
  return { live, liveList, byTargetId, byBookId, uniqueByBookId, known };
}

function lookupWithIndex<B extends ShelfBook, R extends InstallRecord>(
  index: ShelfIndex<B, R>,
  wanted: Wanted,
): { book: B | undefined; record: R | undefined; ambiguous?: boolean } {
  if (index.live.size === 0) return { ...ABSENT };
  const sameCatalog = (record: R) => !wanted.catalog || !record.catalog || wanted.catalog === record.catalog;
  const rawCandidates = index.byTargetId.get(wanted.id);
  const candidates = rawCandidates ? rawCandidates.filter(sameCatalog) : [];
  if (wanted.catalogCollision && candidates.some((record) => !record.catalog)) return { ...AMBIGUOUS };
  if (candidates.length > 0) {
    const directIds = new Set(candidates.map((record) => record.bookId));
    if (directIds.size > 1) return { ...AMBIGUOUS };
    const bookId = [...directIds][0]!;
    const record = index.uniqueByBookId.get(bookId);
    return record ? { book: index.live.get(bookId), record } : { ...AMBIGUOUS };
  }
  const hits = index.liveList.filter((book) => {
    const own = index.byBookId.get(book.id);
    if (own?.some((record) => !sameCatalog(record))) return false;
    return (index.known.has(book.id) || book.source === "epub" || book.needsEpub) && sameCatalogBook(book, wanted);
  });
  if (hits.length > 1) return { ...AMBIGUOUS };
  if (hits.length === 0) return { ...ABSENT };
  if (wanted.catalogCollision) return { ...AMBIGUOUS };
  const book = hits[0]!;
  const unique = index.uniqueByBookId.get(book.id);
  if (index.known.has(book.id) && !unique) return { ...AMBIGUOUS };
  return { book, record: unique };
}

/** One catalog/shelf snapshot serves every filter visit; matching rules remain in one place. */
export function createDiscoverShelfLookup<B extends ShelfBook, R extends InstallRecord, W extends Wanted>(
  shelf: B[], records: R[], catalog: W[],
): (wanted: W) => ReturnType<typeof discoverShelfBook<B, R>> {
  if (shelf.length === 0) return () => ({ ...ABSENT });
  const kinds = new Map<string, Set<CatalogName | undefined>>();
  for (const row of catalog) {
    const group = kinds.get(row.id) ?? new Set<CatalogName | undefined>();
    group.add(row.catalog);
    kinds.set(row.id, group);
  }
  const index = buildShelfIndex(shelf, records);
  const cache = new Map<W, ReturnType<typeof discoverShelfBook<B, R>>>();
  return (wanted) => {
    let result = cache.get(wanted);
    if (!result) {
      result = lookupWithIndex(index, {
        ...wanted,
        catalogCollision: wanted.catalogCollision || (kinds.get(wanted.id)?.size ?? 0) > 1,
      });
      cache.set(wanted, result);
    }
    return result;
  };
}

/** Shelf membership survives sync; an ambiguous target is not an invitation to install. */
export function discoverShelfBook<B extends ShelfBook, R extends InstallRecord>(
  shelf: B[], records: R[], wanted: Wanted,
): { book: B | undefined; record: R | undefined; ambiguous?: boolean } {
  return lookupWithIndex(buildShelfIndex(shelf, records), wanted);
}
