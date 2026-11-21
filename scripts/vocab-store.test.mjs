import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";

// Load the real store with Node's type stripping and the app's alias resolution.
// Replace only IndexedDB IO so a no-op can assert that neither persistence path runs.
const writes = [];
globalThis.window = { addEventListener() {}, removeEventListener() {} };
globalThis.localStorage = {
  getItem: () => null,
  setItem: (...args) => writes.push(args),
  removeItem: () => {},
};
globalThis.__noteWrites = [];
register(`data:text/javascript,${encodeURIComponent(`
  const root = ${JSON.stringify(new URL("../src/", import.meta.url).href)};
  export function resolve(specifier, context, next) {
    if (specifier === "@/lib/book-db") {
      return { shortCircuit: true, url: "data:text/javascript,export async function saveNotes(words) { globalThis.__noteWrites.push(words); }" };
    }
    if (specifier.startsWith("@/")) return next(new URL(specifier.slice(2) + ".ts", root).href, context);
    return next(specifier, context);
  }
`)}`, import.meta.url);
const { useVocab, markVocabHydrated } = await import("../src/lib/vocab-store.ts");
const { bookSyncKey } = await import("../src/lib/sync-merge.ts");
markVocabHydrated();
const home = { id: "reader-test", title: "A lantern", author: "Test" };
const placeholder = "The meaning is still being prepared.";
const word = (meaning = placeholder) => ({
  id: "lantern", lemma: "lantern", pos: "noun", meaning, whyHard: "",
  sources: [{ book: bookSyncKey(home) }],
});
function reset(words) {
  useVocab.setState({ books: [home], words });
  writes.length = 0;
  globalThis.__noteWrites.length = 0;
}

test("opening with no prepared meanings preserves identity and performs no persistence", () => {
  for (const words of [[], [word("A portable light.")], [word()]]) {
    reset(words);
    const before = useVocab.getState();
    useVocab.getState().fillPrepared(home.id, {});
    assert.equal(useVocab.getState(), before);
    assert.equal(writes.length, 0);
    assert.equal(globalThis.__noteWrites.length, 0);
  }
});

test("prepared meanings update only matching placeholders and persist once", () => {
  const ready = word("Already ready.");
  reset([word(), ready]);
  useVocab.getState().fillPrepared(home.id, {
    lantern: { pos: "noun", meaning: "A portable light.", whyHard: "An object." },
  });
  assert.equal(useVocab.getState().words[0].meaning, "A portable light.");
  assert.equal(useVocab.getState().words[1], ready);
  assert.equal(writes.length, 1);
  assert.equal(globalThis.__noteWrites.length, 1);
  useVocab.getState().fillPrepared(home.id, {});
  assert.equal(writes.length, 1);
});

test("phrase and word saves persist independently without resetting an existing review schedule", () => {
  reset([]);
  const book = bookSyncKey(home);
  const sentence = "They were tuning in from home.";
  const save = (lemma, surface, phrase) => useVocab.getState().saveWord({
    lemma, surface, pos: phrase ? "idiom" : "verb", meaning: "", whyHard: "", recommend: true, sentence,
  }, { book, title: home.title, author: home.author, sentence, surface, savedAt: 100,
    ref: phrase ? { list: "test-list", phrase: true } : { list: "test-list", chapter: 0, occurrence: 1 } });
  save("tune in", "tuning in", true);
  save("tune", "tuning", false);
  assert.deepEqual(useVocab.getState().words.map((entry) => entry.lemma).sort(), ["tune", "tune in"]);
  assert.equal(writes.length, 2);
  assert.equal(globalThis.__noteWrites.length, 2);
  const phrase = useVocab.getState().words.find((entry) => entry.lemma === "tune in");
  const word = useVocab.getState().words.find((entry) => entry.lemma === "tune");
  assert.equal(phrase.sources[0].ref.phrase, true);
  assert.equal(word.sources[0].ref.phrase, undefined);
  useVocab.setState({ words: [phrase, { ...word, stage: 3, reps: 6, dueAt: 12345 }] });
  save("tune", "tuning", false);
  const reviewed = useVocab.getState().words.find((entry) => entry.lemma === "tune");
  assert.equal(reviewed.id, word.id);
  assert.equal(reviewed.stage, 3);
  assert.equal(reviewed.reps, 6);
  assert.equal(reviewed.dueAt, 12345);
  useVocab.getState().removeWordFromBook(book, "tune in");
  assert.deepEqual(useVocab.getState().words.map((entry) => entry.lemma), ["tune"]);
  assert.equal(useVocab.getState().words[0].dueAt, 12345);
  save("tune in", "tuning in", true);
  useVocab.getState().removeWordFromBook(book, "tune");
  assert.deepEqual(useVocab.getState().words.map((entry) => entry.lemma), ["tune in"]);
  const stored = JSON.parse(writes.at(-1)[1]);
  assert.deepEqual(stored.state.words.map((entry) => entry.lemma), ["tune in"]);
  assert.deepEqual(globalThis.__noteWrites.at(-1).map((entry) => entry.lemma), ["tune in"]);
});

