"use client";
import type { ComponentProps } from "react";
import { Tabs as Primitive } from "radix-ui";
import { cn } from "@/lib/utils";
export const Tabs = Primitive.Root;
export function TabsList({ className, ...props }: ComponentProps<typeof Primitive.List>) {
  return (
    <Primitive.List
      className={cn(
        "tabs inline-flex p-[3px] rounded-group bg-muted gap-[2px] [&_button]:h-[30px] [&_button]:px-group [&_button]:border-0 [&_button]:rounded-control [&_button]:bg-transparent [&_button]:text-secondary [&_button]:text-(length:--text-small) [&_button]:font-[600] [&_button]:[cursor:pointer] [&_button]:inline-flex [&_button]:items-center [&_button]:gap-compact [&_button]:whitespace-nowrap [&_button[aria-selected='true']]:bg-surface [&_button[aria-selected='true']]:text-foreground [&_button[aria-selected='true']]:shadow-control [&_button[data-state='active']]:bg-surface [&_button[data-state='active']]:text-foreground [&_button[data-state='active']]:shadow-control max-phone:[&_button]:min-h-[36px]",
        className,
      )}
      {...props}
    />
  );
}
export const TabsTrigger = Primitive.Trigger;
export const TabsContent = Primitive.Content;
