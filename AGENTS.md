# Relay CRM

- Keep product rules in `packages/domain`, SQL and transactions in `packages/store`, HTTP and browser screens in `apps/web`, and the phone client in `apps/mobile`. See the [development guide](docs/development.md) for commands and the [v0.1 limits](docs/limits.md) for scope.
- Enforce record scope in the store. Route lead, account, and payment operations through the existing tRPC procedures. Use the app database role at runtime and the owner role for migrations and maintenance.
- Preserve the transaction, audit, and idempotency rules for lead work and payments. Keep sandbox checkout and manual payment approval within the [payment rules](docs/payments.md).
- Verify changes with the [local verification skill](.agents/skills/verify-relay-crm/SKILL.md). Use synthetic data, a disposable local database, and local mail sinks. Keep verification off the hosted demo and its maintenance workflow.
