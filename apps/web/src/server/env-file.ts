import { readFile } from "node:fs/promises";

export async function applyDemoConfiguration(file: string) {
  const value: unknown = JSON.parse(await readFile(file, "utf8"));
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid demo configuration.");
  const variables: Record<string, string> = {};
  for (const [name, variable] of Object.entries(value)) {
    if (typeof variable !== "string") throw new Error("Invalid demo configuration value.");
    variables[name] = variable;
  }
  Object.assign(process.env, variables);
}
