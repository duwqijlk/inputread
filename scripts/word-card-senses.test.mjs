import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import ts from "typescript";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";

const require = createRequire(import.meta.url);
const source = readFileSync(new URL("../src/components/word-card.tsx", import.meta.url), "utf8");
const received = { community: null, panel: null };
const icon = () => React.createElement("svg");
const stubs = {
  "lucide-react": { Heart: icon, Image: icon, Menu: icon, Sparkles: icon, X: icon },
  "@/assets/merriam-webster-logo.png": "logo.png",
  "@/lib/glossary-format": { countSurface: (word) => word.toLowerCase() },
  "@/lib/standard-dictionary": { lookupStandardWord: async () => null },
  "@/lib/dictionary-positions": { dictionaryPosition: async () => null, mappedPosition: async () => null },
  "@/lib/dictionary-choices": { useDictionaryChoices: () => ({ vote: { eligibility: "unavailable", selectedId: null, pending: false }, onVote() {} }) },
  "@/lib/i18n": { useT: () => ({ t: (key) => key }) },
  "@/lib/lookup-links": { LOOKUP_SITES: ["longman", "webster", "images"], lookupUrl: (site, word) => `https://example.invalid/${site}/${word}` },
  "@/lib/text": { surfaceOffset: () => 0 },
  "@/components/floating-card": { FloatingAside: ({ children }) => React.createElement("aside", { "data-word-card": true }, children) },
  "@/components/help-panels": { SentenceHint: () => null },
  "@/components/side-panel": { SIDE_PANEL: "" },
  "@/components/ui": { cn: (...parts) => parts.filter(Boolean).join(" "), SpeakButton: () => null },
  "@/components/credit-line": { CreditLine: () => null },
  "@/components/word-feedback": { WordMeaning: (props) => { received.community = props; return React.createElement("div", { "data-test-community": true }, props.meaning); } },
  "@/components/word-sense-panel": { WordSensePanel: (props) => { received.panel = props; const [tab, setTab] = React.useState("recommended"); return React.createElement("button", { "data-test-panel": true, onClick: () => setTab("dictionary") }, tab); } },
  "@/components/word-ipa": { WordIpa: () => null },
  "@/components/word-lookup-menu": { WordLookupMenu: ({ word, open, onOpenChange }) => React.createElement("div", null,
    React.createElement("button", { "data-word-more": true, "aria-expanded": open, onClick: () => onOpenChange(!open) }),
    open ? React.createElement("nav", { "data-word-lookup-menu": true }, ...["longman", "webster", "images"].map(site => React.createElement("a", { key: site, "data-lookup": site, href: `https://example.invalid/${site}/${word}` }))) : null) },
  "virtual:local-ipa-data": { version: "test" },
};
const module = { exports: {} };
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
new Function("module", "exports", "require", js)(module, module.exports, (id) => {
  if (Object.hasOwn(stubs, id)) return stubs[id];
  assert.ok(["react", "react/jsx-runtime"].includes(id), `Unexpected dependency ${id}`);
  return require(id);
});
const { WordCard } = module.exports;

