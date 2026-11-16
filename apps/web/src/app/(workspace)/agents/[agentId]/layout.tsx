import type { ReactNode } from "react";
import { QueueRoute } from "@/components/queue-route";
export default async function AgentQueueLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ agentId: string }>;
}) {
  return <QueueRoute agentId={(await params).agentId}>{children}</QueueRoute>;
}
