import type { ComponentProps } from "react";
import { cn } from "cn";
export function Input({ className, ...props }: ComponentProps<"input">) {
  return <input data-slot="input" className={cn("input", className)} {...props} />;
}
