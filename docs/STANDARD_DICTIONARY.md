# Static standard dictionary publication

## Stable per-word updates (compatible reader implementation)

The product contract is **one word file containing all of its existing senses**, with stable sense
IDs. Definition edits overwrite only affected word files at stable paths; books and position
mappings do not change, and a whole dictionary release upload is not required. A sense ID is an
identity field inside the word file, NOT a separate network resource. This reader patch supports
the contract but does not itself migrate R2 or enable stable mode in production.

No new word directory or full data copy is needed. The compatible reader adds the exact boolean
`"wordsMutable":true` to the existing current manifest to select revalidation semantics for the
ALREADY UPLOADED `dictionary/releases/<release>/words/<firsthex>/<fullhex>.json` URLs. The fixed
path's release component becomes its address/index baseline, not a requirement to move files on
each wording edit. Without the flag, legacy immutable caching and release equality remain.
Entry schema stays `oewn-r2-entry-v1`, lookupKey and all full sense IDs stay exact. Entry.release
may record the latest word's update provenance without changing the path or current.release.
One word request still returns all of that word's senses. The proposed wordBase/new-directory
scheme was withdrawn and is not an implemented publication route.

```json
{"schema":"oewn-r2-current-v1","release":"oewn-2025-809369f31478","caseIndex":"case-v1-3d7f0ca2538e","formsIndex":"forms-v1-b53375d8c584","wordsMutable":true}
```

`current.release` continues to bind the immutable case/forms index versions. A meaning-only edit
needs no pointer or index change. If lemma spelling, forms, POS or sense inventory changes, this
is NOT merely a definition edit: coordinate an index-compatible update separately. Never silently
publish new lexical inventory with an old index. Release equality is not sense identity and must
not invalidate an otherwise unchanged book position mapping.

### Mutable caching and incremental publisher requirements

- Stable word objects: `Content-Type: application/json` and
  `Cache-Control: no-cache, max-age=0, must-revalidate` (not immutable). Ensure custom-domain CDN
  rules honor revalidation and ETags. A custom cache-everything rule overriding it must be corrected
  or the affected URL purged; client no-cache alone does not fix an incorrectly configured CDN.
- The reader coalesces simultaneous requests and caches each whole word for 60 seconds from
  response completion. It revalidates on the next lookup after expiry using fetch cache:no-cache.
  Stable 404 responses expire too. Resolved alias results are not cached on top of the word cache.
- Existing displayed cards do not poll or update under a finger; a subsequent lookup after expiry
  sees updated content without a page reload. This is a bounded freshness policy, not instant push.
- Choice validation reads the current stable word object through BOOKS and checks full sense ID
  membership. A wording/provenance revision alone must not reject an older browser's choice.
- Build a changed-lemma list by semantic payload comparison, excluding provenance-only changes;
  for each changed lemma preserve all unrelated sense fields and verify ID/POS membership.
  Map IDs through the actual source inventory, never by parsing an opaque sense ID.
- Snapshot exact previous bytes/metadata and ETag, conditionally PUT only changed stable word
  objects, then read back and compare hashes/headers. Preserve receipts and recovery bytes outside
  the public dictionary. Do not overwrite a concurrent edit or a stable file with unrelated changes.
- No initial full word upload or prefix copy: existing per-word objects are reused. Deploy the
  compatible reader/backend, establish CDN revalidation/purge behavior for existing cached URLs,
  then conditionally add wordsMutable to the same current.json. For every changed word update its
  HTTP metadata to no-cache and purge/verify the affected public URL if an old immutable copy
  persists. Do not claim cache freshness from PUT success alone. No production flag/metadata or
  dictionary content was changed by this implementation task.

The old release publication procedure below remains for immutable source snapshots and initial
index/bootstrap resources; it is not the daily meaning-only update workflow in stable mode.

The reader fetches standard dictionary data directly from the public books host, without a
Function or D1 request. Community explanations, feedback, credits, saved words and book files
remain separate. Reader maintenance must never mint source sense IDs or rewrite standard definitions.

## Identity and case lookup

