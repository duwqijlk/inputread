import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { readBookGenres } from "../src/lib/book-genres.ts";

const require = createRequire(import.meta.url);
const source = readFileSync(new URL("../src/components/discover-browse.tsx", import.meta.url), "utf8");
const node = (tag) => ({ children }) => React.createElement(tag, null, children);
const labels = { "browse.genreLabel": "Genres", "genre.fantasy": "Fantasy", "genre.adventure": "Adventure", "genre.mystery": "Mystery" };
const stubs = {
  "@radix-ui/react-dialog": Object.fromEntries(["Root", "Portal", "Overlay", "Content", "Close", "Title", "Description"].map((key) => [key, node(key === "Title" ? "h2" : "div")])),
  "lucide-react": new Proxy({}, { get: () => () => null }),
  "@/components/floating-card": { useSheetDrag() {} },
  "@/components/book-cover": { BookCover: () => null, coverLookOf: () => "book", talkCoverTone: () => "" },
  "@/lib/cover-tone": { useBookTone: () => ({}) },
  "@/lib/motion": { bump() {} },
  "@/components/ui": { cn: (...values) => values.filter(Boolean).join(" "), btn: {} },
  "@/lib/library-totals": { groupDigits: String },
  "@/lib/lexile": { lexileMeasure: () => "" },
  "@/lib/i18n": { useT: () => ({ locale: "en", t: (key) => labels[key] ?? key }) },
  "@/lib/book-blurbs": { useBookBlurb: () => "" },
  "@/components/book-maintainers": { BookMaintainerList: () => null },
  "@/lib/catalog-id": { catalogRef: (catalog, id) => `${catalog}:${id}` },
  "@/lib/page-meta": { SITE: "https://test.invalid" },
  "@/lib/book-genres": { readBookGenres },
};
const module = { exports: {} };
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
new Function("module", "exports", "require", js)(module, module.exports, (id) => stubs[id] ?? require(id));
const { BookDetail } = module.exports;
const base = { id: "sample", key: "list:sample", title: "Sample", author: "Author", kind: "list", category: "novel" };
const render = (extra) => renderToStaticMarkup(React.createElement(BookDetail, { row: { ...base, ...extra }, model: { state: "off", lexile: "" }, canAdd: false, onClose() {}, onAction() {}, onOpen() {}, onRemove() {} }));

test("real detail displays translated genres once, with at most three valid values", () => {
  const html = render({ genres: ["fantasy", "unknown", "fantasy", "adventure", "mystery", "romance"] });
  assert.equal((html.match(/data-detail-genre=/g) ?? []).length, 3);
  assert.match(html, />Fantasy<.*>Adventure<.*>Mystery</);
  assert.doesNotMatch(html, /unknown|Romance/);
});

test("old unclassified books and speeches do not show an empty genre section", () => {
  for (const extra of [{}, { genres: [] }, { genres: ["unknown"] }, { category: "speech", genres: ["fantasy"] }]) {
    assert.doesNotMatch(render(extra), /data-detail-genres/);
  }
});
