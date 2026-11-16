import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";
export function Input({ className, ...props }: ComponentProps<"input">) {
  return (
    <input
      data-slot="input"
      className={cn(
        "input flex items-center gap-related h-[36px] px-control border-[1px] border-solid border-control-border rounded-control bg-surface text-foreground text-(length:--text-body) [.sign-sheet_&]:h-[44px] [.sign-sheet_&]:w-full max-phone:min-h-[44px] [&:focus-visible]:[outline:none] [&:focus-visible]:border-primary [&:focus-visible]:[box-shadow:0_0_0_3px_var(--color-selected)]",
        className,
      )}
      {...props}
    />
  );
}
