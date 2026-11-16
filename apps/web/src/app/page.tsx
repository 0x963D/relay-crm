import { isAccessError } from "@relay/store";
import { TRPCError } from "@trpc/server";
import { QueryClient, dehydrate } from "@tanstack/react-query";
import { DataProvider } from "@/components/data-provider";
import { workspaceView } from "@/lib/workspace";
import { reads } from "@/lib/reads";
import { failureMessage } from "@/lib/failures";
import { connection } from "next/server";
import { headers } from "next/headers";
import { composition } from "@/server/composition.ts";
import { resolvePrincipal } from "@/server/actor.ts";
import { appRouter } from "@/server/rpc.ts";
import { Workspace } from "@/components/workspace";
import { SignIn } from "@/components/sign-in";

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await connection();
  const app = composition();
  const principal = await resolvePrincipal(app, await headers());
  if (!principal) return <SignIn demo={app.env.demo} />;
  const caller = appRouter.createCaller({
    store: app.store,
    principal,
    timeZone: app.env.timeZone,
  });
  const profile = await caller.session.profile();
  const params = await searchParams;
  const client = new QueryClient();
  const read = async <T,>(key: readonly unknown[], load: () => Promise<T>) =>
    client.query({
      queryKey: key,
      retry: false,
      queryFn: load,
    });
  const view = workspaceView(
    profile.role,
    typeof params.view === "string" ? params.view : undefined,
  );
  const requestedAgent = typeof params.agent === "string" ? params.agent : undefined;
  const leadId = typeof params.lead === "string" ? params.lead : undefined;
  const agentsRead = read(reads.agents().queryKey, () => caller.leads.agents({ offset: 0 }));
  const queueInput = {
    agentId: profile.role === "agent" ? profile.userId : requestedAgent,
    limit: 20,
  };
  const queueRead =
    view === "queue" && queueInput.agentId
      ? read(reads.queue(queueInput).queryKey, () => caller.leads.queue(queueInput))
      : null;
  const poolRead =
    view !== "queue"
      ? read(reads.pool().queryKey, () => caller.leads.pool({ limit: 14, offset: 0 }))
      : null;
  const leadRead = leadId
    ? read(reads.lead(leadId).queryKey, () => caller.leads.get({ id: leadId }))
    : null;
  await Promise.allSettled([agentsRead, queueRead, poolRead, leadRead]);
  const agents = client.getQueryData<Awaited<ReturnType<typeof caller.leads.agents>>>(
    reads.agents().queryKey,
  );
  const agentId = queueInput.agentId ?? agents?.[0]?.ownerId;
  const input = { agentId, limit: 20 };
  if (view === "queue" && agentId) {
    if (!queueRead)
      await Promise.allSettled([
        read(reads.queue(input).queryKey, () => caller.leads.queue(input)),
      ]);
    const queue = client.getQueryData<Awaited<ReturnType<typeof caller.leads.queue>>>(
      reads.queue(input).queryKey,
    );
    const first =
      queue &&
      [
        queue.overdueCallbacks,
        queue.dueToday,
        queue.noCallbackSet,
        queue.notYetCalled,
        queue.later,
      ].flat()[0];
    if (!leadId && first)
      await Promise.allSettled([
        read(reads.lead(first.id).queryKey, () => caller.leads.get({ id: first.id })),
      ]);
  }
  const dehydrated = dehydrate(client, {
    shouldDehydrateQuery: () => true,
    shouldRedactErrors: () => false,
  });
  const state = {
    ...dehydrated,
    queries: dehydrated.queries.map((query) => {
      const error: unknown = query.state.error;
      const cause = error instanceof TRPCError ? error.cause : error;
      const failure = {
        data: {
          code: error instanceof TRPCError ? error.code : "INTERNAL_SERVER_ERROR",
          accessFailure: isAccessError(cause) ? cause.code : null,
        },
      };
      return {
        ...query,
        state: {
          ...query.state,
          error: error
            ? { ...failure, name: "ReadError", message: failureMessage(failure, "read") }
            : null,
          fetchFailureReason: error
            ? { ...failure, name: "ReadError", message: failureMessage(failure, "read") }
            : null,
        },
      };
    }),
  };
  return (
    <DataProvider state={state}>
      <Workspace
        profile={profile}
        agents={agents ?? []}
        demo={app.env.demo}
        zone={app.env.timeZone}
      />
    </DataProvider>
  );
}
