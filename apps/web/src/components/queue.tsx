"use client";
import { type ReactNode, Suspense, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useQuery, useSuspenseQuery, useQueryClient } from "@tanstack/react-query";
import { useTRPC } from "@/lib/trpc/client";
import { usePagedQuery } from "@/lib/trpc/use-paged-query";
import type { Outputs } from "@/lib/api";
import { failureMessage } from "@/lib/failures";
import { campaignLabel, dayLabel, sourceLabel, callbackDate, overdueLabel } from "@/lib/display";
import { cn } from "@/lib/utils";
import { Avatar, Empty, Loading, PageHeader, Refusal, Slip } from "./pieces";
import { NativeSelect } from "./ui/native-select";
import { Button } from "./ui/button";
import { Icon } from "./icons";
export type Profile = Outputs["session"]["profile"];
type Queue = Outputs["leads"]["queue"];
type QueueItem = Queue["later"][number];
const groups = [
  {
    key: "overdueCallbacks",
    title: "Overdue callbacks",
    caption: "",
    empty: "No overdue callbacks.",
  },
  { key: "dueToday", title: "Due today", caption: "", empty: "No more callbacks due today." },
  {
    key: "noCallbackSet",
    title: "No callback set",
    caption: "Tried at least once",
    empty: "Every tried lead has a callback.",
  },
  {
    key: "notYetCalled",
    title: "Assigned to you, not yet called",
    caption: "Newest first",
    empty: "Every lead has been tried in this assignment.",
  },
  {
    key: "later",
    title: "Later",
    caption: "Callback after today, soonest first",
    empty: "No callbacks after today.",
  },
] as const;
type Group = (typeof groups)[number]["key"];
function QueueSlip({
  item,
  group,
  zone,
  at,
}: {
  item: QueueItem;
  group: Group;
  zone: string;
  at: Date;
}) {
  if (group === "overdueCallbacks")
    return (
      <Slip kind="refused" icon="alarm">
        {item.callbackAt ? overdueLabel(item.callbackAt, zone, at) : "Overdue"}
      </Slip>
    );
  if (group === "dueToday" || group === "later")
    return (
      <Slip
        kind={group === "dueToday" ? "waiting" : "outline"}
        icon={group === "dueToday" ? "clock" : "callback"}
      >
        {callbackDate(item.callbackAt, zone, at)}
      </Slip>
    );
  if (group === "notYetCalled")
    return (
      <Slip kind="fresh" icon="assign">
        New to you
      </Slip>
    );
  const last = item.lastNoteOrOutcome;
  return last?.kind === "attempt" && last.outcome === "spokeToThem" ? (
    <Slip icon="check">Spoke to them</Slip>
  ) : (
    <Slip icon="missed">
      {item.noAnswerCount ? `No answer ×${String(item.noAnswerCount)}` : "Attempt logged"}
    </Slip>
  );
}
function AgentPicker({ agentId }: { agentId: string }) {
  const trpc = useTRPC();
  const router = useRouter();
  const picker = useRef<HTMLSelectElement>(null);
  useEffect(() => {
    picker.current?.focus();
  }, [agentId]);
  const { data: agents } = useSuspenseQuery(trpc.leads.agents.queryOptions({ offset: 0 }));
  const people = [
    ...new Map(
      agents.map((agent) => [
        agent.ownerId,
        {
          ...agent,
          teams: agents
            .filter((other) => other.ownerId === agent.ownerId)
            .map((other) => other.team)
            .join(", "),
        },
      ]),
    ).values(),
  ];
  return (
    <NativeSelect
      ref={picker}
      aria-label="View agent queue"
      value={agentId}
      onChange={(event) => {
        router.push(`/agents/${event.target.value}`);
      }}
    >
      {people.map((agent) => (
        <option key={agent.ownerId} value={agent.ownerId}>
          {agent.name} · {agent.teams}
        </option>
      ))}
    </NativeSelect>
  );
}
export function QueueScreen({
  profile,
  agentId,
  zone,
  basePath,
  children,
}: {
  profile: Profile;
  agentId: string;
  zone: string;
  basePath: string;
  children: ReactNode;
}) {
  const trpc = useTRPC();
  const client = useQueryClient();
  const params = useParams<{ leadId?: string }>();
  const previousLead = useRef(params.leadId);
  const leadLinks = useRef(new Map<string, HTMLAnchorElement>());
  useEffect(() => {
    if (!params.leadId && previousLead.current)
      leadLinks.current.get(previousLead.current)?.focus();
    previousLead.current = params.leadId;
  }, [params.leadId]);
  const [limit, setLimit] = useState(20);
  const pageQuery = usePagedQuery(trpc.leads.queue.queryOptions({ agentId, limit }), agentId);
  const queue = pageQuery.data;
  const people = useQuery(
    trpc.leads.agents.queryOptions({ offset: 0 }, { enabled: profile.role !== "agent" }),
  );
  const name = people.data?.find((agent) => agent.ownerId === agentId)?.name ?? "Agent";
  useEffect(() => {
    if (!queue?.nextCallbackAt) return;
    const delay = Math.max(1000, queue.nextCallbackAt.getTime() - Date.now() + 100);
    const timer = setTimeout(
      () => void client.invalidateQueries({ queryKey: trpc.leads.queue.queryKey() }),
      Math.min(delay, 2147483647),
    );
    return () => {
      clearTimeout(timer);
    };
  }, [client, queue?.nextCallbackAt, trpc]);
  if (!queue) {
    if (pageQuery.error)
      return (
        <Refusal title="The queue could not be loaded" retry={() => void pageQuery.refetch()}>
          {failureMessage(pageQuery.error, "read")}
        </Refusal>
      );
    return <Loading label="Loading queue" />;
  }
  const total = Object.values(queue.counts).reduce((sum, count) => sum + count, 0);
  const hasMore =
    limit < 100 && groups.some((group) => queue[group.key].length < queue.counts[group.key]);
  return (
    <>
      <PageHeader
        title={profile.role === "agent" ? "My queue" : `${name}'s queue`}
        action={
          profile.role !== "agent" && (
            <Suspense fallback={<span>Loading agents</span>}>
              <AgentPicker agentId={agentId} />
            </Suspense>
          )
        }
      >
        {dayLabel(queue.at, zone)} · {total} open leads · {queue.counts.overdueCallbacks} overdue,{" "}
        {queue.counts.dueToday} due today, {queue.counts.noCallbackSet} with no callback,{" "}
        {queue.counts.notYetCalled} not yet called, {queue.counts.later} later
      </PageHeader>
      <div className="flex min-h-0 flex-1">
        <section
          aria-label="Work queue"
          tabIndex={0}
          className={cn(
            "@container/queue min-h-0 w-full shrink-0 overflow-y-auto overscroll-contain md:w-2/5 md:max-w-queue xl:w-queue",
            params.leadId && "hidden md:block",
          )}
        >
          {total === 0 ? (
            <Empty
              icon="queue"
              title={
                profile.role === "agent" ? "You have no open leads" : `${name} has no open leads`
              }
            >
              Leads appear here when they are assigned to{" "}
              {profile.role === "agent" ? "you" : "this agent"}.
            </Empty>
          ) : (
            groups.map((group) => (
              <section key={group.key} aria-labelledby={`group-${group.key}`}>
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 px-4 pb-1 pt-3 @md/queue:px-6">
                  <h2 className="text-caption font-semibold" id={`group-${group.key}`}>
                    {group.title}
                  </h2>
                  <span className="text-caption text-muted-foreground">
                    {queue.counts[group.key]}
                  </span>
                  {group.caption && (
                    <span className="ms-auto text-xs text-muted-foreground">{group.caption}</span>
                  )}
                </div>
                {queue.counts[group.key] === 0 && (
                  <p className="px-4 pb-2 text-caption text-muted-foreground @md/queue:px-6">
                    {group.empty}
                  </p>
                )}
                <ul>
                  {queue[group.key].map((item) => (
                    <li
                      key={item.id}
                      className={cn(
                        "relative flex items-center gap-2 px-4 py-2 @md/queue:px-6",
                        item.id === params.leadId ? "bg-accent" : "hover:bg-muted",
                      )}
                    >
                      <span className="hidden @md/queue:block">
                        <Avatar name={item.name ?? "Unknown"} large />
                      </span>
                      <div className="grid min-w-0 flex-1 gap-1 @md/queue:grid-cols-value-action">
                        <Link
                          ref={(link) => {
                            if (link) leadLinks.current.set(item.id, link);
                            else leadLinks.current.delete(item.id);
                          }}
                          href={`${basePath}/leads/${item.id}`}
                          scroll={false}
                          aria-label={`Open ${item.name ?? item.email}`}
                          aria-current={item.id === params.leadId ? "page" : undefined}
                          aria-describedby={`lead-summary-${item.id}`}
                          className="font-semibold after:absolute after:inset-0"
                        >
                          {item.name ?? item.email}
                        </Link>
                        <p
                          id={`lead-summary-${item.id}`}
                          className="text-caption text-secondary-foreground @md/queue:col-span-2 @md/queue:row-start-2 @md/queue:truncate"
                        >
                          {campaignLabel(item.campaign)} ·{" "}
                          {group.key === "notYetCalled"
                            ? `Assigned ${callbackDate(item.assignedAt, zone, queue.at)} · ${sourceLabel(item.source)}`
                            : (item.lastNoteOrOutcome?.note ?? "No note yet")}
                        </p>
                        <span className="justify-self-start @md/queue:col-start-2 @md/queue:row-start-1 @md/queue:justify-self-end">
                          <QueueSlip item={item} group={group.key} zone={zone} at={queue.at} />
                        </span>
                      </div>
                      <div className="relative flex gap-2 md:hidden">
                        <Button asChild variant="outline" size="icon">
                          <Link
                            href={`${basePath}/leads/${item.id}?action=call`}
                            aria-label={`Call ${item.name ?? item.email}`}
                          >
                            <Icon name="call" />
                          </Link>
                        </Button>
                        <Button asChild variant="outline" size="icon">
                          <Link
                            href={`${basePath}/leads/${item.id}?action=whatsapp`}
                            aria-label={`WhatsApp ${item.name ?? item.email}`}
                          >
                            <Icon name="whatsapp" />
                          </Link>
                        </Button>
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            ))
          )}
          {pageQuery.error && (
            <Refusal title="More leads could not be loaded" retry={() => void pageQuery.refetch()}>
              {failureMessage(pageQuery.error, "read")}
            </Refusal>
          )}
          {(hasMore || limit > 20) && (
            <Button
              variant="outline"
              className="m-4"
              busy={pageQuery.isFetching}
              aria-disabled={!hasMore || pageQuery.isFetching}
              onClick={() => {
                if (hasMore) setLimit((value) => Math.min(value + 20, 100));
              }}
            >
              {hasMore ? "Show more leads" : "All leads shown"}
            </Button>
          )}
          {people.isError && (
            <Refusal title="Agents could not be loaded">
              {failureMessage(people.error, "read")}
            </Refusal>
          )}
        </section>
        <section
          aria-label="Lead detail"
          tabIndex={0}
          className={cn(
            "@container/detail min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain md:border-s",
            !params.leadId && "hidden md:block",
          )}
        >
          <Suspense fallback={<Loading label="Loading lead" />}>{children}</Suspense>
        </section>
      </div>
    </>
  );
}
