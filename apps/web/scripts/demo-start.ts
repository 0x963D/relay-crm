import "../src/server/connection-context.ts";
import { applyDemoConfiguration } from "../src/server/env-file.ts";

await applyDemoConfiguration("/run/relay-secrets/app/config.json");
await import(new URL("../server.js", import.meta.url).href);
