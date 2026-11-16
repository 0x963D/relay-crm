import type { Role } from "@relay/domain";
export function isLeadManager(role: Role): boolean {
  return role === "owner" || role === "admin" || role === "manager" || role === "teamLead";
}
export function homeFor(role: Role): string {
  return role === "accountant" ? "/accountant" : role === "agent" ? "/queue" : "/pool";
}
