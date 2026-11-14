import { describe, expect, it } from "vitest";
import { isEmailKey, parseEmail } from "../src/index.ts";

const ACCEPTED: readonly (readonly [label: string, input: string, key: string])[] = [
  ["a plain address", "ana@example.com", "ana@example.com"],
  ["mixed case", "Ana.Silva@Example.COM", "ana.silva@example.com"],
  ["surrounding whitespace", "  ana@example.com\n", "ana@example.com"],
  ["a plus tag, which stays", "ana+crm@example.com", "ana+crm@example.com"],
  ["Gmail dots, which stay", "a.n.a@gmail.com", "a.n.a@gmail.com"],
  ["a subdomain", "ana@mail.example.co.uk", "ana@mail.example.co.uk"],
  ["a non-ASCII local part", "JOSÉ@example.com", "josé@example.com"],
  ["a decomposed accent", "jose\u0301@example.com", "jos\u00e9@example.com"],
  ["an internationalized domain", "ana@BÜCHER.example", "ana@bücher.example"],
  ["a letter that only composes once lowercased", "J\u030Can@example.com", "\u01F0an@example.com"],
  ["a capital dotted I", "\u0130lker@example.com", "i\u0307lker@example.com"],
  ["a final sigma", "ΟΔΟΣ@example.gr", "οδος@example.gr"],
];

describe("parseEmail", () => {
  it.each(ACCEPTED)("accepts %s", (_label, input, key) => {
    expect(parseEmail(input)).toEqual({ asTyped: input.trim(), key });
  });

  it.each(ACCEPTED)("produces a key that parses to itself for %s", (_label, input) => {
    const email = parseEmail(input);
    expect(email).not.toBeNull();
    if (email === null) return;
    expect(isEmailKey(email.key)).toBe(true);
    expect(parseEmail(email.key)).toEqual({ asTyped: email.key, key: email.key });
  });

  it.each([
    ["an empty string", ""],
    ["only whitespace", "   "],
    ["no at sign", "ana.example.com"],
    ["two at signs", "ana@home@example.com"],
    ["an empty local part", "@example.com"],
    ["an empty domain", "ana@"],
    ["a domain without a dot", "ana@localhost"],
    ["a leading empty label", "ana@.example.com"],
    ["a doubled dot in the domain", "ana@example..com"],
    ["a trailing dot on the domain", "ana@example.com."],
    ["inner whitespace", "ana silva@example.com"],
    ["a non-breaking space", "ana\u00a0silva@example.com"],
    ["a zero-width space", "ana\u200b@example.com"],
    ["a NUL character", "ana\u0000@example.com"],
    ["a quoted local part", '"ana"@example.com'],
    ["a display name", "Ana <ana@example.com>"],
    ["a local part longer than 64 characters", `${"a".repeat(65)}@example.com`],
    ["a label longer than 63 characters", `ana@${"a".repeat(64)}.com`],
    ["an address longer than 254 characters", `ana@${"a.".repeat(125)}com`],
  ])("refuses %s", (_label, input) => {
    expect(parseEmail(input)).toBeNull();
  });
});

describe("isEmailKey", () => {
  it.each([
    ["an uppercase letter", "Ana@example.com"],
    ["a decomposed accent", "jose\u0301@example.com"],
    ["something that is not an address", "ana"],
  ])("refuses a key with %s", (_label, value) => {
    expect(isEmailKey(value)).toBe(false);
  });
});
