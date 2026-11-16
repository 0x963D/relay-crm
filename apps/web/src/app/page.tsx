import { connection } from "next/server";
import { headers } from "next/headers";
import { composition } from "@/server/composition.ts";
import { resolvePrincipal } from "@/server/actor.ts";
import { appRouter } from "@/server/rpc.ts";
import { Workspace } from "@/components/workspace";
import { SignIn } from "@/components/sign-in";

export default async function HomePage() {
  await connection();
  const app = composition();
  const principal = await resolvePrincipal(app, await headers());
  if (!principal) return <SignIn demo={app.env.demo} />;
  const caller = appRouter.createCaller({
    store: app.store,
    principal,
  });
  const profile = await caller.session.profile();
  const agents =
    profile.role === "accountant" ? [] : await caller.leads.agents({ offset: 0 }).catch(() => []);
  return (
    <Workspace profile={profile} agents={agents} demo={app.env.demo} zone={app.env.timeZone} />
  );
}
