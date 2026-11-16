import { readAccountLedger, readAccountPayments } from "./payments.ts";
import { scopeWhere } from "./scope.ts";
import {
  AccountId,
  TeamId,
  UserId,
  recordScope,
  scopeAdmits,
  type Actor,
  type Account,
} from "@relay/domain";
import type { Account as AccountRow } from "./generated/client.ts";
import { currentActor } from "./auth.ts";
import { AccessError } from "./errors.ts";
import { InvariantError } from "./lead-row.ts";
import { transact, type Db } from "./tx.ts";

function accountFromRow(row: AccountRow): Account {
  const id = AccountId.parse(row.id);
  const ownerId = row.ownerId === null ? null : UserId.parse(row.ownerId);
  const teamId = row.teamId === null ? null : TeamId.parse(row.teamId);
  if (!id || (row.ownerId !== null && !ownerId) || (row.teamId !== null && !teamId)) {
    throw new InvariantError("An account contains an invalid UUID");
  }
  return { id, ownerId, teamId, createdAt: row.createdAt };
}
export async function listAccounts(db: Db, actor: Actor, page: { readonly limit: number }) {
  return transact(db, async (tx) => {
    const current = await currentActor(tx, actor);
    const where = scopeWhere(recordScope(current, "account", "read"));
    const total = await tx.account.count({ where });
    const rows = await tx.account.findMany({
      where,
      orderBy: [{ lead: { name: "asc" } }, { lead: { email: "asc" } }, { id: "asc" }],
      take: page.limit,
      include: {
        owner: { select: { id: true, name: true } },
        lead: {
          select: {
            id: true,
            email: true,
            name: true,
            intakeEvents: {
              where: { outcome: "leadCreated" },
              orderBy: { id: "asc" },
              take: 1,
              select: { campaign: true },
            },
          },
        },
      },
    });
    const mayReadLedger = recordScope(current, "ledger", "read").kind === "all";
    const items = await Promise.all(
      rows.map(async (row) => {
        const account = accountFromRow(row);
        const payments = scopeAdmits(recordScope(current, "payment", "read"), account)
          ? await readAccountPayments(tx, account.id)
          : null;
        return {
          ...account,
          campaign: row.lead?.intakeEvents[0]?.campaign ?? null,
          paymentCount:
            payments?.filter((payment) => payment.state.status === "completed").length ?? null,
          paymentInProgress:
            payments?.find(
              (payment) =>
                payment.state.status === "pendingApproval" ||
                payment.state.status === "checkoutCreated",
            )?.state ?? null,
          owner: row.owner,
          person: row.lead ? { id: row.lead.id, name: row.lead.name, email: row.lead.email } : null,
          balances: mayReadLedger
            ? (await readAccountLedger(tx, account.id)).balances.map(({ currency, balance }) => ({
                currency,
                balance,
              }))
            : null,
        };
      }),
    );
    return { items, total };
  });
}
export async function getAccount(db: Db, actor: Actor, id: AccountId): Promise<Account> {
  return transact(db, async (tx) => {
    const current = await currentActor(tx, actor);
    const row = await tx.account.findUnique({ where: { id } });
    if (!row || !scopeAdmits(recordScope(current, "account", "read"), accountFromRow(row))) {
      throw new AccessError("accessDenied");
    }
    return accountFromRow(row);
  });
}
