-- Operator-only review snapshots. No public acceptance writer; mutable dictionary_choices
-- are raw evidence, not canonical positions. Never FK to those rows: withdrawal/change
-- must not remove a review or earned credit. Only account deletion cascades.
-- Nightly candidates: LEFT JOIN reviews on (user_id,target_hash), then review missing
-- OR reviewed_updated_at != choice.updated_at. Unchanged needs-context is NOT retried
-- unless an operator explicitly targets it.
-- CAS every review write against the captured current choice's updated_at, target_json,
-- choice_id, choice_lemma and choice_release; never overwrite a newer review snapshot.
-- Accept only after verifying authorized source text and publishing + reading back the
-- exact adopted mapping. verified_sense_id MUST equal the reader's captured choice_id.
CREATE TABLE dictionary_choice_reviews (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_hash TEXT NOT NULL,
  reviewed_updated_at INTEGER NOT NULL,
  reviewed_choice_id TEXT NOT NULL,
  reviewed_choice_lemma TEXT NOT NULL,
  reviewed_choice_release TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('accepted', 'rejected', 'needs-context')),
  reason TEXT NOT NULL CHECK (length(trim(reason)) > 0),
  catalog_id TEXT NOT NULL DEFAULT '',
  text_sha256 TEXT NOT NULL DEFAULT '',
  canonical_position TEXT NOT NULL DEFAULT '',
  verified_sense_id TEXT NOT NULL DEFAULT '',
  evidence_sha256 TEXT NOT NULL DEFAULT '',
  mapping_key TEXT NOT NULL DEFAULT '',
  accepted_at INTEGER NOT NULL DEFAULT 0,
  reviewed_at INTEGER NOT NULL CHECK (reviewed_at > 0),
  PRIMARY KEY (user_id, target_hash),
  CHECK (
    (outcome != 'accepted' AND accepted_at = 0)
    OR (outcome = 'accepted' AND accepted_at > 0
      AND length(trim(reviewed_choice_id)) > 0
      AND length(trim(reviewed_choice_lemma)) > 0
      AND length(trim(reviewed_choice_release)) > 0
      AND length(trim(catalog_id)) > 0
      AND length(text_sha256) = 64 AND text_sha256 NOT GLOB '*[^0-9a-f]*'
      AND length(trim(verified_sense_id)) > 0 AND verified_sense_id = reviewed_choice_id
      AND length(trim(evidence_sha256)) > 0 AND length(trim(mapping_key)) > 0
      AND CASE WHEN json_valid(canonical_position) THEN COALESCE(
        json_type(canonical_position) = 'object'
        AND json_type(canonical_position, '$.chapterSha256') = 'text'
        AND json_extract(canonical_position, '$.chapterSha256') = text_sha256
        AND json_type(canonical_position, '$.paragraphIndex') = 'integer'
        AND json_extract(canonical_position, '$.paragraphIndex') >= 0
        AND json_type(canonical_position, '$.paragraphSha256') = 'text'
        AND length(json_extract(canonical_position, '$.paragraphSha256')) = 64
        AND json_extract(canonical_position, '$.paragraphSha256') NOT GLOB '*[^0-9a-f]*'
        AND json_type(canonical_position, '$.offset') = 'integer'
        AND json_extract(canonical_position, '$.offset') >= 0
        AND json_type(canonical_position, '$.surface') = 'text'
        AND length(trim(json_extract(canonical_position, '$.surface'))) > 0, 0)
        ELSE 0 END)
  )
);

-- Immutable earning receipts, independent even of later review outcomes. Insert only
-- accepted actual selections using INSERT ... SELECT from the CAS-matched accepted
-- review in the SAME transaction/batch; ON CONFLICT DO NOTHING makes reruns idempotent.
-- Do not update/delete receipts when choices are changed, withdrawn or reviewed again.
-- canonical_position / position_json: compact JSON
-- {chapterSha256,paragraphIndex,paragraphSha256,offset,surface}; offset is codepoints.
-- chapterSha256 = SHA256(JSON array of exact original EPUB chapter paragraph strings),
-- without normalization; paragraphIndex is its zero-based index. text_sha256 is
-- chapterSha256. position_key = SHA256(JSON array [catalog_id, chapterSha256,
-- paragraphIndex, paragraphSha256, offset, surface]), never a client target_hash/book id.
-- evidence_sha256 / mapping_sha256 = SHA256 of the COMPLETE published mapping file
-- read back at mapping_key (dictionary/positions/<catalog>/<id>/mappings.json).
-- Retain first receipt per account + canonical position, even across device evidence.
CREATE TABLE dictionary_choice_credits (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  position_key TEXT NOT NULL CHECK (length(trim(position_key)) > 0),
  catalog_id TEXT NOT NULL CHECK (length(trim(catalog_id)) > 0),
  text_sha256 TEXT NOT NULL CHECK (length(text_sha256) = 64 AND text_sha256 NOT GLOB '*[^0-9a-f]*'),
  position_json TEXT NOT NULL CHECK (CASE WHEN json_valid(position_json) THEN COALESCE(
    json_type(position_json) = 'object'
    AND json_type(position_json, '$.chapterSha256') = 'text'
    AND json_extract(position_json, '$.chapterSha256') = text_sha256
    AND json_type(position_json, '$.paragraphIndex') = 'integer'
    AND json_extract(position_json, '$.paragraphIndex') >= 0
    AND json_type(position_json, '$.paragraphSha256') = 'text'
    AND length(json_extract(position_json, '$.paragraphSha256')) = 64
    AND json_extract(position_json, '$.paragraphSha256') NOT GLOB '*[^0-9a-f]*'
    AND json_type(position_json, '$.offset') = 'integer'
    AND json_extract(position_json, '$.offset') >= 0
    AND json_type(position_json, '$.surface') = 'text'
    AND length(trim(json_extract(position_json, '$.surface'))) > 0, 0)
    ELSE 0 END),
  sense_id TEXT NOT NULL CHECK (length(trim(sense_id)) > 0),
  accepted_at INTEGER NOT NULL CHECK (accepted_at > 0),
  mapping_key TEXT NOT NULL CHECK (length(trim(mapping_key)) > 0),
  mapping_sha256 TEXT NOT NULL CHECK (length(trim(mapping_sha256)) > 0),
  PRIMARY KEY (user_id, position_key),
  UNIQUE (user_id, catalog_id, text_sha256, position_json)
);
