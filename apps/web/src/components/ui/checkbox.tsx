"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { Icon } from "../icons";
import { Checkbox as CheckboxPrimitive } from "radix-ui";

function Checkbox({ className, ...props }: React.ComponentProps<typeof CheckboxPrimitive.Root>) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={cn(
        "relative inline-grid size-11 shrink-0 place-items-center rounded-sm transition-shadow outline-none md:size-4 focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:ring-destructive/20 before:pointer-events-none before:absolute before:size-4 before:rounded-sm before:border before:border-input before:shadow-xs data-[state=checked]:before:border-primary data-[state=checked]:before:bg-primary data-[state=checked]:text-primary-foreground dark:before:bg-input/30 dark:data-[state=checked]:before:bg-primary",
        className,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator
        data-slot="checkbox-indicator"
        className="relative grid place-content-center text-current transition-none"
      >
        <Icon name="check" className="size-3.5" />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}

export { Checkbox };
