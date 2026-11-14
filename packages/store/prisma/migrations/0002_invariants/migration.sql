-- Everything Prisma cannot model. These rules hold for every writer, including one that bypasses
-- the store.

-- The SQL twin of the LeadState union, one arm per status. IS [NOT] NULL never yields NULL, so no
-- arm passes by being unknown, and ELSE false makes a status this constraint has not heard of
-- fail closed.
ALTER TABLE leads ADD CONSTRAINT leads_state_shape CHECK (
  (owner_id IS NULL) = (team_id IS NULL) AND
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

-- The twin of WorkStage: each stage carries its own detail and no other.
ALTER TABLE leads ADD CONSTRAINT leads_stage_shape CHECK (
  CASE
    WHEN stage IS NULL OR stage = 'contacted' THEN call_back_at IS NULL AND no_answer_count IS NULL
    WHEN stage = 'callBack' THEN call_back_at IS NOT NULL AND no_answer_count IS NULL
    WHEN stage = 'noAnswer' THEN call_back_at IS NULL AND no_answer_count IS NOT NULL AND no_answer_count >= 1
    ELSE false
  END
);

ALTER TABLE leads ADD CONSTRAINT leads_owned_was_assigned CHECK (
  owner_id IS NULL OR first_assigned_at IS NOT NULL
);

-- Only what JavaScript and PostgreSQL agree on. lower() depends on the collation, and a CHECK
-- that disagreed with toLowerCase() would reject that person's intake forever.
ALTER TABLE leads ADD CONSTRAINT leads_email_key_normalized CHECK (
  email_key !~ '[A-Z[:space:]]' AND email_key LIKE '_%@_%'
);

-- A ledger row points at the subject its outcome names: a lead, an account, or nothing.
ALTER TABLE intake_events ADD CONSTRAINT intake_events_outcome_subject CHECK (
  CASE
    WHEN outcome = 'rejectedNoEmail' THEN lead_id IS NULL AND account_id IS NULL
    WHEN outcome = 'linkedToAccount' THEN lead_id IS NULL AND account_id IS NOT NULL
    WHEN outcome IN ('leadCreated', 'attachedToOpenLead', 'leadReopened', 'suppressedDoNotContact')
      THEN lead_id IS NOT NULL AND account_id IS NULL
    ELSE false
  END
);

ALTER TABLE activities ADD CONSTRAINT activities_one_subject CHECK (
  num_nonnulls(lead_id, account_id) = 1
);

ALTER TABLE activities ADD CONSTRAINT activities_intake_ref CHECK (
  (kind = 'intake') = (intake_event_id IS NOT NULL)
);

-- The ledger and the timeline are append-only in the database, not by convention.
CREATE FUNCTION reject_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
END
$$;

CREATE TRIGGER intake_events_append_only
  BEFORE UPDATE OR DELETE ON intake_events
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();

CREATE TRIGGER activities_append_only
  BEFORE UPDATE OR DELETE ON activities
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();
