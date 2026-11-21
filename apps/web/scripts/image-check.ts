import { z } from "zod";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFile, unlink } from "node:fs/promises";
import { promisify } from "node:util";

const execute = promisify(execFile);
const tag = `relay-image-check-${randomUUID()}:local`;
const maintenanceTag = tag.replace(":local", "-maintenance:local");
const canary = "apps/web/.env.local";
await writeFile(canary, "FAKE_RELAY_IMAGE_CANARY=not-a-real-secret\n", { flag: "wx", mode: 0o600 });
let built = false;
let maintenanceBuilt = false;
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
  const maintenance = await execute(
    "docker",
    ["build", "--target", "maintenance", "--tag", maintenanceTag, "."],
    { maxBuffer: 20 * 1024 * 1024 },
  );
  maintenanceBuilt = true;
  process.stdout.write(maintenance.stdout + maintenance.stderr);
  const user = await execute("docker", [
    "image",
    "inspect",
    maintenanceTag,
    "--format",
    "{{.Config.User}}",
  ]);
  assert.equal(user.stdout.trim(), "node", "Maintenance must run as a non-root user.");

  const config = JSON.stringify({
    RELAY_DEMO: "1",
    DATABASE_URL: "postgresql://relay_app@127.0.0.1:9/relay",
    MIGRATION_DATABASE_URL: "postgresql://relay_owner@127.0.0.1:9/relay",
  });
  const probe = [
    "set -eu",
    "touch -m package.json apps/web/package.json packages/store/package.json packages/domain/package.json",
    "mkdir -p /run/relay-secrets/reset",
    `printf '%s\\n' '${config}' > /run/relay-secrets/reset/config.json`,
    "if runuser -u node -- node --import tsx apps/web/scripts/demo-resetter.ts; then exit 1; fi",
  ].join("\n");
  const offline = await execute("docker", [
    "run",
    "--rm",
    "--network",
    "none",
    "--user",
    "root",
    "--entrypoint",
    "sh",
    maintenanceTag,
    "-c",
    probe,
  ]);
  const output = offline.stdout + offline.stderr;
  assert.match(
    output,
    /P1001/,
    "The offline resetter must get as far as connecting to PostgreSQL.",
  );
  assert.doesNotMatch(
    output,
    /pnpm install|EACCES/,
    "The resetter must use the dependencies built into the image.",
  );
  process.stdout.write(
    "Maintenance reached the database connection with a stale dependency status and no network.\n",
  );
} finally {
  await unlink(canary);
  if (maintenanceBuilt) await execute("docker", ["image", "rm", maintenanceTag]);
  if (built) await execute("docker", ["image", "rm", tag]);
}
