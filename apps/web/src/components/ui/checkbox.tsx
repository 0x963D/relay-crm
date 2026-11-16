"use client";
import type { ComponentProps } from "react";
import { Checkbox as Primitive } from "radix-ui";
import { Check } from "lucide-react";
import { cn } from "cn";
export function Checkbox({ className, ...props }: ComponentProps<typeof Primitive.Root>) {
  return (
    <Primitive.Root data-slot="checkbox" className={cn("chk", className)} {...props}>
      <Primitive.Indicator>
        <Check aria-hidden="true" className="i-14" />
      </Primitive.Indicator>
    </Primitive.Root>
  );
}
