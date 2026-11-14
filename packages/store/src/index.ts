import type { Actor, Intake } from "@relay/domain";
import { intakeWith } from "./intake.ts";
import { listLeads, type LeadListItem } from "./leads.ts";
import { connect } from "./tx.ts";

export type { LeadListItem };

/**
 * Everything the application can do with the database. Callers pass domain values and get domain
 * values back. The Prisma client, the isolation level and the retry policy stay behind this.
 */
export interface Store {
  /** Records one submission. Idempotent by source and external ID. */
  readonly intake: Intake;
  /** The leads this actor may read, newest first. */
  listLeads(actor: Actor, page: { readonly limit: number }): Promise<readonly LeadListItem[]>;
  close(): Promise<void>;
}

/** Opens no connection until the first query, so building a store needs no database. */
export function openStore(config: { readonly connectionString: string }): Store {
  const db = connect(config.connectionString);
  return {
    intake: intakeWith(db),
    listLeads: (actor, page) => listLeads(db, actor, page),
    close: () => db.$disconnect(),
  };
}
