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
  "@/components/ui": { cn: (...parts) => parts.filter(Boolean).join(" "), SpeakButton: () => null, panel: { close: "close", closeIcon: "close-icon" } },
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
    assert.ok(container.textContent.includes("card.senses.signed"), "credited word renders signed layer header");
    assert.equal(received.community.credit, state.credit);
    assert.equal(received.community.meaning, state.meaning);
    await render({ state: { ...state, credit: undefined } });
    assert.ok(container.textContent.includes("card.senses.community"), "uncredited word renders community layer header");
    await render();
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

    const pending = new Map(); const lookups = []; const partials = new Map();
    stubs["@/lib/standard-dictionary"].lookupStandardWord = (word, partial) => {
      lookups.push(word); partials.set(word, partial);
      return new Promise(resolve => pending.set(word, resolve));
    };
    await render({ state: { ...state, surface: "Bank", key: "bank" }, selectionId: 10 });
    assert.equal(lookups.at(-1), "Bank", "query exact book spelling, never the legacy lowercase key");
    assert.equal(container.querySelector("h2").textContent, "Bank");
    const bankResult = { kind: "unmapped", senses: [{ id: "bank-existing", pos: "n", meaning: "Bank meaning" }] };
    await act(async () => partials.get('Bank')(bankResult));
    assert.equal(received.panel.resolution, bankResult, 'base senses draw before the final enrichment resolves');
    await act(async () => pending.get("Bank")(bankResult));
    assert.equal(received.panel.resolution, bankResult);
    assert.equal(received.panel.vote.eligibility, "unavailable");
    assert.ok(received.panel.communityContent);
    await render({ state: { ...state, surface: "London", key: "london" }, selectionId: 11 });
    assert.equal(container.querySelector("[data-test-panel]"), null, "old result never renders for the new target");
    await render({ state: { ...state, surface: "Us", key: "us" }, selectionId: 12 });
    await act(async () => partials.get('London')({ kind: 'unmapped', senses: [{ id: 'late-partial', pos: 'n', meaning: 'Late meaning' }] }));
    assert.equal(container.querySelector('[data-test-panel]'), null, 'late partial from prior target cannot flash');
    await act(async () => pending.get("London")({ kind: "unmapped", senses: [{ id: "london-existing", pos: "n", meaning: "London meaning" }] }));
    assert.equal(container.querySelector("[data-test-panel]"), null, "late previous response is ignored");
    await act(async () => pending.get("Us")({ kind: "ambiguous" }));
    assert.equal(container.querySelector("[data-dictionary-status]").textContent, "card.senses.ambiguous");
    assert.equal(container.querySelector("[data-test-panel]"), null);
    await render({ state: { ...state, surface: "BANK", key: "bank", meaning: "", ready: false, status: "unknown" }, selectionId: 13 });
    await act(async () => pending.get("BANK")(bankResult));
    assert.ok(received.panel.communityEditor, "unknown words retain real missing-meaning feedback");

    // Anti-jitter regression: when positionParagraphs + positionOffset are present (real catalog
    // books), wait for mappedPosition before mounting WordSensePanel so the card never flashes
    // temporary unmapped tabs/candidates and then collapses once the mapped sense arrives.
    let resolvePos;
    let resolveMap;
    stubs["@/lib/dictionary-positions"].dictionaryPosition = () => new Promise(r => { resolvePos = r; });
    stubs["@/lib/dictionary-positions"].mappedPosition = () => new Promise(r => { resolveMap = r; });
    const mappedResult = { kind: "unmapped", senses: [{ id: "bank-mapped-1", pos: "noun", meaning: "Mapped river edge", source: { lemma: "bank", release: "oewn-test" } }] };
    await render({
      state: { ...state, surface: "bank", key: "bank", positionParagraphs: ["We sat on the bank."], positionOffset: 14 },
      selectionId: 14,
    });
    await act(async () => pending.get("bank")(mappedResult));
    assert.equal(container.querySelector("[data-test-panel]"), null, "does not flash unmapped panel before position mapping settles");
    await act(async () => {
      resolvePos({ paragraphIndex: 0, offset: 14, surface: "bank" });
      for (let i = 0; i < 4 && !resolveMap; i += 1) await Promise.resolve();
      resolveMap({ lemma: "bank", senseId: "bank-mapped-1" });
    });
    assert.ok(container.querySelector("[data-test-panel]"), "mounts panel once position mapping settles");
    assert.equal(received.panel.resolution.kind, "mapped", "goes straight to mapped resolution without flashing unmapped");

    // Regression: irregular OEWN fallback ("ran" -> "run") passes senseId/standardLemma/positionKey
    // to resolveSaved, onToggle, and renders recall strips with + Save sentence cleanly.
    const posKeyCh1 = "a".repeat(64);
    const runResult = {
      kind: "unmapped",
      senses: [{ id: "oewn-run-v", pos: "verb", meaning: "Move fast by using one's feet.", source: { lemma: "run", release: "oewn-test" } }],
    };
    stubs["@/lib/dictionary-positions"].dictionaryPosition = async () => ({ paragraphIndex: 0, offset: 4, surface: "ran" });
    stubs["@/lib/dictionary-positions"].mappedPosition = async () => ({ lemma: "run", senseId: "oewn-run-v", positionKey: posKeyCh1 });
    let lastResolvedArg = null;
    let toggled = null;
    let addedSentence = null;
    let fakeStatus = { saved: false, status: "none" };
    await render({
      state: {
        ...state,
        surface: "ran",
        key: "ran",
        meaning: "",
        pos: "",
        ready: false,
        status: "unknown",
        positionParagraphs: ["She ran down the hall."],
        positionOffset: 4,
      },
      canSave: false,
      selectionId: 20,
      resolveSaved: (payload) => {
        lastResolvedArg = payload;
        return fakeStatus;
      },
      onToggle: (fallback, info) => {
        toggled = { fallback, info };
      },
      onAddSentence: (payload, info) => {
        addedSentence = { payload, info };
      },
    });
    await act(async () => pending.get("ran")(runResult));
    assert.equal(lastResolvedArg.lemma, "run");
    assert.equal(lastResolvedArg.senseId, "oewn-run-v");
    assert.equal(lastResolvedArg.standardLemma, "run");
    assert.equal(lastResolvedArg.positionKey, posKeyCh1);
    assert.equal(lastResolvedArg.fallbackOnly, true);
    const saveBtn = container.querySelector("[data-word-save]");
    assert.equal(saveBtn.disabled, false, "irregular OEWN fallback enables Heart");
    assert.equal(saveBtn.getAttribute("aria-pressed"), "false");
    await click(saveBtn);
    assert.equal(toggled.fallback.lemma, "run");
    assert.equal(toggled.fallback.senseId, "oewn-run-v");
    assert.equal(toggled.info.status, "none");

    // Same sense already saved in Ch 1 -> filled Heart + quiet recall strip + "+ Save sentence"
    fakeStatus = { saved: true, status: "saved-in-book", cardId: "card-run", recallScope: "chapter", recallLabel: "Chapter 1" };
    await render({
      state: {
        ...state,
        surface: "ran",
        key: "ran",
        meaning: "",
        pos: "",
        ready: false,
        status: "unknown",
        positionParagraphs: ["She ran down the hall."],
        positionOffset: 4,
      },
      canSave: false,
      selectionId: 20,
      resolveSaved: () => fakeStatus,
      onToggle: (fallback, info) => {
        toggled = { fallback, info };
      },
      onAddSentence: (payload, info) => {
        addedSentence = { payload, info };
      },
    });
    assert.equal(container.querySelector("[data-word-save]").getAttribute("aria-pressed"), "true");
    const recall = container.querySelector("[data-word-recall]");
    assert.ok(recall, "shows recall strip when saved earlier in the same book");
    assert.equal(recall.getAttribute("data-recall-status"), "saved-in-book");
    const addSentenceBtn = container.querySelector("[data-word-add-sentence]");
    assert.ok(addSentenceBtn, "offers + Save sentence action");
    await click(addSentenceBtn);
    assert.equal(addedSentence.payload.senseId, "oewn-run-v");
    assert.equal(addedSentence.info.cardId, "card-run");

    // Same sense saved in another book & mastered -> outline Heart + recall strip with mastered note
    fakeStatus = { saved: false, status: "saved-other-book", cardId: "card-run", recallScope: "book", recallLabel: "Alice", mastered: true };
    await render({
      state: {
        ...state,
        surface: "ran",
        key: "ran",
        meaning: "",
        pos: "",
        ready: false,
        status: "unknown",
        positionParagraphs: ["She ran down the hall."],
        positionOffset: 4,
      },
      canSave: false,
      selectionId: 20,
      resolveSaved: () => fakeStatus,
      onToggle: () => {},
      onAddSentence: () => {},
    });
    assert.equal(container.querySelector("[data-word-save]").getAttribute("aria-pressed"), "false");
    const otherRecall = container.querySelector("[data-word-recall]");
    assert.ok(otherRecall);
    assert.equal(otherRecall.getAttribute("data-recall-status"), "saved-other-book");
    assert.ok(otherRecall.textContent.includes("card.recall.mastered"));
    assert.equal(container.querySelector("[data-word-add-sentence]"), null, "other-book recall uses main Heart rather than duplicate button");
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of originals) descriptor ? Object.defineProperty(globalThis, key, descriptor) : delete globalThis[key];
  }
});
