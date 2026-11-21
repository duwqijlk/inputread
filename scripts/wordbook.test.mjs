// The global wordbook: per-book cards become one list, sources merge by lemma, the schedule is untouched.
import assert from "node:assert/strict";
import { test } from "node:test";
import { applyReview } from "../src/lib/srs.ts";
import { bookSyncKey } from "../src/lib/sync-merge.ts";
import {
  addSourceTo,
  bookForSource,
  countFromBook,
  countsByBookKey,
  hasSourceFrom,
  matchSavedWord,
  mergeCards,
  mergeSources,
  migrateWords,
  rehomeForeignSources,
  savedFromCard,
  sourceKey,
  withoutBook,
  withoutSource,
  wordCardKey,
  MAX_SOURCES,
} from "../src/lib/wordbook.ts";

const alice = { id: "a1", title: "Alice's Adventures in Wonderland", author: "Lewis Carroll" };
const peter = { id: "p1", title: "Peter Pan", author: "J. M. Barrie" };
const keyA = bookSyncKey(alice);
const keyP = bookSyncKey(peter);

const old = (bookId, lemma, extra = {}) => ({
  id: `${bookId}-${lemma}`,
  bookId,
  surface: lemma,
  lemma,
  pos: "adjective",
  meaning: `meaning of ${lemma}`,
  whyHard: "",
  recommend: true,
  sentence: `A sentence with ${lemma} in ${bookId}.`,
  stage: 0,
  dueAt: 1000,
  createdAt: 1000,
  reps: 0,
  lapses: 0,
  ...extra,
});

const source = (book, sentence, extra = {}) => ({
  book,
  title: book === keyA ? alice.title : peter.title,
  author: "x",
  sentence,
  surface: "faint",
  savedAt: 1,
  ...extra,
});

test("per-book cards become one list: one card per lemma, a source per book", () => {
  const list = migrateWords(
    [old("a1", "faint"), old("p1", "faint"), old("a1", "glimmer")],
    [alice, peter],
  );
  assert.equal(list.length, 2);
  const faint = list.find((word) => word.lemma === "faint");
  assert.deepEqual(faint.sources.map((s) => s.book).sort(), [keyA, keyP].sort());
  assert.equal(faint.sources.find((s) => s.book === keyA).title, alice.title);
  assert.equal(hasSourceFrom(faint, keyP), true);
  assert.equal(countFromBook(list, alice), 2);
  assert.equal(countFromBook(list, peter), 1);
});

test("the card with more review progress keeps its schedule, the other only adds its source", () => {
  const reviewed = applyReview(old("a1", "faint", { stage: 0 }), true, 5000);
  const merged = migrateWords([old("p1", "faint"), reviewed], [alice, peter]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].stage, reviewed.stage);
  assert.equal(merged[0].dueAt, reviewed.dueAt);
  assert.equal(merged[0].reps, reviewed.reps);
  assert.equal(merged[0].sources.length, 2);
});

test("migration is safe to run again on its own output", () => {
  const once = migrateWords([old("a1", "faint"), old("p1", "faint")], [alice, peter]);
  const twice = migrateWords(once, [alice, peter]);
  assert.deepEqual(twice, once);
});

test("a card whose book is gone from the shelf keeps a source with an empty title", () => {
  const [word] = migrateWords([old("gone", "faint")], []);
  assert.equal(word.sources.length, 1);
  assert.equal(word.sources[0].title, "");
  assert.equal(word.sources[0].sentence, "A sentence with faint in gone.");
});

test("saving the same lemma again adds a source and never touches the schedule", () => {
  const [card] = migrateWords([old("a1", "faint", { stage: 3, reps: 4 })], [alice]);
  const next = addSourceTo(card, source(keyP, "Faint in Peter Pan."));
  assert.equal(next.stage, 3);
  assert.equal(next.reps, 4);
  assert.equal(next.sources.length, 2);
});

test("a sense stored on only one copy of a save is kept", () => {
  const plain = source(keyA, "The same sentence here.", { at: { chapter: 1, paragraph: 0, quote: "The same sentence here", offset: 0 } });
  const sensed = source(keyA, "The same sentence here.", { meaning: "A small light.", pos: "singular noun" });
  const list = mergeSources([plain], [sensed]);
  assert.equal(list.length, 1);
  assert.equal(list[0].meaning, "A small light.");
  assert.equal(list[0].pos, "singular noun");
  assert.ok(list[0].at);
});

