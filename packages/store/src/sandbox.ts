import { createHash, randomBytes } from "node:crypto";
import type { Money, SandboxMode } from "@relay/domain";
import type { SandboxCheckout } from "./generated/client.ts";
import { AccessError } from "./errors.ts";
import { transact, type Db } from "./tx.ts";

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
function current(row: SandboxCheckout | null) {
  return row?.status === "pending" && row.expiresAt <= new Date()
    ? { ...row, status: "expired" }
    : row;
}
export function createSandboxCheckout(
  db: Db,
  input: {
    readonly paymentId: string;
    readonly money: Money;
    readonly mode: SandboxMode;
    readonly expiresAt?: Date;
    readonly creationToken?: string;
  },
) {
  return transact(db, async (tx) => {
    const payment = await tx.payment.findUnique({ where: { id: input.paymentId } });
    if (
      payment?.status !== "checkoutCreated" ||
      payment.creationToken !== (input.creationToken ?? null) ||
      (payment.creationPendingUntil !== null && payment.creationPendingUntil <= new Date())
    )
      throw new AccessError("conflict");
    await tx.payment.update({
      where: { id: input.paymentId },
      data: { creationPendingUntil: null, creationToken: null, checkToken: null },
    });
    const prior = await tx.sandboxCheckout.findUnique({ where: { paymentId: input.paymentId } });
    if (prior) return { id: prior.id, token: null };
    const token = randomBytes(32).toString("base64url");
    const row = await tx.sandboxCheckout.create({
      data: {
        paymentId: input.paymentId,
        tokenHash: tokenHash(token),
        amount: input.money.minor,
        currency: input.money.currency,
        mode: input.mode,
        expiresAt: input.expiresAt ?? new Date(Date.now() + 86400000),
      },
    });
    return { id: row.id, token };
  });
}
export async function getSandboxCheckout(db: Db, paymentId: string) {
  return current(await db.sandboxCheckout.findUnique({ where: { paymentId } }));
}
export async function getSandboxCheckoutByToken(db: Db, token: string) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  return current(await db.sandboxCheckout.findUnique({ where: { tokenHash: tokenHash(token) } }));
}
export async function cancelSandboxCheckout(db: Db, paymentId: string) {
  await transact(db, (tx) =>
    tx.sandboxCheckout.updateMany({
      where: { paymentId, status: "pending" },
      data: { status: "failed" },
    }),
  );
}
export function paySandboxCheckout(db: Db, token: string) {
  return transact(db, async (tx) => {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const row = current(
      await tx.sandboxCheckout.findUnique({ where: { tokenHash: tokenHash(token) } }),
    );
    if (row?.status !== "pending") return null;
    return tx.sandboxCheckout.update({
      where: { id: row.id },
      data: {
        status: "completed",
        amount: row.mode === "differentAmount" ? row.amount + 1n : row.amount,
      },
    });
  });
}
