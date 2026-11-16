import type { ComponentProps } from "react";
import { Slot } from "radix-ui";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";
const buttonVariants = cva(
  "btn inline-flex items-center justify-center gap-[7px] h-[36px] px-[14px] rounded-control border-[1px] border-solid border-transparent text-(length:--text-body) font-[600] whitespace-nowrap [cursor:pointer] bg-transparent text-foreground [transition:background-color_var(--duration-control)_ease-out,_border-color_var(--duration-control)_ease-out] [&:focus-visible]:[outline:2px_solid_var(--color-primary)] [&:focus-visible]:[outline-offset:2px] [&[disabled]]:bg-muted [&[disabled]]:[border-color:transparent] [&[disabled]]:text-tertiary [&[disabled]]:[cursor:not-allowed] motion-reduce:[transition:none] [.demo-choices_&]:justify-between [.demo-choices_&]:h-auto [.demo-choices_&]:min-h-[44px] [.demo-choices_&]:whitespace-normal [.demo-choices_&]:text-start [.empty_&]:mt-compact max-phone:[.lead-title_&]:min-h-[44px] max-phone:[.form-actions_&]:min-h-[44px] max-phone:[.tl-actions_&]:min-h-[44px] max-phone:[.mobile-identity_&]:p-0 phone:max-poolcompact:[.lead-title_&]:px-related",
  {
    variants: {
      variant: {
        default: "btn--pri bg-primary text-primary-foreground [&:hover]:bg-primary-hover",
        outline: "btn--sec bg-surface border-control-border text-foreground [&:hover]:bg-muted",
        ghost:
          "btn--ghost text-primary px-related [&:hover]:bg-selected [.rail_&]:text-shell-secondary [.rail_&:hover]:bg-shell-hover [.rail_&:hover]:text-shell-foreground",
        destructive:
          "btn--danger bg-surface border-refused-border text-refused-foreground [&:hover]:bg-refused",
      },
      size: {
        default: "",
        sm: "btn--sm h-[30px] px-control text-(length:--text-small)",
        lg: "btn--lg h-[44px] px-section text-(length:--text-action)",
        icon: "btn--icon w-[44px] h-[44px] p-0 rounded-group",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);
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
