import { randomUUID } from "node:crypto";
import {
  PaymentId,
  SANDBOX_MODES,
  isCurrencyCode,
  type PaymentProvider,
  AccountId,
  LeadId,
  TeamId,
  UserId,
  normalizeName,
  normalizePhone,
  type SessionPrincipal,
} from "@relay/domain";
import { isAccessError, type Store } from "@relay/store";
import { initTRPC, TRPCError } from "@trpc/server";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import superjson from "superjson";
import { z } from "zod";
import { boundedRequest } from "./http.ts";
import { reportFailure } from "./errors.ts";

export interface RpcContext {
  readonly requestId?: string;
  readonly store: Store;
  readonly payments?: { readonly provider: PaymentProvider; readonly firstCheckMs: number } | null;
  readonly principal: SessionPrincipal | null;
}
const t = initTRPC.context<RpcContext>().create({
  transformer: superjson,
  errorFormatter: ({ shape, error, ctx }) => {
    const accessFailure = isAccessError(error.cause) ? error.cause.code : null;
    const failure = accessFailure
      ? null
      : reportFailure("rpc.failed", error.cause ?? error, undefined, ctx?.requestId);
    return {
      ...shape,
      message: failure?.message ?? shape.message,
      data: {
        ...shape.data,
        stack: undefined,
        accessFailure,
        ...(failure ? { requestId: failure.requestId } : {}),
      },
    };
  },
});
const authenticated = t.procedure.use(async ({ ctx, next }) => {
  if (!ctx.principal) throw new TRPCError({ code: "UNAUTHORIZED" });
  try {
    const result = await next({
      ctx: {
        ...ctx,
        principal: ctx.principal,
        actor: ctx.principal.actor,
        requestId: ctx.requestId ?? randomUUID(),
      },
    });
    if (!result.ok && isAccessError(result.error.cause)) throw result.error.cause;
    return result;
  } catch (cause) {
    if (!isAccessError(cause)) throw cause;
    const code =
      cause.code === "accessDenied"
        ? "FORBIDDEN"
        : cause.code === "conflict" ||
            cause.code === "refreshConflict" ||
            cause.code === "pendingPayment" ||
            cause.code === "receiptUsed" ||
            cause.code === "stalePreview" ||
            cause.code === "idempotencyConflict"
          ? "CONFLICT"
          : "BAD_REQUEST";
    throw new TRPCError({ code, message: cause.message, cause });
  }
});

function identifier<T extends string>(guard: { parse(value: string): T | null }) {
  return z.string().transform((value, ctx) => {
    const parsed = guard.parse(value);
    if (parsed !== null) return parsed;
    ctx.addIssue({ code: "custom", message: "Expected a canonical UUID." });
    return z.NEVER;
  });
}
const LeadIdentifier = identifier(LeadId);
const Agent = z.object({ ownerId: identifier(UserId), teamId: identifier(TeamId) }).strict();
const LeadIds = z
  .array(LeadIdentifier)
  .min(1)
  .max(100)
  .refine((ids) => new Set(ids).size === ids.length, "Lead IDs must be unique.");
const Page = z.object({ limit: z.int().min(1).max(100).default(100) }).strict();

const MoneyInput = {
  amount: z
    .string()
    .regex(/^[1-9]\d{0,18}$/)
    .refine((v) => BigInt(v) <= 9223372036854775806n),
  currency: z.string().refine(isCurrencyCode),
};
const ManualTermsInput = {
  ...MoneyInput,
  receiptHash: z.string().regex(/^[a-f0-9]{64}$/),
  reference: z.string().trim().min(1).max(200).nullable().default(null),
};
const DecisionInput = { id: identifier(PaymentId), version: z.int().min(0) };
const RefusalInput = z
  .object({ ...DecisionInput, reason: z.string().trim().min(1).max(2000) })
  .strict();
