import type { NextConfig } from "next";
import { PHASE_DEVELOPMENT_SERVER, PHASE_PRODUCTION_SERVER } from "next/constants.js";
import { readEnv } from "./src/server/env.ts";

const config: NextConfig = {
  transpilePackages: ["@relay/domain", "@relay/store"],
  // Keeps `next dev` from writing a generated file into the repository.
  agentRules: false,
  // requireActor answers a request with no session through unauthorized(), which needs this.
  experimental: { authInterrupts: true },
};

export default function configuration(phase: string): NextConfig {
  if (phase === PHASE_PRODUCTION_SERVER) readEnv(false);
  return {
    ...config,
    env: { RELAY_DEVELOPMENT_BUILD: String(phase === PHASE_DEVELOPMENT_SERVER) },
  };
}
