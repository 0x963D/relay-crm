import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";
export function Textarea({ className, ...props }: ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "input flex gap-related px-control border-[1px] border-solid border-control-border rounded-control bg-surface text-foreground text-(length:--text-body) [.sign-sheet_&]:h-[44px] [.sign-sheet_&]:w-full max-phone:min-h-[44px] [&:focus-visible]:[outline:none] [&:focus-visible]:border-primary [&:focus-visible]:[box-shadow:0_0_0_3px_var(--color-selected)] input--area h-auto min-h-[64px] items-start py-related leading-[20px]",
        className,
      )}
      {...props}
    />
  );
}
