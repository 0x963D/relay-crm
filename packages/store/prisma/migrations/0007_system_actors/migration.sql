CREATE TYPE system_actor AS ENUM ('intake', 'providerWebhook', 'reconciler');
ALTER TABLE audit_log ALTER COLUMN actor_id DROP NOT NULL;
ALTER TABLE audit_log ADD COLUMN system_actor system_actor;
ALTER TABLE audit_log ADD CONSTRAINT audit_actor_exactly_one
  CHECK ((actor_id IS NOT NULL)::int + (system_actor IS NOT NULL)::int = 1);