test("unchanged placeholder and another book's sources do not trigger writes", () => {
  const foreign = { ...word(), sources: [{ book: "another-book" }] };
  reset([word(), foreign]);
  useVocab.getState().fillPrepared(home.id, {
    lantern: { pos: "noun", meaning: placeholder, whyHard: "" },
  });
  assert.equal(writes.length, 0);
  assert.equal(globalThis.__noteWrites.length, 0);
});

test("undoReview restores a card's prior SRS stage, schedule and daily review log", async () => {
  const { dayKey } = await import("../src/lib/srs.ts");
  const prior = {
    ...word("A portable light."),
    surface: "lantern",
    recommend: true,
    sentence: "A lantern glowed.",
    stage: 5,
    dueAt: 1000,
    createdAt: 500,
    reps: 5,
    lapses: 0,
  };
  useVocab.setState({ books: [home], words: [prior], log: {} });
  const today = dayKey(Date.now());
  useVocab.getState().review(prior.id, false, true);
  const afterMiss = useVocab.getState().words[0];
  assert.equal(afterMiss.stage, 0);
  assert.equal(afterMiss.lapses, 1);
  assert.deepEqual(useVocab.getState().log[today], { reviewed: 1, correct: 0 });

  useVocab.getState().undoReview(prior, today, false);
  const restored = useVocab.getState().words[0];
  assert.equal(restored.stage, 5);
  assert.equal(restored.lapses, 0);
  assert.equal(restored.dueAt, 1000);
  assert.equal(useVocab.getState().log[today], undefined);
});

