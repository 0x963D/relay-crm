import { cn } from "@/lib/utils";
import type { ReactNode } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { Badge } from "./ui/badge";
import { Alert, AlertTitle, AlertDescription } from "./ui/alert";
import { Button } from "./ui/button";
import { Icon, type IconName } from "./icons";

export function Avatar({
  name,
  large = false,
  carbon = false,
}: {
  name: string;
  large?: boolean;
  carbon?: boolean;
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-grid shrink-0 place-items-center rounded-full text-xs font-semibold",
        large ? "size-8" : "size-6",
        carbon
          ? "bg-sidebar-foreground/15 text-sidebar-foreground"
          : "bg-muted text-secondary-foreground",
      )}
    >
      {name
        .split(" ")
        .map((part) => part[0])
        .slice(0, 2)
        .join("")}
    </span>
  );
}
const slipVariants = cva(
  "max-w-full gap-1 whitespace-normal rounded-sm px-2 py-0.5 text-start text-xs font-medium",
  {
    variants: {
      kind: {
        neutral: "border-transparent bg-muted text-secondary-foreground",
        waiting: "border-waiting-border bg-waiting text-waiting-foreground",
        refused: "border-refused-border bg-refused text-refused-foreground",
        complete: "border-complete-border bg-complete text-complete-foreground",
        fresh: "border-transparent bg-accent text-accent-foreground",
        outline: "border-input bg-background text-secondary-foreground",
      },
    },
    defaultVariants: { kind: "neutral" },
  },
);
export function Slip({
  kind,
  icon,
  children,
}: VariantProps<typeof slipVariants> & {
  icon: IconName;
  children: ReactNode;
}) {
  return (
    <Badge variant="outline" className={slipVariants({ kind })}>
      <Icon name={icon} size="small" />
      {children}
    </Badge>
  );
}
export function Signoff({
  caption,
  name,
  time,
  icon,
}: {
  caption: string;
  name: string | null;
  time?: string | undefined;
  icon?: IconName;
}) {
  return (
    <div className="min-w-0">
      <div
        className={cn(
          "flex min-h-9 flex-wrap items-center gap-x-2 gap-y-1 border-b pb-1 font-semibold",
          name
            ? "border-foreground"
            : "border-dashed border-waiting-foreground text-waiting-foreground",
        )}
      >
        {icon ? <Icon name={icon} /> : name ? <Avatar name={name} /> : <Icon name="wait" />}
        <span className="break-words">{name ?? "Not assigned"}</span>
        {time && (
          <span className="ms-auto text-xs font-normal text-secondary-foreground">{time}</span>
        )}
      </div>
      <p className="pt-1 text-xs text-muted-foreground">{caption}</p>
    </div>
  );
}
export function Refusal({
  title = "This could not be completed",
  children,
  retry,
  announce = true,
}: {
  title?: string;
  children: ReactNode;
  retry?: () => void;
  announce?: boolean;
}) {
  return (
    <Alert
      className="border-refused-border bg-refused text-refused-foreground"
      role={announce ? "alert" : undefined}
    >
      <Icon name="error" />
      <AlertTitle className="font-semibold">{title}</AlertTitle>
      <AlertDescription className="gap-2 text-current">
        {children}
        {retry && (
          <Button variant="outline" onClick={retry}>
            Try again
          </Button>
        )}
      </AlertDescription>
    </Alert>
  );
}
export function Empty({
  icon,
  title,
  children,
  action,
}: {
  icon: IconName;
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-2 px-8 py-7 text-center">
      <span className="grid size-11 place-items-center rounded-full bg-muted text-secondary-foreground">
        <Icon name={icon} size="large" />
      </span>
      <h2 className="text-panel font-bold">{title}</h2>
      <p className="max-w-sm text-caption text-secondary-foreground">{children}</p>
      {action}
    </div>
  );
}
export function Loading({ label = "Loading leads" }: { label?: string }) {
  return (
    <div role="status" aria-label={label} aria-busy="true" className="space-y-4 p-6">
      {[0, 1, 2].map((i) => (
        <div key={i} className="flex gap-3 motion-safe:animate-pulse">
          <span className="size-8 shrink-0 rounded-full bg-muted" />
          <div className="flex-1 space-y-2">
            <div className="h-3 w-1/2 rounded bg-muted" />
            <div className="h-3 w-3/4 rounded bg-muted" />
          </div>
        </div>
      ))}
      <span className="sr-only">{label}</span>
    </div>
  );
}
export function PageHeader({
  title,
  children,
  action,
}: {
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <header className="flex shrink-0 flex-wrap items-end justify-between gap-3 border-b px-4 py-4 md:px-6">
      <div className="min-w-0">
        <h1 className="text-title font-bold">{title}</h1>
        <div className="mt-1 text-caption text-secondary-foreground">{children}</div>
      </div>
      {action}
    </header>
  );
}
export function Brand() {
  return (
    <div className="flex items-center gap-2.5 text-sidebar-foreground">
      <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-sidebar-foreground text-sidebar">
        <svg
          className="size-5"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          aria-hidden="true"
        >
          <path d="M2.5 9.5c3.2-3.4 6.3-3.4 9.5 0s6.3 3.4 9.5 0M2.5 15.5c3.2-3.4 6.3-3.4 9.5 0s6.3 3.4 9.5 0" />
        </svg>
      </span>
      <div>
        <div className="font-semibold leading-tight">Tidewell Language School</div>
        <div className="text-xs text-sidebar-muted">Relay CRM</div>
      </div>
    </div>
  );
}
