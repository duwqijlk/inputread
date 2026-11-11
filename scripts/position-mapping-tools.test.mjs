import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
import { buildEpub } from "./make-sample-epub.mjs";
import { loadAppModules, loadFreshAppModule } from "./lib/app-modules.mjs";
import { buildPositionMappings, verifyPositionMappings, readPositionSource, sha256 } from "./lib/position-mapping-tools.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const json = (path, value) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(value)); };
const publication = { schema: "oewn-r2-current-v1", release: "fixture-current", wordsMutable: true,
  caseIndex: "case-v1-000000000001", formsIndex: "forms-v1-000000000001" };
const basicGlossary = { version: 2, glossary: { lantern: { pos: "noun", meaning: "A portable light.", whyHard: "A particular kind of light.", forms: ["lanterns"] } } };

async function fixture(t, bodies) {
  const dir = mkdtempSync(join(tmpdir(), "position-mapping-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const epub = join(dir, "source.epub"), glossary = join(dir, "glossary.json"), dictionaryRoot = join(dir, "local-publication");
  let bytes = await buildEpub();
  if (bodies) {
    const zip = await JSZip.loadAsync(bytes);
    for (const [index, body] of bodies.entries()) zip.file(`OEBPS/chapter${index + 1}.xhtml`,
      `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>Source</title></head><body>${body}</body></html>`);
    bytes = await zip.generateAsync({ type: "nodebuffer" });
  }
  writeFileSync(epub, bytes);
  json(glossary, basicGlossary);
  json(join(dictionaryRoot, "dictionary/current.json"), publication);
  const dictionary = await loadFreshAppModule("standard-dictionary");
  // Complete tiny 256-shard indexes let the actual morphology loader probe any proposal.
  for (let n = 0; n < 256; n++) {
    const shard = n.toString(16).padStart(2, "0");
    json(join(dictionaryRoot, `dictionary/case-indexes/${publication.caseIndex}/${shard}.json`), {
      schema: "oewn-case-index-v1", release: publication.release, indexVersion: publication.caseIndex, shard, entries: {},
    });
    json(join(dictionaryRoot, `dictionary/form-indexes/${publication.formsIndex}/${shard}.json`), {
      schema: "oewn-form-index-v1", release: publication.release, indexVersion: publication.formsIndex, shard, entries: {},
    });
  }
  const cases = new Map(), forms = new Map();
  const word = (lemma, senses, release = "wording-newer") => {
    json(join(dictionaryRoot, dictionary.dictionaryWordPath(publication.release, lemma)), {
      schema: "oewn-r2-entry-v1", release, lookupKey: lemma,
      senses: senses.map(([id, pos]) => ({ id, pos, meaning: "A local fixture meaning.", originalMeaning: "A source fixture definition." })),
    });
    const lower = lemma.toLowerCase(), shard = dictionary.dictionaryCaseShard(lower);
    if (!cases.has(shard)) cases.set(shard, {});
    (cases.get(shard)[lower] ??= []).push(lemma);
    json(join(dictionaryRoot, `dictionary/case-indexes/${publication.caseIndex}/${shard}.json`), {
      schema: "oewn-case-index-v1", release: publication.release, indexVersion: publication.caseIndex, shard, entries: cases.get(shard),
    });
  };
  const form = (surface, candidates) => {
    const lower = surface.toLowerCase(), shard = dictionary.dictionaryCaseShard(lower);
    if (!forms.has(shard)) forms.set(shard, {});
    forms.get(shard)[lower] = candidates;
    json(join(dictionaryRoot, `dictionary/form-indexes/${publication.formsIndex}/${shard}.json`), {
      schema: "oewn-form-index-v1", release: publication.release, indexVersion: publication.formsIndex, shard, entries: forms.get(shard),
    });
  };
  word("lantern", [["opaque/sense:%full/id", "n"]]);
  form("lanterns", [{ lemma: "lantern", pos: "n" }]);
  return { dir, epub, glossary, dictionaryRoot, catalogId: "word-lists:fixture", bytes, word, form, dictionary };
}

async function decisionAt(f, surface, occurrence = 1) {
  const source = await readPositionSource(f);
  for (const chapter of source.chapters) {
    const token = chapter.tokens.find(token => token.surface === surface && token.occurrence === occurrence);
    if (token) return { chapterIndex: chapter.chapterIndex, paragraphIndex: token.paragraphIndex, offset: token.offset,
      surface, lemma: "lantern", senseId: "opaque/sense:%full/id", release: "historical-review", reviewedAt: 123 };
  }
  throw new Error(`Fixture token missing: ${surface}`);
}

// Serial top-level tests: the real dictionary loader uses process-global fetch by design.
test("sample original EPUB builds exact reader coordinates and verifies mutable current paths", async t => {
  const f = await fixture(t);
  const decision = await decisionAt(f, "lantern");
  const { mappings, report } = await buildPositionMappings(f, { entries: [decision] });
  assert.equal(report.ok, true);
  assert.equal(report.semanticReview, "operator-required");
  assert.equal(report.catalogProof.startsWith("syntax-only"), true);
  assert.equal(report.source.epubSha256, sha256(f.bytes));
  assert.deepEqual(report.source.parseOptions, { cover: false });
  assert.equal(report.rows[0].currentEntryRelease, "wording-newer");
  assert.equal(report.rows[0].mappingRelease, "historical-review");
  assert.equal(report.rows[0].releaseMatchesCurrentEntry, false);
  assert.equal(report.dictionary.resources.some(r => r.path.includes("releases/fixture-current/words/")), true);
  assert.equal(report.dictionary.resources.some(r => r.path.includes("releases/wording-newer")), false);
  const source = await readPositionSource(f), P = source.chapters[decision.chapterIndex].paragraphs;
  assert.equal(mappings.entries[0].chapterSha256, sha256(JSON.stringify(P)));
  assert.equal(mappings.entries[0].paragraphSha256, sha256(P[decision.paragraphIndex]));
  assert.equal((await verifyPositionMappings(f, mappings)).ok, true);
});

test("code points, inline fragments, line breaks, hidden content and repeated occurrences", async t => {
  const f = await fixture(t, ['<h1>Fixture</h1><p>😀 A lan<em>tern</em><br/>lantern waits here. Lanterns remain.</p><p>lantern waits here.</p>']);
  const first = await decisionAt(f, "lantern", 1), second = await decisionAt(f, "lantern", 2);
  assert.equal(first.offset, 4); // emoji is one code point, not two UTF-16 code units
  assert.notEqual(first.offset, second.offset);
  const result = await buildPositionMappings(f, { entries: [first, second] });
  assert.equal(result.report.ok, true);
  assert.notEqual(result.mappings.entries[0].positionKey, result.mappings.entries[1].positionKey);
  const plural = await decisionAt(f, "Lanterns");
  assert.equal((await buildPositionMappings(f, { entries: [plural] })).report.ok, true);
  const wrong = { ...first, offset: first.offset + 1 };
  await assert.rejects(buildPositionMappings(f, { entries: [wrong] }), /offset\/surface mismatch/);
  await assert.rejects(buildPositionMappings(f, { entries: [{ ...first, occurrence: 1 }] }), /never occurrence/);
});

test("identical chapter arrays are ambiguous even with an explicit chapterIndex", async t => {
  const body = '<h1>Identical</h1><p>A lantern waits quietly beside the window.</p>';
  const f = await fixture(t, [body, body]);
  const decision = await decisionAt(f, "lantern");
  const result = await buildPositionMappings(f, { entries: [decision] });
  assert.equal(result.report.ok, false, JSON.stringify((await readPositionSource(f)).chapters.map(c => c.paragraphs)));
  assert.match(result.report.rows[0].error, /Ambiguous identical/);
});

test("verify checks every row: forged keys, duplicates, ranges, substring/phrase, candidate IDs", async t => {
  const f = await fixture(t, ['<h1>Fixture</h1><p>A lantern lantern waits beside the window.</p>']);
  const decision = await decisionAt(f, "lantern");
  const { mappings } = await buildPositionMappings(f, { entries: [decision] });
  const row = mappings.entries[0];
  const source = await readPositionSource(f);
  const position = async (offset, surface) => {
    const p = await source.app.dictionaryPositions.dictionaryPosition(source.chapters[0].paragraphs, row.paragraphIndex, offset, surface);
    return { ...row, ...p, positionKey: await source.app.dictionaryPositions.positionKey(f.catalogId, p) };
  };
  const rows = [row, { ...row }, { ...row, positionKey: "0".repeat(64) },
    { ...row, paragraphIndex: 100, positionKey: "1".repeat(64) },
    { ...await position(row.offset + 1, "antern"), senseId: "invented" },
    await position(row.offset, "lantern lantern"),
    { ...await position(row.offset + 8, "lantern"), senseId: "short-id-not-full" },
    { ...row, reviewedAt: 0, positionKey: "2".repeat(64) }];
  const report = await verifyPositionMappings(f, { ...mappings, entries: rows });
  assert.equal(report.checkedRows, rows.length);
  assert.equal(report.rows.filter(row => row.ok).length, 1);
  assert.match(report.rows[1].error, /Duplicate/);
  assert.match(report.rows[2].error, /key mismatch/);
  assert.match(report.rows[3].error, /range/);
  assert.match(report.rows[4].error, /one exact reader token/);
  assert.match(report.rows[5].error, /one exact reader token/);
  assert.match(report.rows[6].error, /opaque senseId/);
});

test("case inventory and explicit forms constrain lemma and POS; regular forms use actual loader", async t => {
  const f = await fixture(t, ['<p>Axes axes Lanterns lanterns remained beside the window.</p>']);
  f.word("axe", [["axe-n", "n"], ["axe-v", "v"]]);
  f.word("axis", [["axis-n", "n"]]);
  f.word("Axes", [["proper-axes", "n"]]);
  f.form("axes", [{ lemma: "axe", pos: "n" }]);
  const d = { ...await decisionAt(f, "Axes"), senseId: "axe-n", lemma: "axe" };
  assert.equal((await buildPositionMappings(f, { entries: [d] })).report.ok, true);
  const bad = await buildPositionMappings(f, { entries: [{ ...d, senseId: "axe-v" }, { ...d, senseId: "axis-n", lemma: "axis" }] });
  assert.equal(bad.report.ok, false);
  assert.match(bad.report.rows[0].error, /not a legal surface candidate/);
  // No explicit form for Lanterns after removing that fixture index group: Morphy must resolve it.
  const shard = f.dictionary.dictionaryCaseShard("lanterns");
  json(join(f.dictionaryRoot, `dictionary/form-indexes/${publication.formsIndex}/${shard}.json`), {
    schema: "oewn-form-index-v1", release: publication.release, indexVersion: publication.formsIndex, shard, entries: {},
  });
  assert.equal((await buildPositionMappings(f, { entries: [await decisionAt(f, "Lanterns")] })).report.ok, true);
});

test("missing/corrupt enrichment fails closed without network fallback", async t => {
  const f = await fixture(t);
  const d = await decisionAt(f, "lantern");
  const shard = f.dictionary.dictionaryCaseShard("lantern");
  rmSync(join(f.dictionaryRoot, `dictionary/form-indexes/${publication.formsIndex}/${shard}.json`));
  const original = globalThis.fetch;
  let networkCalls = 0;
  globalThis.fetch = async () => { networkCalls++; throw new Error("Network forbidden"); };
  try {
    const result = await buildPositionMappings(f, { entries: [d] });
    assert.equal(result.report.ok, false);
    assert.match(result.report.rows[0].error, /enrichment failed|form index unavailable/);
    assert.equal(networkCalls, 0);
    assert.notEqual(globalThis.fetch, original); // caller's fetch is restored
  } finally { globalThis.fetch = original; }
});

test("segmentation uses exact extracted reader helper; forms, sparse/tricky and phrase linking stay in route", async t => {
  const f = await fixture(t, ['<blockquote class="calibre1"><h1>Fixture</h1><p>A lantern waited beside the window.</p><p>Lanterns waited there.</p></blockquote>']);
  const before = await readPositionSource(f);
  json(f.glossary, { ...basicGlossary, segmentation: 2,
    glossary: { lantern: { ...basicGlossary.glossary.lantern, senseOnly: true,
      senses: [{ pos: "noun", meaning: "A portable light.", whyHard: "A particular kind of light.", trickyMeaning: true,
        anchors: [{ chapter: 0, occurrence: 1, form: "lantern" }] }] } },
    phrases: { "wait beside": { pos: "phrase", meaning: "To stay near something.", forms: ["waited beside"] } },
  });
  const after = await readPositionSource(f);
  assert.equal(after.evidence.parseOptions.segmentation, 2);
  assert.ok(after.chapters[0].paragraphs.length > before.chapters[0].paragraphs.length);
  const d = await decisionAt(f, "lantern");
  assert.equal((await buildPositionMappings(f, { entries: [d] })).report.ok, true);
  const { readerBlocks } = await loadAppModules();
  const root = document.createElement("article");
  root.setAttribute("data-reader-paragraphs", ""); root.innerHTML = '<h2>Decorative title</h2><p></p><p>A</p>';
  assert.equal(readerBlocks.readerParagraphBlocks(root).length, 2);
});

test("spine.merge replays actual importer and excludes inserted decorative merge titles", async t => {
  const f = await fixture(t);
  const zip = await JSZip.loadAsync(f.bytes);
  let opf = await zip.file("OEBPS/content.opf").async("string");
  opf = opf.replace("</manifest>", '<item id="appendix" href="appendix.xhtml" media-type="application/xhtml+xml"/></manifest>')
    .replace("</spine>", '<itemref idref="appendix"/></spine>');
  zip.file("OEBPS/content.opf", opf);
  zip.file("OEBPS/appendix.xhtml", '<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>Extra</title></head><body><h1>Afterword</h1><p>A lantern remained beside the quiet window.</p></body></html>');
  writeFileSync(f.epub, await zip.generateAsync({ type: "nodebuffer" }));
  const before = await readPositionSource(f);
  assert.equal(before.evidence.extraCount, 1);
  json(f.glossary, { ...basicGlossary, spine: { merge: { "appendix.xhtml": "chapter1.xhtml" } } });
  const after = await readPositionSource(f);
  assert.deepEqual(after.evidence.spineMerge, { "appendix.xhtml": "chapter1.xhtml" });
  assert.equal(after.evidence.extraCount, 0);
  assert.ok(after.chapters[0].paragraphs.includes("A lantern remained beside the quiet window."));
  assert.notEqual(after.chapters[0].chapterSha256, before.chapters[0].chapterSha256);
  const result = await buildPositionMappings(f, { entries: [await decisionAt(f, "lantern")] });
  assert.equal(result.report.ok, true);
  json(f.glossary, { ...basicGlossary, spine: { merge: { "missing.xhtml": "chapter1.xhtml" } } });
  await assert.rejects(readPositionSource(f), /Uncertain spine.merge/);
});

test("CLI exclusive outputs, required catalog syntax, report and failure exit", async t => {
  const f = await fixture(t);
  const decisions = join(f.dir, "decisions.json"), out = join(f.dir, "new-mappings.json"), report = join(f.dir, "new-report.json");
  json(decisions, { entries: [await decisionAt(f, "lantern")] });
  const base = ["--epub", f.epub, "--glossary", f.glossary, "--catalog-id", f.catalogId, "--dictionary-root", f.dictionaryRoot];
  const cli = (name, args) => spawnSync(process.execPath, [join(ROOT, `scripts/positions-${name}.mjs`), ...args], { encoding: "utf8" });
  let run = cli("build", [...base, "--decisions", decisions, "--out", out, "--report", report]);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(JSON.parse(readFileSync(report)).ok, true);
  const saved = readFileSync(out);
  run = cli("build", [...base, "--decisions", decisions, "--out", out, "--report", join(f.dir, "unused-report.json")]);
  assert.equal(run.status, 1);
  assert.deepEqual(readFileSync(out), saved);
  assert.equal(existsSync(join(f.dir, "unused-report.json")), false);
  run = cli("verify", [...base, "--mappings", out, "--report", join(f.dir, "verified.json")]);
  assert.equal(run.status, 0, run.stderr);
  const invalid = JSON.parse(saved); invalid.entries[0].senseId = "bogus";
  json(join(f.dir, "invalid.json"), invalid);
  run = cli("verify", [...base, "--mappings", join(f.dir, "invalid.json"), "--report", join(f.dir, "failed.json")]);
  assert.equal(run.status, 1);
  assert.equal(JSON.parse(readFileSync(join(f.dir, "failed.json"))).checkedRows, 1);
  run = cli("build", [...base, "--decisions", decisions, "--out", f.epub, "--report", join(f.dir, "cannot-write.json")]);
  assert.equal(run.status, 1);
  assert.deepEqual(readFileSync(f.epub), f.bytes);
  const noCatalog = base.filter((_, index) => index !== 4 && index !== 5);
  run = cli("verify", [...noCatalog, "--mappings", out, "--report", join(f.dir, "absent.json")]);
  assert.equal(run.status, 1);
  assert.match(run.stderr, /Missing --catalog-id/);
  run = cli("verify", [...base.slice(0, 5), "public-books:custom", ...base.slice(6), "--mappings", out, "--report", join(f.dir, "custom.json")]);
  assert.equal(run.status, 1);
  assert.match(run.stderr, /catalog identity/);
});
