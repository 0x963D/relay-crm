import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runInThisContext } from "node:vm";
import { transformSync } from "@babel/core";
import { expect, test } from "vitest";

function expression(source: string): RegExp {
  const value: unknown = runInThisContext(`(() => { return ${source}; })()`);
  if (!(value instanceof RegExp))
    throw new Error("The validator must compile to a regular expression.");
  return value;
}

test("the mobile compiler preserves the shared hostname rule using Hermes-compatible flags", () => {
  const filename = fileURLToPath(new URL("../../../packages/domain/src/email.ts", import.meta.url));
  const source = readFileSync(filename, "utf8");
  const literal = /const NOT_HOSTNAME_TEXT\s*=\s*(\/.+\/v);/.exec(source)?.[1];
  if (!literal) throw new Error("The hostname validator was not found.");
  const result = transformSync(`const pattern = ${literal};`, {
    filename,
    configFile: fileURLToPath(new URL("../babel.config.json", import.meta.url)),
    babelrc: false,
  });
  if (!result?.code) throw new Error("The mobile Babel configuration emitted no code.");
  const compiled: unknown = runInThisContext(`(() => { ${result.code}; return pattern; })()`);
  if (!(compiled instanceof RegExp)) throw new Error("The mobile compiler emitted no pattern.");
  expect(compiled.flags).not.toContain("v");
  const original = expression(literal);
  const characters = [
    ...Array.from({ length: 128 }, (_, point) => String.fromCodePoint(point)),
    "é",
    "ü",
    "例",
    "。",
    "｡",
    "\u200B",
    "\u200D",
    "\u00AD",
    "\u0301",
    "\uFEFF",
    "😀",
  ];
  for (const character of characters)
    expect(compiled.test(character), JSON.stringify(character)).toBe(original.test(character));
});
