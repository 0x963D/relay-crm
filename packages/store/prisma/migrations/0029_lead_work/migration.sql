ALTER TYPE activity_kind ADD VALUE 'attempt';
ALTER TYPE activity_kind ADD VALUE 'note';
ALTER TYPE activity_kind ADD VALUE 'callback';
ALTER TYPE activity_kind ADD VALUE 'closure';
ALTER TYPE audit_action ADD VALUE 'leadWorked';

ALTER TABLE leads ADD COLUMN contacted_at timestamptz(3), ADD COLUMN lost_note text,
  ADD COLUMN work_history_known boolean NOT NULL DEFAULT false;
ALTER TABLE leads ALTER COLUMN work_history_known SET DEFAULT true;
ALTER TABLE leads DROP CONSTRAINT leads_state_shape;
ALTER TABLE leads ADD CONSTRAINT leads_state_shape CHECK (
  (owner_id IS NULL) = (team_id IS NULL) AND
  (lost_note IS NULL OR (status = 'lost' AND btrim(lost_note) <> '')) AND
  CASE status
    WHEN 'new'      THEN owner_id IS NULL     AND stage IS NULL     AND lost_reason IS NULL     AND dead_reason IS NULL     AND account_id IS NULL
    WHEN 'assigned' THEN owner_id IS NOT NULL AND stage IS NULL     AND lost_reason IS NULL     AND dead_reason IS NULL     AND account_id IS NULL
    WHEN 'working'  THEN owner_id IS NOT NULL AND stage IS NOT NULL AND lost_reason IS NULL     AND dead_reason IS NULL     AND account_id IS NULL
    WHEN 'won'      THEN owner_id IS NOT NULL AND stage IS NULL     AND lost_reason IS NULL     AND dead_reason IS NULL     AND account_id IS NOT NULL
    WHEN 'lost'     THEN owner_id IS NOT NULL AND stage IS NULL     AND lost_reason IS NOT NULL AND dead_reason IS NULL     AND account_id IS NULL
    -- A lead can die in the pool, so a dead lead may have no owner.
    WHEN 'dead'     THEN                          stage IS NULL     AND lost_reason IS NULL     AND dead_reason IS NOT NULL AND account_id IS NULL
    ELSE false
  END
);

ALTER TABLE activities ADD COLUMN sequence bigserial;
ALTER TABLE activities DISABLE TRIGGER activities_append_only;
WITH ordered AS (SELECT id, row_number() OVER (ORDER BY id) AS position FROM activities)
UPDATE activities SET sequence = ordered.position FROM ordered WHERE activities.id = ordered.id;
SELECT setval(pg_get_serial_sequence('activities','sequence'), COALESCE(max(sequence),0)+1, false) FROM activities;
ALTER TABLE activities ENABLE TRIGGER activities_append_only;
ALTER TABLE activities ADD CONSTRAINT activities_sequence_key UNIQUE(sequence);
GRANT USAGE ON SEQUENCE activities_sequence_seq TO relay_app;