test("the same save twice is one source, and the more detailed copy is kept", () => {
  const plain = source(keyA, "The same sentence here.");
  const placed = { ...plain, chapter: 2, chapterTitle: "Chapter 3", at: { chapter: 2, paragraph: 4, quote: "The same sentence here", offset: 0 } };
  const list = mergeSources([plain], [placed]);
  assert.equal(list.length, 1);
  assert.equal(list[0].chapter, 2);
  assert.ok(list[0].at);
});

test("a word keeps at most MAX_SOURCES places, the newest", () => {
  const many = Array.from({ length: MAX_SOURCES + 5 }, (_, i) => source(keyA, `Sentence number ${i} with a long enough start.`, { savedAt: i + 1 }));
  const list = mergeSources(many, []);
  assert.equal(list.length, MAX_SOURCES);
  assert.equal(list[list.length - 1].savedAt, MAX_SOURCES + 5);
});

test("taking a word out of one book keeps it while another book still has it", () => {
  const [card] = migrateWords([old("a1", "faint"), old("p1", "faint")], [alice, peter]);
  const rest = withoutBook(card, keyA);
  assert.ok(rest);
  assert.deepEqual(rest.sources.map((s) => s.book), [keyP]);
  assert.equal(withoutBook(rest, keyP), null);
});

test("mergeCards unites sources and keeps the earliest save date", () => {
  const a = { ...migrateWords([old("a1", "faint", { createdAt: 500 })], [alice])[0] };
  const b = { ...migrateWords([old("p1", "faint", { createdAt: 900, reps: 2, stage: 2 })], [peter])[0] };
  const merged = mergeCards(a, b);
  assert.equal(merged.createdAt, 500);
  assert.equal(merged.reps, 2);
  assert.equal(merged.sources.length, 2);
});

const place = (surface, sentence, meaning, pos, chapterTitle) => ({
  book: keyA,
  title: alice.title,
  author: alice.author,
  sentence,
  surface,
  meaning,
  pos,
  chapterTitle,
  savedAt: 1,
});

test("a place from another word moves off the card and onto that word", () => {
  const queer = {
    ...old("a1", "queer", {
      surface: "queer",
      pos: "adjective",
      meaning: "Strange or unusual.",
      sentence: "How queer everything is to-day!",
    }),
    sources: [
      place(
        "fortunately",
        "…with either a waistcoat-pocket, or a watch to take out of it, and burning with curiosity, she ran across the field after it, and fortunately was just in time to see it pop down a large rabbit-hole under the hedge.",
        "By good luck.",
        "adverb",
        "CHAPTER I. Down the Rabbit-Hole",
      ),
      place("queer", "How queer everything is to-day!", "Strange or unusual.", "adjective", "CHAPTER II. The Pool of Tears"),
    ],
  };
  const [fixed, moved] = rehomeForeignSources([queer]);
  assert.equal(fixed.lemma, "queer");
  assert.equal(fixed.sources.length, 1);
  assert.equal(fixed.sources[0].surface, "queer");
  assert.equal(fixed.meaning, "Strange or unusual.");
  assert.match(fixed.sentence, /How queer/);
  assert.equal(moved.lemma, "fortunately");
  assert.equal(moved.sources.length, 1);
  assert.equal(moved.meaning, "By good luck.");
  assert.match(moved.sentence, /fortunately/);
  const again = rehomeForeignSources([fixed, moved]);
  assert.equal(again.length, 2);
  assert.equal(again[0].sources.length, 1);
  assert.equal(again[1].sources.length, 1);
});

test("an irregular form with the same meaning stays on the card", () => {
  const go = {
    ...old("a1", "go", { surface: "go", pos: "base verb", meaning: "To move.", sentence: "I go home." }),
    sources: [
      place("go", "I go home.", "To move.", "base verb", "Chapter 1"),
      place("went", "She went home.", "To move.", "past-tense verb", "Chapter 2"),
    ],
  };
  const [fixed] = rehomeForeignSources([go]);
  assert.deepEqual(
    fixed.sources.map((source) => source.surface),
    ["go", "went"],
  );
});

