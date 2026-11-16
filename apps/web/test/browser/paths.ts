import { join } from "node:path";
import { tmpdir } from "node:os";
import { readFileSync } from "node:fs";
import { z } from "zod";
export const evidenceDirectory =
  process.platform === "win32"
    ? "test-results/relay-crm-screens"
    : join(tmpdir(), "relay-crm-screens");
export const browserDirectory = join(evidenceDirectory, "playwright");
export const captureDirectory = join(evidenceDirectory, "built");
export const stateFile = join(browserDirectory, "state.json");
export function browserState() {
  return z
    .object({ url: z.url(), signInUrl: z.url(), inbox: z.string() })
    .parse(JSON.parse(readFileSync(stateFile, "utf8")));
}
