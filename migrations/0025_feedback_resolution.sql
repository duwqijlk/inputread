-- A resolved report was reviewed, not necessarily repaired. Preserve legacy reasons as unknown.
-- Apply before deploying the updated patrol SQL. No historical status or credit is inferred.
ALTER TABLE word_feedback ADD COLUMN resolution TEXT NOT NULL DEFAULT ''
  CHECK (resolution IN ('', 'fixed', 'already_covered', 'no_change'));
ALTER TABLE passage_feedback ADD COLUMN resolution TEXT NOT NULL DEFAULT ''
  CHECK (resolution IN ('', 'fixed', 'already_covered', 'no_change'));
