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
      className={`av ${large ? "av--lg" : ""} ${carbon ? "av--carbon" : ""}`}
    >
      {name
        .split(" ")
        .map((n) => n[0])
        .slice(0, 2)
        .join("")}
    </span>
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
    <div className={`so ${name ? "" : "so--blank"}`}>
      <div className="so-line">
        {icon ? <Icon name={icon} /> : name ? <Avatar name={name} /> : <Icon name="wait" />}
        <span className="trunc">{name ?? "Not assigned"}</span>
        {time && <span className="so-time">{time}</span>}
      </div>
      <div className="so-cap">{caption}</div>
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
    <Alert className="alert--refused" role={announce ? "alert" : undefined}>
      <Icon name="error" size="large" />
      <div className="form-message">
        <p className="alert-title">{title}</p>
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
    <div className="empty">
      <span className="empty-icon">
        <Icon name={icon} size="large" />
      </span>
      <h2 className="h2">{title}</h2>
      <p className="sm t2">{children}</p>
      {action}
    </div>
  );
}
export function Loading() {
  return (
    <div aria-label="Loading leads" role="status" aria-busy="true">
      {[0, 1, 2].map((i) => (
        <div className="skeleton-row" key={i}>
          <span className="sk skeleton-avatar" />
          <span className="skeleton-lines">
            <span className="sk" />
            <span className="sk" />
          </span>
          <span className="sk skeleton-slip" />
        </div>
      ))}
      <span className="sr-only">Loading leads</span>
    </div>
  );
}
export function Brand() {
  return (
    <div className="org">
      <span className="org-mark">
        <svg
          className="i-20"
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
        <div className="org-name">Tidewell Language School</div>
        <div className="org-by">Relay CRM</div>
      </div>
    </div>
  );
}
