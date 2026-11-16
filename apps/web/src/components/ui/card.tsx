import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";
export function Card({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="card"
      className={cn(
        "card border-[1px] border-solid border-rule rounded-group bg-surface",
        className,
      )}
      {...props}
    />
  );
}
