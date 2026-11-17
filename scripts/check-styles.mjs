import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

const root = process.argv[2] ?? "apps/web/src";
const allow = JSON.parse(readFileSync("scripts/style-allowlist.json", "utf8"));
const violations = [];
for (const entry of allow)
  if (!existsSync(entry.file)) violations.push(`${entry.file}: stale style exception`);
const counts = {
  arbitraryValues: 0,
  classCoupling: 0,
  numericWeights: 0,
  inlineLiterals: 0,
  defaultTheme: 0,
  inlineStyles: 0,
  cssLiterals: 0,
};

for (const file of readdirSync(root, { recursive: true }).filter((file) =>
  /\.(tsx?|css)$/.test(file),
)) {
  const path = relative(".", join(root, file)).replaceAll("\\", "/");
  const source = readFileSync(join(root, file), "utf8");
  if (source.includes("\uFFFD")) violations.push(`${path}: invalid UTF-8 replacement character`);
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
  for (const match of source.matchAll(/\[[\w-]+:[^\]\r\n]+\](?!:)/g))
    report("arbitraryValues", match[0], match.index);
  for (const match of source.matchAll(
    /(?<![\w-])(?:bg|text|border(?:-[xysetblr])?|ring(?:-offset)?|outline|fill|stroke|decoration|accent|caret|from|via|to|divide|shadow)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-(?:50|[1-9]00|950)(?![\w-])|(?<![\w-])(?:bg|text|border|ring|outline|fill|stroke|from|via|to)-(?:black|white)(?![\w-])|(?<![\w-])(?:inset-|drop-)?shadow(?:-(?:2xs|xs|sm|md|lg|xl|2xl))?(?![\w-])/g,
  ))
    report("defaultTheme", match[0], match.index);
  for (const match of source.matchAll(
    /\[(?:[^\]\r\n]|\[[^\]\r\n]*\])*\.[a-zA-Z_-][^\]\r\n]*\](?=:)/g,
  ))
    report("classCoupling", match[0], match.index);
  for (const match of source.matchAll(
    /(?:font-\[(?:number:)?_?\d+\]|\[font-weight:_?\d+\]|(?<![\w-])(?:font-weight|fontWeight)\s*:\s*["']?_?(?:\d+|bold\b|bolder\b|lighter\b))/g,
  ))
    report("numericWeights", match[0], match.index);

  for (const match of source.matchAll(
    /(?<![\w-])font-(thin|extralight|light|normal|medium|semibold|bold|extrabold|black)(?![\w-])/g,
  ))
    if (!["normal", "medium", "semibold", "bold"].includes(match[1]))
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
  if (file.endsWith(".css")) {
    checkCss(source, 0);
    const blocks = [];
    for (const match of source
      .replace(/\/\*[\s\S]*?\*\//g, (value) => " ".repeat(value.length))
      .matchAll(/([^{};]*)([{};])/g)) {
      const text = match[1].trim();
      if (match[2] === "{") blocks.push(text);
      else {
        const declaration = /^([\w-]+)\s*:\s*([\s\S]+)$/.exec(text);
        if (declaration) {
          const [, property, value] = declaration;
          const token =
            path === "apps/web/src/app/globals.css" &&
            property.startsWith("--") &&
            blocks.some((block) => block === ":root" || block.startsWith("@theme"));
          const resolved = value.replace(/var\(--[\w-]+\)/g, "");
          const namedColour =
            /(?:color$|^background$|^fill$|^stroke$)/.test(property) &&
            resolved.trim() !== "" &&
            !/^(?:inherit|initial|unset|revert|currentColor|transparent|none|Canvas|CanvasText)$/i.test(
              resolved.trim(),
            );
          const colour =
            namedColour ||
            /#(?:[\da-f]{3,8})\b|\b(?:rgb|hsl|oklch|oklab|lab|lch|color)\(/i.test(resolved) ||
            (/^(?:color|background(?:-color)?|border(?:-[\w]+)?|fill|stroke|outline(?:-color)?)$/.test(
              property,
            ) &&
              /\b(?:red|blue|green|black|white|yellow|gray|grey|pink|orange|purple|rebeccapurple)\b/i.test(
                resolved,
              ));
          const size = /(?:\d*\.)?\d+(?:px|r?em|[dsl]?v[wh]|ch|ex|pt|cm|mm|in|%)\b|\d+%/i.test(
            resolved,
          );
          if (!token && (colour || size)) report("cssLiterals", text, match.index);
        }
        if (match[2] === "}") blocks.pop();
      }
    }
  } else {
    const tree = ts.createSourceFile(
      file,
      source,
      ts.ScriptTarget.Latest,
      true,
      file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const sizing =
      /^(?:width|height|minWidth|maxWidth|minHeight|maxHeight|padding\w*|margin\w*|gap|rowGap|columnGap|top|right|bottom|left|inset\w*|fontSize|lineHeight|borderRadius|borderWidth|color|background\w*|borderColor|fill|stroke|fontWeight|boxShadow|opacity)$/;
    function visit(node) {
      if (ts.isJsxAttribute(node) && node.name.getText(tree) === "style") {
        let expression =
          node.initializer && ts.isJsxExpression(node.initializer)
            ? node.initializer.expression
            : undefined;
        while (
          expression &&
          (ts.isAsExpression(expression) ||
            ts.isSatisfiesExpression(expression) ||
            ts.isParenthesizedExpression(expression))
        )
          expression = expression.expression;
        if (!expression || !ts.isObjectLiteralExpression(expression))
          report("inlineStyles", node.getText(tree), node.pos);
        else
          for (const property of expression.properties) {
            const name =
              ts.isPropertyAssignment(property) && !ts.isComputedPropertyName(property.name)
                ? property.name.getText(tree).replace(/["']/g, "")
                : null;
            if (
              !name ||
              !allow.some((entry) => entry.file === path && entry.property === name && entry.reason)
            )
              report("inlineStyles", property.getText(tree), property.pos);
          }
      }
      const key =
        ts.isPropertyAssignment(node) && ts.isComputedPropertyName(node.name)
          ? node.name.expression
          : null;
      let inStyle = false;
      for (let parent = node.parent; parent; parent = parent.parent)
        if (ts.isJsxAttribute(parent) && parent.name.getText(tree) === "style") inStyle = true;
      if (
        ts.isPropertyAssignment(node) &&
        ((key && inStyle) ||
          sizing.test(
            key && ts.isStringLiteralLike(key)
              ? key.text
              : node.name.getText(tree).replace(/["']/g, ""),
          ))
      ) {
        const value = node.initializer;
        if (
          (key && inStyle) ||
          ts.isNumericLiteral(value) ||
          ts.isPrefixUnaryExpression(value) ||
          ts.isTemplateExpression(value) ||
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
      /(?:width|height|padding|margin|gap|font-size|color|background|border|box-shadow|opacity)[\w-]*\s*:\s*(?:\d|#|rgb|hsl)/.test(
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
