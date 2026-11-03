-- Lower the number of D1 rows written by the two hottest upsert paths.
-- No table data changes; only indexes that were maintained on every sync/tap write.
--
-- sync_items: a pull with ?after reads server_at; the legacy ?since pull reads updated_at.
-- The primary key already starts with user_id, so dropping the updated_at index only makes the
-- legacy pull scan that user's rows (the heaviest account has 96 items) and sort them.
-- Current clients use ?after and are unaffected.
DROP INDEX IF EXISTS idx_sync_user_updated;

-- book_word_taps is upserted on every tap. Keep a covering index for the patrol's hot query:
--   WHERE in_glossary = 0 AND status != 'resolved' AND book_id = ?
--   ORDER BY tap_count DESC, last_tapped_at DESC LIMIT 50
-- It is partial, so rows already in the glossary or resolved no longer maintain it. The lookup
-- and status indexes only filter; their tap_count column was rewritten on every tap, so it is
-- removed and the small filtered result is sorted at read time.
DROP INDEX IF EXISTS idx_book_word_taps_missing;
CREATE INDEX IF NOT EXISTS idx_book_word_taps_missing
ON book_word_taps (book_id, tap_count DESC, last_tapped_at DESC)
WHERE in_glossary = 0 AND status != 'resolved';

DROP INDEX IF EXISTS idx_book_word_taps_lookup;
CREATE INDEX IF NOT EXISTS idx_book_word_taps_lookup
ON book_word_taps (word, in_glossary);

DROP INDEX IF EXISTS idx_book_word_taps_status;
CREATE INDEX IF NOT EXISTS idx_book_word_taps_status
ON book_word_taps (book_id, status);

-- Only queries that sort by last_tapped_at used this; the patrol and admin queries sort by
-- tap_count first. Dropping it also stops every tap from rewriting it.
DROP INDEX IF EXISTS idx_book_word_taps_recent;
