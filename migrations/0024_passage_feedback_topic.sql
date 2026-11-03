-- A new topic gets its own report id inside the INSERT, not in a second request.
-- Trigger failure rolls back the INSERT too, so interrupted requests cannot leave topic = 0.
-- Apply this migration before deploying the handler that removes the separate topic UPDATE.
CREATE TRIGGER IF NOT EXISTS passage_feedback_self_topic
AFTER INSERT ON passage_feedback
WHEN NEW.topic = 0
BEGIN
  UPDATE passage_feedback SET topic = NEW.id WHERE id = NEW.id;
END;

-- Repair legacy orphan roots, including resolved reports. Existing positive topics and all
-- other fields stay unchanged; a child already pointing to this id stays in the same topic.
UPDATE passage_feedback SET topic = id WHERE topic = 0;
