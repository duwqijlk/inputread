-- Raw pending-review evidence, NOT canonical votes or validated source coordinates.
-- One current selection per account + full client-supplied target evidence hash.
-- Cancel deletes the evidence; no global counters, mapping or review queue policy.
CREATE TABLE dictionary_choices (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_hash TEXT NOT NULL,
  target_json TEXT NOT NULL,
  choice_id TEXT NOT NULL,
  choice_lemma TEXT NOT NULL,
  choice_release TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, target_hash)
);

CREATE INDEX idx_dictionary_choices_updated ON dictionary_choices (updated_at);
