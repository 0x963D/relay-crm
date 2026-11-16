import {
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
import { reportFailure } from "./errors.ts";

export interface RpcContext {
  readonly store: Store;
  readonly principal: SessionPrincipal | null;
}
const t = initTRPC.context<RpcContext>().create({
  transformer: superjson,
  errorFormatter: ({ shape, error }) => {
    const accessFailure = isAccessError(error.cause) ? error.cause.code : null;
    const failure = accessFailure ? null : reportFailure("rpc.failed", error.cause ?? error);
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
      ctx: { ...ctx, principal: ctx.principal, actor: ctx.principal.actor },
    });
    if (!result.ok && isAccessError(result.error.cause)) throw result.error.cause;
    return result;
  } catch (cause) {
    if (!isAccessError(cause)) throw cause;
    const code =
      cause.code === "accessDenied"
        ? "FORBIDDEN"
        : cause.code === "conflict" ||
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

export const appRouter = t.router({
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
      .mutation(({ ctx, input }) => ctx.store.assignPool(ctx.actor, input.leadIds, input.to)),
    reassign: authenticated
      .input(z.object({ leadId: LeadIdentifier, to: Agent }).strict())
      .mutation(({ ctx, input }) => ctx.store.reassignLead(ctx.actor, input.leadId, input.to)),
  }),
  accounts: t.router({
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
      .mutation(({ ctx, input }) => ctx.store.submitDistribution(ctx.actor, input)),
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

export function handleRpc(
  request: Request,
  context: () => Promise<RpcContext>,
  origin: string,
): Promise<Response> | Response {
  if (request.method === "POST" && request.headers.get("origin") !== origin)
    return new Response(null, { status: 403 });
  return fetchRequestHandler({
    endpoint: "/api/trpc",
    req: request,
    router: appRouter,
    createContext: context,
  });
}
