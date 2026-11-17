import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";
import { appModuleUrl, loadAppModules } from "./lib/app-modules.mjs";
import { countCreditsInGlossary, splitGlossaryCredits } from "./credits-layer.mjs";

const app = await loadAppModules();
const { signedMeanings, format } = app;

const storageStub = `
  export const extrasRevision = () => 0;
  export const loadBookExtras = async () => globalThis.__signedTestNotes;
  export const loadStoredBook = async () => globalThis.__signedTestBook;
`;
const helpSource = readFileSync(new URL("../src/lib/help-lookup.ts", import.meta.url), "utf8");
const helpJs = ts
  .transpileModule(helpSource, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  })
  .outputText.replace(/from "@\/lib\/([\w-]+)"/g, (_, name) => {
    const url =
      name === "book-db"
        ? `data:text/javascript,${encodeURIComponent(storageStub)}`
        : appModuleUrl(name);
    return `from ${JSON.stringify(url)}`;
  })
  .replace(/import\.meta\.env\.DEV/g, "false");
const helpLookup = await import(`data:text/javascript,${encodeURIComponent(helpJs)}`);

function makeStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    clear: () => { map.clear(); },
    raw: map,
  };
}

test("signedMeaningsPath and parseSignedMeaningsOverlay enforce schema, identity and credit format", () => {
  assert.equal(
    signedMeanings.signedMeaningsPath("public-books:alice"),
    "dictionary/credits/public-books/alice/credits.json",
  );
  assert.throws(() => signedMeanings.signedMeaningsPath("../bad:id"));

  const valid = signedMeanings.parseSignedMeaningsOverlay(
    {
      schema: "signed-meanings-v1",
      catalogId: "public-books:alice",
      updatedAt: 1700000000000,
      words: [
        {
          key: "Antipathy",
          forms: ["Antipathies"],
          pos: "noun",
          meaning: "A strong feeling of dislike for somebody or something.",
          trickyMeaning: true,
          credit: "6da588e40b29",
          anchors: [
            {
              chapter: 0,
              occurrence: 1,
              form: "antipathies",
              context: "The Antipathies, I think",
            },
          ],
        },
      ],
      phrases: [
        {
          key: "Set To Work",
          pos: "phrase",
          meaning: "Start doing something right away.",
          credit: "7bcfe1197e91",
        },
      ],
      sentences: [
        {
          chapter: 0,
          context: "Alice was beginning to get very tired of sitting",
          simple: "Alice feels very tired as she sits by her sister.",
          grammar: "Two reasons joined by 'and'.",
          credit: "7badae81f4a4",
        },
      ],
    },
    "public-books:alice",
  );
  assert.equal(valid.words[0].key, "antipathy");
  assert.deepEqual(valid.words[0].forms, ["antipathies"]);
  assert.equal(valid.phrases[0].key, "set to work");
  assert.equal(valid.sentences.length, 1);

  assert.throws(() =>
    signedMeanings.parseSignedMeaningsOverlay(
      { ...valid, catalogId: "public-books:anne" },
      "public-books:alice",
    ),
  );
  assert.throws(() =>
    signedMeanings.parseSignedMeaningsOverlay({
      ...valid,
      words: [{ ...valid.words[0], credit: "INVALID_CRED" }],
    }),
  );
});

