#!/usr/bin/env node
/**
 * Layer a combined v2 glossary.json into:
 *   - Layer 2 (Community / Skill base): clean glossary.json with zero reader `credit`s
 *   - Layer 3 (Signed reader overlay): dictionary/credits/<catalog>/<id>/credits.json
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadAppModules } from "./lib/app-modules.mjs";

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function stripCredit(obj) {
  const copy = { ...obj };
  delete copy.credit;
  return copy;
}

export function countCreditsInGlossary(raw) {
  let words = 0;
  let senses = 0;
  let phrases = 0;
  let sentences = 0;
  let paragraphs = 0;
  for (const entry of Object.values(raw.glossary ?? {})) {
    if (entry?.credit) words += 1;
    for (const sense of entry?.senses ?? []) {
      if (sense?.credit) senses += 1;
    }
  }
  for (const entry of Object.values(raw.phrases ?? {})) {
    if (entry?.credit) phrases += 1;
  }
  for (const note of raw.sentences ?? []) {
    if (note?.credit) sentences += 1;
  }
  for (const note of raw.paragraphs ?? []) {
    if (note?.credit) paragraphs += 1;
  }
  return {
    words,
    senses,
    phrases,
    sentences,
    paragraphs,
    total: words + senses + phrases + sentences + paragraphs,
  };
}

export async function splitGlossaryCredits(rawGlossary, options = {}) {
  const {
    catalogId,
    updatedAt = Date.now(),
    keepHardWordBase = true,
    existingOverlay = null,
    app: passedApp,
  } = options;
  if (!catalogId || typeof catalogId !== "string") {
    throw new Error("splitGlossaryCredits requires catalogId (<catalog>:<id>)");
  }
  const app = passedApp ?? (await loadAppModules());
  const { format, signedMeanings, text } = app;

  const clean = cloneJson(rawGlossary);
  const nextGlossary = {};
  const signedWords = [];
  const signedPhrases = [];
  const signedSentences = [];
  const signedParagraphs = [];

  for (const [rawKey, entry] of Object.entries(clean.glossary ?? {})) {
    const key = rawKey.trim().toLowerCase();
    const entryForms = Array.isArray(entry.forms) && entry.forms.length > 0 ? [...entry.forms] : undefined;
    const rawSenses = Array.isArray(entry.senses) ? entry.senses : undefined;

    if (entry.credit) {
      signedWords.push({
        key,
        ...(entryForms ? { forms: entryForms } : {}),
        ...(entry.pos ? { pos: entry.pos } : {}),
        meaning: entry.meaning,
        ...(entry.whyHard ? { whyHard: entry.whyHard } : {}),
        ...(entry.here ? { here: entry.here } : {}),
        ...(entry.coined === true ? { coined: true } : {}),
        credit: entry.credit,
      });
    }

    const creditedSenses = [];
    const uncreditedSenses = [];
    for (const sense of rawSenses ?? []) {
      if (sense.credit) {
        creditedSenses.push(sense);
        signedWords.push({
          key,
          ...(entryForms ? { forms: entryForms } : {}),
          ...((sense.pos || entry.pos) ? { pos: sense.pos || entry.pos } : {}),
          meaning: sense.meaning,
          ...((sense.whyHard || entry.whyHard) ? { whyHard: sense.whyHard || entry.whyHard } : {}),
          ...(sense.here ? { here: sense.here } : {}),
          ...(entry.coined === true ? { coined: true } : {}),
          ...(sense.trickyMeaning === true ? { trickyMeaning: true } : {}),
          credit: sense.credit,
          ...(Array.isArray(sense.anchors) && sense.anchors.length > 0
            ? { anchors: cloneJson(sense.anchors) }
            : {}),
        });
      } else {
        uncreditedSenses.push(stripCredit(sense));
      }
    }

    if (!entry.credit && creditedSenses.length === 0) {
      nextGlossary[rawKey] = entry;
      continue;
    }

    if (uncreditedSenses.length > 0) {
      const baseEntry = stripCredit(entry);
      baseEntry.senses = uncreditedSenses;
      // Ensure top-level fallback meaning/pos reflects clean L2 senses rather than a removed reader sense.
      if (creditedSenses.some((s) => s.meaning === baseEntry.meaning)) {
        baseEntry.meaning = uncreditedSenses[0].meaning;
        if (uncreditedSenses[0].pos) baseEntry.pos = uncreditedSenses[0].pos;
      }
      nextGlossary[rawKey] = baseEntry;
      continue;
    }

    // All senses (or the whole entry) were reader-credited.
    // Keep an uncredited L2 fallback ONLY when the entry is a book-wide (non-senseOnly) hard word,
    // so sparse reader additions (`senseOnly: true` with 100% credited senses) move cleanly to L3.
    const isHardLemma = keepHardWordBase && entry.senseOnly !== true && !text.isEasyKey(key);
    if (isHardLemma) {
      const baseEntry = stripCredit(entry);
      if (rawSenses && rawSenses.length > 0) {
        baseEntry.senses = rawSenses.map((s) => stripCredit(s));
      }
      nextGlossary[rawKey] = baseEntry;
    }
  }

  clean.glossary = nextGlossary;
  if (typeof clean.count === "number") {
    clean.count = Object.keys(nextGlossary).length;
  }

  if (clean.phrases && typeof clean.phrases === "object") {
    const nextPhrases = {};
    for (const [phraseKey, item] of Object.entries(clean.phrases)) {
      if (item?.credit) {
        signedPhrases.push({
          key: phraseKey.trim().toLowerCase().replace(/\s+/g, " "),
          ...(Array.isArray(item.forms) && item.forms.length > 0 ? { forms: [...item.forms] } : {}),
          ...(item.pos ? { pos: item.pos } : {}),
          meaning: item.meaning,
          ...(item.whyHard ? { whyHard: item.whyHard } : {}),
          ...(item.here ? { here: item.here } : {}),
          ...(item.example ? { example: item.example } : {}),
          credit: item.credit,
        });
      } else {
        nextPhrases[phraseKey] = item;
      }
    }
    if (Object.keys(nextPhrases).length > 0) clean.phrases = nextPhrases;
    else delete clean.phrases;
  }

  if (Array.isArray(clean.sentences)) {
    const nextSentences = [];
    for (const note of clean.sentences) {
      if (note?.credit) {
        signedSentences.push(cloneJson(note));
      } else {
        nextSentences.push(note);
      }
    }
    if (nextSentences.length > 0) clean.sentences = nextSentences;
    else delete clean.sentences;
  }

  if (Array.isArray(clean.paragraphs)) {
    const nextParagraphs = [];
    for (const note of clean.paragraphs) {
      if (note?.credit) {
        signedParagraphs.push(cloneJson(note));
      } else {
        nextParagraphs.push(note);
      }
    }
    if (nextParagraphs.length > 0) clean.paragraphs = nextParagraphs;
    else delete clean.paragraphs;
  }

  if (existingOverlay) {
    const prior = signedMeanings.parseSignedMeaningsOverlay(existingOverlay, catalogId);
    const wordSig = (w) => `${w.key}\0${JSON.stringify(w.anchors ?? null)}`;
    const seenWords = new Set(prior.words.map(wordSig));
    signedWords.splice(0, signedWords.length, ...prior.words, ...signedWords.filter((w) => !seenWords.has(wordSig(w))));
    const seenPhrases = new Set(prior.phrases.map((p) => p.key));
    signedPhrases.splice(0, signedPhrases.length, ...prior.phrases, ...signedPhrases.filter((p) => !seenPhrases.has(p.key)));
    const sentSig = (s) => `${s.chapter}\0${s.context.trim().toLowerCase().replace(/\s+/g, " ")}`;
    const seenSentences = new Set(prior.sentences.map(sentSig));
    signedSentences.splice(0, signedSentences.length, ...prior.sentences, ...signedSentences.filter((s) => !seenSentences.has(sentSig(s))));
    const paraSig = (p) => `${p.chapter}\0${p.paragraph}`;
    const seenParagraphs = new Set(prior.paragraphs.map(paraSig));
    signedParagraphs.splice(0, signedParagraphs.length, ...prior.paragraphs, ...signedParagraphs.filter((p) => !seenParagraphs.has(paraSig(p))));
  }

  const remaining = countCreditsInGlossary(clean);
  if (remaining.total !== 0) {
    throw new Error(`Clean L2 glossary still has ${remaining.total} credit fields`);
  }

  const glossaryValidation = format.validateGlossary(clean);
  if (!glossaryValidation.ok) {
    throw new Error(`Clean L2 glossary failed validation: ${glossaryValidation.errors.join("; ")}`);
  }

  const rawOverlay = {
    schema: signedMeanings.SIGNED_MEANINGS_SCHEMA,
    catalogId,
    updatedAt,
    words: signedWords,
    phrases: signedPhrases,
    sentences: signedSentences,
    ...(signedParagraphs.length > 0 ? { paragraphs: signedParagraphs } : {}),
  };
  const overlay = signedMeanings.parseSignedMeaningsOverlay(rawOverlay, catalogId);
  const serializedOverlay = overlay.paragraphs.length > 0
    ? overlay
    : {
        schema: overlay.schema,
        catalogId: overlay.catalogId,
        updatedAt: overlay.updatedAt,
        words: overlay.words,
        phrases: overlay.phrases,
        sentences: overlay.sentences,
      };
  const compactCredits = `${JSON.stringify(serializedOverlay, null, 2)}\n`;
  if (Buffer.byteLength(compactCredits, "utf8") > signedMeanings.MAX_SIGNED_MEANINGS_BYTES) {
    throw new Error(`Signed meanings overlay exceeds ${signedMeanings.MAX_SIGNED_MEANINGS_BYTES} bytes`);
  }

  return {
    glossary: clean,
    overlay: serializedOverlay,
    extracted: {
      words: overlay.words.length,
      phrases: overlay.phrases.length,
      sentences: overlay.sentences.length,
      paragraphs: overlay.paragraphs.length,
      total:
        overlay.words.length +
        overlay.phrases.length +
        overlay.sentences.length +
        overlay.paragraphs.length,
    },
  };
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--catalog-id") out.catalogId = argv[++i];
    else if (arg === "--in") out.input = argv[++i];
    else if (arg === "--out-glossary") out.outGlossary = argv[++i];
    else if (arg === "--out-credits") out.outCredits = argv[++i];
    else if (arg === "--updated-at") out.updatedAt = Number(argv[++i]);
    else if (arg === "--merge-credits") out.mergeCredits = argv[++i];
    else if (arg === "--drop-hard-base") out.keepHardWordBase = false;
  }
  return out;
}

const isCli =
  process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isCli) {
  const args = parseArgs(process.argv.slice(2));
  if (!args.catalogId || !args.input || !args.outGlossary || !args.outCredits) {
    console.error(
      "Usage: node scripts/credits-layer.mjs --catalog-id <catalog:id> --in <glossary.json> --out-glossary <clean.json> --out-credits <credits.json> [--updated-at <ms>]",
    );
    process.exit(1);
  }
  const raw = JSON.parse(readFileSync(resolve(args.input), "utf8"));
  const existingOverlay = args.mergeCredits
    ? JSON.parse(readFileSync(resolve(args.mergeCredits), "utf8"))
    : null;
  const result = await splitGlossaryCredits(raw, {
    catalogId: args.catalogId,
    updatedAt: Number.isSafeInteger(args.updatedAt) ? args.updatedAt : Date.now(),
    keepHardWordBase: args.keepHardWordBase !== false,
    existingOverlay,
  });
  mkdirSync(dirname(resolve(args.outGlossary)), { recursive: true });
  mkdirSync(dirname(resolve(args.outCredits)), { recursive: true });
  writeFileSync(resolve(args.outGlossary), `${JSON.stringify(result.glossary, null, 2)}\n`);
  writeFileSync(resolve(args.outCredits), `${JSON.stringify(result.overlay, null, 2)}\n`);
  console.log(
    JSON.stringify({
      catalogId: args.catalogId,
      l2Words: Object.keys(result.glossary.glossary).length,
      extracted: result.extracted,
    }),
  );
}
