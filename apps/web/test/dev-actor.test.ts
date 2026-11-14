import { describe, expect, it } from "vitest";
import { devActor } from "../src/server/dev-actor.ts";
import { parseEnv } from "../src/server/env.ts";

const DATABASE_URL = "postgresql://relay:relay@localhost:5432/relay";
const DEV_USER_ID = "00000000-0000-7000-8000-000000000001";

function actorFor(variables: Readonly<Record<string, string>>) {
  return devActor(parseEnv({ DATABASE_URL, ...variables }));
}

describe("devActor", () => {
  it("acts as the dev user with the agent role, the least a sales user can do", () => {
    expect(actorFor({ NODE_ENV: "development", RELAY_DEV_ACTOR: "1" })).toEqual({
      userId: DEV_USER_ID,
      role: "agent",
      team: null,
    });
  });

  it("takes the role RELAY_DEV_ROLE names", () => {
    expect(
      actorFor({ NODE_ENV: "development", RELAY_DEV_ACTOR: "1", RELAY_DEV_ROLE: "owner" }),
    ).toMatchObject({ role: "owner" });
  });

  it.each([
    ["RELAY_DEV_ACTOR is unset", { NODE_ENV: "development" }],
    ["RELAY_DEV_ACTOR is empty", { NODE_ENV: "development", RELAY_DEV_ACTOR: "" }],
    ["NODE_ENV is production", { NODE_ENV: "production", RELAY_DEV_ACTOR: "1" }],
    ["NODE_ENV is test", { NODE_ENV: "test", RELAY_DEV_ACTOR: "1" }],
    ["NODE_ENV is unset", { RELAY_DEV_ACTOR: "1" }],
    [
      "NODE_ENV is production, whatever the role",
      { NODE_ENV: "production", RELAY_DEV_ACTOR: "1", RELAY_DEV_ROLE: "owner" },
    ],
  ])("throws when %s", (_label, variables) => {
    expect(() => actorFor(variables)).toThrow(/NODE_ENV=development and RELAY_DEV_ACTOR=1/);
  });
});
