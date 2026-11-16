import { randomUUID } from "node:crypto";
import {
  ATTEMPT_CHANNELS,
  ATTEMPT_OUTCOMES,
  DEAD_REASONS,
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
import { AccessError, isAccessError, type Store } from "@relay/store";
import { initTRPC, TRPCError } from "@trpc/server";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import superjson from "superjson";
import { z } from "zod";
import { boundedRequest } from "./http.ts";
import { reportFailure } from "./errors.ts";

export interface RpcContext {
  readonly timeZone?: string;
  readonly demo?: boolean;
  readonly requestId?: string;
  readonly store: Store;
  readonly payments?: {
    readonly provider: PaymentProvider;
    readonly firstCheckMs: number;
    readonly intervalMs: number;
  } | null;
  readonly principal: SessionPrincipal | null;
}
async function paymentResponse<T extends object | null>(
  ctx: { readonly demo?: boolean | undefined; readonly payments?: RpcContext["payments"] },
  result: Promise<T>,
) {
  return {
    ...(await result),
    demo: ctx.demo ?? false,
    reconciliation: ctx.payments
      ? { firstCheckMs: ctx.payments.firstCheckMs, intervalMs: ctx.payments.intervalMs }
      : null,
  };
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
            cause.code === "receiptAttemptLimit" ||
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
const Paged = Page.extend({ offset: z.int().min(0).default(0) });

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

const CallbackInput = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("set"), at: z.date() }).strict(),
  z.object({ kind: z.literal("clear") }).strict(),
]);
const WorkInput = { id: LeadIdentifier, key: z.string().min(1).max(200) };
const Note = z.string().trim().min(1).max(4000);
const ClosingInput = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("won") }).strict(),
  z.object({ kind: z.literal("lost"), note: Note }).strict(),
  z.object({ kind: z.literal("dead"), reason: z.enum(DEAD_REASONS) }).strict(),
]);

