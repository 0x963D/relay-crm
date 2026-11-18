export function formatDate(at: Date, zone: string, options: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat("en-GB", { ...options, timeZone: zone, hourCycle: "h23" }).format(
    at,
  );
}

export const clock = (at: Date, zone?: string) =>
  zone ? formatDate(at, zone, { hour: "2-digit", minute: "2-digit" }) : "";
export const dayHeading = (at: Date, zone: string) =>
  formatDate(at, zone, { weekday: "short", day: "numeric", month: "short" });
export const zoneName = (zone: string) => (zone.split("/").at(-1) ?? zone).replaceAll("_", " ");

function parts(at: Date, zone: string) {
  const p = new Intl.DateTimeFormat("en-GB", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(at);
  const value = (type: string) => Number(p.find((part) => part.type === type)?.value);
  return { year: value("year"), day: Date.UTC(value("year"), value("month") - 1, value("day")) };
}

export function contextualDate(
  at: Date,
  now: Date,
  zone: string | undefined,
  context: "callback" | "timeline" | "custody" | "checked" | "session",
): string {
  if (!zone) return dayHeading(at, "UTC");
  const a = parts(at, zone);
  const n = parts(now, zone);
  const sameYear = a.year === n.year;
  const days = (a.day - n.day) / 86400000;
  if (context === "session") return `${dayHeading(at, zone)}, ${clock(at, zone)}`;
  if (context === "custody")
    return formatDate(
      at,
      zone,
      sameYear
        ? { weekday: "short", day: "numeric", month: "short" }
        : { day: "numeric", month: "short", year: "numeric" },
    );
  if (days === 0) return clock(at, zone);
  if (context === "checked" || (context === "callback" && days > 0 && days <= 6))
    return `${formatDate(at, zone, { weekday: "short" })} ${clock(at, zone)}`;
  return `${formatDate(at, zone, { day: "numeric", month: "short", ...(sameYear ? {} : { year: "numeric" }) })}, ${clock(at, zone)}`;
}

export function overdue(at: Date, now: Date, zone: string | undefined): string {
  const minutes = Math.max(0, Math.floor((now.getTime() - at.getTime()) / 60000));
  if (minutes < 60) return `${String(minutes)} min`;
  if (minutes < 1440) return `${String(Math.floor(minutes / 60))} h ${String(minutes % 60)} min`;
  const date =
    minutes < 10080
      ? `${formatDate(at, zone ?? "UTC", { weekday: "short" })}${zone ? ` ${clock(at, zone)}` : ""}`
      : contextualDate(at, now, zone, "timeline");
  return `Since ${date}`;
}

export function nextMidnight(now: Date, zone: string): Date {
  const today = parts(now, zone).day;
  let low = now.getTime();
  let high = low + 27 * 3600000;
  while (high - low > 1) {
    const mid = Math.floor((low + high) / 2);
    if (parts(new Date(mid), zone).day === today) low = mid;
    else high = mid;
  }
  return new Date(high);
}

export function nextQueueRefresh(now: Date, zone: string, callback: Date | null): number {
  return Math.max(
    1,
    Math.min(
      nextMidnight(now, zone).getTime(),
      callback && callback > now ? callback.getTime() + 1 : Infinity,
    ) - now.getTime(),
  );
}
