import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { expect, it } from "vitest";

const app = fileURLToPath(new URL("../src/app", import.meta.url));
function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(join(directory, entry.name)) : [join(directory, entry.name)],
  );
}
it("owns the session gate once in the root layout and declares a modal sign-in route", () => {
  const owners: string[] = [];
  for (const file of files(app).filter((file) => file.endsWith(".tsx"))) {
    const parsed = ts.createSourceFile(
      file,
      readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    function visit(node: ts.Node) {
      if (ts.isJsxOpeningElement(node) && node.tagName.getText(parsed) === "SessionGate")
        owners.push(file);
      ts.forEachChild(node, visit);
    }
    visit(parsed);
  }
  expect(owners).toEqual([join(app, "_layout.tsx")]);
  expect(readFileSync(join(app, "_layout.tsx"), "utf8")).toContain('presentation: "modal"');
});
it("reads only the id from a lead route", () => {
  const source = readFileSync(join(app, "lead", "[id].tsx"), "utf8");
  const parsed = ts.createSourceFile("route.tsx", source, ts.ScriptTarget.Latest, true);
  const parameters: string[] = [];
  function visit(node: ts.Node) {
    if (
      ts.isVariableDeclaration(node) &&
      node.initializer &&
      ts.isCallExpression(node.initializer) &&
      node.initializer.expression.getText(parsed) === "useLocalSearchParams" &&
      ts.isObjectBindingPattern(node.name)
    ) {
      parameters.push(...node.name.elements.map((element) => element.name.getText(parsed)));
    }
    ts.forEachChild(node, visit);
  }
  visit(parsed);
  expect(parameters).toEqual(["id"]);
});