test("loadSignedMeanings deduplicates requests, treats 404 as empty, and falls back to offline cache", async () => {
  signedMeanings.clearSignedMeaningsCache();
  const storage = makeStorage();
  const prevStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const prevFetch = globalThis.fetch;
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });

  let fetches = 0;
  const payload = {
    schema: "signed-meanings-v1",
    catalogId: "public-books:back-to-school",
    updatedAt: 1700000000001,
    words: [
      {
        key: "discuss",
        pos: "verb",
        meaning: "To talk with other people about something.",
        credit: "7bcfe1197e91",
        anchors: [{ chapter: 2, occurrence: 1, form: "discuss", context: "important to discuss with you" }],
      },
    ],
    phrases: [],
    sentences: [],
  };

  try {
    globalThis.fetch = async () => {
      fetches += 1;
      return new Response(JSON.stringify(payload), { status: 200 });
    };
    const [a, b] = await Promise.all([
      signedMeanings.readSignedMeanings("public-books:back-to-school"),
      signedMeanings.readSignedMeanings("public-books:back-to-school"),
    ]);
    assert.equal(fetches, 1, "concurrent reads share one static request");
    assert.equal(a.words[0].credit, "7bcfe1197e91");
    assert.equal(b.words[0].credit, "7bcfe1197e91");

    // Simulate page reload + offline network: peekSignedMeanings and readSignedMeanings both recover from localStorage.
    signedMeanings.clearSignedMeaningsCache();
    globalThis.fetch = async () => {
      throw new Error("offline");
    };
    const peeked = signedMeanings.peekSignedMeanings("public-books:back-to-school");
    assert.equal(peeked?.words[0]?.key, "discuss");
    const offlineRead = await signedMeanings.readSignedMeanings("public-books:back-to-school");
    assert.equal(offlineRead.words[0]?.credit, "7bcfe1197e91");

    // 404 yields an empty overlay and clears nothing unexpectedly.
    globalThis.fetch = async () => new Response("Not found", { status: 404 });
    const missing = await signedMeanings.loadSignedMeanings("public-books:obama-inaugural-2009");
    assert.deepEqual(missing.words, []);
    assert.deepEqual(missing.phrases, []);
    assert.deepEqual(missing.sentences, []);
  } finally {
    globalThis.fetch = prevFetch;
    if (prevStorage) Object.defineProperty(globalThis, "localStorage", prevStorage);
    else delete globalThis.localStorage;
    signedMeanings.clearSignedMeaningsCache();
  }
});

test("Layer 3 overrides Layer 2 at signed coordinates while preserving Layer 2 everywhere else", async () => {
  const baseGlossary = {
    wonder: {
      pos: "verb",
      meaning: "a surprising natural sight in the rock hole",
      whyHard: "This word is harder than everyday English.",
      forms: ["wondered", "wondering", "wonders"],
      senseOnly: true,
      senses: [
        {
          pos: "noun",
          meaning: "a surprising natural sight in the rock hole",
          anchors: [{ chapter: 35, occurrence: 1, form: "wonders", context: "see the wonders of McDougal's cave" }],
        },
        {
          pos: "verb",
          meaning: "skill base meaning at chapter 3",
          anchors: [{ chapter: 3, occurrence: 1, form: "wonder", context: "What's gone with that boy, I wonder" }],
        },
      ],
    },
  };
  const overlay = signedMeanings.parseSignedMeaningsOverlay({
    schema: "signed-meanings-v1",
    catalogId: "public-books:tom-sawyer",
    updatedAt: 100,
    words: [
      {
        key: "wonder",
        pos: "verb",
        meaning: "To ask yourself about something you do not know.",
        credit: "6ae686d4d1cc",
        anchors: [{ chapter: 3, occurrence: 1, form: "wonder", context: "What's gone with that boy, I wonder" }],
      },
      {
        key: "discuss",
        pos: "verb",
        meaning: "To talk with other people about something.",
        credit: "7bcfe1197e91",
        anchors: [{ chapter: 2, occurrence: 1, form: "discuss", context: "something important to discuss with you" }],
      },
    ],
    phrases: [
      {
        key: "set to work",
        pos: "phrase",
        meaning: "Reader signed phrase override.",
        credit: "62a32f6b1bf3",
      },
    ],
    sentences: [
      {
        chapter: 0,
        context: "Alice was beginning to get very tired of sitting",
        simple: "Signed simple sentence explanation.",
        grammar: "Signed grammar note.",
        credit: "7badae81f4a4",
      },
    ],
  });

  const merged = signedMeanings.mergeSignedGlossary(baseGlossary, overlay);
  // Ch 3 Occ 1 uses L3 signed override and hides duplicate L2 coordinate:
  const hitCh3 = format.pickSense("wonder", merged.wonder, {
    chapter: 3,
    surface: "wonder",
    occurrence: 1,
    paragraph: "What's gone with that boy, I wonder?",
  });
  assert.equal(hitCh3.meaning, "To ask yourself about something you do not know.");
  assert.equal(hitCh3.credit, "6ae686d4d1cc");
  assert.equal(
    hitCh3.others.some((o) => o.meaning === "skill base meaning at chapter 3"),
    false,
    "overridden L2 sense at the same coordinate does not linger in others",
  );

  // Ch 35 Occ 1 still uses L2 Skill sense with no credit:
  const hitCh35 = format.pickSense("wonder", merged.wonder, {
    chapter: 35,
    surface: "wonders",
    occurrence: 1,
    paragraph: "Come to see the wonders of McDougal's cave.",
  });
  assert.equal(hitCh35.meaning, "a surprising natural sight in the rock hole");
  assert.equal(hitCh35.credit, undefined);

  // L3-only easy word `discuss` applies ONLY at Ch 2 Occ 1 (`senseOnly: true`):
  assert.equal(merged.discuss.senseOnly, true);
  assert.equal(
    format.entryAppliesAt("discuss", merged.discuss, {
      chapter: 1,
      surface: "discuss",
      occurrence: 1,
      paragraph: "Let us discuss another matter.",
    }),
    false,
  );
  assert.equal(
    format.entryAppliesAt("discuss", merged.discuss, {
      chapter: 2,
      surface: "discuss",
      occurrence: 1,
      paragraph: "I have something important to discuss with you.",
    }),
    true,
  );

  // Phrases & Sentences through help-lookup active book bridge:
  globalThis.__signedTestNotes = {
    source: "public-books:alice",
    phrases: { "set to work": { pos: "phrase", meaning: "Base skill phrase meaning." } },
    sentences: [],
    paragraphs: [],
  };
  const sharedBook = {
    id: "book-1",
    title: "Alice",
    author: "Carroll",
    chapters: [{ title: "Ch 1", html: "<p>Alice was beginning to get very tired of sitting by her sister, and she set to work.</p>", paragraphs: ["Alice was beginning to get very tired of sitting by her sister, and she set to work."] }],
    glossary: {},
  };
  globalThis.__signedTestBook = sharedBook;
  helpLookup.shareStoredBook("book-1", sharedBook);
  signedMeanings.shareBookSignedMeanings("book-1", overlay);
  try {
    const flags = await helpLookup.getParagraphNoteFlags("book-1", 0, [
      "Alice was beginning to get very tired of sitting by her sister, and she set to work.",
    ]);
    assert.deepEqual(flags, [true], "L3 sentence note lights up paragraph help bulb");
    const sHelp = await helpLookup.getSentenceHelp(
      "book-1",
      0,
      "Alice was beginning to get very tired of sitting by her sister, and she set to work.",
    );
    assert.equal(sHelp?.credit, "7badae81f4a4");
    assert.equal(sHelp?.simple, "Signed simple sentence explanation.");

    const pHit = await helpLookup.findPhrase(
      "book-1",
      "Alice was beginning to get very tired of sitting by her sister, and she set to work.",
      "work",
    );
    assert.equal(pHit?.entry.credit, "62a32f6b1bf3");
    assert.equal(pHit?.entry.meaning, "Reader signed phrase override.");
  } finally {
    signedMeanings.shareBookSignedMeanings("book-1", null);
  }
});

