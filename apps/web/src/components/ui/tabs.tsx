"use client";
import type { ComponentProps } from "react";
import { Tabs as Primitive } from "radix-ui";
import { cn } from "cn";
export const Tabs = Primitive.Root;
export function TabsList({ className, ...props }: ComponentProps<typeof Primitive.List>) {
  return <Primitive.List className={cn("tabs", className)} {...props} />;
}
export const TabsTrigger = Primitive.Trigger;
export const TabsContent = Primitive.Content;