export const appRouter = t.router({
  payments: t.router({
    receiptUse: authenticated
      .input(z.object({ hash: ManualTermsInput.receiptHash }).strict())
      .query(({ ctx, input }) => ctx.store.paymentUsingReceipt(ctx.actor, input.hash)),
    requeueReceipt: authenticated
      .input(z.object({ id: identifier(PaymentId) }).strict())
      .mutation(({ ctx, input }) =>
        paymentResponse(ctx, ctx.store.requeueReceipt(ctx.actor, input.id, ctx.requestId)),
      ),
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
        paymentResponse(
          ctx,
          ctx.store.recordManualPayment(
            ctx.actor,
            { ...input, money: parsedMoney(input) },
            ctx.requestId,
          ),
        ),
      ),
    approve: authenticated
      .input(z.object({ ...DecisionInput, roleVersion: z.int().min(0) }).strict())
      .mutation(({ ctx, input }) =>
        paymentResponse(ctx, ctx.store.approveManualPayment(ctx.actor, input, ctx.requestId)),
      ),
    reject: authenticated.input(RefusalInput).mutation(async ({ ctx, input }) => {
      try {
        return await paymentResponse(
          ctx,
          ctx.store.decideManualPayment(ctx.actor, { ...input, decision: "reject" }, ctx.requestId),
        );
      } catch (cause) {
        if (isAccessError(cause) && cause.code === "accessDenied") {
          const { actions } = await ctx.store.getPayment(ctx.actor, input.id);
          if (
            actions.approvalRefusal === "paymentRecorder" ||
            actions.approvalRefusal === "paymentMaker"
          )
            throw new AccessError(actions.approvalRefusal);
        }
        throw cause;
      }
    }),
    cancel: authenticated
      .input(RefusalInput)
      .mutation(({ ctx, input }) =>
        paymentResponse(
          ctx,
          ctx.store.decideManualPayment(ctx.actor, { ...input, decision: "cancel" }, ctx.requestId),
        ),
      ),
    editManual: authenticated
      .input(z.object({ ...DecisionInput, ...ManualTermsInput }).strict())
      .mutation(({ ctx, input }) =>
        paymentResponse(
          ctx,
          ctx.store.editManualPayment(
            ctx.actor,
            { ...input, money: parsedMoney(input) },
            ctx.requestId,
          ),
        ),
      ),
    list: authenticated
      .input(Paged)
      .query(({ ctx, input }) =>
        paymentResponse(ctx, ctx.store.listPayments(ctx.actor, input.limit, input.offset)),
      ),
    get: authenticated
      .input(z.object({ id: identifier(PaymentId) }).strict())
      .query(({ ctx, input }) => paymentResponse(ctx, ctx.store.getPayment(ctx.actor, input.id))),
    closeCheckout: authenticated
      .input(
        z
          .object({ id: identifier(PaymentId), reason: z.string().trim().min(1).max(2000) })
          .strict(),
      )
      .mutation(async ({ ctx, input }) => {
        await ctx.store.closePaymentCheckout(ctx.actor, input.id, input.reason, ctx.requestId);
        let observed = null;
        try {
          if (ctx.payments) {
            await ctx.payments.provider.cancelCheckout(input.id);
            observed = await ctx.payments.provider.readPayment(input.id);
          }
        } catch {
          /* Reconciliation retries an unavailable provider. */
        }
        await ctx.store.recordCheckoutCancellation(
          input.id,
          observed,
          ctx.requestId,
          Boolean(ctx.payments),
        );
        const result = await ctx.store.getPayment(ctx.actor, input.id);
        return {
          ...result,
          demo: ctx.demo ?? false,
          message:
            result.state.status === "needsReview"
              ? "The checkout was already paid. The payment needs review; nothing was credited."
              : ctx.payments
                ? "The checkout is closed."
                : "The checkout is closed. The provider was not asked because sandbox payments are disabled.",
        };
      }),
    closeReview: authenticated
      .input(
        z
          .object({ id: identifier(PaymentId), reason: z.string().trim().min(1).max(2000) })
          .strict(),
      )
      .mutation(({ ctx, input }) =>
        paymentResponse(
          ctx,
          ctx.store.closePaymentReview(ctx.actor, input.id, input.reason, ctx.requestId),
        ),
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
        try {
          return {
            demo: ctx.demo ?? false,
            paymentId: created.id,
            checkout: await ctx.payments.provider.createCheckout(terms),
          };
        } finally {
          await ctx.store.finishCheckoutCreation(created.id, terms.creationToken);
        }
      }),
  }),
  reports: t.router({
    funnel: authenticated.query(({ ctx }) => ctx.store.campaignFunnel(ctx.actor)),
  }),
  leads: t.router({
    pool: authenticated
      .input(
        z
          .object({ limit: z.int().min(1).max(100).default(14), offset: z.int().min(0).default(0) })
          .strict(),
      )
      .query(({ ctx, input }) => ctx.store.leadPool(ctx.actor, input)),
    agents: authenticated
      .input(z.object({ offset: z.int().min(0).default(0) }).strict())
      .query(({ ctx, input }) => ctx.store.queueAgents(ctx.actor, input.offset)),
    queue: authenticated
      .input(
        z
          .object({
            agentId: identifier(UserId).optional(),
            limit: z.int().min(1).max(100).default(100),
            offset: z.int().min(0).default(0),
          })
          .strict(),
      )
      .query(({ ctx, input }) =>
        ctx.store.workQueue(ctx.actor, {
          agentId: input.agentId ?? ctx.actor.userId,
          limit: input.limit,
          offset: input.offset,
          at: new Date(),
          timeZone: ctx.timeZone ?? "UTC",
        }),
      ),
    logAttempt: authenticated
      .input(
        z
          .object({
            ...WorkInput,
            channel: z.enum(ATTEMPT_CHANNELS),
            outcome: z.enum(ATTEMPT_OUTCOMES),
            note: Note,
            callback: CallbackInput.optional(),
          })
          .strict(),
      )
      .mutation(({ ctx, input: { id, key, ...attempt } }) =>
        ctx.store.workLead(
          ctx.actor,
          { id, key, work: { kind: "attempt", attempt } },
          ctx.requestId,
        ),
      ),
    addNote: authenticated
      .input(z.object({ ...WorkInput, note: Note }).strict())
      .mutation(({ ctx, input: { id, key, note } }) =>
        ctx.store.workLead(ctx.actor, { id, key, work: { kind: "note", note } }, ctx.requestId),
      ),
    setCallback: authenticated
      .input(z.object({ ...WorkInput, change: CallbackInput }).strict())
      .mutation(({ ctx, input: { id, key, change } }) =>
        ctx.store.workLead(
          ctx.actor,
          { id, key, work: { kind: "callback", change } },
          ctx.requestId,
        ),
      ),
    close: authenticated
      .input(z.object({ ...WorkInput, closing: ClosingInput }).strict())
      .mutation(({ ctx, input: { id, key, closing } }) =>
        ctx.store.workLead(ctx.actor, { id, key, work: { kind: "close", closing } }, ctx.requestId),
      ),
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
      .query(({ ctx, input }) =>
        paymentResponse(ctx, ctx.store.accountLedger(ctx.actor, input.id)),
      ),
    list: authenticated
      .input(Paged)
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
    profile: authenticated.query(({ ctx }) => ctx.store.sessionProfile(ctx.actor)),
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
