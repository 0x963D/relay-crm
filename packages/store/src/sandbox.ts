import type { Money, SandboxMode } from "@relay/domain";
import { transact, type Db } from "./tx.ts";

export function createSandboxCheckout(
  db: Db,
  input: { readonly paymentId: string; readonly money: Money; readonly mode: SandboxMode },
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
      },
    });
  });
}
export function getSandboxCheckout(db: Db, id: string) {
  return db.sandboxCheckout.findUnique({ where: { id } });
}
export function paySandboxCheckout(db: Db, id: string) {
  return transact(db, async (tx) => {
    const row = await tx.sandboxCheckout.findUnique({ where: { id } });
    if (row?.status !== "pending") return null;
    return tx.sandboxCheckout.update({
      where: { id },
      data: {
        status: "completed",
        amount: row.mode === "differentAmount" ? row.amount + 1n : row.amount,
      },
    });
  });
}