- Source lemmas and sense IDs stay unchanged. Exact NFC UTF-8 lemma bytes encode the lossless
  `dictionary/releases/<release>/words/<first-byte-hex>/<full-hex>.json` path.
- Query the exact spelling encountered in the book first, not the legacy glossary resolver's stem.
- Only a genuine exact-entry 404 permits case fallback. Network errors, malformed data and
  identity mismatches must fail closed, not trigger a different meaning.
- Lowercase uses JavaScript `word.normalize('NFC').toLowerCase().normalize('NFC')`, not a locale,
  stemming or Unicode case folding. The complete source inventory supplies every case candidate.
- One candidate permits fallback to that exact source lemma. Multiple candidates are ambiguous:
  do not merge senses or choose a lowercase spelling by preference. Existing `US` and `us`
  resolve exactly; a non-exact `Us` does not pick one of them.
- The card keeps the original spelling, and async results belong only to the selected target.

## Separate immutable case index

Generate from the same validated release with:

```bash
node scripts/build-dictionary-case-index.mjs --root <release-directory> --out <new-directory>
```

The generator validates source entry paths and the full source inventory SHA-256. It writes:

- `dictionary/case-indexes/case-v1-<digest12>/<00..ff>.json` (all 256 shards);
- the index's `manifest.json` with each shard's original-byte SHA-256 and length;
- a candidate `dictionary/current.json` naming both `release` and `caseIndex`.

Sharding uses the first two hex digits of FNV-1a32 over the lowercase key's UTF-8 bytes. This
hash selects a shard only; the complete lowercase string remains the key inside the shard.
Hash collisions therefore do not collapse entries. The index version covers the source release
and the entire deterministic grouping. Never overwrite an immutable path with different bytes.

## Inflected forms and part-of-speech labels

`n`, `v`, `a`/`s`, and `r` are source codes, displayed as `noun`, `verb`, `adjective`,
and `adverb` without changing the immutable entry bytes or sense IDs.

When neither exact spelling nor a unique case spelling resolves, the optional `formsIndex`
publication field enables inflection lookup. Build the explicit exceptions index with:

```bash
python -I scripts/build-dictionary-form-index.py --source <pinned-git-source> --release <release-directory> --out <new-directory>
```

The builder verifies the pinned source commit and YAML bytes, the entire released entry inventory,
and every source sense/POS binding. Only source `form` arrays are indexed, e.g. `children`, `went`,
`running`; source meanings and IDs are not edited. Outputs are 256 immutable shards under
`dictionary/form-indexes/forms-v1-<digest12>/`, each mapping a normalized surface to exact
`{lemma,pos}` candidates. Its manifest records every shard's byte length and SHA-256.

Explicit source forms take precedence over WordNet Morphy suffix-detachment proposals for noun
plurals, verb inflections, and adjective comparatives/superlatives. A regular proposal is not an
accepted mapping until the source case inventory and actual entry confirm its lemma and POS.
Only matching source POS senses are displayed. Competing source lemmas yield ambiguity, never
an arbitrary selected meaning. This is lexical normalization, not context disambiguation or a
claim of exhaustive English morphology. Exact senses always remain first (e.g. `news` is not `new`).
An exact surface may also be an inflected verb: `running`, `learned`, and `stopped` keep their own
noun/adjective senses and append the uniquely resolved base verb senses, retaining every source ID.
Unknown, conflicting, malformed, and network-failed lookups remain distinct read-only outcomes.

Publish and verify all form shards before updating `current.json` with `formsIndex`; deploy the
compatible reader first, back up the old switch bytes and replace it using its current ETag.

## Lookup latency and bounded warming

The reader may publish already-validated exact/base senses to the card before optional source-form
expansion finishes. The final result retains original ordering and merges legitimate inflection
senses by full ID. Ambiguous aliases or competing morphology never emit a guessed interim lemma.
Late partial/final responses from a previously selected word are ignored.

Publication and up to four shared case/form shard pairs are warmed from the chapter's first 80
sampled tokens after its initial render; no chapter-wide word payload prefetch, D1 read, choice
write or telemetry is added. Case/inflected spellings use the verified case inventory to avoid
known-nonexistent word requests, while simple lowercase base words keep their direct-word fast
path. Independent form work runs in parallel, as do multiple candidate entry requests.

