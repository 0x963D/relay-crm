ALTER TYPE work_stage ADD VALUE 'ready';
ALTER TABLE leads DROP CONSTRAINT leads_stage_shape;
ALTER TABLE leads ADD CONSTRAINT leads_stage_shape CHECK (
  CASE
    WHEN stage IS NULL OR stage::text IN ('contacted', 'ready') THEN call_back_at IS NULL AND no_answer_count IS NULL
    WHEN stage = 'callBack' THEN call_back_at IS NOT NULL AND no_answer_count IS NULL
    WHEN stage = 'noAnswer' THEN call_back_at IS NULL AND no_answer_count IS NOT NULL AND no_answer_count >= 1
    ELSE false
  END
);
