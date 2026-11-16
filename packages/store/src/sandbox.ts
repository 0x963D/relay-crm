import type { Money, SandboxMode } from "@relay/domain";
import { transact, type Db } from "./tx.ts";

export function createSandboxCheckout(
  db: Db,
  input: {
    readonly paymentId: string;
    readonly money: Money;
    readonly mode: SandboxMode;
    readonly expiresAt?: Date;
  },
) {
  return transact(db, async (tx) => {
    const prior = await tx.sandboxCheckout.findUnique({ where: { id: input.paymentId } });
    if (prior) return prior;
    return tx.sandboxCheckout.create({
      data: {
        id: input.paymentId,
        amount: input.money.minor,
        currency: input.money.currency,
        mode: input.mode,
        expiresAt: input.expiresAt ?? new Date(Date.now() + 86400000),
      },
    });
  });
}
export async function getSandboxCheckout(db: Db, id: string) {
  const row = await db.sandboxCheckout.findUnique({ where: { id } });
  return row?.status === "pending" && row.expiresAt <= new Date()
    ? { ...row, status: "expired" }
    : row;
}
export async function cancelSandboxCheckout(db: Db, id: string) {
  await transact(db, (tx) =>
    tx.sandboxCheckout.updateMany({ where: { id, status: "pending" }, data: { status: "failed" } }),
  );
}
export function paySandboxCheckout(db: Db, id: string) {
  return transact(db, async (tx) => {
    const row = await tx.sandboxCheckout.findUnique({ where: { id } });
    if (row?.status !== "pending" || row.expiresAt <= new Date()) return null;
    return tx.sandboxCheckout.update({
      where: { id },
      data: {
        status: "completed",
        amount: row.mode === "differentAmount" ? row.amount + 1n : row.amount,
      },
    });
  });
}
