import { z } from "zod";

const date = z.date();
const person = z.object({ id: z.string(), name: z.string() });
const assignment = z.object({ ownerId: z.string(), teamId: z.string() });
const stage = z.union([
  z.object({ kind: z.literal("ready") }),
  z.object({ kind: z.literal("contacted") }),
  z.object({ kind: z.literal("callBack"), at: date }),
  z.object({ kind: z.literal("noAnswer"), count: z.number() }),
  z.object({
    kind: z
      .string()
      .refine((kind) => !["ready", "contacted", "callBack", "noAnswer"].includes(kind)),
  }),
]);
const lifecycle = z.object({
  state: z.union([
    z.object({ status: z.literal("new") }),
    z.object({ status: z.literal("assigned"), assignee: assignment }),
    z.object({ status: z.literal("working"), assignee: assignment, stage }),
    z.object({ status: z.literal("won"), assignee: assignment, accountId: z.string() }),
    z.object({ status: z.literal("lost"), assignee: assignment, reason: z.string() }),
    z.object({
      status: z.literal("dead"),
      assignee: assignment.nullable(),
      reason: z.string(),
    }),
    z.object({
      status: z
        .string()
        .refine(
          (status) => !["new", "assigned", "working", "won", "lost", "dead"].includes(status),
        ),
    }),
  ]),
  firstAssignedAt: date.nullable(),
  previousOwnerId: z.string().nullable(),
});
const summary = z.union([
  z.object({ kind: z.literal("note"), note: z.string() }),
  z.object({
    kind: z.literal("attempt"),
    note: z.string(),
    outcome: z.string(),
    channel: z.string(),
    callbackAt: date.nullable(),
    noAnswerCount: z.number().nullable(),
  }),
  z.object({ kind: z.string().refine((kind) => kind !== "note" && kind !== "attempt") }),
]);
const row = z.object({
  id: z.string(),
  name: z.string().nullable(),
  email: z.string(),
  phone: z.string().nullable(),
  callbackAt: date.nullable(),
  noAnswerCount: z.number(),
  assignedAt: date.nullable(),
  campaign: z.string().nullable(),
  source: z.string().nullable(),
  lastNoteOrOutcome: summary.nullable(),
  lifecycle,
  createdAt: date,
  assignmentSequence: z.bigint(),
  hasAttempt: z.boolean().nullable(),
});
const timeZone = z.string().refine((value) => {
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: value });
    return true;
  } catch {
    return false;
  }
});
export const queueReadShape = z.object({
  timeZone,
  at: date,
  nextCallbackAt: date.nullable(),
  counts: z.object({
    overdueCallbacks: z.number(),
    dueToday: z.number(),
    noCallbackSet: z.number(),
    notYetCalled: z.number(),
    later: z.number(),
  }),
  overdueCallbacks: z.array(row),
  dueToday: z.array(row),
  noCallbackSet: z.array(row),
  notYetCalled: z.array(row),
  later: z.array(row),
});
export const leadReadShape = z.object({
  id: z.string(),
  name: z.string().nullable(),
  email: z.string(),
  phone: z.string().nullable(),
  source: z.string().nullable(),
  lifecycle,
  contactedAt: date.nullable(),
  noAnswerCount: z.number(),
  custody: z.object({
    assignedBy: person.extend({ at: date.nullable() }).nullable(),
    heldBy: person.extend({ since: date.nullable() }).nullable(),
  }),
  attribution: z.object({ campaign: z.string().nullable() }).nullable(),
  timeline: z.array(
    z.object({
      id: z.string(),
      sequence: z.bigint(),
      kind: z.string(),
      at: date,
      detail: z.json(),
      summary: summary.nullable(),
      actor: person.nullable(),
    }),
  ),
});
export const readShapes = new Map<string, z.ZodType>([
  ["server.info", z.object({ demo: z.boolean(), demoAgentName: z.string().nullable().optional() })],
  [
    "session.profile",
    z.object({
      name: z.string(),
      email: z.string(),
      teams: z.array(z.object({ name: z.string() })).optional(),
      demoRole: z.string().nullable().optional(),
    }),
  ],
  ["leads.queue", queueReadShape],
  ["leads.get", leadReadShape],
]);
