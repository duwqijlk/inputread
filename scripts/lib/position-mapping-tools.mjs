/** Local-only exact-position proof. This does NOT decide which meaning fits a sentence. */
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, existsSync, openSync, closeSync, writeFileSync, unlinkSync } from "node:fs";
import { resolve, relative, isAbsolute, dirname, sep } from "node:path";
import { loadAppModules, loadFreshAppModule } from "./app-modules.mjs";

const HEX = /^[0-9a-f]{64}$/;
const RELEASE = /^[a-z0-9][a-z0-9-]{0,79}$/;
const SCHEMA = "oewn-position-mappings-v1";
const MAX_BYTES = 192 * 1024;
export const sha256 = value => createHash("sha256").update(value).digest("hex");
function need(ok, message) { if (!ok) throw new Error(message); }
const integer = n => Number.isSafeInteger(n) && n >= 0;

/** Same map assembly as reader.tsx; spelling/inflection resolution is the shared text helper. */
function readerMarks(glossary, format) {
  const ready = new Set(), sparse = new Map(), tricky = new Map(), forms = new Map(), keys = new Map();
  for (const [key, gloss] of Object.entries(glossary)) {
    ready.add(key);
    if (!keys.has(key)) keys.set(key, key);
    const straight = format.plainSurface(key);
    if (!keys.has(straight)) keys.set(straight, key);
    const bare = straight.replace(/\.+$/g, "");
    if (bare && !keys.has(bare)) keys.set(bare, key);
    if (gloss.senseOnly === true) sparse.set(key, gloss);
    if (format.hasTrickySense(gloss)) tricky.set(key, gloss);
    for (const form of gloss.forms ?? []) {
      const name = format.plainSurface(form);
      if (name && !forms.has(name)) forms.set(name, key);
    }
  }
  return { ready, sparse, tricky, forms, keys };
}

export async function readPositionSource({ epub: epubPath, glossary: glossaryPath }) {
  const app = await loadAppModules();
  const bytes = readFileSync(epubPath), glossaryBytes = readFileSync(glossaryPath);
  const raw = JSON.parse(glossaryBytes.toString("utf8").replace(new RegExp("^" + String.fromCharCode(0xfeff)), ""));
  const check = app.format.validateGlossary(raw);
  need(check.ok && check.file, `Unsupported glossary: ${check.errors.join("; ")}`);
  // Fail closed instead of guessing how lenient or legacy installation rewrote a list.
  need(raw.version === 2, "Only validated version 2 whole-book glossaries are supported");
  const file = check.file;
  need(JSON.stringify(Object.keys(raw.glossary)) === JSON.stringify(Object.keys(file.glossary)),
    "Glossary keys require normalization; live-equivalent installation is uncertain");
  need(raw.segmentation === undefined || raw.segmentation === 2, "Unsupported segmentation option");
  if (raw.spine !== undefined) need(JSON.stringify(raw.spine) === JSON.stringify(file.spine), "Unsupported or discarded spine.merge settings");
  const parseOptions = { cover: false, ...(file.segmentation === 2 ? { segmentation: 2 } : {}) };
  let book = await app.epub.parseEpub(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), parseOptions);
  const merge = file.spine?.merge ?? {};
  const warnings = app.epub.spineFileWarnings(merge, book);
  need(warnings.length === 0, `Uncertain spine.merge: ${JSON.stringify(warnings)}`);
  book = app.epub.applySpineMerge(book, merge);
  const used = app.format.forBook(file, book.chapters.length);
  const marks = readerMarks(used.glossary, app.format);
  const render = (chapter, chapterIndex) => {
    need(chapter.html, "Paragraphs-only chapters are unsupported; exact linked EPUB HTML required");
    const html = app.chapterLink.linkChapterHtml(chapter.html, marks.ready,
      surface => app.text.resolveGlossKey(surface, marks.keys, marks.forms), chapterIndex,
      marks.sparse, marks.tricky, used.phrases ?? {});
    need(html, "Reader chapter linking produced no HTML");
    const root = document.createElement("article");
    if (file.segmentation === 2) root.setAttribute("data-segmentation", "2");
    root.innerHTML = html;
    const blocks = app.readerBlocks.readerParagraphBlocks(root);
    const paragraphs = blocks.map(block => app.flow.flowText(block));
    const tokens = [];
    for (const button of root.querySelectorAll('[role="button"][data-word]')) {
      const paragraphIndex = blocks.findIndex(block => block.contains(button));
      if (paragraphIndex < 0) continue;
      // Exactly the reader's pickButton path, including its nearest-block choice.
      const block = button.closest("p, li, blockquote, h1, h2, h3, h4, div[data-para]") ?? blocks[paragraphIndex];
      tokens.push({ paragraphIndex, offset: Array.from(app.flow.flowTextBefore(block, button)).length,
        surface: button.getAttribute("data-word"), occurrence: Number(button.getAttribute("data-n")) || 1 });
    }
    return { chapterIndex, paragraphs, tokens, chapterSha256: sha256(JSON.stringify(paragraphs)),
      paragraphHashes: paragraphs.map(sha256) };
  };
  const chapters = book.chapters.map(render);
  // Unmerged files can be displayed as extras; identical text there is also ambiguous source proof.
  const extras = (book.extras ?? []).map(extra => render(extra, -1));
  return { app, chapters, allSources: [...chapters, ...extras], evidence: {
    epubSha256: sha256(bytes), glossarySha256: sha256(glossaryBytes),
    parseOptions, spineMerge: merge, chapterCount: chapters.length, extraCount: extras.length,
    chapters: chapters.map(({ chapterIndex, chapterSha256, paragraphHashes }) => ({ chapterIndex, chapterSha256, paragraphHashes })),
    parser: "src/lib/epub.ts + chapter-link.ts + reader-blocks.ts + flow-text.ts",
  } };
}

