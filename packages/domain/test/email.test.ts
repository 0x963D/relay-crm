import { describe, expect, it } from "vitest";
import { err, isEmailAddress, ok, parseEmail, type EmailProblem } from "../src/index.ts";

const ACCEPTED: readonly (readonly [label: string, input: string, canonical: string])[] = [
  ["a plain address", "ana@example.com", "ana@example.com"],
  ["mixed ASCII case", "Ana.Silva@Example.COM", "ana.silva@example.com"],
  ["surrounding whitespace", "  ana@example.com\n", "ana@example.com"],
  ["a plus tag, which stays", "ana+crm@example.com", "ana+crm@example.com"],
  ["Gmail dots, which stay", "a.n.a@gmail.com", "a.n.a@gmail.com"],
  ["a subdomain", "ana@mail.example.co.uk", "ana@mail.example.co.uk"],
  ["every atext symbol", "a!#$%&'*+-/=?^_`{|}~z@example.com", "a!#$%&'*+-/=?^_`{|}~z@example.com"],
  ["a hyphen and digits in the domain", "ana@mail-2.example9.com", "ana@mail-2.example9.com"],
  ["an internationalized domain", "ana@BÜCHER.example", "ana@xn--bcher-kva.example"],
  ["a domain typed as punycode", "ana@XN--BCHER-KVA.example", "ana@xn--bcher-kva.example"],
  ["an internationalized top-level domain", "ana@例え.テスト", "ana@xn--r8jz45g.xn--zckzah"],
  ["a dotless i in the domain", "ana@\u0131.example", "ana@xn--cfa.example"],
  [
    "a local part of 64 characters",
    `${"a".repeat(64)}@example.com`,
    `${"a".repeat(64)}@example.com`,
  ],
  ["a label of 63 characters", `ana@${"a".repeat(63)}.com`, `ana@${"a".repeat(63)}.com`],
];

