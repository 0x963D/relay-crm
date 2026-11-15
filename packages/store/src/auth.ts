import { TeamId, UserId, type Actor, type SessionPrincipal } from "@relay/domain";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { AccessError } from "./errors.ts";
import { InvariantError } from "./lead-row.ts";
import { transact, type Db, type Tx } from "./tx.ts";

export function authenticationDatabase(db: Db) {
  return prismaAdapter(db, { provider: "postgresql" });
}

export async function currentActor(tx: Tx, actor: Actor): Promise<Actor> {
  const user = await tx.user.findUnique({ where: { id: actor.userId } });
  if (!user) throw new AccessError("accessDenied");
  const teamId = actor.team?.id ?? null;
  const membership =
    teamId === null
      ? null
      : await tx.membership.findUnique({
          where: { userId_teamId: { userId: actor.userId, teamId } },
          include: { team: true },
        });
  return {
    userId: actor.userId,
    role: user.role,
    team:
      membership === null || teamId === null
        ? null
        : {
            id: teamId,
            kind: membership.team.kind,
            isLead: membership.isLead,
          },
  };
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
      role: "agent",
      team: teamId === null ? null : { id: teamId, kind: "sales", isLead: false },
    });
    return {
      kind: "session",
      session: { id, userId, currentTeamId: teamId, expiresAt: session.expiresAt },
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

export async function takeAuthRequest(
  db: Db,
  key: string,
  max: number,
  windowSeconds: number,
): Promise<boolean> {
  return transact(db, async (tx) => {
    const now = new Date();
    const prior = await tx.authRequestLimit.findUnique({ where: { key } });
    if (!prior || now.getTime() - prior.startedAt.getTime() >= windowSeconds * 1000) {
      await tx.authRequestLimit.upsert({
        where: { key },
        create: { key, count: 1, startedAt: now },
        update: { count: 1, startedAt: now },
      });
      return true;
    }
    if (prior.count >= max) return false;
    await tx.authRequestLimit.update({ where: { key }, data: { count: { increment: 1 } } });
    return true;
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
