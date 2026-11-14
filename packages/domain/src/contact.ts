const MAX_NAME = 200;
const MAX_PHONE = 40;

/**
 * Collapses each run of whitespace or control characters to one space, trims, and clips to
 * `maxLength` characters. Empty text is null. Control characters go because PostgreSQL refuses a
 * NUL in text, and one bad character must not make a submission impossible to store.
 */
export function tidyText(input: string | null | undefined, maxLength: number): string | null {
  const collapsed = (input ?? "").replace(/[\s\p{Cc}]+/gu, " ").trim();
  const clipped = Array.from(collapsed).slice(0, maxLength).join("").trimEnd();
  return clipped === "" ? null : clipped;
}

export function normalizeName(input: string | null | undefined): string | null {
  return tidyText(input, MAX_NAME);
}

/** Phone is contact data, never identity, so it is tidied and not parsed. It never fails. */
export function normalizePhone(input: string | null | undefined): string | null {
  return tidyText(input, MAX_PHONE);
}
