import { cn } from "@/lib/utils";
import type { ReactNode } from "react";
import { Badge } from "./ui/badge";
import { Alert } from "./ui/alert";
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
      data-initials={name
        .split(" ")
        .map((part) => part[0])
        .slice(0, 2)
        .join("")}
      className={cn(
        `av after:content-[attr(data-initials)] inline-grid place-items-center w-[24px] h-[24px] [border-radius:50%] bg-muted text-secondary [font-size:10.5px] font-[650] flex-none [letter-spacing:0.01em] max-phone:[.qrow_>_&]:hidden max-phone:[.q-select_>_&]:hidden ${large ? "av--lg w-[32px] h-[32px] text-(length:--text-caption)" : ""} ${carbon ? "av--carbon bg-avatar text-shell-foreground" : ""}`,
      )}
    />
  );
}
export function Slip({
  kind = "mute",
  icon,
  children,
}: {
  kind?: "pink" | "canary" | "green" | "ink" | "mute" | "line";
  icon: IconName;
  children: ReactNode;
}) {
  return (
    <Badge variant={kind}>
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
    <div className={`so min-w-0 ${name ? "" : "so--blank"}`}>
      <div className="so-line flex items-center gap-related h-[34px] [border-block-end:1.5px_solid_var(--color-foreground)] font-[620] [.so--blank_&]:[border-block-end:1.5px_dashed_var(--color-waiting-foreground)] [.so--blank_&]:text-waiting-foreground [.so--blank_&]:font-[560] [.so--sm_&]:h-[28px] [.so--sm_&]:text-(length:--text-small) max-laptop:h-auto max-laptop:min-h-[34px] max-laptop:flex-wrap">
        {icon ? <Icon name={icon} /> : name ? <Avatar name={name} /> : <Icon name="wait" />}
        <span className="trunc overflow-hidden text-ellipsis whitespace-nowrap min-w-0">
          {name ?? "Not assigned"}
        </span>
        {time && (
          <span className="so-time ms-auto font-[500] text-(length:--text-caption) text-secondary whitespace-nowrap max-laptop:ms-0 max-phone:ms-auto">
            {time}
          </span>
        )}
      </div>
      <div className="so-cap flex items-center gap-[5px] pt-[5px] text-(length:--text-caption) leading-[16px] text-tertiary [font-stretch:94%] [.so--blank_&]:text-waiting-foreground">
        {caption}
      </div>
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
      className="alert--refused bg-refused border-refused-border text-refused-foreground"
      role={announce ? "alert" : undefined}
    >
      <Icon name="error" size="large" />
      <div className="form-message text-(length:--text-small) leading-[18px] [&_p_+_p]:mt-compact">
        <p className="alert-title font-[660]">{title}</p>
        <div>{children}</div>
        {retry && (
          <Button variant="outline" onClick={retry}>
            Try again
          </Button>
        )}
      </div>
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
    <div className="empty flex flex-col items-center text-center gap-related p-[28px_32px] [&_p]:max-w-[34ch]">
      <span className="empty-icon w-[44px] h-[44px] [border-radius:50%] bg-muted text-secondary grid place-items-center">
        <Icon name={icon} size="large" />
      </span>
      <h2 className="h2 text-(length:--text-panel) leading-[22px] font-[700] [font-variation-settings:'wdth'_86] [.pool-panel_&]:flex-none">
        {title}
      </h2>
      <p className="sm text-(length:--text-small) leading-[18px] [.demo-choices_&]:font-[400] [.pool-people_&]:ms-auto [.preview-person_&]:[overflow-wrap:anywhere] [.preview-header_>_&]:text-(length:--text-caption) [.preview-header_>_&]:whitespace-nowrap t2 text-secondary [.alert--refused_&]:text-refused-foreground">
        {children}
      </p>
      {action}
    </div>
  );
}
export function Loading() {
  return (
    <div aria-label="Loading leads" role="status" aria-busy="true">
      {[0, 1, 2].map((i) => (
        <div className="skeleton-row flex gap-group p-[10px_24px]" key={i}>
          <span className="sk bg-skeleton rounded-slip [animation:sk_var(--duration-loading)_ease-in-out_infinite] motion-reduce:[animation:none] [.skeleton-lines_&:first-child]:w-[46%] [.skeleton-lines_&:last-child]:w-[72%] skeleton-avatar w-[32px] h-[32px] [border-radius:50%]" />
          <span className="skeleton-lines flex-1 flex flex-col gap-related">
            <span className="sk bg-skeleton rounded-slip h-[12px] [animation:sk_var(--duration-loading)_ease-in-out_infinite] motion-reduce:[animation:none] [.skeleton-lines_&:first-child]:w-[46%] [.skeleton-lines_&:last-child]:w-[72%]" />
            <span className="sk bg-skeleton rounded-slip h-[12px] [animation:sk_var(--duration-loading)_ease-in-out_infinite] motion-reduce:[animation:none] [.skeleton-lines_&:first-child]:w-[46%] [.skeleton-lines_&:last-child]:w-[72%]" />
          </span>
          <span className="sk bg-skeleton rounded-slip [animation:sk_var(--duration-loading)_ease-in-out_infinite] motion-reduce:[animation:none] [.skeleton-lines_&:first-child]:w-[46%] [.skeleton-lines_&:last-child]:w-[72%] skeleton-slip w-[64px] h-[22px]" />
        </div>
      ))}
      <span className="sr-only absolute w-[1px] h-[1px] p-0 m-[-1px] overflow-hidden [clip-path:inset(50%)] whitespace-nowrap border-0">
        Loading leads
      </span>
    </div>
  );
}
export function Brand() {
  return (
    <div className="org flex items-center gap-control p-[6px_6px_16px] max-phone:[.rail_&]:p-0 max-phone:[.rail_&]:flex-1 [.sign-brand_&]:p-0">
      <span className="org-mark w-[32px] h-[32px] rounded-group bg-shell-foreground text-brand grid place-items-center flex-none [&_svg]:[stroke-width:2.3] max-phone:[.rail_&]:w-[28px] max-phone:[.rail_&]:h-[28px] max-phone:[.rail_&]:[border-radius:7px]">
        <svg
          className="i-20 w-[20px] h-[20px] flex-none"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeLinecap="round"
          aria-hidden="true"
        >
          <path d="M2.5 9.5c3.2-3.4 6.3-3.4 9.5 0s6.3 3.4 9.5 0M2.5 15.5c3.2-3.4 6.3-3.4 9.5 0s6.3 3.4 9.5 0" />
        </svg>
      </span>
      <div>
        <div className="org-name font-[650] text-(length:--text-body) leading-[17px] [font-stretch:92%] [overflow-wrap:anywhere] [.rail_&]:max-w-[154px] max-phone:[.rail_&]:text-(length:--text-small) max-phone:[.rail_&]:max-w-[none]">
          Tidewell Language School
        </div>
        <div className="org-by text-(length:--text-caption) leading-[15px] text-shell-secondary max-phone:[.rail_&]:hidden">
          Relay CRM
        </div>
      </div>
    </div>
  );
}