test("splitGlossaryCredits separates L2 and L3 with zero remaining L2 credits and exact runtime equivalence", async () => {
  const combined = {
    version: 2,
    title: "Demo Book",
    author: "Demo Author",
    glossary: {
      discuss: {
        pos: "verb",
        meaning: "To talk with other people about something.",
        whyHard: "This word is harder than everyday English.",
        senseOnly: true,
        senses: [
          {
            meaning: "To talk with other people about something.",
            credit: "7bcfe1197e91",
            anchors: [{ chapter: 2, occurrence: 1, form: "discuss", context: "something important to discuss with you" }],
          },
        ],
      },
      antipathy: {
        pos: "noun",
        meaning: "A strong feeling of dislike for somebody or something.",
        whyHard: "This word is harder than everyday English.",
        forms: ["antipathies"],
        senses: [
          {
            pos: "noun",
            meaning: "A strong feeling of dislike for somebody or something.",
            trickyMeaning: true,
            credit: "6da588e40b29",
            anchors: [{ chapter: 0, occurrence: 1, form: "antipathies", context: "The Antipathies, I think" }],
          },
        ],
      },
    },
    sentences: [
      {
        chapter: 0,
        context: "Alice was beginning to get very tired of sitting",
        simple: "Alice feels very tired as she sits by her sister.",
        grammar: "Two reasons joined by 'and'.",
        credit: "7badae81f4a4",
      },
    ],
  };

  const { glossary: cleanL2, overlay, extracted } = await splitGlossaryCredits(combined, {
    catalogId: "public-books:alice",
    updatedAt: 1700000000000,
    app,
  });

  assert.equal(countCreditsInGlossary(cleanL2).total, 0);
  assert.equal(cleanL2.glossary.discuss, undefined, "easy reader-only word is omitted from L2");
  assert.ok(cleanL2.glossary.antipathy, "hard vocabulary word keeps uncredited L2 fallback");
  assert.equal(cleanL2.glossary.antipathy.senses[0].credit, undefined);
  assert.equal(cleanL2.sentences, undefined);
  assert.equal(extracted.words, 2);
  assert.equal(extracted.sentences, 1);

  // Runtime merge matches legacy combined glossary at both locations:
  const merged = signedMeanings.mergeSignedGlossary(cleanL2.glossary, overlay);
  const tapDiscuss = {
    chapter: 2,
    surface: "discuss",
    occurrence: 1,
    paragraph: "I have something important to discuss with you.",
  };
  const tapAntipathy = {
    chapter: 0,
    surface: "Antipathies",
    occurrence: 1,
    paragraph: "The Antipathies, I think.",
  };
  assert.equal(
    format.pickSense("discuss", merged.discuss, tapDiscuss).credit,
    format.pickSense("discuss", combined.glossary.discuss, tapDiscuss).credit,
  );
  assert.equal(
    format.pickSense("antipathy", merged.antipathy, tapAntipathy).credit,
    format.pickSense("antipathy", combined.glossary.antipathy, tapAntipathy).credit,
  );
  // Also verify sha256HexSync in dictionary-choices matches Node's crypto sha256!
  const ts = await import("typescript");
  const { readFileSync } = await import("node:fs");
  const choiceSrc = readFileSync(new URL("../src/lib/dictionary-choices.ts", import.meta.url), "utf8");
  const choiceJs = ts.default.transpileModule(choiceSrc, {
    compilerOptions: { module: ts.default.ModuleKind.CommonJS, target: ts.default.ScriptTarget.ES2022 },
  }).outputText;
  const mod = { exports: {} };
  new Function("module", "exports", "require", choiceJs)(mod, mod.exports, (id) => {
    if (id === "react") return { useEffect() {}, useRef: () => ({}), useState: () => [] };
    if (id === "@/lib/account-store") return { useAccount: () => null };
    if (id === "@/lib/sync-engine") return { accountRequest: async () => ({ ok: true }) };
    throw new Error(`Unexpected import ${id}`);
  });
  for (const sample of ["", "abc", "reader@example.com\0[\"alice\",\"Café — downward!\"]", "x".repeat(200)]) {
    assert.equal(
      mod.exports.sha256HexSync(sample),
      createHash("sha256").update(sample, "utf8").digest("hex"),
    );
  }
});

