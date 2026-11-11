-- Operation receipt only, not file backups or an R2/D1 transaction. A 'started' row may
-- mean an interrupted/unknown result: inspect live objects before any retry.
CREATE TABLE publication_audit (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 64),
  object_key TEXT NOT NULL CHECK (length(object_key) BETWEEN 1 AND 256),
  operation TEXT NOT NULL CHECK (length(operation) BETWEEN 1 AND 48),
  status TEXT NOT NULL CHECK (status IN ('started', 'published', 'failed', 'conflict', 'partial-recovery', 'uncertain', 'committed-uncertain')),
  actor_id TEXT CHECK (actor_id IS NULL OR length(actor_id) <= 128),
  baseline_etag TEXT CHECK (baseline_etag IS NULL OR length(baseline_etag) <= 256),
  new_etag TEXT CHECK (new_etag IS NULL OR length(new_etag) <= 256),
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  error_code TEXT CHECK (error_code IS NULL OR length(error_code) <= 80),
  affected_keys TEXT NOT NULL DEFAULT '[]' CHECK (length(affected_keys) <= 16000)
);
CREATE INDEX publication_audit_key_time ON publication_audit(object_key, started_at DESC);
CREATE INDEX publication_audit_time ON publication_audit(started_at DESC);
