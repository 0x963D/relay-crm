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
import type { Account as AccountRow, Prisma } from "./generated/client.ts";
import { currentActor } from "./auth.ts";
import { AccessError } from "./errors.ts";
import { InvariantError } from "./lead-row.ts";
import { transact, type Db, type Tx } from "./tx.ts";

const accountInclude = {
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
} satisfies Prisma.AccountInclude;

async function accountView(
  tx: Tx,
  current: Actor,
  row: Prisma.AccountGetPayload<{ include: typeof accountInclude }>,
) {
  const account = accountFromRow(row);
  const payments = scopeAdmits(recordScope(current, "payment", "read"), account)
    ? await readAccountPayments(tx, account.id)
    : null;
  const pending = payments?.find(
    (payment) =>
      payment.state.status === "pendingApproval" || payment.state.status === "checkoutCreated",
  );
  const recorder = pending
    ? await tx.user.findUnique({
        where: { id: pending.recordedById },
        select: { id: true, name: true },
      })
    : null;
  return {
    ...account,
    mayEdit: scopeAdmits(recordScope(current, "account", "edit"), account),
    campaign: row.lead?.intakeEvents[0]?.campaign ?? null,
    paymentCount: payments?.length ?? null,
    paymentInProgress: pending?.state ?? null,
    pendingPayment: pending
      ? {
          id: pending.id,
          method: pending.method,
          kind: pending.kind,
          money: pending.money,
          state: pending.state,
          createdAt: pending.createdAt,
          recordedBy: recorder,
        }
      : null,
    owner: row.owner,
    person: row.lead ? { id: row.lead.id, name: row.lead.name, email: row.lead.email } : null,
    balances:
      recordScope(current, "ledger", "read").kind === "all"
        ? (await readAccountLedger(tx, account.id)).balances.map(({ currency, balance }) => ({
            currency,
            balance,
          }))
        : null,
  };
}

function accountFromRow(row: AccountRow): Account {
  const id = AccountId.parse(row.id);
  const ownerId = row.ownerId === null ? null : UserId.parse(row.ownerId);
  const teamId = row.teamId === null ? null : TeamId.parse(row.teamId);
  if (!id || (row.ownerId !== null && !ownerId) || (row.teamId !== null && !teamId)) {
    throw new InvariantError("An account contains an invalid UUID");
  }
  return { id, ownerId, teamId, createdAt: row.createdAt };
}
export async function listAccounts(
  db: Db,
  actor: Actor,
  page: { readonly limit: number; readonly offset?: number },
) {
  return transact(db, async (tx) => {
    const current = await currentActor(tx, actor);
    const where = scopeWhere(recordScope(current, "account", "read"));
    const total = await tx.account.count({ where });
    const order = current.role === "accountant" ? "postingsFirst" : "name";
    const orderBy: Prisma.AccountOrderByWithRelationInput[] = [
      { lead: { name: "asc" } },
      { lead: { email: "asc" } },
      { id: "asc" },
    ];
    const read = (filter: Prisma.AccountWhereInput, skip: number, take: number) =>
      tx.account.findMany({
        where: { AND: [where, filter] },
        orderBy,
        skip,
        take,
        include: accountInclude,
      });
    const offset = page.offset ?? 0;
    let rows;
    if (order === "postingsFirst") {
      const ledgerAccounts = await tx.ledgerAccount.findMany({
        where: { accountId: { not: null } },
        select: { accountId: true },
        distinct: ["accountId"],
      });
      const ids = ledgerAccounts.flatMap((row) => (row.accountId ? [row.accountId] : []));
      const posted = { id: { in: ids } };
      const postedCount = await tx.account.count({ where: { AND: [where, posted] } });
      rows = offset < postedCount ? await read(posted, offset, page.limit) : [];
      if (rows.length < page.limit)
        rows.push(
          ...(await read(
            { id: { notIn: ids } },
            Math.max(0, offset - postedCount),
            page.limit - rows.length,
          )),
        );
    } else rows = await read({}, offset, page.limit);
    const items = await Promise.all(rows.map((row) => accountView(tx, current, row)));
    return { items, total, order };
  });
}
export async function getAccount(db: Db, actor: Actor, id: AccountId) {
  return transact(db, async (tx) => {
    const current = await currentActor(tx, actor);
    const row = await tx.account.findUnique({ where: { id }, include: accountInclude });
    if (!row || !scopeAdmits(recordScope(current, "account", "read"), accountFromRow(row))) {
      throw new AccessError("accessDenied");
    }
    return accountView(tx, current, row);
  });
}
