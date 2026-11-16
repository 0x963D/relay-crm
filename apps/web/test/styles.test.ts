import { test, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { evidenceDirectory } from "./browser/paths.ts";

test("the style guard rejects literal values and class-coupled styles in every source format", () => {
  const parent = evidenceDirectory;
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, "style-guard-"));
  const classes = [
    String.fromCharCode(0xfffd),
    "w-[13.5rem]",
    "text-[0.8125rem]",
    "h-[calc(100dvh-3rem)]",
    "max-w-[42ch]",
    "bg-[#123456]",
    "font-[number:600]",
    "[font-weight:_600]",
    "[&_.queue-row]:p-1",
    "in-[.lead-open]:hidden",
    "[width:13px]",
    "[color:#f00]",
    "text-red-500",
    "bg-blue-600",
    "shadow-2xl",
  ];
  try {
    for (const extension of ["ts", "tsx", "css"]) {
      const file = join(root, `fixture.${extension}`);
      for (const value of classes) {
        writeFileSync(
          file,
          extension === "css"
            ? `.fixture { @apply ${value}; }`
            : `export const classes = "${value}";`,
        );
        const result = spawnSync(process.execPath, ["scripts/check-styles.mjs", root], {
          encoding: "utf8",
        });
        expect
          .soft(result.status, `${extension}: ${value}\n${result.stdout}${result.stderr}`)
          .toBe(1);
      }
      writeFileSync(
        file,
        extension === "css"
          ? ".lead-open button { padding: 1rem; }"
          : "export const styles = { width: 222, backgroundColor: '#123456' };",
      );
      const result = spawnSync(process.execPath, ["scripts/check-styles.mjs", root], {
        encoding: "utf8",
      });
      expect
        .soft(result.status, `${extension}: literal styles\n${result.stdout}${result.stderr}`)
        .toBe(1);
      rmSync(file);
    }
  } finally {
    rmSync(root, { recursive: true });
  }
}, 30_000);

test("the style guard rejects computed and template style literals and named font weights", () => {
  mkdirSync(evidenceDirectory, { recursive: true });
  const root = mkdtempSync(join(evidenceDirectory, "style-guard-"));
  try {
    for (const source of [
      'export const View = () => <div style={{ ["width"]: 13 }} />;',
      "export const View = () => <div style={{ [key]: 13 }} />;",
      "export const View = () => <div style={{ width: `13px` }} />;",
      "export const View = () => <div style={{ width: `${13}px` }} />;",
      'export const View = () => <div style={{ boxShadow: "0 1px 2px red" }} />;',
      "export const View = () => <div style={{ opacity: 0.5 }} />;",
      "export const css = `.title{font-weight:bold}`;",
    ]) {
      writeFileSync(join(root, "fixture.tsx"), source);
      const result = spawnSync(process.execPath, ["scripts/check-styles.mjs", root], {
        encoding: "utf8",
      });
      expect.soft(result.status, `${source}\n${result.stdout}${result.stderr}`).toBe(1);
    }
  } finally {
    rmSync(root, { recursive: true });
  }
});
