import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";
export function SidebarProvider({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="sidebar-wrapper"
      className={cn(
        "shell grid [grid-template-columns:var(--rail-width)_minmax(0,_1fr)] [grid-template-rows:44px_1fr] w-full h-[100dvh] bg-shell max-pane:[--rail-width:180px] max-phone:flex max-phone:flex-col max-phone:h-auto max-phone:min-h-[100dvh]",
        className,
      )}
      {...props}
    />
  );
}
export function Sidebar({ className, ...props }: ComponentProps<"aside">) {
  return (
    <aside
      data-slot="sidebar"
      data-variant="inset"
      className={cn(
        "rail flex flex-col p-[6px_12px_14px_14px] text-shell-foreground min-h-0 [.shell--live_&]:[grid-row:1] max-pane:px-control max-phone:flex max-phone:p-[4px_10px_12px_16px] max-phone:flex-row max-phone:items-center max-phone:gap-control max-phone:text-shell-foreground",
        className,
      )}
      {...props}
    />
  );
}
export function SidebarInset({ className, ...props }: ComponentProps<"main">) {
  return (
    <main
      id="main"
      data-slot="sidebar-inset"
      className={cn(
        "sheet bg-surface rounded-surface my-[0_10px] mx-[0_10px] min-w-0 min-h-0 flex flex-col overflow-hidden [.shell--live_&]:[grid-row:1] max-phone:m-0 max-phone:[border-radius:14px_14px_0_0] max-phone:flex-1 max-phone:overflow-visible",
        className,
      )}
      {...props}
    />
  );
}
