import { TeamId, UserId, type Actor, type SessionPrincipal } from "@relay/domain";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { AccessError } from "./errors.ts";
import { InvariantError } from "./lead-row.ts";
import { transact, type Db, type Tx } from "./tx.ts";

export function authenticationDatabase(db: Db) {
  return prismaAdapter(db, { provider: "postgresql" });
}

export async function currentActor(
  tx: Tx,
  actor: { readonly userId: UserId; readonly team: { readonly id: TeamId } | null },
): Promise<Actor> {
  const user = await tx.user.findUnique({ where: { id: actor.userId } });
  if (!user) throw new AccessError("accessDenied");
  const memberships = await tx.membership.findMany({
    where: { userId: actor.userId },
    include: { team: true },
    orderBy: { teamId: "asc" },
  });
  const teams = memberships.map((member) => {
    const id = TeamId.parse(member.teamId);
    if (!id) throw new InvariantError("A membership contains an invalid team UUID");
    return { id, name: member.team.name, kind: member.team.kind, isLead: member.isLead };
  });
  const selected =
    teams.find((team) => team.id === actor.team?.id) ?? (teams.length === 1 ? teams[0] : null);
  return {
    userId: actor.userId,
    role: user.role,
    teams,
    team: selected ? { id: selected.id, kind: selected.kind, isLead: selected.isLead } : null,
  };
}

export async function initialSessionTeam(db: Db, value: string): Promise<TeamId | null> {
  const userId = UserId.parse(value);
  if (!userId) throw new AccessError("accessDenied");
  return transact(
    db,
    async (tx) => (await currentActor(tx, { userId, team: null })).team?.id ?? null,
  );
}

export async function sessionPrincipal(db: Db, id: string): Promise<SessionPrincipal | null> {
  return transact(db, async (tx) => {
    const session = await tx.authSession.findUnique({ where: { id } });
    if (!session || session.expiresAt <= new Date()) return null;
    const userId = UserId.parse(session.userId);
    const teamId = session.currentTeamId === null ? null : TeamId.parse(session.currentTeamId);
    if (userId === null || (session.currentTeamId !== null && teamId === null)) {
      throw new InvariantError("A session contains an invalid UUID");
    }
    const actor = await currentActor(tx, {
      userId,
      team: teamId === null ? null : { id: teamId },
    });
    const currentTeamId = actor.team?.id ?? null;
    if (session.currentTeamId !== currentTeamId)
      await tx.authSession.update({ where: { id }, data: { currentTeamId } });
    return {
      kind: "session",
      session: { id, userId, currentTeamId, expiresAt: session.expiresAt },
      actor,
    };
  });
}

export async function selectTeam(db: Db, sessionId: string, teamId: TeamId | null): Promise<void> {
  await transact(db, async (tx) => {
    const session = await tx.authSession.findUnique({ where: { id: sessionId } });
    if (!session || session.expiresAt <= new Date()) throw new AccessError("accessDenied");
    if (
      teamId !== null &&
      !(await tx.membership.findUnique({
        where: {
          userId_teamId: { userId: session.userId, teamId },
        },
      }))
    )
      throw new AccessError("accessDenied");
    await tx.authSession.update({ where: { id: sessionId }, data: { currentTeamId: teamId } });
  });
}

export async function ensureDevelopmentActor(db: Db, actor: Actor): Promise<void> {
  await transact(db, async (tx) => {
    await tx.user.upsert({
      where: { id: actor.userId },
      create: {
        id: actor.userId,
        email: "development@relay.example",
        name: "Development user",
        role: actor.role,
      },
      update: { role: actor.role },
    });
  });
}
