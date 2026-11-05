/**
 * The admin book-metadata editor: draft rules, batch limits, baseline handling, and the small
 * amount of DOM behavior that matters on a phone (only books, labelled checkboxes, a 409 keeps
 * the draft). No production API is called.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import ts from "typescript";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";

const ROOT = new URL("..", import.meta.url);
const read = (path) => readFileSync(new URL(path, ROOT), "utf8");
const BASELINE = "m1:test";

function loadDraftModule() {
  const source = read("src/lib/book-metadata-draft.ts");
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const BOOK_GENRES = [
    "fantasy", "adventure", "mystery", "science-fiction", "realistic",
    "historical", "romance", "animals", "horror-thriller", "nonfiction",
  ];
  const isBookGenre = (value) => typeof value === "string" && BOOK_GENRES.includes(value);
  const genres = {
    BOOK_GENRES,
    isBookGenre,
    readBookGenres(value) {
      if (!Array.isArray(value)) return [];
      return [...new Set(value.filter(isBookGenre))].slice(0, 3);
    },
  };
  const previewBookMetadata = (book, change) => {
    const next = { ...book, genres: change.genres === undefined ? [...book.genres] : [...change.genres] };
    if (change.series !== undefined) next.series = change.series.replace(/\s+/g, " ").trim();
    if (!next.series) next.seriesNumber = 0;
    else if (change.seriesNumber !== undefined) next.seriesNumber = change.seriesNumber;
    return next;
  };
  const catalogId = {
    CATALOGS: ["word-lists", "public-books"],
    isCatalogName(value) {
      return value === "word-lists" || value === "public-books";
    },
  };
  const stubs = {
    "@/lib/book-genres": genres,
    "@/lib/book-metadata": {
      BOOK_METADATA_LIMIT: 60,
      BOOK_METADATA_BYTES: 32_000,
      isBookMetadataBaseline: (value) =>
        typeof value === "string" && value.startsWith("m1:") && value.length > 3 && value.length <= 8192,
      previewBookMetadata,
    },
    "@/lib/catalog-id": catalogId,
  };
  const module = { exports: {} };
  new Function("module", "exports", "require", js)(module, module.exports, (id) => stubs[id] ?? {});
  return module.exports;
}

const draft = loadDraftModule();

function book(id, extra = {}) {
  return {
    catalog: "word-lists",
    id,
    title: id,
    author: "Author",
    category: "novel",
    genres: [],
    series: "",
    seriesNumber: 0,
    baseline: BASELINE,
    ...extra,
  };
}

test("metadata responses are strict, deduplicated and can inherit the request catalog", () => {
  const rows = draft.readMetadataBooks({
    books: [
      book("one"),
      book("one"),
      { ...book("two"), catalog: "public-books", category: "speech" },
      { ...book("bad"), baseline: "" },
      { ...book("opaque"), baseline: 'm1:{"version":1}' },
      { ...book("bad-genres"), genres: ["fantasy", "unknown", "mystery", "romance", "animals"] },
      { ...book("bad-number"), seriesNumber: 120 },
    ],
  });
  assert.deepEqual(rows.map((row) => `${row.catalog}:${row.id}`), ["word-lists:one", "public-books:two", "word-lists:opaque", "word-lists:bad-genres"]);
  assert.equal(rows[2].baseline, 'm1:{"version":1}', "the baseline is an opaque m1 token");
  assert.deepEqual(rows[3].genres, ["fantasy", "mystery", "romance"], "unknown genres are dropped, known ones stay");
  assert.deepEqual(draft.readMetadataBooks({ books: [{ ...book("patch"), catalog: undefined }] }, "public-books").map((row) => row.catalog), ["public-books"]);
  assert.deepEqual(draft.readMetadataBooks({ books: [{ ...book("patch"), catalog: undefined }] }), []);
});

test("bulk genres add, remove, replace and clear without exceeding three", () => {
  const rows = [book("a", { genres: ["fantasy"] }), book("b", { genres: ["fantasy", "adventure", "mystery"] })];
  let drafts = draft.applyGenresToDrafts(rows, ["word-lists:a", "word-lists:b"], {}, "add", ["adventure"]).drafts;
  assert.deepEqual(drafts["word-lists:a"].genres, ["fantasy", "adventure"]);
  assert.equal(drafts["word-lists:b"], undefined, "a full row is left alone");
  const overflow = draft.applyGenresToDrafts(rows, ["word-lists:b"], {}, "add", ["romance"]);
  assert.equal(overflow.skipped, 1);
  assert.deepEqual(overflow.drafts, {});
  drafts = draft.applyGenresToDrafts(rows, ["word-lists:a"], drafts, "replace", ["romance", "animals"]).drafts;
  assert.deepEqual(drafts["word-lists:a"].genres, ["romance", "animals"]);
  drafts = draft.applyGenresToDrafts(rows, ["word-lists:a"], drafts, "remove", ["romance"]).drafts;
  assert.deepEqual(drafts["word-lists:a"].genres, ["animals"]);
  drafts = draft.applyGenresToDrafts(rows, ["word-lists:a"], drafts, "clear", []).drafts;
  assert.deepEqual(drafts["word-lists:a"], { genres: [] }, "clearing is a real change from the server value");
  assert.equal(
    draft.applyGenresToDrafts([book("empty")], ["word-lists:empty"], {}, "clear", []).drafts["word-lists:empty"],
    undefined,
    "clearing an already empty row leaves no draft",
  );
});

test("a bulk series change asks every changed row for its own number", () => {
  const rows = [
    book("one", { series: "Old", seriesNumber: 3 }),
    book("two"),
  ];
  let drafts = draft.applySeriesToDrafts(rows, ["word-lists:one", "word-lists:two"], {}, "New");
  assert.equal(drafts["word-lists:one"].series, "New");
  assert.ok(!drafts["word-lists:one"].numberConfirmed);
  assert.equal(draft.draftIssue(rows[0], drafts["word-lists:one"]), "number");
  assert.equal(draft.changeFor(rows[0], drafts["word-lists:one"]), null, "an unconfirmed number is never sent");
  drafts = draft.confirmSeriesNumber(rows, "word-lists:one", drafts, 3);
  assert.equal(drafts["word-lists:one"].numberConfirmed, true);
  assert.deepEqual(draft.changeFor(rows[0], drafts["word-lists:one"]), {
    id: "one",
    baseline: BASELINE,
    series: "New",
    seriesNumber: 3,
  });
  // A new non-empty series starts at 0 ("unknown") and never inherits the old number.
  assert.equal(draft.draftIssue(rows[1], drafts["word-lists:two"]), "number");
  drafts = draft.setRowSeriesNumber(rows, "word-lists:two", drafts, null);
  assert.equal(draft.draftIssue(rows[1], drafts["word-lists:two"]), null);
  assert.deepEqual(draft.changeFor(rows[1], drafts["word-lists:two"]), {
    id: "two",
    baseline: BASELINE,
    series: "New",
    seriesNumber: 0,
  });
  const numbered = draft.setRowSeriesNumber(rows, "word-lists:one", drafts, null);
  assert.equal(draft.draftIssue(rows[0], numbered["word-lists:one"]), null);
  assert.deepEqual(draft.changeFor(rows[0], numbered["word-lists:one"]), {
    id: "one",
    baseline: BASELINE,
    series: "New",
    seriesNumber: 0,
  });
});

test("series input keeps typed spaces while preview and publication normalize them", () => {
  const rows = [book("one")], key = "word-lists:one";
  let drafts = {};
  for (const letter of "Magic Tree House") {
    const input = (drafts[key]?.series ?? rows[0].series) + letter;
    drafts = draft.setRowSeries(rows, key, drafts, input);
    assert.equal(drafts[key].series, input, "controlled input must not swallow a trailing space");
  }
  drafts = draft.setRowSeries(rows, key, drafts, "  Magic   Tree House  ");
  drafts = draft.setRowSeriesNumber(rows, key, drafts, 1);
  assert.equal(drafts[key].series, "  Magic   Tree House  ");
  assert.equal(draft.changeFor(rows[0], drafts[key]).series, "Magic Tree House");
});

test("single-row edits become exact previews and only real changes are sent", () => {
  const rows = [book("one", { genres: ["fantasy"], series: "Old", seriesNumber: 2 })];
  const key = "word-lists:one";
  let drafts = draft.setRowGenres(rows, key, {}, ["adventure", "fantasy"]);
  assert.deepEqual(draft.previewDrafts(rows, drafts).map((item) => item.next.genres), [["adventure", "fantasy"]]);
  drafts = draft.setRowSeries(rows, key, drafts, "New");
  drafts = draft.setRowSeriesNumber(rows, key, drafts, 4);
  const change = draft.changeFor(rows[0], drafts[key]);
  assert.deepEqual(change, { id: "one", baseline: BASELINE, genres: ["adventure", "fantasy"], series: "New", seriesNumber: 4 });
  assert.deepEqual(draft.previewDrafts(rows, drafts)[0].next, {
    ...rows[0],
    genres: ["adventure", "fantasy"],
    series: "New",
    seriesNumber: 4,
  });
  assert.equal(draft.changeFor(rows[0], {}), null);
  assert.equal(draft.changeFor(rows[0], draft.setRowGenres(rows, key, {}, ["fantasy"])[key]), null);
  // Number-only 0 is an explicit "unknown" and clears the old number.
  const cleared = draft.setRowSeriesNumber(rows, key, {}, null);
  assert.deepEqual(draft.changeFor(rows[0], cleared[key]), { id: "one", baseline: BASELINE, seriesNumber: 0 });
});

test("changes are grouped by catalog and split into 60-row requests", () => {
  const rows = Array.from({ length: 61 }, (_, index) => book(`w${index}`));
  const drafts = Object.fromEntries(rows.map((row) => [draft.rowKey(row), { genres: ["fantasy"] }]));
  const chunks = draft.buildChunks(rows, drafts);
  assert.equal(chunks.length, 2);
  assert.deepEqual(chunks.map((chunk) => chunk.changes.length), [60, 1]);
  assert.ok(chunks.every((chunk) => chunk.catalog === "word-lists"));
  const mixed = [...rows.slice(0, 2), book("p", { catalog: "public-books" })];
  const mixedDrafts = Object.fromEntries(mixed.map((row) => [draft.rowKey(row), { genres: ["fantasy"] }]));
  assert.deepEqual(draft.buildChunks(mixed, mixedDrafts).map((chunk) => chunk.catalog), ["word-lists", "public-books"]);
});

test("long opaque baselines split by request bytes, not only by row count", () => {
  const long = "m1:" + "x".repeat(8000);
  const rows = Array.from({ length: 10 }, (_, index) => book(`long${index}`, { baseline: long }));
  const drafts = Object.fromEntries(rows.map((row) => [draft.rowKey(row), { genres: ["fantasy"] }]));
  const chunks = draft.buildChunks(rows, drafts);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) {
    assert.ok(chunk.changes.length <= 60);
    assert.ok(
      new TextEncoder().encode(JSON.stringify({ catalog: chunk.catalog, changes: chunk.changes })).length <= 32_000,
      "each request body stays under the API byte limit",
    );
  }
});

test("a saved chunk updates its baselines and clears only its own drafts", () => {
  const rows = [book("one"), book("two")];
  const drafts = { "word-lists:one": { genres: ["fantasy"] }, "word-lists:two": { genres: ["mystery"] } };
  const saved = [{ ...rows[0], genres: ["fantasy"], baseline: "m1:new" }];
  const merged = draft.mergeSaved(rows, saved, drafts);
  assert.equal(merged.rows[0].baseline, "m1:new");
  assert.deepEqual(merged.savedKeys, ["word-lists:one"]);
  assert.equal(merged.drafts["word-lists:one"], undefined);
  assert.deepEqual(merged.drafts["word-lists:two"], { genres: ["mystery"] });
});

test("only books, labelled checkboxes, a preview and a 409 that keeps the draft", async () => {
  const dir = mkdtempSync(new URL("../node_modules/.cache/book-metadata-admin-", import.meta.url));
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: "https://test.invalid" });
  const originals = new Map();
  const set = (name, value) => {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { value, writable: true, configurable: true });
  };
  for (const key of ["window", "document", "Element", "HTMLElement", "Node", "Event"]) set(key, dom.window[key]);
  set("IS_REACT_ACT_ENVIRONMENT", true);

  const rows = [
    { ...book("fantasy"), title: "Fantasy Book" },
    { ...book("series"), title: "Series Book", series: "S", seriesNumber: 1 },
    { ...book("talk"), title: "Speech Book", category: "speech" },
  ];
  let mode = "ok";
  let patchCalls = [];
  set("fetch", async (url, options = {}) => {
    if (options.method === "PATCH") {
      const body = JSON.parse(options.body);
      patchCalls.push(body);
      if (mode === "network") throw new TypeError("Disconnected");
      if (mode === "malformed") return { ok: true, status: 200, json: async () => ({ books: [] }) };
      if (mode === "conflict") {
        return { ok: false, status: 409, json: async () => ({ error: "metadata-conflict" }) };
      }
      const byId = new Map(rows.map((row) => [row.id, row]));
      return {
        ok: true,
        status: 200,
        json: async () => ({
          books: body.changes.map((change) => ({
            ...byId.get(change.id),
            ...(change.genres ? { genres: change.genres } : {}),
            ...(change.series !== undefined ? { series: change.series } : {}),
            ...(change.seriesNumber !== undefined ? { seriesNumber: change.seriesNumber } : {}),
            baseline: "m1:new",
          })),
        }),
      };
    }
    return { ok: true, status: 200, json: async () => ({ books: rows }) };
  });

  let root;
  try {
    writeFileSync(join(dir, "package.json"), '{"type":"module"}');
    writeFileSync(
      join(dir, "genres.js"),
      ts.transpileModule(read("src/lib/book-genres.ts"), {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
      }).outputText,
    );
    writeFileSync(
      join(dir, "meta.js"),
      `export const BOOK_METADATA_LIMIT = 60;
export const BOOK_METADATA_BYTES = 32000;
export const isBookMetadataBaseline = (value) =>
  typeof value === "string" && value.startsWith("m1:") && value.length > 3 && value.length <= 8192;
export const previewBookMetadata = (book, change) => {
  const next = { ...book, genres: change.genres === undefined ? [...book.genres] : [...change.genres] };
  if (change.series !== undefined) next.series = change.series.replace(/\\s+/g, " ").trim();
  if (!next.series) next.seriesNumber = 0;
  else if (change.seriesNumber !== undefined) next.seriesNumber = change.seriesNumber;
  return next;
};`,
    );
    writeFileSync(
      join(dir, "helper-stubs.js"),
      `export { isBookGenre, readBookGenres, BOOK_GENRES } from "./genres.js";
export { BOOK_METADATA_LIMIT, BOOK_METADATA_BYTES, isBookMetadataBaseline, previewBookMetadata } from "./meta.js";
export const isCatalogName = (value) => value === "word-lists" || value === "public-books";`,
    );
    let helper = read("src/lib/book-metadata-draft.ts");
    helper = ts.transpileModule(helper, {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    }).outputText.replace(/from\s+"@\/lib\/[\w-]+"/g, 'from "./helper-stubs.js"');
    writeFileSync(join(dir, "draft.js"), helper);
    writeFileSync(
      join(dir, "stubs.js"),
      `import React from "react";
export * from "./draft.js";
export { BOOK_GENRES } from "./genres.js";
export const useT = () => ({
  t: (key, params) => (params ? key + " " + JSON.stringify(params) : key),
  tn: (base, n) => base + " " + n,
});
export const forgetSharedFetches = () => {};
export const btn = { primary: "primary", quiet: "quiet", ghost: "ghost", danger: "danger", icon: "icon", bare: "bare" };
export const field = "field";
export const selectCls = "select";
export const cn = (...parts) => parts.filter(Boolean).join(" ");
export const ConfirmDialog = ({ open, onConfirm, confirmLabel }) =>
  open ? React.createElement("button", { "data-confirm": "", onClick: onConfirm }, confirmLabel) : null;
export const Check = () => null;
export const ChevronDown = () => null;
export const ChevronRight = () => null;
export const RefreshCw = () => null;
export const Save = () => null;
export const Search = () => null;
export const Tags = () => null;
export const X = () => null;`,
    );
    let component = read("src/components/book-metadata-admin.tsx");
    component = component.replace(/import\s+\{[^}]*\}\s+from\s+"(?:@\/|lucide-react)[^"]*";\s*/g, "");
    component = component.replace(
      /(import\s+\{[\s\S]*?\}\s+from\s+"react";)/,
      '$1\nimport { useT, forgetSharedFetches, BOOK_GENRES, MAX_GENRES, MAX_SELECTION, applyGenresToDrafts, applySeriesToDrafts, buildChunks, draftCount, draftGenres, draftIssue, draftSeries, draftSeriesNumber, mergeSaved, pendingIssues, previewDrafts, readMetadataBooks, resetRowDraft, rowKey, setRowGenres, setRowSeries, setRowSeriesNumber, btn, cn, ConfirmDialog, field, selectCls, Check, ChevronDown, ChevronRight, RefreshCw, Save, Search, Tags, X } from "./stubs.js";',
    );
    writeFileSync(
      join(dir, "component.js"),
      ts.transpileModule(component, {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
      }).outputText,
    );
    const { BookMetadataAdmin } = await import(pathToFileURL(join(dir, "component.js")));
    const container = document.querySelector("#root");
    root = createRoot(container);
    const render = async () => {
      await act(async () => {
        root.render(React.createElement(BookMetadataAdmin));
      });
      for (let i = 0; i < 30 && !container.querySelector("[data-metadata-row]"); i += 1) {
        await act(async () => {
          await Promise.resolve();
        });
      }
    };
    await render();
    assert.equal(container.querySelectorAll("table").length, 0);
    const titles = [...container.querySelectorAll("[data-metadata-title]")].map((node) => node.textContent);
    assert.deepEqual(titles, ["Fantasy Book", "Series Book"], "speeches are not classified here");
    const checkbox = container.querySelector("[data-metadata-select]");
    assert.ok(checkbox.getAttribute("aria-label"), "row checkbox has an accessible name");

    await act(async () => checkbox.click());
    await act(async () => container.querySelector('[data-metadata-bulk-genre="fantasy"]').click());
    await act(async () => container.querySelector("[data-metadata-apply-genres]").click());
    assert.ok(container.querySelector("[data-metadata-preview-row]"));
    assert.match(container.querySelector("[data-metadata-draft-count]").textContent, /1/);

    await act(async () => container.querySelector("[data-metadata-save]").click());
    await act(async () => container.querySelector("[data-confirm]").click());
    for (let i = 0; i < 30 && patchCalls.length === 0; i += 1) {
      await act(async () => {
        await Promise.resolve();
      });
    }
    assert.equal(patchCalls.length, 1);
    assert.equal(patchCalls[0].catalog, "word-lists");
    assert.equal(patchCalls[0].changes.length, 1);
    assert.equal(patchCalls[0].changes[0].id, "fantasy");
    assert.deepEqual(patchCalls[0].changes[0].genres, ["fantasy"]);
    for (let i = 0; i < 30 && container.querySelector("[data-metadata-preview]"); i += 1) {
      await act(async () => {
        await Promise.resolve();
      });
    }
    assert.equal(container.querySelector("[data-metadata-preview]"), null, "saved rows leave the draft");

    // A conflict keeps the draft and shows the conflict, never silently replacing it.
    mode = "conflict";
    patchCalls = [];
    await act(async () => container.querySelector("[data-metadata-select]").click());
    await act(async () => container.querySelector('[data-metadata-bulk-genre="adventure"]').click());
    await act(async () => container.querySelector("[data-metadata-apply-genres]").click());
    await act(async () => container.querySelector("[data-metadata-save]").click());
    await act(async () => container.querySelector("[data-confirm]").click());
    for (let i = 0; i < 30 && patchCalls.length === 0; i += 1) {
      await act(async () => {
        await Promise.resolve();
      });
    }
    assert.equal(patchCalls.length, 1);
    assert.match(container.querySelector("[data-metadata-error]").textContent, /admin\.metadata\.conflict/);
    assert.ok(container.querySelector("[data-metadata-preview]"), "the draft survives a 409");
    assert.equal(container.querySelector("[data-metadata-save]").disabled, true, "a conflict cannot be retried with a silently refreshed baseline");
    for (const failure of ["malformed", "network"]) {
      await act(async () => root.render(null));
      await render();
      mode = failure;
      await act(async () => container.querySelector("[data-metadata-select]").click());
      await act(async () => container.querySelector('[data-metadata-bulk-genre="fantasy"]').click());
      await act(async () => container.querySelector("[data-metadata-apply-genres]").click());
      await act(async () => container.querySelector("[data-metadata-save]").click());
      await act(async () => container.querySelector("[data-confirm]").click());
      assert.equal(container.querySelector("[data-metadata-save]").disabled, true, `${failure} outcome requires reconciliation`);
      assert.ok(container.querySelector("[data-metadata-preview]"), "unknown outcomes keep drafts for inspection");
      assert.ok(container.querySelector("[data-metadata-reconcile]"));
    }
  } finally {
    if (root) await act(async () => root.unmount());
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
