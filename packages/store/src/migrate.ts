import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const cli = createRequire(import.meta.url).resolve("prisma/build/index.js");
const cwd = fileURLToPath(new URL("../", import.meta.url));
const execute = promisify(execFile);

export async function deployMigrations(env?: NodeJS.ProcessEnv) {
  const { stdout } = await execute(process.execPath, [cli, "migrate", "deploy"], {
    cwd,
    ...(env && { env }),
  });
  process.stdout.write(stdout);
}

if (import.meta.main) await deployMigrations();
