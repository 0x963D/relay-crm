"use client";
import { useEffect, useState, type ReactNode } from "react";
import { api, type Outputs } from "@/lib/api";
import { failureCode, failureMessage } from "@/lib/failures";
import { campaignLabel, shortDate, sourceLabel } from "@/lib/display";
import { Avatar, Empty, Loading, Refusal, Slip } from "./pieces";
import { Icon } from "./icons";
import { Button } from "./ui/button";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "./ui/tabs";
import { Checkbox } from "./ui/checkbox";
import { RadioGroup, RadioGroupItem } from "./ui/radio-group";
import { Card } from "./ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./ui/table";
import type { Remote } from "./queue";
type Pool = Outputs["leads"]["pool"];
type Preview = Outputs["distribution"]["preview"];
type Lead = Outputs["leads"]["get"];
type PreviewState =
  | { kind: "editing" }
  | { kind: "preview"; preview: Preview; rows: Pool["rows"]; at: Date }
  | {
      kind: "stale";
      preview: Preview;
      rows: Pool["rows"];
      at: Date;
      changed: Lead[];
      remaining: string[];
    };
const assignmentKey = (a: { ownerId: string; teamId: string }) => `${a.ownerId}:${a.teamId}`;
export function PoolScreen({
  initialAgents,
  zone,
}: {
  initialAgents: Outputs["leads"]["agents"];
  zone: string;
}) {
  const [remote, setRemote] = useState<Remote<Pool>>({ status: "loading" });
  const [agents, setAgents] = useState(initialAgents);
  const [revision, setRevision] = useState(0);
  const [selected, setSelected] = useState<string[]>([]);
  const [method, setMethod] = useState<"hand" | "round">("hand");
  const [chosen, setChosen] = useState<string[]>(
    initialAgents[0] ? [assignmentKey(initialAgents[0])] : [],
  );
  const [exclude, setExclude] = useState(true);
  const [preview, setPreview] = useState<PreviewState>({ kind: "editing" });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  useEffect(() => {
    const c = new AbortController();
    setRemote({ status: "loading" });
    void Promise.all([
      api.leads.pool.query({ limit: 14, offset: 0 }, { signal: c.signal }),
      api.leads.agents.query({ offset: 0 }, { signal: c.signal }),
    ]).then(
      ([value, people]) => {
        setRemote({ status: "ready", value });
        setAgents(people);
      },
      (error: unknown) => {
        if (!c.signal.aborted) setRemote({ status: "error", error });
      },
    );
    return () => {
      c.abort();
    };
  }, [revision]);
  const pool = remote.status === "ready" ? remote.value : null;
  const rows = preview.kind === "stale" ? preview.rows : (pool?.rows ?? []);
  const recipients = agents.filter((a) => chosen.includes(assignmentKey(a)));
  function invalidate() {
    setPreview({ kind: "editing" });
    setError(null);
    setSuccess(null);
  }
  function toggle(id: string, on: boolean) {
    invalidate();
    setSelected((ids) => (on ? [...new Set([...ids, id])] : ids.filter((v) => v !== id)));
  }
  async function more() {
    if (!pool) return;
    setLoadingMore(true);
    try {
      const next = await api.leads.pool.query({ limit: 14, offset: pool.rows.length });
      setRemote({
        status: "ready",
        value: { total: next.total, rows: [...pool.rows, ...next.rows] },
      });
    } catch (error) {
      setError(failureMessage(error));
    } finally {
      setLoadingMore(false);
    }
  }
  async function makePreview(ids = selected) {
    if (!pool) return;
    setPending(true);
    setError(null);
    setSuccess(null);
    try {
      const result = await api.distribution.preview.mutate({
        leadIds: ids,
        agents: recipients.map(({ ownerId, teamId }) => ({ ownerId, teamId })),
        excludePreviousOwner: exclude,
      });
      setSelected(ids);
      setPreview({ kind: "preview", preview: result, rows: pool.rows, at: new Date() });
    } catch (error) {
      setError(failureMessage(error));
    } finally {
      setPending(false);
    }
  }
  async function assign() {
    if (!pool) return;
    setPending(true);
    setError(null);
    try {
      if (method === "round") {
        if (preview.kind !== "preview") return;
        try {
          await api.distribution.submit.mutate({
            previewId: preview.preview.id,
            fingerprint: preview.preview.fingerprint,
            key: preview.preview.id,
          });
        } catch (error) {
          if (failureCode(error) !== "stalePreview") throw error;
          const current = await Promise.all(
            selected.map((id) => api.leads.get.query({ id }).catch(() => null)),
          );
          const changed = current.filter(
            (lead): lead is Lead => lead !== null && lead.lifecycle.state.status !== "new",
          );
          const remaining = current
            .filter((lead): lead is Lead => lead !== null && lead.lifecycle.state.status === "new")
            .map((lead) => lead.id);
          setPreview({ ...preview, kind: "stale", changed, remaining });
          setRemote({
            status: "ready",
            value: await api.leads.pool.query({
              limit: Math.max(14, Math.min(pool.rows.length, 100)),
              offset: 0,
            }),
          });
          return;
        }
      } else {
        const to = recipients[0];
        if (!to) return;
        await api.leads.assign.mutate({
          leadIds: selected,
          to: { ownerId: to.ownerId, teamId: to.teamId },
        });
      }
      setSuccess(
        `${String(selected.length)} ${selected.length === 1 ? "lead was" : "leads were"} assigned. They appear as not yet called in the receiving agents' queues.`,
      );
      setSelected([]);
      setPreview({ kind: "editing" });
      setRevision((r) => r + 1);
    } catch (error) {
      setError(failureMessage(error));
    } finally {
      setPending(false);
    }
  }
  let previewCard: ReactNode = null;
  if (preview.kind !== "editing")
    previewCard = (
      <Card>
        <div className="row preview-header">
          <h3 className="h3">Preview</h3>
          <span className="sm t2">made {shortDate(preview.at, zone)}</span>
          <span className="sp" />
          <Slip
            kind={preview.kind === "stale" ? "mute" : "canary"}
            icon={preview.kind === "stale" ? "history" : "wait"}
          >
            {preview.kind === "stale" ? "Out of date" : "Not assigned yet"}
          </Slip>
        </div>
        {recipients.map((agent) => {
          const items = preview.preview.items.filter((item) => item.to.ownerId === agent.ownerId);
          return (
            <div className="row preview-person" key={assignmentKey(agent)}>
              <Avatar name={agent.name} />
              <div className="sp">
                <div className="row">
                  <span className="b">{agent.name}</span>
                  <span className="sp" />
                  <span className="sm t2">
                    {items.length} {items.length === 1 ? "lead" : "leads"}
                  </span>
                </div>
                <div className="sm t2">
                  {items
                    .map(
                      (item) =>
                        preview.rows.find((row) => row.id === item.leadId)?.name ?? "Unnamed lead",
                    )
                    .join(", ") || "None"}
                </div>
              </div>
            </div>
          );
        })}
      </Card>
    );
  return (
    <>
      <header className="ph">
        <div>
          <h1>Lead pool</h1>
          <div className="ph-sub">
            {pool ? `${String(pool.total)} leads have no owner` : "New leads waiting for an owner"}
          </div>
        </div>
      </header>
      {success && (
        <div className="sticky-feedback" role="status">
          <Slip kind="green" icon="check">
            Assigned
          </Slip>{" "}
          {success}
        </div>
      )}
      <div className="md workspace-pool">
        <div className="pane pool-list">
          {remote.status === "loading" ? (
            <Loading />
          ) : remote.status === "error" ? (
            <div className="pad">
              <Refusal
                title="The lead pool could not be opened"
                retry={() => {
                  setRevision((r) => r + 1);
                }}
              >
                {failureMessage(remote.error)}
              </Refusal>
            </div>
          ) : pool?.total === 0 && preview.kind !== "stale" ? (
            <Empty icon="inbox" title="Every lead has an owner">
              New leads land here as they arrive from Meta Lead Ads, the web form or a CSV import.
            </Empty>
          ) : (
            <>
              <Table aria-label="Leads waiting for an owner">
                <TableHeader>
                  <TableRow>
                    <TableHead className="check-cell">
                      <span className="check-target">
                        <Checkbox
                          aria-label="Select all shown leads"
                          disabled={pending || preview.kind === "stale"}
                          checked={
                            rows.length > 0 && rows.every((row) => selected.includes(row.id))
                          }
                          onCheckedChange={(v) => {
                            invalidate();
                            setSelected(v === true ? rows.map((row) => row.id) : []);
                          }}
                        />
                      </span>
                    </TableHead>
                    <TableHead>Lead</TableHead>
                    <TableHead>Campaign</TableHead>
                    <TableHead>Source</TableHead>
                    <TableHead>Arrived</TableHead>
                    <TableHead>Previous owner</TableHead>
                    {preview.kind !== "editing" && <TableHead>Goes to</TableHead>}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((row) => {
                    const change =
                      preview.kind === "stale"
                        ? preview.changed.find((lead) => lead.id === row.id)
                        : undefined;
                    const to =
                      preview.kind !== "editing"
                        ? preview.preview.items.find((item) => item.leadId === row.id)?.to
                        : undefined;
                    return (
                      <TableRow
                        key={row.id}
                        aria-selected={selected.includes(row.id) && !change}
                        className={change ? "is-gone" : undefined}
                      >
                        <TableCell className="check-cell">
                          <span className="check-target">
                            <Checkbox
                              aria-label={`Select ${row.name ?? row.email}`}
                              checked={selected.includes(row.id) && !change}
                              disabled={pending || preview.kind === "stale"}
                              onCheckedChange={(v) => {
                                toggle(row.id, v === true);
                              }}
                            />
                          </span>
                        </TableCell>
                        <TableCell>
                          <span className="q-name">{row.name ?? row.email}</span>
                        </TableCell>
                        <TableCell data-label="Campaign" className="t2">
                          {campaignLabel(row.origin?.campaign)}
                        </TableCell>
                        <TableCell data-label="Source" className="t2 sm">
                          {sourceLabel(row.source)}
                        </TableCell>
                        <TableCell data-label="Arrived" className="t2 sm">
                          {shortDate(row.createdAt, zone)}
                        </TableCell>
                        <TableCell data-label="Previous owner" className="sm t2">
                          {row.previousOwner?.name ?? "None"}
                        </TableCell>
                        {preview.kind !== "editing" && (
                          <TableCell>
                            {change ? (
                              <Slip kind="pink" icon="assign">
                                {change.custody.heldBy
                                  ? `With ${change.custody.heldBy.name}`
                                  : "No longer in the pool"}
                              </Slip>
                            ) : to ? (
                              <span className="row">
                                <Icon name="next" size="small" />
                                {agents.find((a) => a.ownerId === to.ownerId)?.name ??
                                  "Selected agent"}
                              </span>
                            ) : (
                              <span className="t3">Not selected</span>
                            )}
                          </TableCell>
                        )}
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
              <div className="row sm t2 pool-pager">
                <span>
                  Showing {rows.length} {preview.kind === "stale" ? "preview rows" : "leads"}
                  {pool && ` of ${String(pool.total)} in the pool`}, newest first
                </span>
                <span className="sp" />
                {pool && pool.rows.length < pool.total && preview.kind !== "stale" && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={loadingMore}
                    onClick={() => {
                      void more();
                    }}
                  >
                    Show more leads
                  </Button>
                )}
              </div>
            </>
          )}
        </div>
        <section className="pane pane--side pad pool-panel" aria-label="Assign leads">
          <h2 className="h2">
            {selected.length
              ? `Assign ${String(selected.length)} ${selected.length === 1 ? "lead" : "leads"}`
              : "Assign leads"}
          </h2>
          <Tabs
            className="pool-tabs"
            value={method}
            onValueChange={(v) => {
              if (v !== "hand" && v !== "round") return;
              invalidate();
              setMethod(v);
              setChosen(
                v === "hand" && agents[0] ? [assignmentKey(agents[0])] : agents.map(assignmentKey),
              );
            }}
          >
            <TabsList className="tabs--fill" aria-label="Assignment method">
              <TabsTrigger value="hand" disabled={pending}>
                <Icon name="assign" size="small" />
                To one person
              </TabsTrigger>
              <TabsTrigger value="round" disabled={pending}>
                <Icon name="shuffle" size="small" />
                Round-robin
              </TabsTrigger>
            </TabsList>
            <TabsContent value={method} className="pool-tab-panel">
              {error && <Refusal title="Nothing was assigned">{error}</Refusal>}
              {preview.kind === "stale" ? (
                <Refusal title="Nothing was assigned">
                  <p>
                    {preview.changed.length
                      ? `${String(preview.changed.length)} of these ${String(selected.length)} leads changed hands after your preview.`
                      : "These leads changed or are no longer visible after your preview."}
                  </p>
                  {preview.changed.map((lead) => (
                    <p key={lead.id}>
                      {lead.custody.assignedBy?.name ?? "A staff member"} assigned{" "}
                      {lead.name ?? "this lead"}
                      {lead.custody.heldBy ? ` to ${lead.custody.heldBy.name}` : ""}
                      {lead.custody.assignedBy?.at
                        ? ` at ${shortDate(lead.custody.assignedBy.at, zone)}`
                        : ""}
                      .
                    </p>
                  ))}
                  <p>
                    {preview.remaining.length} still have no owner. Make a new preview to share them
                    out.
                  </p>
                </Refusal>
              ) : method === "hand" ? (
                <div className="field">
                  <span className="label" id="recipient-label">
                    Who gets them?
                  </span>
                  <RadioGroup
                    className="pool-people"
                    aria-labelledby="recipient-label"
                    value={chosen[0] ?? ""}
                    onValueChange={(v) => {
                      invalidate();
                      setChosen([v]);
                    }}
                  >
                    {agents.map((agent) => (
                      <label
                        className="opt"
                        data-checked={chosen.includes(assignmentKey(agent))}
                        key={assignmentKey(agent)}
                      >
                        <RadioGroupItem value={assignmentKey(agent)} disabled={pending} />
                        <Avatar name={agent.name} />
                        <span className="b">{agent.name}</span>
                        <span className="sm t2">{agent.openCount} in queue</span>
                      </label>
                    ))}
                  </RadioGroup>
                </div>
              ) : (
                <>
                  <div className="field">
                    <span className="label">Share between</span>
                    <div className="share-agents">
                      {agents.map((agent) => (
                        <label className="row" key={assignmentKey(agent)}>
                          <Checkbox
                            disabled={pending}
                            checked={chosen.includes(assignmentKey(agent))}
                            onCheckedChange={(v) => {
                              invalidate();
                              setChosen((ids) =>
                                v === true
                                  ? [...ids, assignmentKey(agent)]
                                  : ids.filter((id) => id !== assignmentKey(agent)),
                              );
                            }}
                          />
                          <Avatar name={agent.name} />
                          <span className="b">{agent.name}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                  <label className="row">
                    <Checkbox
                      disabled={pending}
                      checked={exclude}
                      onCheckedChange={(v) => {
                        invalidate();
                        setExclude(v === true);
                      }}
                    />
                    <span className="b">Skip a lead's previous owner</span>
                  </label>
                </>
              )}
              {previewCard}
              {preview.kind !== "stale" && (
                <p className="help">
                  {method === "hand"
                    ? "Only agents have a queue, so only agents are listed. Assigned leads land in their queue as not yet called. Moving a lead to someone else later keeps its status."
                    : "Nothing moves until you confirm. If one of these leads changes hands first, the preview is refused and nothing is assigned."}
                </p>
              )}
              <div className="pool-submit col">
                {preview.kind === "stale" ? (
                  <>
                    <Button
                      className="btn--block"
                      size="lg"
                      disabled={pending || preview.remaining.length === 0}
                      onClick={() => {
                        void makePreview(preview.remaining);
                      }}
                    >
                      <Icon name="refresh" />
                      Preview the remaining {preview.remaining.length} leads
                    </Button>
                    <Button
                      variant="ghost"
                      onClick={() => {
                        invalidate();
                        setSelected([]);
                        setRevision((r) => r + 1);
                      }}
                    >
                      Cancel
                    </Button>
                  </>
                ) : method === "round" && preview.kind === "editing" ? (
                  <Button
                    size="lg"
                    className="btn--block"
                    disabled={pending || selected.length === 0 || chosen.length === 0}
                    onClick={() => {
                      void makePreview();
                    }}
                  >
                    Preview {selected.length} leads
                  </Button>
                ) : (
                  <Button
                    size="lg"
                    className="btn--block"
                    disabled={
                      pending ||
                      selected.length === 0 ||
                      chosen.length === 0 ||
                      remote.status !== "ready"
                    }
                    onClick={() => {
                      void assign();
                    }}
                  >
                    {pending
                      ? "Assigning…"
                      : `Assign ${String(selected.length)} ${selected.length === 1 ? "lead" : "leads"}${method === "hand" && recipients[0] ? ` to ${recipients[0].name}` : ""}`}
                  </Button>
                )}
              </div>
            </TabsContent>
          </Tabs>
        </section>
      </div>
    </>
  );
}