Per-book static mappings warm when catalog identity is available and share the normal loader.
Rendered chapter text arrays are reused until the root/text/chapter/segmentation changes, so
repeated taps reuse the same exact chapter fingerprint rather than traversing the entire chapter.
These optimizations do not change the mutable word TTL, original URLs, source identities or
nightly coordinate contract. Cold network latency still varies; local controlled-delay tests and
single-machine public timings are not guarantees for every user's device or network.

## Reader producer handoff

Contract audit: deployed app commit `50475c8617226edf7c953fb4e625ae8f88df9e9f` (2026-11-11).
This handoff describes that implementation, not a promise that proposed skill exports already work.
The code is authoritative: `src/lib/dictionary-positions.ts`, `standard-dictionary.ts`,
`src/components/reader.tsx`, and `word-card.tsx`. Nightly operational rules stay in the original
`GLOSSARY_PATROL.md` section 10 (`https://inputread.site/kit/patrol.md`).

The observed live publication at audit time is:

```json
{"schema":"oewn-r2-current-v1","release":"oewn-2025-809369f31478","caseIndex":"case-v1-3d7f0ca2538e","formsIndex":"forms-v1-b53375d8c584"}
```

That release pins learning commit `809369f31478a18ba1da67c701b5876601e57894` and source commit
`dc343f2683279ecbb13fab4e2fd778d7b162d287`, with 73,142 learning definitions / 185,129 source
senses. Re-read current.json and the immutable manifest for every new production export; a newer
maintenance HEAD is not permission to silently change a frozen job or the live release.

### Two separate delivery channels

- Legacy `version: 2` glossary `meaning`, `senses[].meaning`, `anchors`, `forms`, `phrases`,
  `paragraphs` and `sentences` remain the community layer. See GLOSSARY_FORMAT.md and its JSON
  schema. Adding `senseId`, `entryId` or a skill-internal `senseRef` does not turn it into a standard
  mapping. Unknown fields may be ignored, which is not proof of supported standard import.
- Standard fixed positions are separate static objects at
  `dictionary/positions/<catalog>/<id>/mappings.json`. No definition override or entryId is read.
  The reader only fixes a meaning if the mapped full source senseId AND exact lemma occur in its
  current surface lookup candidates. Standard IDs are opaque and must not be parsed into lemmas.
- A skill SELECT/BIND reference such as `resource:<entryId>:<senseId>` is internal lineage, not a
  reader ID. Resolve structured candidate fields; never split a colon-containing sense ID.

### Exact coordinate contract

For the actual rendered chapter, obtain `P = readerParagraphBlocks(article).map(flowText)` using
reader-anchor.ts, help-match.ts and flow-text.ts. Apply the same EPUB parsing, segmentation and
spine merge as the reader. Neither raw XML, a different EPUB importer, nor readBook().index.blocks
alone proves identical rendered paragraphs.

- chapterSha256 = SHA-256 of UTF-8 `JSON.stringify(P)` (no whitespace/case/Unicode normalization).
- paragraphIndex = zero-based index in P; paragraphSha256 = SHA-256 of UTF-8 P[index].
- offset = Unicode code-point count of `flowTextBefore(block, tappedButton)`, not a UTF-16 offset,
  token ordinal or a chapter-wide occurrence. Verify the exact code-point slice equals surface.
- positionKey = SHA-256 of UTF-8 `JSON.stringify([catalogId,chapterSha256,paragraphIndex,
  paragraphSha256,offset,surface])`.
- catalogId is `word-lists:<id>` or `public-books:<id>`, never a device UUID or book title. Duplicate
  source chapters still require independent uniqueness proof before publishing, not first-match.

Legacy occurrence is different: one-based count of a particular counted spelling in the chapter,
using glossary-format.ts WORD_PATTERN / countSurface and the actual button data-n. TAP_WORD_PATTERN
may join curly-apostrophe pieces differently. Do not copy a skill token number into occurrence.
Standard mapping identity does not consume occurrence or fuzzy context anchors at all.

