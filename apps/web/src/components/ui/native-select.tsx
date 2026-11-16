import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";
export function NativeSelect({ className, ...props }: ComponentProps<"select">) {
  return (
    <select
      data-slot="native-select"
      className={cn(
        "h-input rounded-control border border-control-border bg-surface px-control text-(length:--text-body) text-foreground focus-visible:border-primary focus-visible:outline-none focus-visible:shadow-[0_0_0_3px_var(--color-selected)] max-phone:min-h-touch",
        className,
      )}
      {...props}
    />
  );
}
