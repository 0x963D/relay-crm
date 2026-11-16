import type { ReactNode } from "react";
import { QueueRoute } from "@/components/queue-route";
export default function QueueLayout({ children }: { children: ReactNode }) {
  return <QueueRoute>{children}</QueueRoute>;
}
