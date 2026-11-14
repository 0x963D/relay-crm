import type { Brand } from "./ids.ts";

/** The normalized address that identifies a person. */
export type EmailKey = Brand<string, "EmailKey">;

export interface Email {
  /** What the person typed, trimmed. This is the address mail goes to. */
  readonly asTyped: string;
  readonly key: EmailKey;
}

const MAX_ADDRESS = 254;
const MAX_LOCAL_PART = 64;
const MAX_DOMAIN = 253;
const MAX_LABEL = 63;

// Whitespace, separators, control and format characters, and the quote of a quoted local part.
const FORBIDDEN = /[\s\p{Z}\p{C}"]/u;

/**
 * Lowercase first, then NFC. Lowercasing can leave a pair that NFC composes ("J" with a combining
 * caron becomes "j" with one, which composes to U+01F0), so the other order is not stable.
 */
function normalize(address: string): string {
  return address.toLowerCase().normalize("NFC");
}

/** Deliberately narrower than RFC 5322: one "@", no quoted local part, a domain with a dot. */
function hasAddressShape(address: string): boolean {
  if (address.length > MAX_ADDRESS || FORBIDDEN.test(address)) return false;
  const parts = address.split("@");
  if (parts.length !== 2) return false;
  const [localPart = "", domain = ""] = parts;
  if (localPart.length === 0 || localPart.length > MAX_LOCAL_PART) return false;
  if (domain.length > MAX_DOMAIN) return false;
  const labels = domain.split(".");
  return (
    labels.length >= 2 && labels.every((label) => label.length >= 1 && label.length <= MAX_LABEL)
  );
}

/** A key is an address that normalization leaves unchanged. Rows read back from storage use this. */
export function isEmailKey(value: string): value is EmailKey {
  return normalize(value) === value && hasAddressShape(value);
}

/**
 * The identity rule, in one place. It is conservative on purpose, so Gmail dots and plus tags
 * stay significant. Splitting one person into two leads is repaired by marking a duplicate, and
 * merging two people into one lead cannot be undone.
 */
export function parseEmail(input: string): Email | null {
  const asTyped = input.trim();
  const key = normalize(asTyped);
  return hasAddressShape(asTyped) && isEmailKey(key) ? { asTyped, key } : null;
}
