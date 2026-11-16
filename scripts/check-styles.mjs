import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
const root = "apps/web/src";
const allow = JSON.parse(readFileSync("scripts/style-allowlist.json", "utf8"));
const violations = [];
const counts = { arbitrary: 0, arbitraryPixels: 0, parentKeyed: 0, numericWeights: 0 };
for (const file of readdirSync(root, { recursive: true }).filter((file) =>
  /\.(tsx|css)$/.test(file),
)) {
  const source = readFileSync(join(root, file), "utf8");
  counts.arbitrary += (source.match(/\[[^\]\r\n]*\]/g) ?? []).length;
  const checks = {
    arbitraryPixels: /[^\s"'\x60]*\[[^\]\r\n]*\d(?:\.\d+)?px[^\]\r\n]*\][^\s"'\x60]*/g,
    parentKeyed:
      /\[\.[^\]\r\n]*&[^\]\r\n]*\]|(?:group|peer)-\[\.[^\]]+\]|\.[\w-]+[^{};]*\s+\.[\w-]+[^{};]*\{/g,
    numericWeights: /font-\[\d+\]|\[font-weight:\d+\]|font-weight:\s*\d+|fontWeight:\s*\d+/g,
  };
  for (const [kind, expression] of Object.entries(checks)) {
    for (const match of source.matchAll(expression)) {
      counts[kind]++;
      const path = relative(".", join(root, file)).replaceAll("\\", "/");
      if (!allow.some((entry) => entry.file === path && entry.value === match[0] && entry.reason))
        violations.push(
          `${path}:${source.slice(0, match.index).split("\n").length}: ${kind} ${match[0]}`,
        );
    }
  }
}
console.log(JSON.stringify(counts));
if (violations.length) {
  console.error(violations.join("\n"));
  process.exitCode = 1;
}
