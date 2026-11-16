import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

const root = process.argv[2] ?? "apps/web/src";
const allow = JSON.parse(readFileSync("scripts/style-allowlist.json", "utf8"));
const violations = [];
const counts = { arbitraryValues: 0, classCoupling: 0, numericWeights: 0, inlineLiterals: 0 };

for (const file of readdirSync(root, { recursive: true }).filter((file) =>
  /\.(tsx?|css)$/.test(file),
)) {
  const path = relative(".", join(root, file)).replaceAll("\\", "/");
  const source = readFileSync(join(root, file), "utf8");
  function report(kind, value, index) {
    counts[kind]++;
    if (!allow.some((entry) => entry.file === path && entry.value === value && entry.reason))
      violations.push(`${path}:${source.slice(0, index).split("\n").length}: ${kind} ${value}`);
  }
  for (const match of source.matchAll(/([\w-]+)-\[((?:[^[\]\r\n]|\[[^[\]\r\n]*\])*)\](?!:)/g)) {
    const [, utility, value] = match;
    if (/(?:^|-)(?:data|aria|supports)$/.test(utility)) continue;
    if (utility === "transition" && /^[a-z,-]+$/.test(value)) continue;
    if (/^(?:var\(--|--)[\w()-]+\)?$/.test(value)) continue;
    if (value.startsWith("--spacing(var(--")) continue;
    report("arbitraryValues", match[0], match.index);
  }
  for (const match of source.matchAll(
    /\[(?:[^\]\r\n]|\[[^\]\r\n]*\])*\.[a-zA-Z_-][^\]\r\n]*\](?=:)/g,
  ))
    report("classCoupling", match[0], match.index);
  for (const match of source.matchAll(
    /(?:font-\[(?:number:)?_?\d+\]|\[font-weight:_?\d+\]|(?<![\w-])(?:font-weight|fontWeight)\s*:\s*["']?_?\d+)/g,
  ))
    report("numericWeights", match[0], match.index);

  function checkCss(css, offset) {
    for (const match of css.matchAll(/\.[\w-]+[^{}]*\{[^{}]*[&\w.][^{};]*\{/g))
      report("classCoupling", match[0], offset + match.index);
    for (const match of css.matchAll(/(?:^|[{}])\s*([^{}]+)\{/g)) {
      const selector = match[1];
      if (/\.[\w-]+(?:\[[^\]]+\]|:[\w-]+(?:\([^)]*\))?)*\s*(?:[>+~]\s*|\s+)[^,]+/.test(selector))
        report("classCoupling", selector.trim(), offset + match.index);
    }
  }
  if (file.endsWith(".css")) checkCss(source, 0);
  else {
    const tree = ts.createSourceFile(
      file,
      source,
      ts.ScriptTarget.Latest,
      true,
      file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const sizing =
      /^(?:width|height|minWidth|maxWidth|minHeight|maxHeight|padding\w*|margin\w*|gap|rowGap|columnGap|top|right|bottom|left|inset\w*|fontSize|lineHeight|borderRadius|borderWidth|color|background\w*|borderColor|fill|stroke|fontWeight)$/;
    function visit(node) {
      if (
        ts.isPropertyAssignment(node) &&
        sizing.test(node.name.getText(tree).replace(/["']/g, ""))
      ) {
        const value = node.initializer;
        if (
          ts.isNumericLiteral(value) ||
          (ts.isStringLiteralLike(value) &&
            !/^(?:var\(--|inherit$|currentColor$|transparent$|auto$|none$)/.test(value.text))
        )
          report("inlineLiterals", node.getText(tree), node.pos);
      }
      if (ts.isStringLiteralLike(node) && node.text.includes("{")) checkCss(node.text, node.pos);
      ts.forEachChild(node, visit);
    }
    visit(tree);
  }
  for (const match of source.matchAll(/style=["']([^"']+)["']/g)) {
    if (
      /(?:width|height|padding|margin|gap|font-size|color|background|border)[\w-]*\s*:\s*(?:\d|#|rgb|hsl)/.test(
        match[1],
      )
    )
      report("inlineLiterals", match[0], match.index);
  }
}
console.log(JSON.stringify(counts));
if (violations.length) {
  console.error(violations.join("\n"));
  process.exitCode = 1;
}