test("two senses of one lemma keep separate SRS schedules, and surgical source removal preserves Ch 1", async () => {
  const { sourceKey } = await import("../src/lib/wordbook.ts");
  reset([]);
  const book = bookSyncKey(home);
  const posCh1 = "1".repeat(64);
  const posCh2 = "2".repeat(64);
  const posVerb = "3".repeat(64);

  // Save sense A (noun) in Ch 1
  useVocab.getState().saveWord(
    {
      lemma: "spring",
      surface: "spring",
      pos: "noun",
      meaning: "a metal elastic device",
      whyHard: "",
      recommend: true,
      sentence: "The broken spring poked out.",
      senseId: "oewn-coil-n",
      standardLemma: "spring",
    },
    {
      book,
      title: home.title,
      author: home.author,
      chapter: 0,
      sentence: "The broken spring poked out.",
      surface: "spring",
      meaning: "a metal elastic device",
      pos: "noun",
      savedAt: 100,
      senseId: "oewn-coil-n",
      standardLemma: "spring",
      positionKey: posCh1,
    },
  );
  // Master sense A
  const coilId = useVocab.getState().words[0].id;
  useVocab.getState().markMastered(coilId);

  // Save sense B (verb, irregular surface "sprang") — must NOT be swallowed by mastered sense A!
  useVocab.getState().saveWord(
    {
      lemma: "spring",
      surface: "sprang",
      pos: "verb",
      meaning: "leap suddenly",
      whyHard: "",
      recommend: true,
      sentence: "She sprang over the wall.",
      senseId: "oewn-jump-v",
      standardLemma: "spring",
    },
    {
      book,
      title: home.title,
      author: home.author,
      chapter: 1,
      sentence: "She sprang over the wall.",
      surface: "sprang",
      meaning: "leap suddenly",
      pos: "verb",
      savedAt: 200,
      senseId: "oewn-jump-v",
      standardLemma: "spring",
      positionKey: posVerb,
    },
  );
  assert.equal(useVocab.getState().words.length, 2);
  const coil = useVocab.getState().words.find((w) => w.senseId === "oewn-coil-n");
  const verb = useVocab.getState().words.find((w) => w.senseId === "oewn-jump-v");
  assert.equal(coil.stage, 7);
  assert.equal(verb.stage, 0);

  // Append Ch 2 sentence onto sense A — keeps mastered stage, adds 2nd source
  useVocab.getState().saveWord(
    {
      lemma: "spring",
      surface: "springs",
      pos: "noun",
      meaning: "a metal elastic device",
      whyHard: "",
      recommend: true,
      sentence: "Old sofa springs creaked.",
      senseId: "oewn-coil-n",
      standardLemma: "spring",
    },
    {
      book,
      title: home.title,
      author: home.author,
      chapter: 1,
      sentence: "Old sofa springs creaked.",
      surface: "springs",
      meaning: "a metal elastic device",
      pos: "noun",
      savedAt: 300,
      senseId: "oewn-coil-n",
      standardLemma: "spring",
      positionKey: posCh2,
    },
  );
  const coilUpdated = useVocab.getState().words.find((w) => w.id === coilId);
  assert.equal(coilUpdated.stage, 7);
  assert.equal(coilUpdated.sources.length, 2);

  // Surgically remove ONLY Ch 2 source -> Ch 1 remains intact
  useVocab.getState().removeWordSource(coilId, sourceKey(coilUpdated.sources[1]));
  const coilAfterCh2Remove = useVocab.getState().words.find((w) => w.id === coilId);
  assert.equal(coilAfterCh2Remove.sources.length, 1);
  assert.equal(coilAfterCh2Remove.sources[0].chapter, 0);

  // Remove sense A from this book -> sense B stays completely untouched
  useVocab.getState().removeCardFromBook(coilId, book);
  assert.equal(useVocab.getState().words.length, 1);
  assert.equal(useVocab.getState().words[0].senseId, "oewn-jump-v");
});

test("appending a sensed occurrence onto a legacy unsensed card via targetCardId keeps its legacy identity", () => {
  const book = bookSyncKey(home);
  const legacy = {
    id: "legacy-spring",
    lemma: "spring",
    surface: "spring",
    pos: "noun",
    meaning: "old meaning",
    whyHard: "",
    recommend: true,
    sentence: "Ch 1 legacy spring.",
    stage: 4,
    dueAt: 5000,
    createdAt: 100,
    reps: 4,
    lapses: 0,
    sources: [{ book, title: home.title, author: home.author, chapter: 0, sentence: "Ch 1 legacy spring.", surface: "spring", savedAt: 100 }],
  };
  reset([legacy]);
  useVocab.getState().saveWord(
    {
      lemma: "spring",
      surface: "spring",
      pos: "noun",
      meaning: "elastic device",
      whyHard: "",
      recommend: true,
      sentence: "Ch 2 sensed spring.",
      senseId: "oewn-coil-n",
      standardLemma: "spring",
    },
    {
      book,
      title: home.title,
      author: home.author,
      chapter: 1,
      sentence: "Ch 2 sensed spring.",
      surface: "spring",
      savedAt: 200,
      senseId: "oewn-coil-n",
      standardLemma: "spring",
      positionKey: "4".repeat(64),
    },
    legacy.id,
  );
  assert.equal(useVocab.getState().words.length, 1);
  const updated = useVocab.getState().words[0];
  assert.equal(updated.id, "legacy-spring");
  assert.equal(updated.senseId, undefined, "legacy card keeps unsensed wordCardKey for cross-device sync compatibility");
  assert.equal(updated.stage, 4);
  assert.equal(updated.sources.length, 2);
});
