import { PHASE_PRODUCTION_BUILD } from "next/constants.js";
import { expect, it, vi } from "vitest";

const { default: configuration } = await vi.importActual<{
  default: (phase: string) => { readonly output?: string };
}>("../next.config.ts");

it.each([
  [undefined, "standalone"],
  ["1", undefined],
])("chooses build output with VERCEL=%s", (flag, output) => {
  vi.stubEnv("VERCEL", flag);
  try {
    expect(configuration(PHASE_PRODUCTION_BUILD).output).toBe(output);
  } finally {
    vi.unstubAllEnvs();
  }
});
