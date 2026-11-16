import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Icon, type IconName } from "./icons";

export function Timeline({ name, children }: { name: string; children: ReactNode }) {
  return <ol aria-label={name}>{children}</ol>;
}
export function TimelineEntry({
  icon,
  gap = false,
  children,
}: {
  icon: IconName;
  gap?: boolean;
  children: ReactNode;
}) {
  return (
    <li className="relative flex gap-3 pb-5 before:absolute before:start-3.5 before:top-7 before:bottom-0 before:border-s last:pb-0 last:before:hidden">
      <span
        className={cn(
          "relative grid size-7 shrink-0 place-items-center rounded-full text-secondary-foreground",
          gap ? "border border-dashed border-input bg-background" : "bg-muted",
        )}
      >
        <Icon name={icon} size="small" />
      </span>
      <div className="min-w-0 flex-1">{children}</div>
    </li>
  );
}
