import type { ComponentProps } from "react";
import { Slot } from "radix-ui";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "cn";
const buttonVariants = cva("btn", {
  variants: {
    variant: {
      default: "btn--pri",
      outline: "btn--sec",
      ghost: "btn--ghost",
      destructive: "btn--danger",
    },
    size: { default: "", sm: "btn--sm", lg: "btn--lg", icon: "btn--icon" },
  },
  defaultVariants: { variant: "default", size: "default" },
});
function Button({
  className,
  variant,
  size,
  asChild = false,
  type = "button",
  ...props
}: ComponentProps<"button"> & VariantProps<typeof buttonVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : "button";
  return (
    <Comp
      type={type}
      data-slot="button"
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  );
}
export { Button, buttonVariants };
