# Static standard dictionary publication

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
