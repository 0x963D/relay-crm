import type { ComponentProps } from "react";
import { cn } from "cn";
export function Alert({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="alert" role="alert" className={cn("alert", className)} {...props} />;
}
