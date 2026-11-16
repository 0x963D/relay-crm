"use client";
import type { ComponentProps } from "react";
import { RadioGroup as Primitive } from "radix-ui";
import { cn } from "@/lib/utils";
export function RadioGroup({ className, ...props }: ComponentProps<typeof Primitive.Root>) {
  return (
    <Primitive.Root
      data-slot="radio-group"
      className={cn("flex flex-col gap-compact", className)}
      {...props}
    />
  );
}
export function RadioGroupItem({
  className,
  children,
  ...props
}: ComponentProps<typeof Primitive.Item>) {
  return (
    <Primitive.Item
      data-slot="radio-group-item"
      className={cn(
        "radio",
        children
          ? "inline-flex items-center gap-compact rounded-control px-control py-[5px] text-(length:--text-small) font-[600] text-secondary data-[state=checked]:bg-surface data-[state=checked]:text-foreground data-[state=checked]:shadow-control"
          : "inline-grid size-icon flex-none place-items-center rounded-full border-[1.5px] border-control-border bg-surface data-[state=checked]:border-[5px] data-[state=checked]:border-primary",
        className,
      )}
      {...props}
    >
      {children ?? <Primitive.Indicator />}
    </Primitive.Item>
  );
}
