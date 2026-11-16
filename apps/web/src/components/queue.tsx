"use client";
import { NativeSelect } from "./ui/native-select";
import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { type Outputs } from "@/lib/api";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { reads, readState } from "@/lib/reads";
import { failureMessage } from "@/lib/failures";
import {
  campaignLabel,
  dayLabel,
  shortDate,
  sourceLabel,
  callbackDate,
  overdueBy,
} from "@/lib/display";
import { Avatar, Empty, Loading, Refusal, Slip } from "./pieces";
import { Button } from "./ui/button";
import { Icon } from "./icons";
import { LeadDetail } from "./lead-detail";
export type Profile = Outputs["session"]["profile"];
export type Queue = Outputs["leads"]["queue"];
export type QueueItem = Queue["later"][number];
export const groups = [
  { key: "overdueCallbacks", title: "Overdue callbacks", caption: "" },
  { key: "dueToday", title: "Due today", caption: "" },
  { key: "noCallbackSet", title: "No callback set", caption: "Tried at least once" },
  { key: "notYetCalled", title: "Assigned to you, not yet called", caption: "Newest first" },
  { key: "later", title: "Later", caption: "Callback after today, soonest first" },
] as const;
type Group = (typeof groups)[number]["key"];
export function QueueSlip({
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
  if (group === "overdueCallbacks") {
    return (
      <Slip kind="pink" icon="alarm">
        Overdue {item.callbackAt ? overdueBy(item.callbackAt, at) : "Unknown"}
      </Slip>
    );
  }
  if (group === "dueToday" || group === "later")
    return (
      <Slip
        kind={group === "dueToday" ? "canary" : "line"}
        icon={group === "dueToday" ? "clock" : "callback"}
      >
        {callbackDate(item.callbackAt, zone, at)}
      </Slip>
    );
  if (group === "notYetCalled")
    return (
      <Slip kind="ink" icon="assign">
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
export function QueueScreen({
  profile,
  agents,
  zone,
  onTotalChange,
}: {
  profile: Profile;
  agents: Outputs["leads"]["agents"];
  zone: string;
  onTotalChange: (total: number) => void;
}) {
  const params = useSearchParams();
  const agentId =
    profile.role === "agent" ? profile.userId : (params.get("agent") ?? agents[0]?.ownerId);
  const client = useQueryClient();
  const query = useQuery({ ...reads.queue({ agentId, limit: 20 }), enabled: !!agentId });
  const remote = readState(query);
  const refresh = () => {
    setMore([]);
    void client.invalidateQueries({ queryKey: ["queue"] });
  };
  const [selected, setSelected] = useState<string | null>(null);
  const [more, setMore] = useState<Queue[]>([]);
  const [moreError, setMoreError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  useEffect(() => {
    if (remote.status !== "ready" || !remote.value.nextCallbackAt) return;
    const delay = Math.max(1000, remote.value.nextCallbackAt.getTime() - Date.now() + 100);
    const timer = setTimeout(
      () => {
        void client.invalidateQueries({ queryKey: ["queue"] });
      },
      Math.min(delay, 2147483647),
    );
    return () => {
      clearTimeout(timer);
    };
  }, [remote]);
  const queue = remote.status === "ready" ? remote.value : null;
  const agentOptions = [
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
  const name = agents.find((a) => a.ownerId === agentId)?.name ?? "Agent";
  const total = queue ? Object.values(queue.counts).reduce((n, v) => n + v, 0) : 0;
  useEffect(() => {
    if (queue) onTotalChange(total);
  }, [queue, total, onTotalChange]);
  const all = (key: Group) => (queue ? [...queue[key], ...more.flatMap((page) => page[key])] : []);
  const selectedId =
    params.get("lead") ?? selected ?? groups.flatMap((g) => all(g.key))[0]?.id ?? null;
  function choose(id: string, action?: "call" | "whatsapp") {
    const next = new URLSearchParams({ view: "queue", lead: id });
    if (agentId && profile.role !== "agent") next.set("agent", agentId);
    if (action) next.set("action", action);
    window.history.pushState(null, "", `/?${next}`);
    setSelected(id);
  }
  async function loadMore() {
    if (!agentId) return;
    setPending(true);
    setMoreError(null);
    try {
      const page = await client.query(
        reads.queue({
          agentId,
          limit: 20,
          offset: (more.length + 1) * 20,
        }),
      );
      setMore((pages) => [...pages, page]);
    } catch (error) {
      setMoreError(failureMessage(error, "read"));
    } finally {
      setPending(false);
    }
  }
  return (
    <>
      <header className="ph flex items-end gap-content p-[18px_24px_14px] [border-block-end:1px_solid_var(--color-rule)] [&_h1]:text-(length:--text-title) [&_h1]:leading-[30px] [&_h1]:font-[720] [&_h1]:[font-variation-settings:'wdth'_84] [&_h1]:[letter-spacing:0] [&_h1]:whitespace-nowrap max-phone:p-[16px_16px_10px] max-phone:items-start max-phone:flex-wrap max-phone:gap-related max-phone:[&_h1]:[font-size:24px] max-phone:[&_h1]:leading-[28px]">
        <div>
          <h1>{profile.role === "agent" ? "My queue" : `${name}'s queue`}</h1>
          <div className="ph-sub text-(length:--text-small) text-secondary mt-[2px] max-phone:text-(length:--text-small)">
            {dayLabel(queue?.at ?? new Date(), zone)}
            {queue &&
              total > 0 &&
              ` · ${String(total)} open leads · ${String(queue.counts.overdueCallbacks)} overdue, ${String(queue.counts.dueToday)} due today, ${String(queue.counts.noCallbackSet)} with no callback, ${String(queue.counts.notYetCalled)} not yet called, ${String(queue.counts.later)} later`}
          </div>
        </div>
        <span className="ph-sp flex-1 max-phone:[.ph_&]:hidden" />
        {profile.role !== "agent" && (
          <label className="field flex flex-col gap-compact">
            <span className="sr-only absolute w-[1px] h-[1px] p-0 m-[-1px] overflow-hidden [clip-path:inset(50%)] whitespace-nowrap border-0">
              View agent queue
            </span>
            <NativeSelect
              className="input flex items-center gap-related h-[36px] px-control border-[1px] border-solid border-control-border rounded-control bg-surface text-foreground text-(length:--text-body) [.sign-sheet_&]:h-[44px] [.sign-sheet_&]:w-full max-phone:min-h-[44px] [&:focus-visible]:[outline:none] [&:focus-visible]:border-primary [&:focus-visible]:[box-shadow:0_0_0_3px_var(--color-selected)] agent-picker max-w-[200px]"
              aria-label="View agent queue"
              value={agentId ?? ""}
              onChange={(e) => {
                window.history.pushState(null, "", `/?view=queue&agent=${e.target.value}`);
              }}
            >
              {agentOptions.map((agent) => (
                <option key={agent.ownerId} value={agent.ownerId}>
                  {agent.name} · {agent.teams}
                </option>
              ))}
            </NativeSelect>
          </label>
        )}
      </header>
      <div
        className="md grid flex-1 min-h-0 max-phone:block workspace-queue [grid-template-columns:minmax(0,_var(--queue-width))_minmax(0,_1fr)] max-laptop:[grid-template-columns:minmax(300px,_40%)_minmax(0,_1fr)] max-pane:[grid-template-columns:minmax(0,_1fr)] phone:max-poolcompact:[grid-template-columns:minmax(0,_40%)_minmax(0,_1fr)]"
        data-detail={params.has("lead")}
      >
        <section
          className="pane min-w-0 min-h-0 overflow-hidden flex flex-col queue-list overflow-y-auto max-pane:[.workspace-queue[data-detail='true']_&]:hidden max-phone:overflow-visible max-phone:pb-content"
          aria-label="Work queue"
        >
          {!agentId ? (
            <Empty icon="queue" title="No agent queue to open">
              An agent's queue appears here when they join a sales team.
            </Empty>
          ) : remote.status === "loading" ? (
            <Loading />
          ) : remote.status === "error" ? (
            <div className="pad p-[18px_24px] max-phone:p-content">
              <Refusal
                title="The queue could not be opened"
                retry={() => {
                  void client.invalidateQueries({ queryKey: ["queue"] });
                }}
              >
                {failureMessage(remote.error, "read")}
              </Refusal>
            </div>
          ) : total === 0 ? (
            <Empty
              icon="queue"
              title={
                profile.role === "agent" ? "You have no open leads" : `${name} has no open leads`
              }
            >
              {profile.role === "agent"
                ? "New leads appear here when your manager or team lead assigns them."
                : "Leads appear here when they are assigned to this agent."}
            </Empty>
          ) : (
            groups.map((group) => (
              <section key={group.key} aria-labelledby={`group-${group.key}`}>
                <div className="sec flex items-center gap-related p-[12px_24px_4px] text-(length:--text-small) font-[680] [font-stretch:88%] flex-none [.queue-list_&]:flex-wrap max-phone:[.queue-list_&]:p-[12px_16px_2px] max-phone:[.queue-list_&]:gap-compact">
                  <h2 className="group-heading" id={`group-${group.key}`}>
                    {group.title}
                  </h2>
                  <span className="sec-n text-tertiary font-[560]">{queue?.counts[group.key]}</span>
                  {group.caption && (
                    <span className="cap text-(length:--text-caption) leading-[16px] text-tertiary [font-stretch:94%] [.sec_&]:font-[400] [.sec_&]:ms-auto [.timeline-heading_&]:flex-1 max-phone:[.queue-list_.sec_&]:text-(length:--text-caption)">
                      {group.caption}
                    </span>
                  )}
                </div>
                <ul>
                  {all(group.key).map((item) => (
                    <li key={item.id}>
                      <div
                        className="qrow flex items-center gap-group p-[7px_24px] min-h-[54px] [cursor:pointer] [border-radius:0] w-full border-0 bg-transparent text-foreground text-start flex-none [&:hover]:bg-muted [&[aria-selected='true']]:bg-selected [&[aria-current='true']]:bg-selected max-phone:py-control max-phone:px-[16px_8px] max-phone:gap-related max-phone:min-h-[68px] max-phone:[.queue-list_&]:items-center [&[data-selected='true']]:bg-selected pane:[&[data-auto-selected='true']]:bg-selected"
                        data-selected={item.id === selectedId && params.has("lead")}
                        data-auto-selected={item.id === selectedId && !params.has("lead")}
                      >
                        <button
                          type="button"
                          className="q-select max-phone:block max-phone:flex-1 max-phone:min-w-0 max-phone:bg-transparent max-phone:[color:inherit] max-phone:border-0 max-phone:text-start flex items-center gap-group flex-1 min-w-0 border-0 bg-transparent [color:inherit] text-start p-0 [cursor:pointer]"
                          aria-current={
                            item.id === selectedId && params.has("lead") ? "true" : undefined
                          }
                          onClick={() => {
                            choose(item.id);
                          }}
                        >
                          <Avatar name={item.name ?? "Unknown"} large />
                          <span className="q-main min-w-0 flex-1 block max-phone:flex max-phone:flex-col max-phone:[.qrow_&]:leading-[20px]">
                            <span className="q-top flex items-center gap-related max-phone:contents phone:max-poolcompact:flex-wrap phone:max-poolcompact:gap-[2px]">
                              <span className="q-name font-[620] [overflow-wrap:anywhere] [.tbl_tbody_tr.is-gone_&]:[text-decoration:line-through] [.tbl_tbody_tr.is-gone_&]:font-[500] max-phone:[order:0] [.pool-list_&]:whitespace-nowrap [.pool-list_&]:[overflow-wrap:normal] phone:max-poolcompact:[flex-basis:100%] max-phone:[.pool-list_&]:whitespace-nowrap trunc overflow-hidden text-ellipsis whitespace-nowrap min-w-0">
                                {item.name ?? item.email}
                              </span>
                              <span className="sp flex-1 max-laptop:[.lead-title_&]:hidden max-phone:[.q-top_&]:hidden phone:max-poolcompact:[.q-top_&]:hidden" />
                              {queue && (
                                <QueueSlip
                                  item={item}
                                  group={group.key}
                                  zone={zone}
                                  at={queue.at}
                                />
                              )}
                            </span>
                            <span className="q-note text-(length:--text-small) leading-[18px] text-secondary mt-[1px] block [.qrow_&]:overflow-hidden [.qrow_&]:text-ellipsis [.qrow_&]:whitespace-nowrap max-phone:[.qrow_&]:whitespace-normal max-phone:[order:1]">
                              {campaignLabel(item.campaign)} ·{" "}
                              {group.key === "notYetCalled"
                                ? `Assigned ${shortDate(item.assignedAt, zone)} · ${sourceLabel(item.source)}`
                                : (item.lastNoteOrOutcome?.note ?? "No note yet")}
                            </span>
                          </span>
                        </button>
                        <div className="q-mobile-actions hidden max-phone:flex max-phone:gap-related">
                          <Button
                            variant="outline"
                            size="icon"
                            aria-label={`Call ${item.name ?? item.email}`}
                            onClick={() => {
                              choose(item.id, "call");
                            }}
                          >
                            <Icon name="call" size="large" />
                          </Button>
                          <Button
                            variant="outline"
                            size="icon"
                            aria-label={`WhatsApp ${item.name ?? item.email}`}
                            onClick={() => {
                              choose(item.id, "whatsapp");
                            }}
                          >
                            <Icon name="whatsapp" size="large" />
                          </Button>
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            ))
          )}
          {queue && groups.some((g) => all(g.key).length < queue.counts[g.key]) && (
            <Button
              variant="outline"
              size="sm"
              className="load-more m-[12px_24px] [align-self:flex-start]"
              disabled={pending}
              onClick={() => {
                void loadMore();
              }}
            >
              Show more leads
            </Button>
          )}
          {query.isError && query.data && (
            <Refusal
              title="The latest queue could not be loaded"
              retry={() => {
                void query.refetch();
              }}
            >
              {failureMessage(query.error, "read")}
            </Refusal>
          )}
          {moreError && <Refusal title="More leads could not be loaded">{moreError}</Refusal>}
        </section>
        <section
          className="pane min-w-0 min-h-0 flex flex-col max-phone:overflow-visible pane--side [border-inline-start:1px_solid_var(--color-rule)] max-pane:[.workspace-queue_&]:hidden max-pane:[.workspace-queue[data-detail='true']_&]:flex max-pane:[.workspace-queue[data-detail='true']_&]:border-0 max-phone:[.workspace-queue_&]:hidden max-phone:[.workspace-queue[data-detail='true']_&]:flex scroll overflow-auto [overscroll-behavior:contain]"
          aria-label="Lead detail"
          tabIndex={0}
        >
          {selectedId ? (
            <LeadDetail
              key={`${selectedId}:${params.get("action") ?? ""}`}
              id={selectedId}
              profile={profile}
              zone={zone}
              action={params.get("action")}
              onSaved={() => {
                setSelected(selectedId);
                refresh();
              }}
              onBack={() => {
                window.history.pushState(
                  null,
                  "",
                  profile.role === "agent" ? "/?view=queue" : `/?view=queue&agent=${agentId ?? ""}`,
                );
              }}
            />
          ) : remote.status === "loading" ? (
            <Loading />
          ) : remote.status === "error" ? (
            <Empty icon="info" title="The queue could not be opened">
              Try loading the queue again.
            </Empty>
          ) : total === 0 ? (
            <Empty icon="queue" title="No lead to open">
              {profile.role === "agent"
                ? "Your next assigned lead will appear in the queue."
                : "This agent's next assigned lead will appear in the queue."}
            </Empty>
          ) : (
            <Empty icon="queue" title="Choose a lead">
              Open a lead from the queue to see its history.
            </Empty>
          )}
        </section>
      </div>
    </>
  );
}
