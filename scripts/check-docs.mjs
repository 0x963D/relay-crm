import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";

const root = resolve(process.argv[2] ?? ".");
const errors = [];
const readme = join(root, "README.md");
if (readFileSync(readme).byteLength > 8000) errors.push("README.md exceeds 8000 bytes");

function documents(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? documents(path) : extname(path) === ".md" ? [path] : [];
  });
}

function prose(path) {
  return readFileSync(path, "utf8").replace(/^(`{3,}|~{3,}).*\r?\n[\s\S]*?^\1[^\n]*$/gm, "");
}

function anchors(path) {
  const seen = new Map();
  const result = new Set();
  for (const [, heading] of prose(path).matchAll(/^#{1,6}\s+(.+)$/gm)) {
    const slug = heading
      .toLowerCase()
      .replace(/<[^>]*>/g, "")
      .replace(/[^\p{L}\p{N}_\s-]/gu, "")
      .trim()
      .replace(/\s/g, "-");
    const count = seen.get(slug) ?? 0;
    seen.set(slug, count + 1);
    result.add(count ? `${slug}-${count}` : slug);
  }
  for (const [, id] of prose(path).matchAll(/\bid=["']([^"']+)["']/g)) result.add(id);
  return result;
}

for (const path of [readme, ...documents(join(root, "docs"))]) {
  const text = prose(path);
  const links = [
    ...[...text.matchAll(/!?\[[^\]]*\]\(<?([^\s>]+)>?(?:\s+["'][^"']*["'])?\)/g)].map(
      (match) => match[1],
    ),
    ...[...text.matchAll(/^\s*\[[^\]]+\]:\s*<?([^\s>]+)>?/gm)].map((match) => match[1]),
    ...[...text.matchAll(/\b(?:href|src|srcset)=["']([^"']+)["']/g)].flatMap((match) =>
      match[1].split(",").map((part) => part.trim().split(/\s/)[0]),
    ),
  ];
  for (const link of links) {
    if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(link)) continue;
    const [file, fragment] = link.split("#");
    const target = file ? resolve(dirname(path), decodeURIComponent(file.split("?")[0])) : path;
    const outside = relative(root, target).startsWith("..");
    if (
      outside ||
      !existsSync(target) ||
      (fragment && extname(target) === ".md" && !anchors(target).has(decodeURIComponent(fragment)))
    ) {
      errors.push(`${relative(root, path)}: unresolved relative link ${link}`);
    }
  }
}
if (errors.length) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
} else console.log("Documentation links resolve; README is within 8000 bytes.");
