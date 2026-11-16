import type { ComponentProps } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "cn";
const badgeVariants = cva("slip", {
  variants: {
    variant: {
      pink: "slip--pink",
      canary: "slip--canary",
      green: "slip--green",
      ink: "slip--ink",
      mute: "slip--mute",
      line: "slip--line",
    },
  },
  defaultVariants: { variant: "mute" },
});
export function Badge({
  className,
  variant,
  ...props
}: ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return (
    <span data-slot="badge" className={cn(badgeVariants({ variant }), className)} {...props} />
  );
}
