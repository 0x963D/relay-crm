import type { Actor } from "./access.ts";
import type { TeamId, UserId } from "./ids.ts";

export interface Session {
  readonly id: string;
  readonly userId: UserId;
  readonly currentTeamId: TeamId | null;
  readonly expiresAt: Date;
}

export type SessionPrincipal =
  | { readonly kind: "session"; readonly session: Session; readonly actor: Actor }
  | { readonly kind: "development"; readonly actor: Actor };
