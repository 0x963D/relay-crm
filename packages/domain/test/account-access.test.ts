import { describe, expect, it } from "vitest";
import { recordScope, ROLES, type Actor } from "../src/index.ts";
import { ana } from "./fixtures.ts";

describe("account and assignment scopes", () => {
  it.each(ROLES)("keeps %s within its role ceiling", (role) => {
    const actor: Actor = {
      userId: ana.ownerId,
      role,
      team: { id: ana.teamId, kind: "sales", isLead: true },
    };
    const management = ["owner", "admin", "manager"].includes(role);
    expect(recordScope(actor, "account", "read")).toEqual(
      management || role === "accountant"
        ? { kind: "all" }
        : role === "teamLead"
          ? { kind: "team", teamId: ana.teamId }
          : { kind: "own", userId: ana.ownerId },
    );
    expect(recordScope(actor, "account", "edit")).toEqual(
      management
        ? { kind: "all" }
        : role === "accountant"
          ? { kind: "none" }
          : { kind: "own", userId: ana.ownerId },
    );
    expect(recordScope(actor, "lead", "assign")).toEqual(
      management
        ? { kind: "all" }
        : role === "teamLead"
          ? { kind: "teamAndPool", teamId: ana.teamId }
          : { kind: "none" },
    );
    expect(recordScope(actor, "account", "assign")).toEqual(
      management
        ? { kind: "all" }
        : role === "teamLead"
          ? { kind: "team", teamId: ana.teamId }
          : { kind: "none" },
    );
  });
  it.each([
    null,
    { id: ana.teamId, kind: "sales", isLead: false },
    { id: ana.teamId, kind: "accounts", isLead: true },
  ] as const)("does not let a team lead assign without leading the current sales team", (team) => {
    expect(recordScope({ userId: ana.ownerId, role: "teamLead", team }, "lead", "assign")).toEqual({
      kind: "none",
    });
  });
});
