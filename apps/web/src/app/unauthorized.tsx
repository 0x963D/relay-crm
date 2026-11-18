import { connection } from "next/server";
import { composition } from "@/server/composition.ts";
import { SignIn } from "@/components/sign-in";

export default async function NotSignedIn() {
  await connection();
  const { demo, email } = composition().env;
  return <SignIn demo={demo} emailDisabled={email?.kind === "disabled"} />;
}
