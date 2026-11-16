import { connection } from "next/server";
import { composition } from "@/server/composition.ts";
import { requireActor } from "@/server/actor.ts";
import { appRouter } from "@/server/rpc.ts";
import { Workspace } from "@/components/workspace";

export default async function HomePage() {
  await connection();
  const actor = await requireActor();
  const app = composition();
  const caller = appRouter.createCaller({
    store: app.store,
    principal: { kind: "development", actor },
  });
  const profile = await caller.session.profile();
  const agents =
    profile.role === "accountant" ? [] : await caller.leads.agents({ offset: 0 }).catch(() => []);
  return (
    <Workspace profile={profile} agents={agents} demo={app.env.demo} zone={app.env.timeZone} />
  );
}
