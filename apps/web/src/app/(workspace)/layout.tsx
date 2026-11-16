import type { ReactNode } from "react";
import { requireSession } from "@/lib/trpc/server";
import { Workspace } from "@/components/workspace";
export default async function WorkspaceLayout({ children }: { children: ReactNode }) {
  const { profile, demo } = await requireSession();
  return (
    <Workspace profile={profile} demo={demo}>
      {children}
    </Workspace>
  );
}
