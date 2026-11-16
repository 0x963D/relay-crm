"use client";
import type { ComponentProps } from "react";
import { Checkbox as Primitive } from "radix-ui";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";
export function Checkbox({ className, ...props }: ComponentProps<typeof Primitive.Root>) {
  return (
    <Primitive.Root
      data-slot="checkbox"
      className={cn(
        "chk inline-grid place-items-center w-[16px] h-[16px] border-[1.5px] border-solid border-control-border rounded-slip bg-surface text-primary-foreground flex-none p-0 [&[data-state='checked']]:bg-primary [&[data-state='checked']]:border-primary",
        className,
      )}
      {...props}
    >
      <Primitive.Indicator>
        <Check aria-hidden="true" className="i-14 w-[14px] h-[14px] flex-none" />
      </Primitive.Indicator>
    </Primitive.Root>
  );
}