### Complete synthetic transport example

For the clearly synthetic paragraph array `P = ["We stayed at a hotel."]`, index 0 and code-point
offset 15, the following has real computed hashes and a real published hotel source sense.
`word-lists:example-hotel` is a synthetic catalog identity, not an authorized live book. Do not upload
this example as real book data or call it semantic/source verification of an actual EPUB.

```json
{
  "schema": "oewn-position-mappings-v1",
  "catalogId": "word-lists:example-hotel",
  "entries": [{
    "positionKey": "64ec78d492c30ca14fffaffbbed466bf792a154384a139f134dc6eee3177f50a",
    "chapterSha256": "43f34c6c77aecff43d36bc6d6cb97e0c65beaa7b510cb55be621e9664848776e",
    "paragraphIndex": 0,
    "paragraphSha256": "9b0b488a75dad66ce6aed7de4ae39d07722e63d5ac861d202535a9789f555c30",
    "offset": 15,
    "surface": "hotel",
    "senseId": "hotel%1:06:00::",
    "lemma": "hotel",
    "release": "oewn-2025-809369f31478",
    "reviewedAt": 1794355200000
  }]
}
```

Optional matchedBy contains up to three actual credited public IDs (12 lowercase hex), resolved
through contributors.json as Matched by. Never invent identities, acceptance timestamps or credits.
Use JSON content type, `Cache-Control: public, max-age=300`, and at most 192 KiB per book object;
exceeding that bound requires a protocol extension, not truncating existing entries.

### Implemented versus unsupported

- Single tapped word: implemented; no-match/ambiguous/error stays unresolved with candidates or
  a distinct failure state. Never force a missing source sense, new definition or context override.
- Multi-token standard phrase/span binding: NOT implemented. Active community phrases bypass
  standard lookup/mapping. `sensePanel` / `meaningContent` presentation overrides also bypass it.
  Keep expression decisions in skill output as unsupported/pending adaptation rather than binding a
  phrase sense to one member word. Community PhraseEntry remains supported independently.
- Difficulty highlighting still belongs to the legacy glossary/senseOnly/reader preference layer;
  a standard mapping does not automatically mark a word difficult.
- Stable-word compatibility is specified above: all senses stay in one lemma JSON, not individual
  sense endpoints. Deployed 50475c8 has not activated it. Wording edits preserve IDs and mappings;
  release is provenance, not a permanent equality gate. Producers must preserve exact source IDs,
  legal surface candidates and source coordinates and wait for the verified wordsMutable opt-in.
- Existing tests: `scripts/dictionary-positions.test.mjs`, `standard-dictionary.test.mjs`,
  `dictionary-choice-credits.test.mjs`. `scripts/validate-glossary.mjs` validates legacy community
  v2, not independent standard mappings. There is no complete standard-book mapping CLI that
  currently proves all source coordinates. Skill coordinates.py proves its own frozen source only;
  a reader-aligned adapter/validator is required before claiming reader compatibility.

## Publication order

Follow `MAINTENANCE.md` for authorization, production build and Pages deployment.

1. Upload and verify every source release object, including both source licenses. Do not put
   source releases or credentials in Git or Pages assets.
2. Upload all 256 case shards and their manifest with JSON content type and immutable caching.
   Read back original bytes and compare SHA-256; retain the upload/inventory receipt locally.
3. Test exact words, capitalized/all-uppercase variants, proper names, ambiguous case groups,
   invalid index bindings, failed requests, and late responses after selecting another word.
4. Merge and deploy the compatible reader. Check the actual custom-domain asset version.
5. Only then publish `dictionary/current.json` with JSON content type and
   `Cache-Control: no-cache, max-age=0, must-revalidate`. Read it back through both authorized
   storage and the public books host. Confirm the browser's cross-origin requests work.

`current.json` is the mutable publication switch. Preserve its previous bytes before a later
replacement and use conditional writes. A 404 keeps the legacy reader available; the client
rechecks the publication after one minute, rather than caching that absence for the whole session.
Publication does not imply pedagogical validation: source manifests retain `studentValidated: false`.