test("real WordCard retains community identity and accepts a typed sense panel", async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: "https://test.invalid" });
  const originals = new Map();
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const container = document.querySelector("#root");
  const root = createRoot(container);
  const state = { surface: "banks", key: "bank", pos: "noun", meaning: "A river side.", whyHard: "", sentence: "We sat on the bank.", ready: true, status: "ready", credit: "reader123456", senseIndex: 2, occurrence: 4, paragraph: 7, chapter: 3, glossaryRev: "book-revision" };
  const base = { state, saved: false, phrase: null, targetMode: "word", phrasePending: false, onTargetChange() {}, selectionId: 1, canSave: true, bookId: "device-book", catalogId: "word-lists:public-book", chapter: 3, noList: false, anchor: null, onClose() {}, onToggle() {} };
  const render = async (props = {}) => { received.community = received.panel = null; await act(async () => root.render(React.createElement(WordCard, { ...base, ...props }))); };
  const click = async (element) => act(async () => element.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })));
  try {
    await render();
    assert.ok(container.textContent.includes("card.senses.community"));
    assert.equal(received.community.credit, state.credit);
    assert.equal(received.community.meaning, state.meaning);
    assert.equal(received.community.target.senseIndex, 2, "legacy index remains feedback evidence, not a standard ID");
    assert.equal(received.community.target.catalogId, base.catalogId);
    assert.equal(received.community.target.occurrence, 4);
    assert.equal(received.community.target.paragraph, 7);
    assert.equal(container.querySelector("[data-word-footer]"), null);
    assert.equal(container.querySelector("[data-word-lookup-menu]"), null);
    await click(container.querySelector("[data-word-more]"));
    assert.ok(container.querySelector("[data-word-lookup-menu]"));
    assert.equal(container.querySelectorAll("[data-lookup]").length, 3);
    await render({ selectionId: 2 });
    assert.equal(container.querySelector("[data-word-lookup-menu]"), null);

    const phrase = { key: "river bank", matched: "river bank", entry: { meaning: "Land beside a river.", pos: "noun", credit: "phrase123456" } };
    await render({ phrase, targetMode: "phrase" });
    assert.equal(received.community.credit, phrase.entry.credit);
    assert.equal(received.community.part, "phrase-meaning");
    assert.equal(received.community.target.senseIndex, -1);
    assert.equal(received.community.target.word, phrase.key);

    await render({ state: { ...state, meaning: "", ready: false, status: "unknown", credit: undefined } });
    assert.ok(!container.textContent.includes("card.senses.community"));
    assert.equal(received.community.missing, true);
    assert.equal(received.community.credit, undefined);

    const panel = { resolution: { kind: "mapped", sense: { id: "test-existing-sense", pos: "noun", meaning: "A river side." } }, vote: { eligibility: "verified", selectedId: null, pending: false }, onVote() {}, onWrite() {} };
    await render({ sensePanel: panel });
    assert.equal(received.community, null, "no duplicate legacy/community body");
    assert.equal(received.panel.resolution, panel.resolution);
    await click(container.querySelector("[data-test-panel]"));
    assert.equal(container.querySelector("[data-test-panel]").textContent, "dictionary");
    await render({ sensePanel: panel, selectionId: 3 });
    assert.equal(container.querySelector("[data-test-panel]").textContent, "recommended", "new selection remounts view state");
    await render({ compactLookups: false });
    assert.ok(container.querySelector("[data-word-footer]"), "explicit old footer remains supported");

    const pending = new Map(); const lookups = [];
    stubs["@/lib/standard-dictionary"].lookupStandardWord = (word) => {
      lookups.push(word);
      return new Promise(resolve => pending.set(word, resolve));
    };
    await render({ state: { ...state, surface: "Bank", key: "bank" }, selectionId: 10 });
    assert.equal(lookups.at(-1), "Bank", "query exact book spelling, never the legacy lowercase key");
    assert.equal(container.querySelector("h2").textContent, "Bank");
    const bankResult = { kind: "unmapped", senses: [{ id: "bank-existing", pos: "n", meaning: "Bank meaning" }] };
    await act(async () => pending.get("Bank")(bankResult));
    assert.equal(received.panel.resolution, bankResult);
    assert.equal(received.panel.vote.eligibility, "unavailable");
    assert.ok(received.panel.communityContent);
    await render({ state: { ...state, surface: "London", key: "london" }, selectionId: 11 });
    assert.equal(container.querySelector("[data-test-panel]"), null, "old result never renders for the new target");
    await render({ state: { ...state, surface: "Us", key: "us" }, selectionId: 12 });
    await act(async () => pending.get("London")({ kind: "unmapped", senses: [{ id: "london-existing", pos: "n", meaning: "London meaning" }] }));
    assert.equal(container.querySelector("[data-test-panel]"), null, "late previous response is ignored");
    await act(async () => pending.get("Us")({ kind: "ambiguous" }));
    assert.equal(container.querySelector("[data-dictionary-status]").textContent, "card.senses.ambiguous");
    assert.equal(container.querySelector("[data-test-panel]"), null);
    await render({ state: { ...state, surface: "BANK", key: "bank", meaning: "", ready: false, status: "unknown" }, selectionId: 13 });
    await act(async () => pending.get("BANK")(bankResult));
    assert.ok(received.panel.communityEditor, "unknown words retain real missing-meaning feedback");
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of originals) descriptor ? Object.defineProperty(globalThis, key, descriptor) : delete globalThis[key];
  }
});
