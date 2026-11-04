import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import ts from "typescript";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { forgetSharedFetches, sessionSnapshot } from "../src/lib/shared-fetch.ts";

test("cover loading has no looping sweep animation", () => {
  const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
  assert.doesNotMatch(css, /\.cover-shimmer\s*\{|@keyframes cover-shimmer/);
});

test("display snapshots revalidate without losing the last success and reject obsolete publications", () => {
  const cache = sessionSnapshot();
  const old = cache.begin();
  assert.equal(cache.publish(old, ["old"]), true);
  const slow = cache.begin(), current = cache.begin();
  assert.equal(cache.publish(current, ["new"]), true);
  assert.equal(cache.publish(slow, ["stale"]), false);
  assert.deepEqual(cache.read(), ["new"]);
  const pending = cache.begin();
  forgetSharedFetches();
  assert.equal(cache.read(), undefined);
  assert.equal(cache.publish(pending, ["obsolete"]), false);
  assert.equal(cache.publish(cache.begin(), []), true);
  assert.deepEqual(cache.read(), [], "successful empty results clear old data");
});

test("real BookCover and useCovers retain remount state, respect lazy boundaries and refresh revisions", async () => {
  const dir = mkdtempSync(new URL("../node_modules/.cache/cover-remount-", import.meta.url));
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: "https://test.invalid" });
  const originals = new Map();
  const set = (name, value) => { originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name)); Object.defineProperty(globalThis, name, { value, writable: true, configurable: true }); };
  for (const key of ["window", "document", "Element", "HTMLElement", "Node", "Event"]) set(key, dom.window[key]);
  set("IS_REACT_ACT_ENVIRONMENT", true);
  let y = 0;
  dom.window.HTMLElement.prototype.getBoundingClientRect = () => ({ top: y, bottom: y + 100, left: 0, right: 100, width: 100, height: 100 });
  const observers = [];
  set("IntersectionObserver", class {
    constructor(callback) { this.callback = callback; observers.push(this); }
    observe() {}
    disconnect() {}
  });
  const rows = [{ id: "pack", title: "Book", author: "Author", cover: { url: "/cover.jpg", sha256: "a".repeat(64) } }];
  let fail = false, calls = 0;
  set("__coverFixture", {
    catalog: async () => { calls++; if (fail) throw Error("offline"); return { catalog: { packs: rows } }; },
    records: async () => [{ bookId: "book", packId: "pack" }],
  });
  let root;
  try {
    writeFileSync(join(dir, "package.json"), '{"type":"module"}');
    const shared = readFileSync(new URL("../src/lib/shared-fetch.ts", import.meta.url), "utf8");
    writeFileSync(join(dir, "shared.js"), ts.transpileModule(shared, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText);
    let source = readFileSync(new URL("../src/components/book-cover.tsx", import.meta.url), "utf8");
    source = source.replace(/^import .* from "@\/[^\n]+";$/gm, "");
    source = source.replace(/(import .* from "react";)/, '$1\nimport { sessionSnapshot } from "./shared.js";\nimport {listPackRecords, catalogRowOf, cloudCover, noteSpeechBooks, BUNDLED_CATALOG_URL, loadCatalog, resolveAgainst, loadWordListCatalog, WORD_LIST_CATALOG_URL, coverCrossOrigin, cn} from "./stubs.js";');
    writeFileSync(join(dir, "cover.js"), ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText);
    writeFileSync(join(dir, "stubs.js"), `
export const listPackRecords = () => globalThis.__coverFixture.records();
export const loadCatalog = () => globalThis.__coverFixture.catalog();
export const loadWordListCatalog = async () => [];
export const BUNDLED_CATALOG_URL = 'https://test.invalid/public-books/catalog.json';
export const WORD_LIST_CATALOG_URL = 'https://test.invalid/word-lists/catalog.json';
export const resolveAgainst = (base, url) => new URL(url, base).href;
export const catalogRowOf = (book, id, sources) => [...sources.classics,...sources.lists].find(r => id ? r.id === id : r.title === book.title && r.author === book.author);
export const cloudCover = (book, id, sources) => { const r = catalogRowOf(book,id,sources); return r?.cover?.url ? r.cover.url+'?v='+r.cover.sha256.slice(0,12) : ''; };
export const noteSpeechBooks = () => {};
export const coverCrossOrigin = () => 'anonymous';
export const cn = (...values) => values.filter(Boolean).join(' ');
`);
    const { BookCover, useCovers } = await import(pathToFileURL(join(dir, "cover.js")));
    const sharedModule = await import(pathToFileURL(join(dir, "shared.js")));
    const container = document.querySelector("#root");
    root = createRoot(container);
    const render = async (props) => act(async () => { root.render(React.createElement(BookCover, { title: "Book", author: "Author", ...props })); });
    const unmount = async () => act(async () => { root.render(null); });
    await render({ cover: "/cover?v=one" });
    assert.ok(container.querySelector("[data-cover-pending]"));
    assert.ok(!container.querySelector(".cover-shimmer"));
    assert.ok(!container.querySelector("img").className.includes("opacity-0"), "pending image is not artificially hidden");
    await unmount();
    await render({ cover: "/cover?v=one" });
    assert.ok(!container.querySelector(".cover-shimmer"), "switching away before load completes never restarts a shimmer");
    await act(async () => container.querySelector("img").dispatchEvent(new Event("load")));
    assert.ok(!container.querySelector("img").className.includes("transition-opacity"), "first load does not replay a presentation fade");
    await unmount();
    await render({ cover: "/cover?v=one", whenVisible: true });
    assert.ok(container.querySelector("img"), "visible remount resolves before paint");
    assert.equal(container.querySelector("img").getAttribute("loading"), "eager", "visibility gating must not be followed by a second lazy gate");
    assert.ok(!container.querySelector("[data-cover-pending]"));
    assert.ok(!container.querySelector("img").className.includes("opacity-0"));
    assert.ok(!container.querySelector("img").className.includes("transition-opacity"));
    await unmount();
    await render({ cover: "/cover?v=one" });
    assert.equal(container.querySelector("img").getAttribute("loading"), "eager", "remembered visible images avoid a new native lazy wait");
    await unmount();
    y = 5000;
    await render({ cover: "/cover?v=one", whenVisible: true });
    assert.equal(container.querySelector("img"), null, "seen but offscreen URLs still stay lazy");
    assert.ok(!container.querySelector(".cover-shimmer"), "offscreen wait is static");
    await act(async () => observers.at(-1).callback([{ isIntersecting: true }]));
    assert.ok(container.querySelector("img"));
    y = 0;
    await render({ cover: "/cover?v=two", whenVisible: true });
    assert.ok(container.querySelector("[data-cover-pending]"), "new revision loads normally");
    await act(async () => container.querySelector("img").dispatchEvent(new Event("error")));
    assert.ok(container.querySelector("[data-generated-cover]"));
    await unmount();
    await render({ cover: "/cover?v=two" });
    assert.ok(container.querySelector("[data-cover-pending]"), "failed image is not remembered as success");
    await unmount();
    await render({});
    assert.ok(container.querySelector("[data-generated-cover]"));

    const book = { id: "book", title: "Book", author: "Author" };
    const renders = [];
    function Shelf({ books }) { const covers = useCovers(books); renders.push(covers); return React.createElement("div", { "data-url": covers[books[0]?.id] ?? "" }); }
    const shelf = async (books) => act(async () => { root.render(React.createElement(Shelf, { books })); });
    await unmount();
    await shelf([book]);
    assert.match(container.firstChild.dataset.url, /v=aaaaaaaaaaaa/);
    await unmount();
    renders.length = 0;
    await shelf([book]);
    assert.match(renders[0].book, /v=aaaaaaaaaaaa/, "remount's first render has the known cover");
    fail = true;
    await unmount();
    await shelf([book]);
    assert.match(container.firstChild.dataset.url, /v=aaaaaaaaaaaa/, "failure preserves success");
    fail = false;
    rows[0] = { ...rows[0], cover: { url: "/cover.jpg", sha256: "b".repeat(64) } };
    await unmount();
    await shelf([book]);
    assert.match(container.firstChild.dataset.url, /v=bbbbbbbbbbbb/);
    await unmount();
    renders.length = 0;
    await shelf([{ ...book, title: "Different", author: "Someone else" }]);
    assert.equal(renders[0].book, undefined, "same id with different identity cannot inherit the old pack");
    rows.length = 0;
    await unmount();
    await shelf([book]);
    assert.equal(container.firstChild.dataset.url, "", "authoritative empty catalog removes old covers");
    const count = calls;
    await unmount();
    await shelf([]);
    assert.equal(calls, count, "empty shelf requests no catalogs");
    sharedModule.forgetSharedFetches();
    await unmount();
    renders.length = 0;
    await shelf([book]);
    assert.equal(renders[0].book, undefined, "explicit invalidation clears the display snapshot");
  } finally {
    if (root) await act(async () => root.unmount());
    dom.window.close();
    for (const [key, value] of originals) { if (value) Object.defineProperty(globalThis, key, value); else delete globalThis[key]; }
    rmSync(dir, { recursive: true, force: true });
  }
});
