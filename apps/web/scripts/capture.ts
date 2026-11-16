import { spawn } from "node:child_process";
import { copyFile } from "node:fs/promises";
import { join } from "node:path";
import { createRequire } from "node:module";
import { commandEnvironment } from "../src/server/env.ts";
import { browserDirectory } from "../test/browser/paths.ts";
const cli = createRequire(import.meta.url).resolve("@playwright/test/cli");
const readme = process.argv.includes("--readme");
const files = readme ? ["readme"] : ["captures", "payments"];
for (const file of files) {
  const code = await new Promise<number>((accept, reject) => {
    const child = spawn(
      process.execPath,
      [
        cli,
        "test",
        `apps/web/test/browser/${file}.spec.ts`,
        "--grep",
        readme ? "@readme" : "@capture",
      ],
      {
        stdio: "inherit",
        env: commandEnvironment({ RELAY_CAPTURE_DAY: "2026-11-16T14:00:00.000Z" }),
      },
    );
    child.on("error", reject);
    child.on("exit", (code) => {
      accept(code ?? 1);
    });
  });
  await copyFile(
    join(browserDirectory, "results.json"),
    join(browserDirectory, `results-${file}.json`),
  );
  if (code !== 0) {
    process.exitCode = code;
    break;
  }
}
