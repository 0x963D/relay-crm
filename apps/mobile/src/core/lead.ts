import type { Lead, Queue } from "./api-types.ts";
import { queueSections } from "./queue.ts";
export function knownLeadState(status: string, stage?: string) {
  return (
    ["new", "assigned", "working", "won", "lost", "dead"].includes(status) &&
    (status !== "working" ||
      (stage !== undefined && ["ready", "contacted", "callBack", "noAnswer"].includes(stage)))
  );
}

export function leadContact(
  id: string,
  lead: Lead | undefined,
  queue: Queue | undefined,
  failed: boolean,
) {
  const cached = queue
    ? queueSections(queue)
        .flatMap((section) => section.rows)
        .find((row) => row.id === id)
    : undefined;
  const loaded = lead?.id === id ? lead : undefined;
  return {
    name: loaded ? (loaded.name ?? loaded.email) : (cached?.name ?? cached?.email ?? "Lead"),
    phone: loaded ? loaded.phone : (cached?.phone ?? null),
    email: loaded?.email ?? cached?.email ?? "",
    callablePhone: !failed ? (loaded?.phone ?? null) : null,
  };
}
