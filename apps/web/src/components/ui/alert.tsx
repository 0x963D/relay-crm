import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";
export function Alert({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="alert"
      role="alert"
      className={cn(
        "alert flex gap-control p-[12px_14px] rounded-group border-[1px] border-solid border-control-border bg-surface",
        className,
      )}
      {...props}
    />
  );
}
