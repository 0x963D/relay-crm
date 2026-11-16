import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { expect, test } from "vitest";
import { commandEnvironment } from "../src/server/env.ts";

const execute = promisify(execFile);
const root = fileURLToPath(new URL("../../..", import.meta.url));
const Configuration = z.object({
  name: z.string(),
  services: z.object({
    app: z.object({ image: z.string(), ports: z.array(z.object({ published: z.string() })) }),
    mail: z.object({
      ports: z.array(z.object({ published: z.string() })),
      environment: z.record(z.string(), z.string()),
    }),
  }),
});
test.each(["relay-check-a", "relay-check-b"])(
  "Compose isolates images and ports for %s",
  async (project) => {
    const result = await execute("docker", ["compose", "config", "--format", "json"], {
      cwd: root,
      env: commandEnvironment({
        COMPOSE_PROJECT_NAME: project,
        RELAY_HTTP_PORT: "35107",
        RELAY_INBOX_PORT: "38127",
      }),
    });
    const raw: unknown = JSON.parse(result.stdout);
    const config = Configuration.parse(raw);
    expect(config.name).toBe(project);
    expect(config.services.app.image).toBe(`${project}-app:local`);
    expect(config.services.app.ports[0]?.published).toBe("35107");
    expect(config.services.mail.ports[0]?.published).toBe("38127");
    expect(config.services.mail.environment.MP_MAX_MESSAGES).toBe("0");
  },
);
