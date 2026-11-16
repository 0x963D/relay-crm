"use client";
import type { ComponentProps } from "react";
import { ToggleGroup as Primitive } from "radix-ui";
import { cn } from "cn";
export function ToggleGroup({ className, ...props }: ComponentProps<typeof Primitive.Root>) {
  return <Primitive.Root className={cn("seg", className)} {...props} />;
}
export const ToggleGroupItem = Primitive.Item;
