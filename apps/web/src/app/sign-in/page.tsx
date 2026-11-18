import { redirect } from "next/navigation";
import { getSession } from "@/lib/trpc/server";
import { composition } from "@/server/composition";
import { homeFor } from "@/lib/workspace";
import { SignIn } from "@/components/sign-in";
export default async function SignInPage() {
  const session = await getSession();
  if (session) redirect(homeFor(session.profile.role));
  const { demo, email } = composition().env;
  return <SignIn demo={demo} emailDisabled={email?.kind === "disabled"} />;
}
