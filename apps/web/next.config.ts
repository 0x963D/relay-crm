import type { NextConfig } from "next";

const config: NextConfig = {
  // The workspace packages ship TypeScript source, so Next compiles them with the app.
  transpilePackages: ["@relay/domain", "@relay/store"],
};

export default config;