test("a phrase card stores the phrase, not the easy word that was tapped", () => {
  const phrase = savedFromCard(
    { surface: "in", key: "in", pos: "", meaning: "This word is very common." },
    {
      key: "tune in",
      matched: "tuning in",
      pos: "idiom",
      meaning: "To watch or listen from another place.",
    },
  );
  assert.deepEqual(phrase, {
    lemma: "tune in",
    surface: "tuning in",
    pos: "idiom",
    meaning: "To watch or listen from another place.",
  });
  const word = savedFromCard(
    { surface: "in", key: "in", pos: "", meaning: "This word is very common." },
    null,
  );
  assert.equal(word.lemma, "in");
  assert.equal(word.surface, "in");
});

test("a selected phrase and its inflected word coexist and keep independent sources and schedules", () => {
  const word = { surface: "tuning", key: "tune", pos: "verb", meaning: "To adjust a musical instrument." };
  const phrase = { key: "tune in", matched: "tuning in", pos: "idiom", meaning: "To watch or listen from another place." };
  const phraseSave = savedFromCard(word, phrase);
  const wordSave = savedFromCard(word, null);
  const sentence = "They were tuning in from home.";
  const reviewed = applyReview(old("a1", wordSave.lemma, wordSave), true, 5000);
  const list = migrateWords([
    old("a1", phraseSave.lemma, { ...phraseSave, sentence }),
    { ...reviewed, sentence },
    old("p1", wordSave.lemma, { ...wordSave, sentence: "They were tuning the piano." }),
  ], [alice, peter]);
  assert.deepEqual(list.map((entry) => entry.lemma).sort(), ["tune", "tune in"]);
  const savedPhrase = list.find((entry) => entry.lemma === "tune in");
  const savedWord = list.find((entry) => entry.lemma === "tune");
  assert.equal(savedPhrase.surface, "tuning in");
  assert.equal(savedWord.surface, "tuning");
  assert.equal(savedPhrase.meaning, phrase.meaning);
  assert.equal(savedWord.meaning, word.meaning);
  assert.equal(savedWord.stage, reviewed.stage);
  assert.equal(savedWord.dueAt, reviewed.dueAt);
  assert.equal(savedWord.reps, reviewed.reps);
  assert.equal(withoutBook(savedPhrase, keyA), null);
  assert.deepEqual(savedWord.sources.map((place) => place.book).sort(), [keyA, keyP].sort());
  const remainingWord = withoutBook(savedWord, keyA);
  assert.deepEqual(remainingWord.sources.map((place) => place.book), [keyP]);
  assert.equal(remainingWord.stage, reviewed.stage);
  assert.equal(remainingWord.dueAt, reviewed.dueAt);
  assert.equal(savedPhrase.sources.length, 1, "removing a word source does not change the phrase");
});

test("a saved phrase stays a phrase when the sentence only contains the written form", () => {
  const sentence = "And we've got students tuning in from all across America.";
  const card = {
    ...old("a1", "tune in", {
      surface: "tuning in",
      pos: "idiom",
      meaning: "To watch or listen from another place.",
      sentence,
    }),
    sources: [
      place(
        "tuning in",
        sentence,
        "To watch or listen from another place.",
        "idiom",
        "Chapter 1",
      ),
    ],
  };
  const [kept] = rehomeForeignSources([card]);
  assert.equal(kept.lemma, "tune in");
  assert.equal(kept.surface, "tuning in");
  assert.equal(kept.sources.length, 1);
  assert.equal(kept.sources[0].surface, "tuning in");
});

test("a source finds its shelf book by title and author, not by card id", () => {
  const [card] = migrateWords([old("a1", "faint")], [alice]);
  assert.equal(bookForSource(card.sources[0], [peter, { ...alice, id: "other-device-id" }]).id, "other-device-id");
  assert.equal(bookForSource(card.sources[0], [peter]), undefined);
});