function validateRow(row) {
  need(row && typeof row === "object" && !Array.isArray(row), "Invalid mapping row");
  need(HEX.test(row.chapterSha256) && HEX.test(row.paragraphSha256) && HEX.test(row.positionKey), "Invalid coordinate hash/key");
  need(integer(row.paragraphIndex) && integer(row.offset), "Invalid paragraphIndex/offset");
  for (const key of ["surface", "lemma", "senseId"]) need(typeof row[key] === "string" && row[key].length > 0, `Missing ${key}`);
  need(typeof row.release === "string" && RELEASE.test(row.release), "Invalid provenance release");
  need(Number.isSafeInteger(row.reviewedAt) && row.reviewedAt > 0, "Invalid reviewedAt");
  if (row.matchedBy !== undefined) need(Array.isArray(row.matchedBy) && row.matchedBy.length <= 3 &&
    row.matchedBy.every(id => typeof id === "string" && /^[0-9a-f]{12}$/.test(id)) && new Set(row.matchedBy).size === row.matchedBy.length, "Invalid matchedBy");
}

async function provePosition(source, catalogId, row) {
  const matches = source.allSources.filter(chapter => chapter.chapterSha256 === row.chapterSha256);
  need(matches.length === 1, matches.length ? "Ambiguous identical source chapters" : "Chapter hash not found in source");
  const chapter = matches[0];
  need(chapter.chapterIndex >= 0, "Unmerged extra positions are unsupported");
  const paragraph = chapter.paragraphs[row.paragraphIndex];
  need(typeof paragraph === "string", "Paragraph index out of range");
  need(sha256(paragraph) === row.paragraphSha256, "Paragraph hash mismatch");
  const position = await source.app.dictionaryPositions.dictionaryPosition(chapter.paragraphs, row.paragraphIndex, row.offset, row.surface);
  need(position, "Code-point offset/surface mismatch or range error");
  need(await source.app.dictionaryPositions.positionKey(catalogId, position) === row.positionKey, "Position key mismatch");
  need(chapter.tokens.filter(token => token.paragraphIndex === row.paragraphIndex && token.offset === row.offset && token.surface === row.surface).length === 1,
    "Unsupported standard span: require one exact reader token (not a phrase, substring, or guessed occurrence)");
  return { chapterIndex: chapter.chapterIndex, paragraphText: paragraph };
}

