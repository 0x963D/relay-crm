import { describe, expect, it } from "vitest";
import { EnvError, parseEnv } from "../src/server/env.ts";

const DATABASE_URL = "postgresql://relay:relay@localhost:5432/relay";

describe("parseEnv", () => {
  it("reads the database URL", () => {
    expect(parseEnv({ DATABASE_URL })).toEqual({ databaseUrl: DATABASE_URL });
  });

  it.each([
    ["missing", {}],
    ["empty", { DATABASE_URL: "" }],
    ["blank", { DATABASE_URL: "   " }],
  ])("refuses a %s database URL and names the variable", (_label, variables) => {
    expect(() => parseEnv(variables)).toThrow(EnvError);
    expect(() => parseEnv(variables)).toThrow(/DATABASE_URL/);
  });
});
