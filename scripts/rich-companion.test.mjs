import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { findNoteSentence } from "../src/lib/note-sentence.ts";
import { loadAppModules } from "./lib/app-modules.mjs";

const { format, paragraphNote } = await loadAppModules();

test("validateGlossary accepts and cleans paragraph clues and 3-step sentence structure", () => {
  const checked = format.validateGlossary({
    version: 2,
    glossary: {
      consider: {
        pos: "verb",
        meaning: "To think carefully before choosing.",
        here: "Alice is weighing whether making a flower chain is worth standing up.",
        whyHard: "Watch out: here 'consider' means think over a choice, not 'regard as'.",
      },
    },
    paragraphs: [
      {
        chapter: 0,
        paragraph: 1,
        context: "So she was considering in her own mind",
        mainIdea: "Hot weather makes Alice too sleepy to get up for daisies, until a talking White Rabbit runs past.",
        simple: "Alice thought about making a flower chain, but the heat made her sleepy. Suddenly a White Rabbit ran past her.",
        clues: [
          "Pronoun clue: 'it' in 'think nothing of it' refers to seeing a rabbit pass by.",
          "Story tone: the narrator jokes that Alice is so sleepy that even a talking rabbit feels normal at first.",
        ],
        hardWords: ["consider", "daisy-chain"],
      },
    ],
    sentences: [
      {
        chapter: 0,
        context: "nor did Alice think it so VERY much out of the way",
        simple: "And Alice did not think it was very strange to hear the Rabbit talk to itself.",
        core: "Alice did not think it strange.",
        chunks: [
          "nor did Alice think... -> inverted after 'nor'; normal order is 'and Alice did not think...'",
          "it so VERY much out of the way -> 'it' is a dummy object pointing to the infinitive 'to hear the Rabbit say...'",
          "to hear the Rabbit say to itself -> the real thing Alice found normal at that sleepy moment",
        ],
        pattern: "nor + did + subject + base verb = 'and [subject] did not ... either' (negative inversion).",
      },
    ],
    phrases: {
      "out of the way": {
        pos: "idiom",
        meaning: "Unusual or surprising.",
        here: "Strange enough to surprise Alice.",
        whyHard: "Not about a physical road; here it means odd or unexpected.",
      },
    },
  });
  assert.equal(checked.ok, true, checked.errors.join("; "));
  assert.equal(checked.file?.paragraphs?.[0]?.clues?.length, 2);
  assert.equal(checked.file?.sentences?.[0]?.core, "Alice did not think it strange.");
  assert.equal(checked.file?.sentences?.[0]?.chunks?.length, 3);
  assert.match(checked.file?.sentences?.[0]?.pattern ?? "", /^nor \+ did/);
  assert.equal(
    checked.file?.phrases?.["out of the way"]?.whyHard,
    "Not about a physical road; here it means odd or unexpected.",
  );

  const cleanedPara = paragraphNote.cleanParagraphNote(checked.file?.paragraphs?.[0]);
  assert.equal(cleanedPara?.clues?.length, 2);
});

test("validateGlossary flags Chinese inside paragraph clues and sentence structure fields", () => {
  const checked = format.validateGlossary({
    version: 2,
    glossary: { lantern: { pos: "noun", meaning: "A portable lamp." } },
    paragraphs: [
      {
        chapter: 0,
        paragraph: 0,
        context: "carried a small brass lantern down",
        mainIdea: "He walks with a lamp.",
        simple: "He carried a small lamp down the road.",
        clues: ["Speaker clue with \u4e2d\u6587"],
      },
    ],
    sentences: [
      {
        chapter: 0,
        context: "carried a small brass lantern down",
        simple: "He carried a lamp.",
        core: "\u4e3b\u5e72 lamp",
      },
    ],
  });
  assert.equal(checked.ok, true);
  assert.deepEqual(checked.stats.chineseWords, ["paragraph 0/0", "sentence 0/1"]);
});

test("WordCard and HelpPanels enforce strict separation and full-sentence grammar resolution", () => {
  const card = readFileSync(new URL("../src/components/word-card.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(card, /data-word-here/);
  assert.doesNotMatch(card, /data-word-why-hard/);
  assert.doesNotMatch(card, /SentenceHint/);
  assert.match(card, /effectiveCanSave/);

  const panels = readFileSync(new URL("../src/components/help-panels.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(panels, /data-part="paragraph-clues"/);
  assert.doesNotMatch(panels, /data-part="sentence-core"/);
  assert.doesNotMatch(panels, /data-hard-word/);
  assert.match(panels, /data-part="grammar-help"/);
  assert.match(panels, /data-part="sentence-chunks"/);
  assert.match(panels, /data-part="sentence-pattern"/);

  const p1 =
    'Alice was beginning to get very tired of sitting by her sister on the bank, and of having nothing to do: once or twice she had peeped into the book her sister was reading, but it had no pictures or conversations in it, \u201cand what is the use of a book,\u201d thought Alice \u201cwithout pictures or conversations?\u201d';
  const span = findNoteSentence(p1, "Alice was beginning to get very tired of sitting by her sister on the bank");
  assert.ok(span);
  assert.equal(p1.slice(span.start, span.end), p1);
});