test("a word-list pointer stays on its card and does not erase an older sentence", () => {
  const kept = old("a1", "faint", {
    sources: [source(keyA, "A sentence with faint in a1.", { savedAt: 1 })],
  });
  const refOnly = {
    ...old("a1", "faint", { sentence: "", meaning: "" }),
    sources: [
      {
        book: keyA,
        surface: "faint",
        savedAt: 2,
        ref: { list: "alice", chapter: 1, occurrence: 2, mark: "0123abcd" },
        sentence: "This uploaded sentence must not decide the card.",
      },
    ],
  };
  const merged = mergeCards(kept, refOnly);
  assert.match(merged.sentence, /A sentence with faint/);
  assert.equal(merged.sources.length, 2);
  const otherWay = mergeCards(refOnly, kept);
  assert.match(otherWay.sentence, /A sentence with faint/);
  const rehomed = rehomeForeignSources([refOnly]);
  assert.equal(rehomed.length, 1);
  assert.equal(rehomed[0].lemma, "faint");
  assert.equal(rehomed[0].sources[0].ref.list, "alice");
});

test("two copies of one word-list pointer keep the paragraph and do not copy a meaning", () => {
  const ref = { list: "alice", chapter: 1, occurrence: 2, mark: "0123abcd" };
  const paragraph = "A faint light on the water.";
  const bare = { book: keyA, surface: "faint", savedAt: 2, ref };
  const full = { book: keyA, surface: "faint", savedAt: 2, ref, sentence: paragraph, meaning: "Copied meaning." };
  const placed = { ...bare, chapter: 1, chapterTitle: "Down the Rabbit-Hole" };
  const fromBare = mergeSources([bare], [full]);
  assert.equal(fromBare.length, 1);
  assert.equal(fromBare[0].sentence, paragraph);
  assert.equal(fromBare[0].meaning, undefined);
  const fromFull = mergeSources([full], [bare]);
  assert.equal(fromFull[0].sentence, paragraph);
  assert.equal(fromFull[0].meaning, "Copied meaning.");
  const detailed = mergeSources([full], [placed]);
  assert.equal(detailed.length, 1);
  assert.equal(detailed[0].sentence, paragraph);
  assert.equal(detailed[0].chapter, 1);
  assert.equal(detailed[0].meaning, undefined);
});

test("countsByBookKey counts each word at most once per book and matches due schedule", () => {
  const now = 10_000;
  const words = [
    { stage: 0, dueAt: 5_000, sources: [{ book: keyA, surface: "faint", savedAt: 1 }, { book: keyA, surface: "faint", savedAt: 2 }, { book: keyP, surface: "faint", savedAt: 3 }] },
    { stage: 2, dueAt: 20_000, sources: [{ book: keyA, surface: "brisk", savedAt: 4 }] },
    { stage: 7, dueAt: 1_000, sources: [{ book: keyA, surface: "steady", savedAt: 5 }] },
  ];
  const counts = countsByBookKey(words, now);
  assert.deepEqual(counts.get(keyA), { words: 3, due: 1 });
  assert.deepEqual(counts.get(keyP), { words: 1, due: 1 });
});

test("distinct OEWN senses of the same lemma stay independent cards with separate SRS schedules", () => {
  const springCoil = {
    ...old("a1", "spring", {
      id: "spring-coil",
      senseId: "oewn-04287965-n",
      standardLemma: "spring",
      pos: "noun",
      meaning: "a metal elastic device",
      stage: 7,
      reps: 8,
      dueAt: Number.MAX_SAFE_INTEGER,
    }),
    sources: [
      source(keyA, "The mattress had a broken spring.", {
        surface: "spring",
        chapter: 0,
        senseId: "oewn-04287965-n",
        standardLemma: "spring",
        positionKey: "1".repeat(64),
      }),
    ],
  };
  const springJump = {
    ...old("a1", "spring", {
      id: "spring-jump",
      senseId: "oewn-01963942-v",
      standardLemma: "spring",
      pos: "verb",
      meaning: "move forward by leaps and bounds",
      stage: 0,
      reps: 0,
      dueAt: 1000,
    }),
    sources: [
      source(keyA, "He sprang across the ditch.", {
        surface: "sprang",
        chapter: 1,
        senseId: "oewn-01963942-v",
        standardLemma: "spring",
        positionKey: "2".repeat(64),
      }),
    ],
  };
  assert.equal(wordCardKey(springCoil), "spring#oewn-04287965-n");
  assert.equal(wordCardKey(springJump), "spring#oewn-01963942-v");
  const migrated = migrateWords([springCoil, springJump], [alice]);
  assert.equal(migrated.length, 2);
  // Irregular form "sprang" with standardLemma "spring" stays on its card instead of being displaced.
  const jumpCard = migrated.find((c) => c.senseId === "oewn-01963942-v");
  assert.equal(jumpCard.stage, 0);
  assert.equal(jumpCard.sources.length, 1);
  assert.equal(jumpCard.sources[0].surface, "sprang");
});

