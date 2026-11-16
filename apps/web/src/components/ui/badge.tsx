import type { ComponentProps } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";
const badgeVariants = cva(
  "slip inline-flex items-center gap-[5px] h-[22px] px-[7px] rounded-slip text-(length:--text-caption) leading-[1] font-[600] whitespace-nowrap border-[1px] border-solid border-transparent [font-stretch:94%] max-phone:[.qrow_.q-top_&]:mt-[5px] max-phone:[.q-top_&]:[order:2] max-phone:[.q-top_&]:[align-self:flex-start] max-phone:[.q-top_&]:mt-[5px]",
  {
    variants: {
      variant: {
        pink: "slip--pink bg-refused text-refused-foreground border-refused-border",
        canary: "slip--canary bg-waiting text-waiting-foreground border-waiting-border",
        green: "slip--green bg-complete text-complete-foreground border-complete-border",
        ink: "slip--ink bg-selected text-primary",
        mute: "slip--mute bg-muted text-secondary",
        line: "slip--line bg-transparent text-secondary border-control-border",
      },
    },
    defaultVariants: { variant: "mute" },
  },
);
export function Badge({
  className,
  variant,
  ...props
}: ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return (
    <span data-slot="badge" className={cn(badgeVariants({ variant }), className)} {...props} />
  );
}
