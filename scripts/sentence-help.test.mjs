/**
 * Sentence notes from a word list must reach the reader. A sentence note lights the bulb of the
 * paragraph that holds its sentence, and the paragraph panel lists it; the word card only shows one
 * small line that opens that panel. The original sentence panel was written with the first import
 * and never rendered, so a published sentence note showed nowhere.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { loadAppModules } from "./lib/app-modules.mjs";

const { help } = await loadAppModules();

// The shape of a live note: the book text has soft hyphens, and the note has no grammar line.
const sentence = "Work­ing with the sit­u­a­tion of the ve­hi­cle.";
const note = {
  chapter: 0,
  context: "Working with the situation of the vehicle.",
  simple: "She is dealing with the car's problem.",
};

test("a sentence note is found by its context inside the tapped sentence", () => {
  assert.equal(help.pickSentenceHelp([note], 0, sentence)?.simple, "She is dealing with the car's problem.");
  assert.equal(help.pickSentenceHelp([note], 0, "Reach out and touch someone."), null);
});

test("a note whose chapter is another edition's index still finds its sentence", () => {
  // The context decides; the chapter number only breaks ties between notes that both fit.
  assert.equal(help.pickSentenceHelp([note], 7, sentence)?.simple, "She is dealing with the car's problem.");
});

test("a paragraph lists the sentence notes inside it, in reading order", () => {
  const second = { chapter: 0, context: "Reach out and touch someone.", simple: "Call someone." };
  const paragraph = `(Video) Woman: Reach out and touch someone. ${sentence}`;
  assert.deepEqual(
    help.sentenceNotesIn([note, second], 0, paragraph).map((n) => n.simple),
    ["Call someone.", "She is dealing with the car's problem."],
  );
  assert.deepEqual(help.sentenceNotesIn([note], 0, "A paragraph without it."), []);
  // An ordinary extra page has no fixed chapter: no sentence note there.
  assert.deepEqual(help.sentenceNotesIn([note], -1, paragraph), []);
  // A note for a recovered extra matches only that extra.
  const extra = { ...note, chapter: "x2" };
  assert.equal(help.sentenceNotesIn([extra], "x2", paragraph).length, 1);
  assert.equal(help.sentenceNotesIn([extra], 0, paragraph).length, 0);
});

test("paragraph and chapter scoping prevent duplicate sentence note attachment while preserving shifted-edition fallback", () => {
  const line = "Oh dear, I shall be late for the party tonight.";
  const chapterTexts = [line, "A quiet bridge paragraph.", line];
  const scoped = { chapter: 0, paragraph: 2, context: "I shall be late for the party", simple: "She is late." };
  // Home paragraph 2 matches -> paragraph 0 with identical dialogue does NOT duplicate the note.
  assert.equal(help.sentenceNotesIn([scoped], 0, chapterTexts[0], { paragraph: 0, chapterTexts }).length, 0);
  assert.equal(help.sentenceNotesIn([scoped], 0, chapterTexts[2], { paragraph: 2, chapterTexts }).length, 1);

  // Shifted paragraph edition (extra paragraph inserted at top, moving target to index 3) still falls back cleanly.
  const shiftedTexts = ["Editor note.", "Intro.", "A quiet bridge paragraph.", line];
  assert.equal(help.sentenceNotesIn([scoped], 0, shiftedTexts[3], { paragraph: 3, chapterTexts: shiftedTexts }).length, 1);

  // Cross-chapter: when home chapter 0 already has the sentence, chapter 1 with the same refrain does not steal it.
  const bookChapters = [[line], [line]];
  assert.equal(help.sentenceNotesIn([scoped], 1, line, { paragraph: 0, chapterTexts: [line], bookChapters }).length, 0);

  // Shifted-chapter edition: when chapter 0 no longer has the sentence, chapter 1 can still rescue it.
  const movedChapters = [["Preface added in another edition."], [line]];
  assert.equal(help.sentenceNotesIn([scoped], 1, line, { paragraph: 0, chapterTexts: [line], bookChapters: movedChapters }).length, 1);
});

test("word card and paragraph panel stay strictly separated without cross-jump links", () => {
  const card = readFileSync(new URL("../src/components/word-card.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(card, /SentenceHint/);
  assert.doesNotMatch(card, /onSentenceHelp/);
  const panel = readFileSync(new URL("../src/components/help-panels.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(panel, /data-hard-word/);
  const reader = readFileSync(new URL("../src/components/reader.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(reader, /pickFromParagraph/);
  assert.match(reader, /loadParagraphHelpView\(/);
});

test("the panel marks the explained sentences in the page and keeps them in view", () => {
  const panel = readFileSync(new URL("../src/components/help-panels.tsx", import.meta.url), "utf8");
  assert.match(panel, /<SentenceMarks[\s\S]*?paragraphEl=\{paragraphEl\}[\s\S]*?chosen=\{chosen\}/);
  assert.match(panel, /noteSentenceRange\(paragraphEl, context\)/);
  // Drawn into the body: inside the transformed sheet a fixed box is placed against the sheet.
  assert.match(panel, /createPortal\(/);
  assert.match(panel, /setAttribute\("data-help-keep", ""\)/);
  const reader = readFileSync(new URL("../src/components/reader.tsx", import.meta.url), "utf8");
  assert.match(reader, /onRevealSentence=\{revealAboveSheet\}/);
  const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
  assert.match(css, /\.book-body \{\s*\/\*[\s\S]*?\*\/\s*position: relative;\s*z-index: 2;/, "the text sits above the marks");
});

test("paragraph, grammar, and reader sentence help stay in separate tabs with full-sentence headers", () => {
  const panel = readFileSync(new URL("../src/components/help-panels.tsx", import.meta.url), "utf8");
  assert.match(panel, /data-part="paragraph-help"[\s\S]*?data-part="main-idea"[\s\S]*?<HelpSource credit=\{paragraph\.credit\} \/>/);
  assert.match(panel, /data-part="grammar-help"[\s\S]*?<GrammarNote/);
  assert.match(panel, /data-part="sentences"[\s\S]*?<SentenceNote/);
  const source = panel.slice(panel.indexOf("function HelpSource"), panel.indexOf("function splitChunk"));
  assert.match(source, /if \(!credit\) return null;/, "an explanation from the word list carries no label");
  assert.match(source, /data-help-source="reader"/);
  assert.match(source, /<CreditLine id=\{credit\} \/>/);
  assert.doesNotMatch(source, /useContributor|person\.|XCrun/, "source kind must not depend on loaded public profiles or a nickname");
  const sentence = panel.slice(panel.indexOf("function SentenceNote"), panel.indexOf("type MarkBox"));
  assert.match(sentence, /<TargetSentenceButton sentence=\{note\.sentence\}[\s\S]*?data-part="easier"[\s\S]*?<HelpSource credit=\{note\.credit\} \/>/);
  assert.match(panel, /role="tablist"[\s\S]*?data-part="help-tabs"/);
  assert.match(panel, /data-part="help-footer"/);
});

test("the help mark is an empty span after the last word, drawn by CSS, with no scroll measuring", () => {
  const panel = readFileSync(new URL("../src/components/help-panels.tsx", import.meta.url), "utf8");
  const marks = panel.slice(panel.indexOf("export function ParagraphMarks"), panel.indexOf("export type ParagraphPanelState"));
  assert.match(marks, /createElement\("span"\)/);
  assert.doesNotMatch(marks, /textContent|createTextNode|innerText|innerHTML/, "the mark must stay empty: its text would join the paragraph's");
  assert.doesNotMatch(marks, /addEventListener\("scroll"|ResizeObserver|requestAnimationFrame|getBoundingClientRect/, "nothing is measured");
  const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
  assert.match(css, /\.book-body \[data-para-marker\]::before \{\s*content: "\\2726";/);
});