test("legacy unmodified 3-in-1 dictionaries and hybrid incremental overlays stay 100% compatible", async () => {
  const legacy3In1 = {
    version: 2,
    title: "Legacy 3-in-1 Book",
    author: "Author",
    glossary: {
      lantern: {
        pos: "noun",
        meaning: "A lamp you can carry.",
        whyHard: "This word is harder than everyday English.",
      },
      bolt: {
        pos: "noun",
        meaning: "A flash of lightning.",
        whyHard: "This word is harder than everyday English.",
        credit: "aaaa11112222",
      },
      glance: {
        pos: "verb",
        meaning: "Look quickly.",
        whyHard: "This word is harder than everyday English.",
        senseOnly: true,
        senses: [
          {
            pos: "verb",
            meaning: "Look quickly at someone.",
            credit: "bbbb33334444",
            anchors: [{ chapter: 0, occurrence: 1, form: "glance", context: "took a quick glance around the hall" }],
          },
        ],
      },
    },
    phrases: {
      "hold back": {
        pos: "phrasal verb",
        meaning: "Stop yourself from doing something.",
        credit: "cccc55556666",
      },
    },
    sentences: [
      {
        chapter: 0,
        context: "took a quick glance around the hall",
        simple: "He looked around the hall very quickly.",
        credit: "dddd77778888",
      },
    ],
    paragraphs: [
      {
        chapter: 0,
        paragraph: 0,
        context: "took a quick glance around the hall",
        mainIdea: "He checks the hall quickly.",
        simple: "He looks around the big room before speaking.",
        credit: "eeee99990000",
      },
    ],
  };

  // State 1: Unmodified 3-in-1 book with 404 / empty credits.json -> zero object cloning, all inline credits preserved!
  const emptyOverlay = signedMeanings.emptySignedMeanings("word-lists:legacy-book");
  assert.equal(signedMeanings.mergeSignedGlossary(legacy3In1.glossary, emptyOverlay), legacy3In1.glossary);
  assert.equal(signedMeanings.mergeSignedPhrases(legacy3In1.phrases, emptyOverlay), legacy3In1.phrases);
  assert.equal(signedMeanings.mergeSignedSentences(legacy3In1.sentences, emptyOverlay), legacy3In1.sentences);
  assert.equal(signedMeanings.mergeSignedParagraphs(legacy3In1.paragraphs, emptyOverlay), legacy3In1.paragraphs);
  assert.equal(
    format.pickSense("bolt", legacy3In1.glossary.bolt, { chapter: 0, surface: "bolt", occurrence: 1, paragraph: "A bolt fell." }).credit,
    "aaaa11112222",
  );
  assert.equal(
    format.pickSense("glance", legacy3In1.glossary.glance, {
      chapter: 0,
      surface: "glance",
      occurrence: 1,
      paragraph: "He took a quick glance around the hall.",
    }).credit,
    "bbbb33334444",
  );

  // State 2: Hybrid book — old 3-in-1 glossary still in IndexedDB + incremental new L3 credits.json!
  const incrementalOverlay = signedMeanings.parseSignedMeaningsOverlay(
    {
      schema: "signed-meanings-v1",
      catalogId: "word-lists:legacy-book",
      updatedAt: 200,
      words: [
        {
          key: "bolt",
          pos: "verb",
          meaning: "Run away very fast.",
          credit: "ffff12345678",
          anchors: [{ chapter: 1, occurrence: 1, form: "bolt", context: "tried to bolt out the door" }],
        },
      ],
      phrases: [],
      sentences: [],
      paragraphs: [
        {
          chapter: 0,
          paragraph: 1,
          context: "second paragraph in the hall",
          mainIdea: "New signed paragraph help.",
          simple: "A reader explained the second paragraph.",
          credit: "111122223333",
        },
      ],
    },
    "word-lists:legacy-book",
  );

  const hybridGlossary = signedMeanings.mergeSignedGlossary(legacy3In1.glossary, incrementalOverlay);
  // Ch 1 Occ 1 gets new L3 credit, while Ch 0 still preserves old inline 3-in-1 credit on `bolt` and `glance`!
  assert.equal(
    format.pickSense("bolt", hybridGlossary.bolt, {
      chapter: 1,
      surface: "bolt",
      occurrence: 1,
      paragraph: "He tried to bolt out the door.",
    }).credit,
    "ffff12345678",
  );
  assert.equal(
    format.pickSense("bolt", hybridGlossary.bolt, {
      chapter: 0,
      surface: "bolt",
      occurrence: 1,
      paragraph: "A bolt fell from the sky.",
    }).credit,
    "aaaa11112222",
  );

  globalThis.__signedTestNotes = {
    source: "word-lists:legacy-book",
    phrases: legacy3In1.phrases,
    sentences: legacy3In1.sentences,
    paragraphs: legacy3In1.paragraphs,
  };
  const hybridBook = {
    id: "book-hybrid",
    title: "Legacy 3-in-1 Book",
    author: "Author",
    chapters: [
      {
        title: "Ch 1",
        html: "<p>He took a quick glance around the hall and tried to hold back.</p><p>This is the second paragraph in the hall.</p>",
        paragraphs: [
          "He took a quick glance around the hall and tried to hold back.",
          "This is the second paragraph in the hall.",
        ],
      },
    ],
    glossary: hybridGlossary,
  };
  globalThis.__signedTestBook = hybridBook;
  helpLookup.shareStoredBook("book-hybrid", hybridBook);
  signedMeanings.shareBookSignedMeanings("book-hybrid", incrementalOverlay);
  try {
    const p0 = await helpLookup.getParagraphHelp("book-hybrid", 0, 0, hybridBook.chapters[0].paragraphs);
    const p1 = await helpLookup.getParagraphHelp("book-hybrid", 0, 1, hybridBook.chapters[0].paragraphs);
    assert.equal(p0?.credit, "eeee99990000", "inline 3-in-1 paragraph credit continues working");
    assert.equal(p1?.credit, "111122223333", "L3 signed paragraph credit merges alongside inline 3-in-1 notes");
  } finally {
    signedMeanings.shareBookSignedMeanings("book-hybrid", null);
  }

  // State 3: Later migrating that hybrid 3-in-1 book with `existingOverlay` preserves BOTH inline and incremental credits!
  const migrated = await splitGlossaryCredits(legacy3In1, {
    catalogId: "word-lists:legacy-book",
    updatedAt: 300,
    existingOverlay: incrementalOverlay,
    app,
  });
  assert.equal(countCreditsInGlossary(migrated.glossary).total, 0);
  assert.equal(migrated.extracted.words, 3);
  assert.equal(migrated.extracted.phrases, 1);
  assert.equal(migrated.extracted.sentences, 1);
  assert.equal(migrated.extracted.paragraphs, 2);
});