let dictionaryBusy = false;
/** Replace fetch for the full awaited loader lifetime. Never fall back to real network fetch. */
async function withLocalDictionary(rootPath, run) {
  need(!dictionaryBusy, "Concurrent local dictionary sessions are unsupported");
  dictionaryBusy = true;
  const originalFetch = globalThis.fetch;
  const resources = new Map();
  try {
    const root = realpathSync(resolve(rootPath));
    globalThis.fetch = async input => {
      const path = typeof input === "string" ? input : input?.url;
      need(typeof path === "string" && /^\/dictionary\/[a-zA-Z0-9/_.-]+\.json$/.test(path) && !path.includes(".."), "Non-local dictionary request denied");
      const local = resolve(root, `.${path}`);
      const rel = relative(root, local);
      need(rel && !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`), "Dictionary path escape denied");
      if (!existsSync(local)) {
        resources.set(path, { path, status: 404 });
        return new Response(null, { status: 404 });
      }
      const actual = realpathSync(local), realRel = relative(root, actual);
      need(!isAbsolute(realRel) && realRel !== ".." && !realRel.startsWith(`..${sep}`), "Dictionary symlink escape denied");
      const bytes = readFileSync(actual);
      const receipt = { path, status: 200, sha256: sha256(bytes), bytes: bytes.length };
      const before = resources.get(path);
      need(!before || JSON.stringify(before) === JSON.stringify(receipt), "Local dictionary changed during verification");
      resources.set(path, receipt);
      return new Response(bytes, { status: 200, headers: { "content-length": String(bytes.length) } });
    };
    const dictionary = await loadFreshAppModule("standard-dictionary");
    const publication = await dictionary.readPublication();
    need(publication, "Local dictionary/current.json is required");
    const result = await run(dictionary, publication);
    // Detect edits even for paths satisfied from loader caches after their first read.
    for (const receipt of resources.values()) {
      const local = resolve(root, `.${receipt.path}`);
      need(receipt.status === 404 ? !existsSync(local) : existsSync(local) && sha256(readFileSync(local)) === receipt.sha256,
        "Local dictionary changed during verification");
    }
    return { ...result, dictionary: { publication,
      loader: { source: "src/lib/standard-dictionary.ts", sourceSha256: sha256(readFileSync(new URL("../../src/lib/standard-dictionary.ts", import.meta.url))),
        nodeOnlyExports: { readPublication: "activeRelease", lookupPublicationForms: "lookupForms" },
        note: "Unmodified source transpiled with private-function export aliases appended only to temporary Node output; no morphology copied." },
      resources: [...resources.values()].sort((a, b) => a.path.localeCompare(b.path)) } };
  } finally {
    globalThis.fetch = originalFetch;
    dictionaryBusy = false;
  }
}

async function candidateProof(dictionary, publication, row) {
  // The real reader does its complete exact/case/forms lookup. No copied morphology rules.
  const result = await dictionary.lookupStandardWord(row.surface);
  if (publication.formsIndex) {
    const forms = await dictionary.lookupPublicationForms(publication, row.surface.normalize("NFC"));
    need(forms.kind !== "error", "Dictionary forms enrichment failed (incomplete candidate evidence)");
  }
  need(result?.kind === "unmapped", `Dictionary candidate lookup is ${result?.kind ?? "unavailable"}`);
  const candidates = result.senses.filter(sense => sense.id === row.senseId && sense.source.lemma === row.lemma);
  need(candidates.length === 1, "Full opaque senseId + lemma is not a legal surface candidate");
  const candidate = candidates[0];
  // release is recorded provenance, never used to choose a word path or define sense identity.
  return { candidateCount: result.senses.length, currentEntryRelease: candidate.source.release,
    mappingRelease: row.release, releaseMatchesCurrentEntry: row.release === candidate.source.release };
}

export async function verifyPositionMappings(options, mappings) {
  const source = await readPositionSource(options);
  const { cleanCatalogRef } = source.app.catalogId;
  need(cleanCatalogRef(options.catalogId) === options.catalogId && !!options.catalogId, "Invalid catalog identity syntax");
  need(mappings?.schema === SCHEMA && mappings.catalogId === options.catalogId && Array.isArray(mappings.entries), "Mapping schema/catalog identity mismatch");
  need(Buffer.byteLength(JSON.stringify(mappings)) <= MAX_BYTES, "Mapping exceeds reader's 192 KiB limit");
  return withLocalDictionary(options.dictionaryRoot, async (dictionary, publication) => {
    const seen = new Set(), rows = [];
    for (const [index, row] of mappings.entries.entries()) {
      try {
        validateRow(row);
        need(!seen.has(row.positionKey), "Duplicate position key");
        seen.add(row.positionKey);
        const coordinate = await provePosition(source, options.catalogId, row);
        const candidate = await candidateProof(dictionary, publication, row);
        rows.push({ index, ok: true, positionKey: row.positionKey, ...coordinate, ...candidate });
      } catch (error) { rows.push({ index, ok: false, positionKey: row?.positionKey, error: error.message }); }
    }
    return { schema: "oewn-position-verification-v1", ok: rows.every(row => row.ok),
      semanticReview: "operator-required", catalogId: options.catalogId, catalogProof: "syntax-only; no live catalog existence or EPUB binding established",
      source: source.evidence, rows, checkedRows: rows.length };
  });
}

export async function buildPositionMappings(options, decisions) {
  need(decisions && Array.isArray(decisions.entries), "Decisions must be {entries:[explicit authored decisions]}");
  const source = await readPositionSource(options);
  need(source.app.catalogId.cleanCatalogRef(options.catalogId) === options.catalogId && !!options.catalogId, "Invalid catalog identity syntax");
  const entries = [];
  for (const [index, decision] of decisions.entries.entries()) {
    need(decision && integer(decision.chapterIndex) && integer(decision.paragraphIndex) && integer(decision.offset), `Decision ${index}: explicit chapterIndex/paragraphIndex/code-point offset required`);
    for (const key of ["surface", "lemma", "senseId", "release", "reviewedAt"]) need(Object.hasOwn(decision, key), `Decision ${index}: explicit ${key} required`);
    need(!Object.hasOwn(decision, "occurrence"), `Decision ${index}: use code-point offset, never occurrence/token ordinal`);
    const chapter = source.chapters[decision.chapterIndex];
    need(chapter, `Decision ${index}: chapterIndex out of range`);
    need(typeof decision.surface === "string" && decision.surface, `Decision ${index}: invalid surface`);
    const position = await source.app.dictionaryPositions.dictionaryPosition(chapter.paragraphs, decision.paragraphIndex, decision.offset, decision.surface);
    need(position, `Decision ${index}: code-point offset/surface mismatch`);
    const row = { positionKey: await source.app.dictionaryPositions.positionKey(options.catalogId, position), ...position,
      senseId: decision.senseId, lemma: decision.lemma, release: decision.release, reviewedAt: decision.reviewedAt,
      ...(decision.matchedBy !== undefined ? { matchedBy: decision.matchedBy } : {}) };
    entries.push(row);
  }
  const mappings = { schema: SCHEMA, catalogId: options.catalogId, entries };
  const report = await verifyPositionMappings(options, mappings);
  need(report.source.epubSha256 === source.evidence.epubSha256 && report.source.glossarySha256 === source.evidence.glossarySha256,
    "Source changed while building");
  return { mappings, report };
}

export function usage(mode) {
  return `Local-only ${mode} (no publication, dictionary writes, or semantic approval)\n` +
    `node scripts/positions-${mode}.mjs --epub BOOK.epub --glossary LIVE.json --catalog-id word-lists:id \\\n  --dictionary-root LOCAL_ROOT --${mode === "build" ? "decisions DECISIONS.json --out NEW-mappings.json" : "mappings EXISTING.json"} --report NEW-report.json\n` +
    `LOCAL_ROOT contains dictionary/current.json and its releases/, case-indexes/, form-indexes/ files.\n` +
    `Only validated v2 whole-book glossaries are supported; segmentation and spine.merge come from that file.\n` +
    `Decisions: {"entries":[{"chapterIndex":0,"paragraphIndex":0,"offset":0,"surface":"word","lemma":"word","senseId":"opaque full ID","release":"provenance-release","reviewedAt":1}]}\n` +
    `Indexes are zero-based, offset counts Unicode code points; author decisions only after contextual semantic review.\n` +
    `Catalog identity is required and syntax-checked only. No claim of actual catalog existence or source binding.\n` +
    `New output/report files must not exist. Verify reports every row; nonzero exit on any failure.\n`;
}

function parseArgs(mode, args) {
  const allowed = new Set(["epub", "glossary", "catalog-id", "dictionary-root", "report", ...(mode === "build" ? ["decisions", "out"] : ["mappings"])]);
  const result = {};
  for (let at = 0; at < args.length; at += 2) {
    const key = args[at]?.replace(/^--/, "");
    need(args[at]?.startsWith("--") && allowed.has(key) && !Object.hasOwn(result, key) && args[at + 1] && !args[at + 1].startsWith("--"), `Invalid argument ${args[at]}`);
    result[key] = args[at + 1];
  }
  for (const key of allowed) need(result[key], `Missing --${key}`);
  return result;
}

/** Reserve every output exclusively before any work. Inputs are never opened for writing. */
function reserveOutputs(paths, inputs, dictionaryRoot) {
  const reserved = [];
  try {
    const dictionary = realpathSync(resolve(dictionaryRoot));
    for (const path of paths) {
      const output = resolve(realpathSync(dirname(resolve(path))), resolve(path).split(/[\\/]/).pop());
      const insideDictionary = relative(dictionary, output);
      need(insideDictionary === ".." || insideDictionary.startsWith(`..${sep}`) || isAbsolute(insideDictionary), "Output must be outside read-only dictionary root");
      need(!inputs.some(input => resolve(input) === output || (existsSync(input) && realpathSync(input) === output)), "Output cannot overwrite input");
      const fd = openSync(output, "wx");
      reserved.push({ path: output, fd });
    }
    return reserved;
  } catch (error) {
    for (const item of reserved) { closeSync(item.fd); unlinkSync(item.path); }
    throw error;
  }
}

export async function runPositionCli(mode, args = process.argv.slice(2)) {
  if (args.length === 1 && ["--help", "-h"].includes(args[0])) { process.stdout.write(usage(mode)); return 0; }
  let outputs;
  try {
    const flags = parseArgs(mode, args);
    const inputPath = mode === "build" ? flags.decisions : flags.mappings;
    outputs = reserveOutputs(mode === "build" ? [flags.out, flags.report] : [flags.report],
      [flags.epub, flags.glossary, inputPath], flags["dictionary-root"]);
    const options = { epub: flags.epub, glossary: flags.glossary, catalogId: flags["catalog-id"], dictionaryRoot: flags["dictionary-root"] };
    const inputBytes = readFileSync(inputPath);
    const input = JSON.parse(inputBytes.toString("utf8").replace(new RegExp("^" + String.fromCharCode(0xfeff)), ""));
    let report, mappings;
    if (mode === "build") ({ mappings, report } = await buildPositionMappings(options, input));
    else {
      need(inputBytes.length <= MAX_BYTES, "Mapping file exceeds reader's 192 KiB limit");
      report = await verifyPositionMappings(options, input);
    }
    report.inputSha256 = sha256(inputBytes);
    if (mappings && report.ok) {
      const output = JSON.stringify(mappings) + "\n";
      need(Buffer.byteLength(output) <= MAX_BYTES, "Mapping output exceeds reader's 192 KiB limit");
      report.mappingSha256 = sha256(output);
      writeFileSync(outputs[0].fd, output);
    }
    writeFileSync(outputs.at(-1).fd, JSON.stringify(report, null, 2) + "\n");
    if (mappings && !report.ok) { closeSync(outputs[0].fd); outputs[0].fd = undefined; unlinkSync(outputs[0].path); }
    process.stdout.write(JSON.stringify({ ok: report.ok, checkedRows: report.checkedRows, semanticReview: report.semanticReview, report: flags.report }) + "\n");
    return report.ok ? 0 : 1;
  } catch (error) {
    if (outputs) {
      writeFileSync(outputs.at(-1).fd, JSON.stringify({ schema: "oewn-position-verification-v1", ok: false, semanticReview: "operator-required", error: error.message }, null, 2) + "\n");
      if (mode === "build" && outputs[0].fd !== undefined) { closeSync(outputs[0].fd); outputs[0].fd = undefined; unlinkSync(outputs[0].path); }
    }
    process.stderr.write(`positions-${mode}: ${error.message}\n`);
    return 1;
  } finally { for (const item of outputs ?? []) if (item.fd !== undefined) closeSync(item.fd); }
}
