import type { ComponentProps } from "react";
import { cn } from "cn";
export function SidebarProvider({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="sidebar-wrapper" className={cn("shell", className)} {...props} />;
}
export function Sidebar({ className, ...props }: ComponentProps<"aside">) {
  return (
    <aside data-slot="sidebar" data-variant="inset" className={cn("rail", className)} {...props} />
  );
}
export function SidebarInset({ className, ...props }: ComponentProps<"main">) {
  return <main id="main" data-slot="sidebar-inset" className={cn("sheet", className)} {...props} />;
}
