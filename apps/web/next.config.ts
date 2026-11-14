import type { NextConfig } from "next";

const config: NextConfig = {
  // The workspace packages ship TypeScript source, so Next compiles them with the app.
  transpilePackages: ["@relay/domain", "@relay/store"],
  // Keeps `next dev` from writing a generated file into the repository.
  agentRules: false,
  // requireActor answers a request with no session through unauthorized(), which needs this.
  experimental: { authInterrupts: true },
};

export default config;
