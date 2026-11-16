import { z } from "zod";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFile, unlink } from "node:fs/promises";
import { promisify } from "node:util";

const execute = promisify(execFile);
const tag = `relay-image-check-${randomUUID()}:local`;
const canary = "apps/web/.env.local";
await writeFile(canary, "FAKE_RELAY_IMAGE_CANARY=not-a-real-secret\n", { flag: "wx", mode: 0o600 });
let built = false;
try {
  const build = await execute("docker", ["build", "--tag", tag, "."], {
    maxBuffer: 20 * 1024 * 1024,
  });
  process.stdout.write(build.stdout + build.stderr);
  built = true;
  const metadata = await execute("docker", ["image", "inspect", tag, "--format", "{{.Size}}"]);
  process.stdout.write(`IMAGE.bytes ${metadata.stdout.trim()}\n`);
  const inspected = await execute("docker", [
    "run",
    "--rm",
    "--entrypoint",
    "node",
    tag,
    "-e",
    "process.stdout.write(String(require('node:fs').existsSync('/app/apps/web/.env.local')))",
  ]);
  assert.equal(inspected.stdout, "false", "The image contains the nested environment canary.");
  const rawRuntime: unknown = JSON.parse(
    (await execute("docker", ["image", "inspect", tag, "--format", "{{json .Config}}"])).stdout,
  );
  const runtime = z
    .object({ User: z.string().default(""), Env: z.array(z.string()) })
    .parse(rawRuntime);
  assert.equal(runtime.User, "node", "The runtime image must run as a non-root user.");
  assert(
    runtime.Env.includes("NEXT_TELEMETRY_DISABLED=1"),
    "Framework telemetry must be disabled at runtime.",
  );
  const standalone = await execute("docker", [
    "run",
    "--rm",
    "--entrypoint",
    "node",
    tag,
    "-e",
    "process.stdout.write(String(require('node:fs').existsSync('/app/apps/web/server.js')))",
  ]);
  assert.equal(standalone.stdout, "true", "The runtime must contain the standalone server.");
} finally {
  await unlink(canary);
  if (built) await execute("docker", ["image", "rm", tag]);
}
