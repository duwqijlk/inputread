import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("../src/lib/discover-shelf.ts", import.meta.url), "utf8");
const titleSource = readFileSync(new URL("../src/lib/book-title.ts", import.meta.url), "utf8");
const compile = (text) => ts.transpileModule(text, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const dataUrl = (text) => `data:text/javascript,${encodeURIComponent(text)}`;
const identitySource = readFileSync(new URL("../src/lib/catalog-shelf-identity.ts", import.meta.url), "utf8");
const identityUrl = dataUrl(compile(identitySource)
  .replace('"@/lib/book-meta"', JSON.stringify(dataUrl(compile(readFileSync(new URL("../src/lib/book-meta.ts", import.meta.url), "utf8")))))
  .replace('"@/lib/book-title"', JSON.stringify(dataUrl(compile(titleSource))))
  .replace('"@/lib/shelf-identity"', JSON.stringify(dataUrl(compile(readFileSync(new URL("../src/lib/shelf-identity.ts", import.meta.url), "utf8"))
    .replace('"@/lib/book-meta"', JSON.stringify(dataUrl(compile(readFileSync(new URL("../src/lib/book-meta.ts", import.meta.url), "utf8")))))))));
const { sameCatalogBook, planSafeShelfMerges, uniqueBookRecord, relinkMislabelled } = await import(identityUrl);
const { discoverShelfBook, createDiscoverShelfLookup } = await import(dataUrl(compile(source)
  .replace('"@/lib/catalog-shelf-identity"', JSON.stringify(identityUrl))));

const row = { id: "sample", title: "The Lantern Seller", author: "A. Sample Writer" };
const book = (extra = {}) => ({ ...row, id: "synced-card", source: "epub", ...extra });

test("snapshot lookup reuses matches across genre visits and retains collision guards", () => {
  const mine = book();
  const wanted = { ...row, catalog: "word-lists" };
  const lookup = createDiscoverShelfLookup([mine], [], [wanted]);
  const first = lookup(wanted);
  assert.equal(first.book, mine);
  assert.equal(lookup(wanted), first, "the same snapshot does not rematch a book on each render");
  const next = createDiscoverShelfLookup([], [], [wanted]);
  assert.equal(next(wanted).book, undefined, "changed shelf data gets a fresh lookup");
  const other = { ...row, catalog: "public-books" };
  const collision = createDiscoverShelfLookup([mine], [], [wanted, other]);
  assert.equal(collision(wanted).ambiguous, true);
  assert.equal(collision(other).ambiguous, true);
});

test("repeated filter visits do not rescan a large shelf snapshot", () => {
  let titleReads = 0;
  const shelf = Array.from({ length: 150 }, (_, index) => ({
    id: `shelf-${index}`, source: "epub", author: "Writer",
    get title() { titleReads++; return `Book ${index}`; },
  }));
  const catalog = Array.from({ length: 260 }, (_, index) => ({ id: `catalog-${index}`, title: `Book ${index}`, author: "Writer", catalog: "word-lists" }));
  const lookup = createDiscoverShelfLookup(shelf, [], catalog);
  for (const row of catalog.slice(0, 24)) lookup(row);
  const initialReads = titleReads;
  assert.ok(initialReads > 0);
  for (let visit = 0; visit < 20; visit++) for (const row of catalog.slice(0, 24)) lookup(row);
  assert.equal(titleReads, initialReads, "already seen cards reuse safe identity matches instead of rescanning shelf titles");
});

test("a synced shelf book remains held with no local install record", () => {
  for (const extra of [{}, { source: "notes", needsEpub: true }]) {
    const mine = book(extra);
    const found = discoverShelfBook([mine], [], row);
    assert.equal(found.book, mine);
    assert.equal(found.record, undefined, "membership must not fabricate an install record");
  }
});

test("direct installs retain their actual record and shelf identity", () => {
  const mine = book({ title: "Old display title" });
  const record = { bookId: mine.id, packId: row.id, rev: "original" };
  assert.deepEqual(discoverShelfBook([mine], [record], row), { book: mine, record });
});

test("legacy installs match by identity without rewriting their pack id", () => {
  const mine = book();
  const record = { bookId: mine.id, packId: "legacy-pack", rev: "original" };
  const found = discoverShelfBook([mine], [record], row);
  assert.equal(found.book, mine);
  assert.equal(found.record, record);
  assert.equal(found.record.packId, "legacy-pack");
});

test("unrelated books and legacy notebooks are not treated as catalog installs", () => {
  for (const mine of [book({ author: "Other Author" }), book({ source: "notes", needsEpub: false })]) {
    assert.equal(discoverShelfBook([mine], [], row).book, undefined);
  }
});

test("multiple matching shelf ids fail closed rather than preferring a stored card", () => {
  const waiting = book({ id: "waiting", needsEpub: true, source: "notes" });
  const ready = book({ id: "ready" });
  const record = { bookId: ready.id, packId: "legacy" };
  assert.equal(discoverShelfBook([waiting, ready], [record], row).book, undefined);
});

test("a removed install record alone is not shelf membership", () => {
  const record = { bookId: "deleted", packId: row.id, rev: "old" };
  assert.deepEqual(discoverShelfBook([], [record], row), { book: undefined, record: undefined });
});

test("recordless recovery preserves real subtitles, valid ISBN conflicts and empty titles", () => {
  const wanted = { ...row, title: "The Lantern Seller: Winter", isbn: "9780306406157" };
  for (const extra of [
    { title: "The Lantern Seller: Summer" },
    { title: wanted.title, isbn: "9780140328721" },
    { title: "", isbn: wanted.isbn },
  ]) assert.equal(discoverShelfBook([book(extra)], [], wanted).book, undefined);
  assert.equal(discoverShelfBook([book({ title: "The Lantern Seller: A Novel" })], [], row).book?.id, "synced-card");
  assert.equal(sameCatalogBook({ ...row, title: "" }, { ...row, title: "" }), false);
});

test("direct records ignore orphans, deduplicate ids and reject competing live targets", () => {
  const mine = book();
  const actual = { bookId: mine.id, packId: row.id, rev: "current" };
  const orphan = { ...actual, bookId: "gone", rev: "old" };
  assert.deepEqual(discoverShelfBook([mine], [orphan, actual, actual], row), { book: mine, record: actual });
  const other = book({ id: "another" });
  assert.equal(discoverShelfBook([mine, other], [actual, { ...actual, bookId: other.id }], row).book, undefined);
  assert.equal(uniqueBookRecord([actual, { ...actual, packId: "different" }], mine.id), undefined);
  assert.equal(discoverShelfBook([mine, mine], [], row).book, mine);
});

const entry = (id, extra = {}) => ({ ...book(), id, stored: false, needsEpub: true,
  work: 1, createdAt: 1, updatedAt: 1, catalogIds: [], ...extra });
test("repair protects unstored cards with distinct subtitles, ISBNs or explicit catalog ids", () => {
  for (const pair of [
    [entry("a", { title: "Series: Volume One" }), entry("b", { title: "Series: Volume Two" })],
    [entry("a", { isbn: "9780306406157" }), entry("b", { isbn: "9780140328721" })],
    [entry("a", { catalogIds: [{ id: "one" }] }), entry("b", { catalogIds: [{ id: "two" }] })],
    [entry("a", { catalogIds: [{ id: "one" }, { id: "two" }] }), entry("b")],
    [entry("a", { catalogIds: [{ id: "one", catalog: "word-lists" }] }), entry("b", { catalogIds: [{ id: "one", catalog: "public-books" }] })],
  ]) assert.deepEqual(planSafeShelfMerges(pair), []);
  assert.equal(planSafeShelfMerges([entry("a"), entry("b", { title: "The Lantern Seller: A Novel" })]).length, 1);
});

test("a metadata-poor card cannot bridge conflicting catalog identities", () => {
  assert.deepEqual(planSafeShelfMerges([
    entry("unknown"), entry("one", { catalogIds: [{ id: "one" }] }),
    entry("two", { catalogIds: [{ id: "two" }] }),
  ]), []);
});

test("explicit catalog identities separate identical raw ids; legacy collisions fail closed", () => {
  const privateBook = book({ id: "private" });
  const publicBook = book({ id: "public" });
  const records = [
    { bookId: "private", packId: row.id, catalog: "word-lists" },
    { bookId: "public", packId: row.id, catalog: "public-books" },
  ];
  const wanted = { ...row, catalog: "word-lists", catalogCollision: true };
  assert.equal(discoverShelfBook([privateBook, publicBook], records, wanted).book, privateBook);
  assert.equal(discoverShelfBook([privateBook], [{ bookId: "private", packId: row.id }], wanted).ambiguous, true);
  assert.equal(discoverShelfBook([publicBook], [records[1]], wanted).book, undefined);
  assert.equal(discoverShelfBook([book({ id: "a" }), book({ id: "b" })], [], row).ambiguous, true);
});

test("a card an older rule re-labelled as another volume is put back, and only when certain", () => {
  const vol = (n, from, to) => ({
    id: `englishpod-365-vol-${n}-lessons-${from}-${to}`,
    title: `EnglishPod - Complete Transcripts (365 Lessons) Vol ${n} (Lessons ${from}-${to})`,
    author: "EnglishPod",
    isbn: "",
    catalog: "word-lists",
  });
  const catalog = [vol(1, 1, 70), vol(2, 71, 140), vol(3, 141, 210)];
  // The Vol 2 card, whose one record was overwritten with Vol 3 when Vol 3 was added.
  const vol2Card = { id: "card-vol2", title: catalog[1].title, author: "EnglishPod" };
  const wrong = { bookId: "card-vol2", packId: catalog[2].id, rev: "r", sha256: "", installedAt: 1, catalog: "word-lists" };
  const fixes = relinkMislabelled([vol2Card], [wrong], catalog);
  assert.equal(fixes.length, 1);
  assert.equal(fixes[0].packId, catalog[1].id, "the record names Vol 2 again");
  // After the fix Discover sees Vol 2 on the shelf and Vol 3 not, so Vol 3 opens nothing wrong.
  const fixed = { ...wrong, packId: fixes[0].packId };
  const lookup = createDiscoverShelfLookup([vol2Card], [fixed], catalog);
  assert.equal(lookup(catalog[1]).book?.id, "card-vol2");
  assert.equal(lookup(catalog[2]).book, undefined, "Vol 3 is not held: adding it makes its own card");

  // Left alone: a correct record, a made-up pack id, a card that matches no book or two, a book another card holds.
  const right = { ...wrong, packId: catalog[1].id };
  assert.deepEqual(relinkMislabelled([vol2Card], [right], catalog), []);
  assert.deepEqual(relinkMislabelled([vol2Card], [{ ...wrong, packId: "my-own-pack" }], catalog), [], "an imported pack id is not checked");
  assert.deepEqual(relinkMislabelled([{ ...vol2Card, title: "Something else" }], [wrong], catalog), []);
  assert.deepEqual(relinkMislabelled([vol2Card], [wrong], [...catalog, { ...catalog[1], id: "duplicate-vol2" }]), [], "two exact matches: not certain");
  const otherCard = { id: "card-other", title: catalog[1].title, author: "EnglishPod" };
  const held = { bookId: "card-other", packId: catalog[1].id, rev: "r", sha256: "", installedAt: 1, catalog: "word-lists" };
  assert.deepEqual(relinkMislabelled([vol2Card, otherCard], [wrong, held], catalog), [], "Vol 2 already has a card");
  assert.deepEqual(relinkMislabelled([], [wrong], catalog), [], "a record of a card no longer on the shelf");
});

test("adding a word list never reuses a card that is plainly another volume", () => {
  const place = readFileSync(new URL("../src/lib/place-word-list.ts", import.meta.url), "utf8");
  assert.match(place, /if \(record\.packId !== pack\.id\) return false;[\s\S]*?return !card \|\| sameBook\(card, wanted\);/);
  const discover = readFileSync(new URL("../src/components/discover.tsx", import.meta.url), "utf8");
  assert.match(discover, /const fixes = relinkMislabelled\(/, "Discover puts re-labelled cards back before drawing them");
  assert.match(discover, /await savePackRecord\(\{ \.\.\.record, packId: fix\.packId \}\);/);
});
