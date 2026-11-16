import { CURRENCIES, type Money } from "@relay/domain";

export function shortDate(at: Date | null, zone: string): string {
  return at
    ? new Intl.DateTimeFormat("en-GB", {
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
        timeZone: zone,
      }).format(at)
    : "Unknown";
}
export function dayLabel(at: Date, zone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: zone,
  }).format(at);
}
export const sources = {
  metaLeadAds: "Meta Lead Ads",
  webForm: "Web form",
  csv: "CSV import",
  manual: "Manual entry",
};
export function sourceLabel(source: keyof typeof sources | null | undefined): string {
  return source ? sources[source] : "Unknown source";
}
export function campaignLabel(campaign: string | null | undefined): string {
  return campaign?.split(" · ")[0] ?? "No campaign";
}
export function localCallback(value: string, timeZone: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null;
  const target = new Date(`${value}:00Z`);
  if (!Number.isFinite(target.getTime())) return null;
  const formatter = new Intl.DateTimeFormat("sv-SE", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  let candidate = target;
  for (let n = 0; n < 3; n++) {
    const parts = formatter.formatToParts(candidate);
    const part = (type: Intl.DateTimeFormatPartTypes, width = 2) =>
      (parts.find((item) => item.type === type)?.value ?? "").padStart(width, "0");
    const rendered = `${part("year", 4)}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}:${part("second")}`;
    const difference = target.getTime() - new Date(`${rendered}Z`).getTime();
    if (!Number.isFinite(difference)) return null;
    if (difference === 0) return candidate;
    candidate = new Date(candidate.getTime() + difference);
  }
  return null;
}

function calendarDay(at: Date, zone: string): number {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(at);
  const part = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return Date.UTC(part("year"), part("month") - 1, part("day")) / 86400000;
}
export function callbackDate(at: Date | null, zone: string, now = new Date()): string {
  if (!at) return "Unknown";
  const days = calendarDay(at, zone) - calendarDay(now, zone);
  return new Intl.DateTimeFormat("en-GB", {
    ...(days === 0
      ? {}
      : days > 0 && days <= 6
        ? { weekday: "short" as const }
        : { day: "numeric" as const, month: "short" as const }),
    hour: "2-digit",
    minute: "2-digit",
    timeZone: zone,
  }).format(at);
}
export function overdueBy(at: Date, now = new Date()): string {
  const minutes = Math.max(1, Math.floor((now.getTime() - at.getTime()) / 60000));
  return minutes >= 60
    ? `${String(Math.floor(minutes / 60))} h ${String(minutes % 60)} min`
    : `${String(minutes)} min`;
}
export function callbackFields(at: Date, zone: string): { day: string; time: string } {
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  })
    .format(at)
    .split(" ");
  return { day: parts[0] ?? "", time: parts[1] ?? "" };
}
export function custodyDate(
  at: Date | null,
  zone: string,
  held = false,
  now = new Date(),
): string | undefined {
  if (!at) return undefined;
  const old = calendarDay(now, zone) - calendarDay(at, zone) > 6;
  const text = new Intl.DateTimeFormat("en-GB", {
    weekday: "short",
    ...(!held || old ? { day: "numeric" as const, month: "short" as const } : {}),
    timeZone: zone,
  }).format(at);
  return held ? `since ${text}` : text;
}

export function formatMoney(money: Money): string {
  const digits = CURRENCIES[money.currency];
  const magnitude = money.minor < 0n ? -money.minor : money.minor;
  const factor = 10n ** BigInt(digits);
  const fraction = (magnitude % factor).toString().padStart(digits, "0");
  const parts = new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: money.currency,
  }).formatToParts(magnitude / factor);
  return (
    (money.minor < 0n ? "−" : "") +
    parts.map((part) => (part.type === "fraction" ? fraction : part.value)).join("")
  );
}
export function overdueLabel(at: Date, zone: string, now = new Date()): string {
  if (now.getTime() - at.getTime() < 86400000) return `Overdue ${overdueBy(at, now)}`;
  const when = new Intl.DateTimeFormat("en-GB", {
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: zone,
  }).format(at);
  return `Overdue since ${when}`;
}
