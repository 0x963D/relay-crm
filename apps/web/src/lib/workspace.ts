import type { Role } from "@relay/domain";
export function isLeadManager(role: Role): boolean {
  return role === "owner" || role === "admin" || role === "manager" || role === "teamLead";
}
export function workspaceView(role: Role, requested: string | null | undefined): "queue" | "pool" {
  return requested === "queue"
    ? "queue"
    : requested === "pool" && isLeadManager(role)
      ? "pool"
      : role === "agent"
        ? "queue"
        : "pool";
}
