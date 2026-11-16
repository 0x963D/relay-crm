import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { z } from "zod";
export const evidenceDirectory =
  process.env.RELAY_EVIDENCE_DIR ??
  fileURLToPath(new URL("../../../../test-results/evidence/", import.meta.url));
export const browserDirectory = join(evidenceDirectory, "playwright");
export const captureDirectory = join(evidenceDirectory, "built");
export const stateFile = join(browserDirectory, "state.json");
export function browserState() {
  return z
    .object({ url: z.url(), signInUrl: z.url(), inbox: z.string() })
    .parse(JSON.parse(readFileSync(stateFile, "utf8")));
}
