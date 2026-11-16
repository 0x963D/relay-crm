"use client";
import { useEffect, useState, useCallback } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { api, type Outputs } from "@/lib/api";
import { failureMessage } from "@/lib/failures";
import { campaignLabel, dayLabel, shortDate, sourceLabel } from "@/lib/display";
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
export type Remote<T> =
  { status: "loading" } | { status: "error"; error: unknown } | { status: "ready"; value: T };
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
    const minutes = item.callbackAt
      ? Math.max(1, Math.floor((at.getTime() - item.callbackAt.getTime()) / 60000))
      : 0;
    return (
      <Slip kind="pink" icon="alarm">
        Overdue{" "}
        {minutes >= 60
          ? `${String(Math.floor(minutes / 60))} h ${String(minutes % 60)} min`
          : `${String(minutes)} min`}
      </Slip>
    );
  }
  if (group === "dueToday" || group === "later")
    return (
      <Slip
        kind={group === "dueToday" ? "canary" : "line"}
        icon={group === "dueToday" ? "clock" : "callback"}
      >
        {group === "dueToday" && item.callbackAt
          ? new Intl.DateTimeFormat("en-GB", {
              hour: "2-digit",
              minute: "2-digit",
              timeZone: zone,
            }).format(item.callbackAt)
          : shortDate(item.callbackAt, zone)}
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
  const router = useRouter();
  const params = useSearchParams();
  const agentId =
    profile.role === "agent" ? profile.userId : (params.get("agent") ?? agents[0]?.ownerId);
  const [remote, setRemote] = useState<Remote<Queue>>({ status: "loading" });
  const [revision, setRevision] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [more, setMore] = useState<Queue[]>([]);
  const [moreError, setMoreError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const load = useCallback(
    async (signal: AbortSignal) => {
      if (!agentId) throw new Error("No agent selected");
      return api.leads.queue.query({ agentId, limit: 20 }, { signal });
    },
    [agentId],
  );
  useEffect(() => {
    const c = new AbortController();
    setRemote({ status: "loading" });
    setMore([]);
    void load(c.signal).then(
      (value) => {
        setRemote({ status: "ready", value });
      },
      (error: unknown) => {
        if (!c.signal.aborted) setRemote({ status: "error", error });
      },
    );
    return () => {
      c.abort();
    };
  }, [load, revision]);
  useEffect(() => {
    if (remote.status !== "ready" || !remote.value.nextCallbackAt) return;
    const delay = Math.max(1000, remote.value.nextCallbackAt.getTime() - Date.now() + 100);
    const timer = setTimeout(
      () => {
        setRevision((r) => r + 1);
      },
      Math.min(delay, 2147483647),
    );
    return () => {
      clearTimeout(timer);
    };
  }, [remote]);
  const queue = remote.status === "ready" ? remote.value : null;
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
    router.push(`/?${next}`, { scroll: false });
    setSelected(id);
  }
  async function loadMore() {
    if (!agentId) return;
    setPending(true);
    setMoreError(null);
    try {
      const page = await api.leads.queue.query({
        agentId,
        limit: 20,
        offset: (more.length + 1) * 20,
      });
      setMore((pages) => [...pages, page]);
    } catch (error) {
      setMoreError(failureMessage(error));
    } finally {
      setPending(false);
    }
  }
  return (
    <>
      <header className="ph">
        <div>
          <h1>{profile.role === "agent" ? "My queue" : `${name}'s queue`}</h1>
          <div className="ph-sub">
            {dayLabel(queue?.at ?? new Date(), zone)}
            {queue &&
              ` · ${String(total)} open leads · ${String(queue.counts.overdueCallbacks)} overdue, ${String(queue.counts.dueToday)} due today, ${String(queue.counts.noCallbackSet)} with no callback, ${String(queue.counts.notYetCalled)} not yet called, ${String(queue.counts.later)} later`}
          </div>
        </div>
        <span className="ph-sp" />
        {profile.role !== "agent" && (
          <label className="field">
            <span className="sr-only">View agent queue</span>
            <select
              className="input agent-picker"
              aria-label="View agent queue"
              value={agentId ?? ""}
              onChange={(e) => {
                router.push(`/?view=queue&agent=${e.target.value}`);
              }}
            >
              {agents.map((agent) => (
                <option key={`${agent.ownerId}:${agent.teamId}`} value={agent.ownerId}>
                  {agent.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </header>
      <div className="md workspace-queue" data-detail={params.has("lead")}>
        <section className="pane queue-list" aria-label="Work queue">
          {remote.status === "loading" ? (
            <Loading />
          ) : remote.status === "error" ? (
            <div className="pad">
              <Refusal
                title="The queue could not be opened"
                retry={() => {
                  setRevision((r) => r + 1);
                }}
              >
                {failureMessage(remote.error)}
              </Refusal>
            </div>
          ) : total === 0 ? (
            <Empty icon="queue" title="You have no open leads">
              New leads appear here when your manager or team lead assigns them.
            </Empty>
          ) : (
            groups.map((group) => (
              <section key={group.key} aria-labelledby={`group-${group.key}`}>
                <div className="sec">
                  <h2 className="group-heading" id={`group-${group.key}`}>
                    {group.title}
                  </h2>
                  <span className="sec-n">{queue?.counts[group.key]}</span>
                  {group.caption && <span className="cap">{group.caption}</span>}
                </div>
                <ul>
                  {all(group.key).map((item) => (
                    <li key={item.id}>
                      <div className="qrow" data-selected={item.id === selectedId}>
                        <button
                          type="button"
                          className="q-select"
                          aria-current={item.id === selectedId ? "true" : undefined}
                          onClick={() => {
                            choose(item.id);
                          }}
                        >
                          <Avatar name={item.name ?? "Unknown"} large />
                          <span className="q-main">
                            <span className="q-top">
                              <span className="q-name trunc">{item.name ?? item.email}</span>
                              <span className="sp" />
                              {queue && (
                                <QueueSlip
                                  item={item}
                                  group={group.key}
                                  zone={zone}
                                  at={queue.at}
                                />
                              )}
                            </span>
                            <span className="q-note">
                              {campaignLabel(item.campaign)} ·{" "}
                              {group.key === "notYetCalled"
                                ? `Assigned ${shortDate(item.assignedAt, zone)} · ${sourceLabel(item.source)}`
                                : (item.lastNoteOrOutcome?.note ?? "No note yet")}
                            </span>
                          </span>
                        </button>
                        <div className="q-mobile-actions">
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
              className="load-more"
              disabled={pending}
              onClick={() => {
                void loadMore();
              }}
            >
              Show more leads
            </Button>
          )}
          {moreError && <Refusal>{moreError}</Refusal>}
        </section>
        <section className="pane pane--side scroll" aria-label="Lead detail" tabIndex={0}>
          {selectedId ? (
            <LeadDetail
              key={`${selectedId}:${params.get("action") ?? ""}`}
              id={selectedId}
              profile={profile}
              zone={zone}
              action={params.get("action")}
              onSaved={() => {
                setSelected(selectedId);
                setRevision((r) => r + 1);
              }}
              onBack={() => {
                router.push(
                  profile.role === "agent" ? "/?view=queue" : `/?view=queue&agent=${agentId ?? ""}`,
                );
              }}
            />
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
