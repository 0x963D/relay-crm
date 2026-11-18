import type { Queue } from "./api-types.ts";
import { queueSections } from "./queue.ts";
import type { GroupKey } from "./queue.ts";

export function queueFocus(
  previous: Queue,
  next: Queue,
  id: string,
  folded: ReadonlySet<GroupKey>,
) {
  const before = queueSections(previous);
  const after = queueSections(next);
  const from = before.find((section) => section.rows.some((row) => row.id === id));
  const row = from?.rows.find((row) => row.id === id);
  if (!from || !row) return null;
  const to = after.find((section) => section.rows.some((row) => row.id === id));
  const name = row.name ?? row.email;
  if (to) {
    if (to.key === from.key && to.rows.findIndex((row) => row.id === id) === from.rows.indexOf(row))
      return null;
    return {
      target: folded.has(to.key) ? `group:${to.key}` : `row:${id}`,
      announcement: `${name} moved to ${to.title}`,
    };
  }
  const group = after.find((section) => section.key === from.key);
  const index = from.rows.indexOf(row);
  const neighbor =
    from.rows
      .slice(index + 1)
      .find((candidate) => group?.rows.some((row) => row.id === candidate.id)) ??
    from.rows
      .slice(0, index)
      .reverse()
      .find((candidate) => group?.rows.some((row) => row.id === candidate.id));
  const target = after.every((section) => section.count === 0)
    ? "state"
    : folded.has(from.key) || !neighbor
      ? `group:${from.key}`
      : `row:${neighbor.id}`;
  return { target, announcement: `${name} left your queue` };
}
