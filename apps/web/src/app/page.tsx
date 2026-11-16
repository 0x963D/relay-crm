import { redirect } from "next/navigation";
import { getSession } from "@/lib/trpc/server";
import { homeFor } from "@/lib/workspace";
export default async function HomePage() {
  const session = await getSession();
  redirect(session ? homeFor(session.profile.role) : "/sign-in");
}
