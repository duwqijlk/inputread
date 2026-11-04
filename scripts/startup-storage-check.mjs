// Browser-side verification with synthetic local records only. Run through the preview console.
export async function verifyStartupStorage(db) {
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const id = "startup-storage-test";
  const glossary = { lantern: { pos: "noun", meaning: "A light.", whyHard: "" } };
  const book = { id, title: "Storage Fixture", author: "Fixture", chapters: [], glossary, pending: [], totalHard: 999 };
  const extras = { source: "fixture", catalog: "word-lists", rev: "r1", paragraphs: [], sentences: [], phrases: {} };
  const raw = async (mode, run) => {
    const connection = await new Promise((resolve, reject) => {
      const request = indexedDB.open("cibian-books", 3);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const tx = connection.transaction(["books", "notes"], mode);
    const done = new Promise((resolve, reject) => {
      tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
    });
    const value = await run(tx);
    await done;
    connection.close();
    return value;
  };
  const get = (store, key) => new Promise((resolve, reject) => {
    const request = store.get(key); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
  await db.deleteStoredBook(id);
  try {
    await db.saveBookExtras(id, extras);
    await db.saveStoredBook(book);
    let summary = await db.loadBookSummary(id, true);
    check(summary.glossaryWords === 1 && summary.source === "fixture", "save order preserves identity and counts actual glossary keys");
    await db.patchStoredBook(id, (meta) => { meta.glossary.second = glossary.lantern; meta.title = "Renamed"; });
    summary = await db.loadBookSummary(id, true);
    check(summary.glossaryWords === 2 && summary.title === "Renamed" && summary.catalog === "word-lists", "glossary patch updates summary without losing identity");
    await db.saveBookExtras(id, { ...extras, source: "custom" });
    summary = await db.loadBookSummary(id, true);
    check(summary.source === "custom" && summary.glossaryWords === 2, "extras update preserves glossary fields");

    await raw("readwrite", async (tx) => {
      tx.objectStore("notes").delete(`summary:${id}`);
    });
    summary = await db.loadBookSummary(id, true);
    check(summary.title === "Renamed" && summary.glossaryWords === 2 && summary.source === "custom", "legacy backfill reads current records");

    const reads = [];
    const originalGet = IDBObjectStore.prototype.get, originalAll = IDBObjectStore.prototype.getAll;
    IDBObjectStore.prototype.get = function (key) { reads.push({ store: this.name, operation: "get", key: String(key) }); return originalGet.apply(this, arguments); };
    IDBObjectStore.prototype.getAll = function (range) { reads.push({ store: this.name, operation: "getAll", key: range?.lower ?? null }); return originalAll.apply(this, arguments); };
    try {
      const summaries = await db.listBookSummaries();
      check(summaries.some((item) => item.id === id && item.title === "Renamed"), "stored summary listed");
      await db.loadBookSummary(id, true);
    } finally { IDBObjectStore.prototype.get = originalGet; IDBObjectStore.prototype.getAll = originalAll; }
    check(!reads.some((read) => read.operation === "getAll" && read.store === "notes" && read.key === null), "no unbounded notes read");
    check(!reads.some((read) => read.operation === "get" && /^(gloss:|extras:)/.test(read.key)), "warm listing and identity never read full payloads");

    await raw("readwrite", async (tx) => {
      const notes = tx.objectStore("notes");
      const meta = await get(notes, `gloss:${id}`);
      meta.title = "Changed by an older tab";
      notes.put(meta, `gloss:${id}`);
    });
    window.dispatchEvent(new StorageEvent("storage", { key: "cibian-notebook-v1", newValue: "legacy-change" }));
    for (let attempt = 0; attempt < 30; attempt++) {
      const value = await raw("readonly", (tx) => get(tx.objectStore("notes"), `summary:${id}`));
      if (!value) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    summary = await db.loadBookSummary(id, true);
    check(summary.title === "Changed by an older tab", "legacy tab signal invalidates derived fields");

    const before = await raw("readonly", (tx) => get(tx.objectStore("notes"), `gloss:${id}`));
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (value, key) {
      if (key === `summary:${id}`) throw new Error("injected projection failure");
      return put.apply(this, arguments);
    };
    let rejected = false;
    try { await db.patchStoredBook(id, (meta) => { meta.title = "Must roll back"; }); }
    catch { rejected = true; }
    finally { IDBObjectStore.prototype.put = put; }
    check(rejected, "projection failure propagates");
    const after = await raw("readonly", (tx) => get(tx.objectStore("notes"), `gloss:${id}`));
    check(JSON.stringify(before) === JSON.stringify(after), "glossary transaction rolls back with projection");

    // A legacy book with no glossary metadata still recovers from its original stored record once.
    await raw("readwrite", async (tx) => {
      tx.objectStore("notes").delete(`summary:${id}`);
      tx.objectStore("notes").delete(`gloss:${id}`);
    });
    summary = await db.loadBookSummary(id, true);
    check(summary.title === book.title && summary.glossaryWords === 1, "oldest stored book fallback remains readable");
    await Promise.all([db.loadBookSummary(id, true), db.deleteStoredBook(id)]);
    check(await db.loadBookSummary(id) === null, "concurrent deletion does not restore a stored book");
    check(!await raw("readonly", (tx) => get(tx.objectStore("notes"), `summary:${id}`)), "delete removes projection");
    const generation = db.bookDataGeneration();
    await db.savePackRecord({ bookId: id, packId: "fixture", rev: "r1", sha256: "", installedAt: 1 });
    await db.deletePackRecord(id);
    check(db.bookDataGeneration() === generation + 2, "pack changes invalidate checks after commit");
    return { passed: true, warmReads: reads, tests: ["writer-order", "patch", "custom-identity", "legacy-backfill", "bounded-warm-reads", "legacy-tab-invalidation", "atomic-rollback", "oldest-format", "delete-race", "pack-invalidation"] };
  } finally { await db.deleteStoredBook(id); }
}
