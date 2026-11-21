import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, test } from "vitest";

test("running the migrate script runs prisma migrate deploy", { timeout: 30_000 }, async () => {
  const script = fileURLToPath(new URL("../src/migrate.ts", import.meta.url));
  const run = promisify(execFile)(process.execPath, [script], { env: {} });
  await expect(run).rejects.toThrow("when using prisma migrate deploy");
});
