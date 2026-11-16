"use client";
import type { ComponentProps } from "react";
import { RadioGroup as Primitive } from "radix-ui";
import { cn } from "cn";
export function RadioGroup({ className, ...props }: ComponentProps<typeof Primitive.Root>) {
  return <Primitive.Root className={cn("field", className)} {...props} />;
}
export function RadioGroupItem({
  className,
  children,
  ...props
}: ComponentProps<typeof Primitive.Item>) {
  return (
    <Primitive.Item className={cn("radio", className)} {...props}>
      {children ?? <Primitive.Indicator className="radio-dot" />}
    </Primitive.Item>
  );
}
