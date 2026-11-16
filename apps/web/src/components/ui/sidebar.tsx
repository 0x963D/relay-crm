import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";
export function Sidebar({ className, ...props }: ComponentProps<"aside">) {
  return (
    <aside
      data-slot="sidebar"
      className={cn("flex h-full w-rail flex-col bg-sidebar text-sidebar-foreground", className)}
      {...props}
    />
  );
}
