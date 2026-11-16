import type { ComponentProps } from "react";
import { cn } from "cn";
export function Card({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="card" className={cn("card", className)} {...props} />;
}
