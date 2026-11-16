ALTER TABLE leads DROP CONSTRAINT leads_state_shape;
UPDATE leads SET lost_note = COALESCE(lost_note, lost_reason::text) WHERE status='lost';
ALTER TABLE leads DROP COLUMN lost_reason;
DROP TYPE lost_reason;
ALTER TABLE leads ADD CONSTRAINT leads_state_shape CHECK (
  (owner_id IS NULL) = (team_id IS NULL) AND
  (lost_note IS NULL OR (status = 'lost' AND btrim(lost_note) <> '')) AND
  CASE status
    WHEN 'new'      THEN owner_id IS NULL     AND stage IS NULL     AND lost_note IS NULL     AND dead_reason IS NULL     AND account_id IS NULL
    WHEN 'assigned' THEN owner_id IS NOT NULL AND stage IS NULL     AND lost_note IS NULL     AND dead_reason IS NULL     AND account_id IS NULL
    WHEN 'working'  THEN owner_id IS NOT NULL AND stage IS NOT NULL AND lost_note IS NULL     AND dead_reason IS NULL     AND account_id IS NULL
    WHEN 'won'      THEN owner_id IS NOT NULL AND stage IS NULL     AND lost_note IS NULL     AND dead_reason IS NULL     AND account_id IS NOT NULL
    WHEN 'lost'     THEN owner_id IS NOT NULL AND stage IS NULL     AND lost_note IS NOT NULL AND dead_reason IS NULL     AND account_id IS NULL
    -- A lead can die in the pool, so a dead lead may have no owner.
    WHEN 'dead'     THEN                          stage IS NULL     AND lost_note IS NULL     AND dead_reason IS NOT NULL AND account_id IS NULL
    ELSE false
  END
);
