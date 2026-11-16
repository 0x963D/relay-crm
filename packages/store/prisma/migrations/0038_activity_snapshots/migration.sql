ALTER TABLE activities DISABLE TRIGGER activities_append_only;
UPDATE activities
SET detail = detail || jsonb_build_object(
  'before', CASE WHEN jsonb_typeof(detail->'before') = 'string' THEN (detail->>'before')::jsonb ELSE detail->'before' END,
  'after', CASE WHEN jsonb_typeof(detail->'after') = 'string' THEN (detail->>'after')::jsonb ELSE detail->'after' END
)
WHERE jsonb_typeof(detail->'before') = 'string' OR jsonb_typeof(detail->'after') = 'string';
ALTER TABLE activities ENABLE TRIGGER activities_append_only;
