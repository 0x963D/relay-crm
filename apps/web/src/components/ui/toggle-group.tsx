"use client";
import type { ComponentProps } from "react";
import { ToggleGroup as Primitive } from "radix-ui";
import { cn } from "@/lib/utils";
export function ToggleGroup({ className, ...props }: ComponentProps<typeof Primitive.Root>) {
  return (
    <Primitive.Root
      className={cn(
        "seg inline-flex p-[3px] rounded-group bg-shell-deep gap-[2px] [&_button]:h-[28px] [&_button]:px-group [&_button]:border-0 [&_button]:rounded-control [&_button]:bg-transparent [&_button]:text-shell-secondary [&_button]:text-(length:--text-small) [&_button]:font-[600] [&_button]:[cursor:pointer] [&_button]:inline-flex [&_button]:items-center [&_button]:gap-compact [&_button:hover]:text-shell-foreground [&_button[aria-pressed='true']]:bg-shell-foreground [&_button[aria-pressed='true']]:text-brand [.demo_&_button]:whitespace-nowrap [&_button[data-state='on']]:bg-shell-foreground [&_button[data-state='on']]:text-brand max-phone:[.demo_&]:ms-auto max-phone:[.demo_&_button]:px-control max-phone:[.demo_&_button]:min-h-[28px]",
        className,
      )}
      {...props}
    />
  );
}
export const ToggleGroupItem = Primitive.Item;
