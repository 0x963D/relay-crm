import type { Outputs } from "./api";
export type Pool = Outputs["leads"]["pool"];
type Lead = Outputs["leads"]["get"];
type Preview = Outputs["distribution"]["preview"];
export type Plan =
  | { kind: "editing" }
  | { kind: "preview"; preview: Preview; rows: Pool["rows"]; at: Date }
  | {
      kind: "stale";
      preview: Preview;
      rows: Pool["rows"];
      at: Date;
      changed: Lead[];
      remaining: string[];
    };
export const assignmentKey = (agent: { ownerId: string; teamId: string }) =>
  `${agent.ownerId}:${agent.teamId}`;