describe("parseEmail", () => {
  it.each(ACCEPTED)("accepts %s", (_label, input, canonical) => {
    expect(parseEmail(input)).toEqual(ok(canonical));
  });

  it.each(ACCEPTED)("produces an address that parses to itself for %s", (_label, input) => {
    const parsed = parseEmail(input);
    if (!parsed.ok) throw new Error(`Expected ${input} to parse`);
    expect(isEmailAddress(parsed.value)).toBe(true);
    expect(parseEmail(parsed.value)).toEqual(parsed);
  });

  it("merges a mixed-case ASCII address with its lowercase form", () => {
    expect(parseEmail("KIM@Kelvin.Example")).toEqual(parseEmail("kim@kelvin.example"));
  });

  it("keeps a dotted or dotless i in the domain apart from a plain i", () => {
    const plain = parseEmail("ana@i.example");

    expect(parseEmail("ana@\u0131.example")).not.toEqual(plain);
    expect(parseEmail("ana@\u0130.example")).not.toEqual(plain);
  });

  const REFUSED: readonly (readonly [label: string, input: string, problem: EmailProblem])[] = [
    ["an empty string", "", "malformed"],
    ["only whitespace", "   ", "malformed"],
    ["no at sign", "ana.example.com", "malformed"],
    ["two at signs", "ana@home@example.com", "malformed"],
    ["an empty local part", "@example.com", "malformed"],
    ["an empty domain", "ana@", "malformed"],
    ["a leading dot in the local part", ".ana@example.com", "malformed"],
    ["a trailing dot in the local part", "ana.@example.com", "malformed"],
    ["a doubled dot in the local part", "ana..silva@example.com", "malformed"],
    ["inner whitespace", "ana silva@example.com", "malformed"],
    ["a NUL character", "ana\u0000@example.com", "malformed"],
    ["a quoted local part", '"ana"@example.com', "malformed"],
    ["a display name", "Ana <ana@example.com>", "malformed"],
    ["a non-breaking space", "ana\u00A0silva@example.com", "nonAsciiLocalPart"],
    ["a zero-width space", "ana\u200B@example.com", "nonAsciiLocalPart"],
    ["an accented local part", "JOSÉ@example.com", "nonAsciiLocalPart"],
    ["a capital dotted I in the local part", "\u0130lker@example.com", "nonAsciiLocalPart"],
    ["a dotless i in the local part", "\u0131lker@example.com", "nonAsciiLocalPart"],
    ["a Greek local part", "ΟΔΟΣ@example.gr", "nonAsciiLocalPart"],
    ["a domain without a dot", "ana@localhost", "invalidDomain"],
    ["a leading empty label", "ana@.example.com", "invalidDomain"],
    ["a doubled dot in the domain", "ana@example..com", "invalidDomain"],
    ["a trailing dot on the domain", "ana@example.com.", "invalidDomain"],
    ["a label that starts with a hyphen", "ana@-example.com", "invalidDomain"],
    ["a label that ends with a hyphen", "ana@example-.com", "invalidDomain"],
    ["an underscore label", "ana@a_b.com", "invalidDomain"],
    ["an IPv4 address", "ana@127.0.0.1", "invalidDomain"],
    ["a hexadecimal IPv4 address", "ana@0x7f.1", "invalidDomain"],
    ["an IPv6 literal", "ana@[::1]", "invalidDomain"],
    ["a port", "ana@example.com:80", "invalidDomain"],
    ["a path", "ana@example.com/x", "invalidDomain"],
    ["a query", "ana@example.com?x", "invalidDomain"],
    ["a fragment", "ana@example.com#x", "invalidDomain"],
    ["a percent escape", "ana@exa%41mple.com", "invalidDomain"],
    ["a backslash", "ana@example.com\\x", "invalidDomain"],
    ["invalid punycode", "ana@xn--a.com", "invalidDomain"],
    ["punycode with a truncated integer", "ana@xn--zz.com", "invalidDomain"],
    ["punycode for plain ASCII", "ana@xn--a-.com", "invalidDomain"],
    ["punycode for no text", "ana@xn---.com", "invalidDomain"],
    ["punycode for an uppercase non-ASCII letter", "ana@xn--BCHER-2pa.com", "invalidDomain"],
    ["punycode for a fullwidth letter", "ana@xn--xample-hy68a.com", "invalidDomain"],
    ["a soft hyphen in the domain", "ana@ex\u00ADample.com", "invalidDomain"],
    ["a variation selector in the domain", "ana@exa\uFE0Fmple.com", "invalidDomain"],
    ["a Hangul filler in the domain", "ana@ex\u3164ample.com", "invalidDomain"],
    ["an ideographic full stop", "ana@example\u3002com", "invalidDomain"],
    ["a fullwidth letter in the domain", "ana@\uFF45xample.com", "invalidDomain"],
    ["a fullwidth full stop", "ana@example\uFF0Ecom", "invalidDomain"],
    ["a local part longer than 64 characters", `${"a".repeat(65)}@example.com`, "tooLong"],
    ["a label longer than 63 characters", `ana@${"a".repeat(64)}.com`, "invalidDomain"],
    ["an address longer than 254 characters", `ana@${"a.".repeat(125)}com`, "tooLong"],
  ];

  it.each(REFUSED)("refuses %s", (_label, input, problem) => {
    expect(parseEmail(input)).toEqual(err(problem));
  });
});

describe("a lookalike of an ASCII address", () => {
  const PLAIN = "kim@kelvin.example";

  it.each([
    ["the local part", "\u212Aim@kelvin.example", "nonAsciiLocalPart"],
    ["the domain", "kim@\u212Aelvin.example", "invalidDomain"],
  ] as const)("is refused with a Kelvin sign in %s", (_label, input, problem) => {
    expect(parseEmail(input)).toEqual(err(problem));
    expect(isEmailAddress(input)).toBe(false);
    expect(parseEmail(PLAIN)).toEqual(ok(PLAIN));
  });

  it(
    "never folds into an ASCII domain, whichever single character it holds",
    { timeout: 30_000 },
    () => {
      const folded: string[] = [];
      for (let codePoint = 0x80; codePoint <= 0x10ffff; codePoint += 1) {
        if (codePoint >= 0xd800 && codePoint <= 0xdfff) continue;
        const character = String.fromCodePoint(codePoint);
        const parsed = parseEmail(`ana@a${character}b.example`);
        if (parsed.ok && !parsed.value.startsWith("ana@xn--")) folded.push(parsed.value);
      }

      expect(folded).toEqual([]);
    },
  );
});

describe("isEmailAddress", () => {
  it.each([
    ["an uppercase letter", "Ana@example.com"],
    ["surrounding whitespace", " ana@example.com"],
    ["a domain that is not punycode yet", "ana@bücher.example"],
    ["something that is not an address", "ana"],
  ])("refuses a value with %s", (_label, value) => {
    expect(isEmailAddress(value)).toBe(false);
  });
});