function parsedMoney(input: { amount: string; currency: string }) {
  if (!isCurrencyCode(input.currency)) throw new TRPCError({ code: "BAD_REQUEST" });
  return { minor: BigInt(input.amount), currency: input.currency };
}

export const appRouter = t.router({
  payments: t.router({
    requeueReceipt: authenticated
      .input(z.object({ id: identifier(PaymentId) }).strict())
      .mutation(({ ctx, input }) => ctx.store.requeueReceipt(ctx.actor, input.id, ctx.requestId)),
    recordManual: authenticated
      .input(
        z
          .object({
            ...ManualTermsInput,
            key: z.string().min(1).max(200),
            accountId: identifier(AccountId),
            kind: z.enum(["first", "repeat"]),
          })
          .strict(),
      )
      .mutation(({ ctx, input }) =>
        ctx.store.recordManualPayment(
          ctx.actor,
          { ...input, money: parsedMoney(input) },
          ctx.requestId,
        ),
      ),
    approve: authenticated
      .input(z.object({ ...DecisionInput, roleVersion: z.int().min(0) }).strict())
      .mutation(({ ctx, input }) =>
        ctx.store.approveManualPayment(ctx.actor, input, ctx.requestId),
      ),
    reject: authenticated
      .input(RefusalInput)
      .mutation(({ ctx, input }) =>
        ctx.store.decideManualPayment(ctx.actor, { ...input, decision: "reject" }, ctx.requestId),
      ),
    cancel: authenticated
      .input(RefusalInput)
      .mutation(({ ctx, input }) =>
        ctx.store.decideManualPayment(ctx.actor, { ...input, decision: "cancel" }, ctx.requestId),
      ),
    editManual: authenticated
      .input(z.object({ ...DecisionInput, ...ManualTermsInput }).strict())
      .mutation(({ ctx, input }) =>
        ctx.store.editManualPayment(
          ctx.actor,
          { ...input, money: parsedMoney(input) },
          ctx.requestId,
        ),
      ),
    list: authenticated
      .input(Page)
      .query(({ ctx, input }) => ctx.store.listPayments(ctx.actor, input.limit)),
    get: authenticated
      .input(z.object({ id: identifier(PaymentId) }).strict())
      .query(({ ctx, input }) => ctx.store.getPayment(ctx.actor, input.id)),
    closeCheckout: authenticated
      .input(
        z
          .object({ id: identifier(PaymentId), reason: z.string().trim().min(1).max(2000) })
          .strict(),
      )
      .mutation(async ({ ctx, input }) => {
        if (!ctx.payments) throw new TRPCError({ code: "NOT_FOUND" });
        const result = await ctx.store.closePaymentCheckout(
          ctx.actor,
          input.id,
          input.reason,
          ctx.requestId,
        );
        await ctx.payments.provider.cancelCheckout(input.id);
        return result;
      }),
    closeReview: authenticated
      .input(
        z
          .object({ id: identifier(PaymentId), reason: z.string().trim().min(1).max(2000) })
          .strict(),
      )
      .mutation(({ ctx, input }) =>
        ctx.store.closePaymentReview(ctx.actor, input.id, input.reason, ctx.requestId),
      ),
    createCheckout: authenticated
      .input(
        z
          .object({
            key: z.string().min(1).max(200),
            accountId: identifier(AccountId),
            ...MoneyInput,
            kind: z.enum(["first", "repeat"]),
            mode: z.enum(SANDBOX_MODES).default("normal"),
          })
          .strict(),
      )
      .mutation(async ({ ctx, input }) => {
        if (!ctx.payments)
          throw new TRPCError({ code: "NOT_FOUND", message: "Sandbox payments are disabled." });
        if (!isCurrencyCode(input.currency)) throw new TRPCError({ code: "BAD_REQUEST" });
        const created = await ctx.store.createPayment(
          ctx.actor,
          {
            key: input.key,
            accountId: input.accountId,
            money: { minor: BigInt(input.amount), currency: input.currency },
            kind: input.kind,
            mode: input.mode,
          },
          ctx.payments.firstCheckMs,
          ctx.requestId,
        );
        const terms = await ctx.store.checkoutTerms(ctx.actor, created.id);
        return {
          paymentId: created.id,
          checkout: await ctx.payments.provider.createCheckout(terms),
        };
      }),
  }),
  leads: t.router({
    list: authenticated
      .input(Page)
      .query(({ ctx, input }) => ctx.store.listLeads(ctx.actor, input)),
    get: authenticated
      .input(z.object({ id: LeadIdentifier }).strict())
      .query(({ ctx, input }) => ctx.store.getLead(ctx.actor, input.id)),
    edit: authenticated
      .input(
        z
          .object({
            id: LeadIdentifier,
            name: z.string().max(200).nullable(),
            phone: z.string().max(40).nullable(),
          })
          .strict(),
      )
      .mutation(({ ctx, input }) =>
        ctx.store.editLead(ctx.actor, input.id, {
          name: normalizeName(input.name),
          phone: normalizePhone(input.phone),
        }),
      ),
    assign: authenticated
      .input(z.object({ leadIds: LeadIds, to: Agent }).strict())
      .mutation(({ ctx, input }) =>
        ctx.store.assignPool(ctx.actor, input.leadIds, input.to, ctx.requestId),
      ),
    reassign: authenticated
      .input(z.object({ leadId: LeadIdentifier, to: Agent }).strict())
      .mutation(({ ctx, input }) =>
        ctx.store.reassignLead(ctx.actor, input.leadId, input.to, ctx.requestId),
      ),
  }),
  accounts: t.router({
    ledger: authenticated
      .input(z.object({ id: identifier(AccountId) }).strict())
      .query(({ ctx, input }) => ctx.store.accountLedger(ctx.actor, input.id)),
    list: authenticated
      .input(Page)
      .query(({ ctx, input }) => ctx.store.listAccounts(ctx.actor, input)),
    get: authenticated
      .input(z.object({ id: identifier(AccountId) }).strict())
      .query(({ ctx, input }) => ctx.store.getAccount(ctx.actor, input.id)),
  }),
  distribution: t.router({
    preview: authenticated
      .input(
        z
          .object({
            leadIds: LeadIds,
            agents: z.array(Agent).min(1).max(100),
            excludePreviousOwner: z.boolean(),
          })
          .strict(),
      )
      .mutation(({ ctx, input }) => ctx.store.previewDistribution(ctx.actor, input)),
    submit: authenticated
      .input(
        z
          .object({
            previewId: z.uuid(),
            fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
            key: z.string().min(1).max(200),
          })
          .strict(),
      )
      .mutation(({ ctx, input }) => ctx.store.submitDistribution(ctx.actor, input, ctx.requestId)),
  }),
  session: t.router({
    current: authenticated.query(({ ctx }) => ctx.principal),
    selectTeam: authenticated
      .input(z.object({ teamId: identifier(TeamId).nullable() }).strict())
      .mutation(async ({ ctx, input }) => {
        if (ctx.principal.kind !== "session") throw new TRPCError({ code: "FORBIDDEN" });
        await ctx.store.selectTeam(ctx.principal.session.id, input.teamId);
        return { selected: true };
      }),
  }),
});
export type AppRouter = typeof appRouter;

export async function handleRpc(
  incoming: Request,
  context: () => Promise<RpcContext>,
  origin: string,
): Promise<Response> {
  const request = await boundedRequest(incoming);
  if (request === null) return new Response(null, { status: 413 });
  if (request.method === "POST" && request.headers.get("origin") !== origin)
    return new Response(null, { status: 403 });
  const requestId = randomUUID();
  const response = await fetchRequestHandler({
    endpoint: "/api/trpc",
    req: request,
    router: appRouter,
    createContext: async () => ({ ...(await context()), requestId }),
  });
  response.headers.set("x-request-id", requestId);
  return response;
}
