import {
  AccountId,
  TeamId,
  UserId,
  recordScope,
  scopeAdmits,
  type Actor,
  type Account,
  type RecordScope,
} from "@relay/domain";
import type { Prisma, Account as AccountRow } from "./generated/client.ts";
import { currentActor } from "./auth.ts";
import { AccessError } from "./errors.ts";
import { InvariantError } from "./lead-row.ts";
import { transact, type Db } from "./tx.ts";

function whereScope(scope: RecordScope): Prisma.AccountWhereInput {
  switch (scope.kind) {
    case "all":
      return {};
    case "own":
      return { ownerId: scope.userId };
    case "team":
    case "teamAndPool":
      return { teamId: scope.teamId };
    case "none":
      return { id: { in: [] } };
  }
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
  page: { readonly limit: number },
): Promise<readonly Account[]> {
  return transact(db, async (tx) => {
    const current = await currentActor(tx, actor);
    const rows = await tx.account.findMany({
      where: whereScope(recordScope(current, "account", "read")),
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: page.limit,
    });
    return rows.map(accountFromRow);
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
