import type { Brand } from "./ids.ts";
import { decodePunycode } from "./punycode.ts";
import { err, ok, type Result } from "./result.ts";

/**
 * The canonical address of a person, one spelling for identity and for delivery. It is a fixed
 * point of `parseEmail`, so the lead that holds it and the mailbox mail goes to cannot part ways.
 */
export type EmailAddress = Brand<string, "EmailAddress">;

export type EmailProblem = "malformed" | "tooLong" | "nonAsciiLocalPart" | "invalidDomain";

// The domain loads no ambient types, so it declares the one global it uses. A module-scoped
// declaration shadows the global in this file only, so it never collides with Node's or the DOM's.
declare const URL: new (input: string) => { readonly hostname: string };

const MAX_ADDRESS = 254;
const MAX_LOCAL_PART = 64;
const MAX_DOMAIN = 253;

const ASCII_ONLY = /^\p{ASCII}*$/u;

/** RFC 5321's dot-atom, which joins runs of atext with single dots. No quoted local part. */
const DOT_ATOM = /^[\w!#$%&'*+/=?^`{|}~-]+(?:\.[\w!#$%&'*+/=?^`{|}~-]+)*$/;

/**
 * What a domain may not hold. Among ASCII characters only letters, digits, "." and "-" pass, so no
 * URL delimiter reaches the parser. No whitespace, control or format character passes, nor an
 * invisible one, which the parser would drop, nor an ideographic full stop, which it reads as a dot.
 */
const NOT_HOSTNAME_TEXT =
  /[[\p{ASCII}--[A-Za-z0-9.\-]]\s\p{C}\p{Default_Ignorable_Code_Point}\u3002\uFF61]/v;

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function foldsToAscii(character: string): boolean {
  return !ASCII_ONLY.test(character) && ASCII_ONLY.test(character.normalize("NFKC"));
}

/** The URL parser also accepts an IPv4 address or a single label, and mail takes neither. */
function isMailDomain(hostname: string): boolean {
  const labels = hostname.split(".");
  return (
    hostname.length <= MAX_DOMAIN &&
    labels.length >= 2 &&
    labels.every((label) => LABEL.test(label)) &&
    /[a-z]/.test(labels.at(-1) ?? "")
  );
}

/**
 * The WHATWG URL parser applies UTS-46 and returns punycode. A lookalike of an ASCII name is
 * refused before it gets there, because the parser would fold it into that name.
 */
function hostnameFromText(domain: string): string | null {
  if (NOT_HOSTNAME_TEXT.test(domain) || Array.from(domain).some(foldsToAscii)) return null;
  try {
    return new URL(`http://${domain}/`).hostname;
  } catch {
    return null;
  }
}

function canonicalDomain(domain: string): string | null {
  const hostname = hostnameFromText(domain);
  if (hostname === null || !isMailDomain(hostname)) return null;
  // Some URL parsers pass ASCII punycode through without checking the text it spells.
  for (const label of hostname.split(".")) {
    if (!label.startsWith("xn--")) continue;
    const decoded = decodePunycode(label.slice(4));
    if (decoded === null || hostnameFromText(decoded) !== label) return null;
  }
  return hostname;
}

function canonicalize(input: string): Result<string, EmailProblem> {
  const address = input.trim();
  if (address.length > MAX_ADDRESS) return err("tooLong");

  const parts = address.split("@");
  const [localPart = "", domain = ""] = parts;
  if (parts.length !== 2 || localPart === "" || domain === "") return err("malformed");
  if (!ASCII_ONLY.test(localPart)) return err("nonAsciiLocalPart");
  if (!DOT_ATOM.test(localPart)) return err("malformed");
  if (localPart.length > MAX_LOCAL_PART) return err("tooLong");

  const hostname = canonicalDomain(domain);
  if (hostname === null) return err("invalidDomain");
  const canonical = `${localPart.toLowerCase()}@${hostname}`;
  return canonical.length > MAX_ADDRESS ? err("tooLong") : ok(canonical);
}

/** True exactly when the value is the canonical address `parseEmail` produces. Rows use this. */
export function isEmailAddress(value: string): value is EmailAddress {
  const canonical = canonicalize(value);
  return canonical.ok && canonical.value === value;
}

/**
 * The identity rule, in one place. It is conservative on purpose, so Gmail dots and plus tags stay
 * significant and only ASCII case folds. Splitting one person into two leads is repaired by
 * marking a duplicate, and merging two people into one lead cannot be undone.
 */
export function parseEmail(input: string): Result<EmailAddress, EmailProblem> {
  const canonical = canonicalize(input);
  if (!canonical.ok) return canonical;
  return isEmailAddress(canonical.value) ? ok(canonical.value) : err("invalidDomain");
}