test("matchSavedWord distinguishes saved-here, saved-in-book, saved-other-book, different senses, and legacy cards", () => {
  const posCh1 = "a".repeat(64);
  const posCh2 = "b".repeat(64);
  const coilCard = {
    ...old("a1", "spring", { id: "c-coil", senseId: "oewn-coil-n", standardLemma: "spring" }),
    sources: [
      source(keyA, "The rusty spring snapped.", {
        title: alice.title,
        surface: "spring",
        chapter: 0,
        senseId: "oewn-coil-n",
        standardLemma: "spring",
        positionKey: posCh1,
      }),
    ],
  };
  const legacyCard = {
    ...old("a1", "curious", { id: "c-legacy" }),
    sources: [source(keyA, "Curiouser and curiouser.", { title: alice.title, surface: "curious", chapter: 1 })],
  };
  const words = [coilCard, legacyCard];

  // Exact position -> saved-here
  const here = matchSavedWord(words, {
    bookKey: keyA,
    lemma: "spring",
    senseId: "oewn-coil-n",
    positionKey: posCh1,
    sentence: "The rusty spring snapped.",
    surface: "spring",
  });
  assert.equal(here.status, "saved-here");
  assert.equal(here.card.id, "c-coil");
  assert.equal(here.hereSourceKey, sourceKey(coilCard.sources[0]));

  // Same senseId in Ch 2 -> saved-in-book with Ch 1 priorSource
  const inBook = matchSavedWord(words, {
    bookKey: keyA,
    lemma: "spring",
    senseId: "oewn-coil-n",
    positionKey: posCh2,
    sentence: "Another spring popped out of the clock.",
    surface: "spring",
  });
  assert.equal(inBook.status, "saved-in-book");
  assert.equal(inBook.priorSource.chapter, 0);

  // Different senseId of same lemma -> none (never collides!)
  const diffSense = matchSavedWord(words, {
    bookKey: keyA,
    lemma: "spring",
    senseId: "oewn-jump-v",
    positionKey: "c".repeat(64),
    sentence: "He sprang over the fence.",
    surface: "sprang",
  });
  assert.equal(diffSense.status, "none");

  // Same senseId in another book -> saved-other-book
  const otherBook = matchSavedWord(words, {
    bookKey: keyP,
    lemma: "spring",
    senseId: "oewn-coil-n",
    positionKey: "d".repeat(64),
    sentence: "The watch spring broke.",
    surface: "spring",
  });
  assert.equal(otherBook.status, "saved-other-book");
  assert.equal(otherBook.priorSource.title, alice.title);

  // Legacy unsensed card fallback still works for sensed queries when no sensed card exists
  const legacyHit = matchSavedWord(words, {
    bookKey: keyA,
    lemma: "curious",
    senseId: "oewn-curious-a",
    positionKey: "e".repeat(64),
    sentence: "She felt quite curious about the door.",
    surface: "curious",
  });
  assert.equal(legacyHit.status, "saved-in-book");
  assert.equal(legacyHit.card.id, "c-legacy");
});

test("withoutSource removes only the targeted chapter source and preserves earlier chapters", () => {
  const ch1 = source(keyA, "First chapter spring.", { chapter: 0, positionKey: "a".repeat(64), savedAt: 10 });
  const ch2 = source(keyA, "Second chapter spring.", { chapter: 1, positionKey: "b".repeat(64), savedAt: 20 });
  const card = {
    ...old("a1", "spring", { senseId: "oewn-coil-n" }),
    sources: [ch1, ch2],
  };
  const afterCh2 = withoutSource(card, sourceKey(ch2));
  assert.ok(afterCh2);
  assert.equal(afterCh2.sources.length, 1);
  assert.equal(afterCh2.sources[0].chapter, 0);
  assert.equal(withoutSource(afterCh2, sourceKey(ch1)), null);
});
