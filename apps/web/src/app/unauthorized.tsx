import { connection } from "next/server";
import { composition } from "@/server/composition.ts";
import { SignIn } from "@/components/sign-in";

export default async function NotSignedIn() {
  await connection();
  return <SignIn demo={composition().env.demo} />;
}
