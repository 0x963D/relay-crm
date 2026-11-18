import { test, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { evidenceDirectory } from "./browser/paths.ts";

test("documentation checks resolve relative links and count README bytes", () => {
  mkdirSync(evidenceDirectory, { recursive: true });
  const root = mkdtempSync(join(evidenceDirectory, "docs-check-"));
  mkdirSync(join(root, "docs"));
  writeFileSync(join(root, "docs", "image.png"), "fixture");
  const valid =
    '# Product\n[Guide](docs/guide.md#run-it)\n<picture><source srcset="docs/image.png"><img src="docs/image.png"></picture>\n';
  try {
    for (const [readme, guide, expected] of [
      [valid, "# Guide\n## Run it\n[Home](../README.md#product)", ""],
      ["[Missing](docs/missing.md)", "# Guide", "missing.md"],
      [valid, "# Guide\n## Run it\n[Missing](missing.md)", "missing.md"],
      [
        valid.replace('srcset="docs/image.png"', 'srcset="docs/missing.png"'),
        "# Guide\n## Run it",
        "missing.png",
      ],
      [valid.replace("#run-it", "#missing"), "# Guide\n## Run it", "#missing"],
      ["é".repeat(4001), "# Guide", "8000 bytes"],
    ] as const) {
      writeFileSync(join(root, "README.md"), readme);
      writeFileSync(join(root, "docs", "guide.md"), guide);
      const result = spawnSync(process.execPath, ["scripts/check-docs.mjs", root], {
        encoding: "utf8",
      });
      expect.soft(result.status, result.stderr).toBe(expected ? 1 : 0);
      if (expected) expect.soft(result.stderr).toContain(expected);
    }
  } finally {
    rmSync(root, { recursive: true });
  }
});

test("the mobile guide names the environment variable read by the app", () => {
  mkdirSync(evidenceDirectory, { recursive: true });
  const root = mkdtempSync(join(evidenceDirectory, "docs-check-"));
  try {
    const source = join(root, "apps", "mobile", "src", "api");
    mkdirSync(source, { recursive: true });
    mkdirSync(join(root, "docs"));
    writeFileSync(join(root, "README.md"), "# Product");
    writeFileSync(join(source, "server.ts"), "const origin = process.env.EXPO_PUBLIC_NEW_ORIGIN;");
    for (const [name, status] of [
      ["EXPO_PUBLIC_OLD_ORIGIN", 1],
      ["EXPO_PUBLIC_NEW_ORIGIN", 0],
    ] as const) {
      writeFileSync(join(root, "docs", "mobile.md"), `Set \`${name}\` to the server's origin.`);
      const result = spawnSync(process.execPath, ["scripts/check-docs.mjs", root], {
        encoding: "utf8",
      });
      expect.soft(result.status, result.stderr).toBe(status);
      if (status === 1) expect.soft(result.stderr).toContain("EXPO_PUBLIC_NEW_ORIGIN");
    }
  } finally {
    rmSync(root, { recursive: true });
  }
});
