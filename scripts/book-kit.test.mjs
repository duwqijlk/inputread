import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import JSZip from "jszip";
import { buildKit, buildSamplePack, KIT_FILES, KIT_NAME, SAMPLE_PACK_NAME } from "./build-kit.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

test("kit text sources use canonical LF bytes on every platform", () => {
  for (const { from } of KIT_FILES.filter(file => /\.(?:md|json)$/.test(file.from))) {
    const bytes = readFileSync(join(ROOT, from));
    assert.equal(bytes.includes(13), false, `${from}: use the LF checkout required by .gitattributes`);
    assert.equal(bytes.at(-1), 10, `${from}: preserve the final LF`);
  }
});

test("the tracked kit is byte-identical to the deterministic generator", async () => {
  const generated = await buildKit();
  // Digest comparisons retain exact byte equality without dumping tens of thousands of bytes on failure.
  const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
  assert.equal(digest(await buildKit()), digest(generated), "repeated kit builds must produce the same bytes");
  assert.equal(
    digest(readFileSync(join(ROOT, KIT_NAME))),
    digest(generated),
    "rebuild the tracked kit after changing its specification or sample sources",
  );
});

test("the kit preserves its four-file layout and unchanged sample source bytes", async () => {
  const kit = await JSZip.loadAsync(readFileSync(join(ROOT, KIT_NAME)));
  assert.deepEqual(Object.keys(kit.files).sort(), [
    "book-pack-spec.md",
    "the-lantern-seller.epub",
    "the-lantern-seller.glossary.json",
    "the-lantern-seller.pack.zip",
  ]);
  for (const { name, from } of KIT_FILES) {
    assert.deepEqual(await kit.file(name).async("nodebuffer"), readFileSync(join(ROOT, from)), name);
  }
  const sampleBytes = await kit.file(SAMPLE_PACK_NAME).async("nodebuffer");
  assert.deepEqual(sampleBytes, await buildSamplePack());
  const sample = await JSZip.loadAsync(sampleBytes);
  assert.deepEqual(Object.keys(sample.files).sort(), ["book.epub", "glossary.json"]);
  assert.deepEqual(
    await sample.file("book.epub").async("nodebuffer"),
    readFileSync(join(ROOT, "examples/sample-book/the-lantern-seller.epub")),
  );
  assert.deepEqual(
    await sample.file("glossary.json").async("nodebuffer"),
    readFileSync(join(ROOT, "examples/sample-book/glossary.json")),
  );
});
