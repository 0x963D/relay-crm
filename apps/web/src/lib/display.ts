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
    const rendered = formatter.format(candidate).replace(" ", "T");
    const difference = target.getTime() - new Date(`${rendered}Z`).getTime();
    if (difference === 0) return candidate;
    candidate = new Date(candidate.getTime() + difference);
  }
  return null;
}

export function custodyDate(at: Date | null, zone: string, held = false): string | undefined {
  if (!at) return undefined;
  return held
    ? `since ${new Intl.DateTimeFormat("en-GB", { weekday: "short", timeZone: zone }).format(at)}`
    : new Intl.DateTimeFormat("en-GB", {
        weekday: "short",
        day: "numeric",
        month: "short",
        timeZone: zone,
      }).format(at);
}
import { CURRENCIES, type Money } from "@relay/domain";

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
