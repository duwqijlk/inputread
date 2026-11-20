import { isbnDigits } from "@/lib/book-meta";
import { normalizeTitle } from "@/lib/book-title";
import { rankEntries, sameAuthor, type Identity, type MergePlan, type ShelfEntry } from "@/lib/shelf-identity";
import type { CatalogName } from "@/lib/catalog-id";

/** Catalog recovery must not use the broad main-title keys used by older import flows. */
export function sameCatalogBook(a: Identity, b: Identity): boolean {
  const titleA = normalizeTitle(a.title);
  const titleB = normalizeTitle(b.title);
  if (!titleA || !titleB) return false;
  const isbnA = isbnDigits(a.isbn);
  const isbnB = isbnDigits(b.isbn);
  if (isbnA && isbnB && isbnA !== isbnB) return false;
  return titleA === titleB && sameAuthor(a.author, b.author);
}

type RecordIdentity = { bookId: string; packId: string };

type CatalogRow = Identity & { id: string; catalog: CatalogName };

/**
 * Cards whose pack record names the wrong catalog book, and the book it should name.
 *
 * An older shelf rule took different volumes for one book: their titles shortened to the same main
 * title ("EnglishPod - ... Vol 2 (...)" and "... Vol 3 (...)" both became "EnglishPod"), so adding
 * Vol 3 with Vol 2 on the shelf re-labelled the Vol 2 card as Vol 3 (one record per card, overwritten)
 * and opening Vol 3 opened Vol 2. A record is put back only when it is certain: the card's own title
 * does not match the book its record names, exactly one catalog book of the same catalog matches the
 * card's title and author exactly, and no other live card already holds that book. Anything less
 * certain is left alone; nothing is deleted and no card is touched but its record.
 */
export function relinkMislabelled<R extends RecordIdentity & { catalog?: CatalogName }>(
  shelf: Array<Identity & { id: string }>,
  records: R[],
  catalog: CatalogRow[],
): Array<{ record: R; packId: string }> {
  const cards = new Map(shelf.map((book) => [book.id, book]));
  const fixes: Array<{ record: R; packId: string }> = [];
  for (const record of records) {
    const card = cards.get(record.bookId);
    if (!card) continue;
    const rows = catalog.filter((row) => !record.catalog || row.catalog === record.catalog);
    const named = rows.find((row) => row.id === record.packId);
    // A made-up pack id (an imported pack) names no catalog book: nothing to check against.
    if (!named || sameCatalogBook(card, named)) continue;
    const matches = rows.filter((row) => sameCatalogBook(card, row));
    if (matches.length !== 1) continue;
    const target = matches[0]!;
    if (target.id === record.packId) continue;
    const taken = records.some((other) => other !== record && other.packId === target.id && cards.has(other.bookId));
    if (taken) continue;
    fixes.push({ record, packId: target.id });
  }
  return fixes;
}

/** Multiple rows for one target are harmless; conflicting identities are not. */
export function uniqueBookRecord<R extends RecordIdentity>(records: R[], bookId: string): R | undefined {
  const matches = records.filter((record) => record.bookId === bookId);
  return new Set(matches.map((record) => record.packId)).size === 1 ? matches[0] : undefined;
}

type RepairEntry = ShelfEntry & { catalogIds: { id: string; catalog?: string }[] };

function compatible(a: RepairEntry, b: RepairEntry): boolean {
  if (!sameCatalogBook(a, b)) return false;
  const identities = [...a.catalogIds, ...b.catalogIds];
  if (new Set(identities.map((identity) => identity.id)).size > 1) return false;
  const catalogs = identities.map((identity) => identity.catalog).filter(Boolean);
  if (new Set(catalogs).size > 1) return false;
  return true;
}

/** Every pair must agree: a metadata-poor card must not bridge two distinct volumes. */
export function planSafeShelfMerges(entries: RepairEntry[]): MergePlan[] {
  const groups: RepairEntry[][] = [];
  for (const entry of entries) {
    const matches = groups.filter((group) => group.some((other) => compatible(entry, other)));
    if (matches.length === 0) groups.push([entry]);
    else {
      const joined = [entry, ...matches.flat()];
      for (const group of matches) groups.splice(groups.indexOf(group), 1);
      groups.push(joined);
    }
  }
  return groups.filter((group) => group.length > 1 && group.every((entry, index) =>
    group.slice(index + 1).every((other) => compatible(entry, other)),
  )).map((group) => {
    const [keep, ...drop] = rankEntries(group) as [ShelfEntry, ...ShelfEntry[]];
    return { keep, drop };
  });
}
