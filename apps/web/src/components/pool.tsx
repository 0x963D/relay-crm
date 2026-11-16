"use client";
import { useEffect, useState, useRef, type ReactNode } from "react";
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
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { reads, readState } from "@/lib/reads";
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
  onTotalChange,
}: {
  initialAgents: Outputs["leads"]["agents"];
  zone: string;
  onTotalChange: (total: number) => void;
}) {
  const feedback = useRef<HTMLDivElement>(null);
  const refusal = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLElement>(null);
  const client = useQueryClient();
  const query = useQuery(reads.pool());
  const people = useQuery(reads.agents());
  const agents = people.data ?? initialAgents;
  const remote = readState(query);
  const refresh = () =>
    Promise.all([
      client.invalidateQueries({ queryKey: ["pool"] }),
      client.invalidateQueries({ queryKey: ["agents"] }),
      client.invalidateQueries({ queryKey: ["queue"] }),
    ]);
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
  const [moreError, setMoreError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const pool = remote.status === "ready" ? remote.value : null;
  useEffect(() => {
    if (pool) onTotalChange(pool.total);
  }, [pool, onTotalChange]);
  const rows = preview.kind === "stale" ? preview.rows : (pool?.rows ?? []);
  const recipients = agents.filter((a) => chosen.includes(assignmentKey(a)));
  function invalidate() {
    setPreview({ kind: "editing" });
    setError(null);
    setSuccess(null);
  }
  function toggle(id: string, on: boolean) {
    invalidate();
    if (on && selected.length >= 100) {
      setError("Select at most 100 leads at a time. Assign these leads before selecting more.");
      return;
    }
    setSelected((ids) => (on ? [...new Set([...ids, id])] : ids.filter((v) => v !== id)));
  }
  async function more() {
    if (!pool) return;
    setLoadingMore(true);
    setMoreError(null);
    try {
      const next = await client.query(reads.pool({ limit: 14, offset: pool.rows.length }));
      client.setQueryData(reads.pool().queryKey, {
        total: next.total,
        oldestAt: next.oldestAt,
        rows: [...pool.rows, ...next.rows],
      });
    } catch (error) {
      setMoreError(failureMessage(error, "read"));
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
            selected.map((id) => client.query({ ...reads.lead(id), staleTime: 0 })),
          );
          const changed = current.filter(
            (lead): lead is Lead => lead.lifecycle.state.status !== "new",
          );
          const remaining = current
            .filter((lead): lead is Lead => lead.lifecycle.state.status === "new")
            .map((lead) => lead.id);
          setPreview({ ...preview, kind: "stale", changed, remaining });
          await refresh();
          requestAnimationFrame(() => {
            const retry = panel.current?.querySelector<HTMLElement>(
              "[data-repreview]:not([disabled])",
            );
            (retry ?? refusal.current)?.focus();
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
      await refresh();
      requestAnimationFrame(() => {
        feedback.current?.focus();
      });
    } catch (error) {
      setError(failureMessage(error));
    } finally {
      setPending(false);
    }
  }
  let previewCard: ReactNode = null;
  if (preview.kind !== "editing")
    previewCard = (
      <Card className="data-[stale=true]:opacity-85" data-stale={preview.kind === "stale"}>
        <div className="row flex items-center max-phone:[.lead-body_&]:flex-wrap max-phone:[.pool-panel_label&]:min-h-[44px] preview-header p-[9px_12px] flex-nowrap gap-compact">
          <h3 className="h3 text-(length:--text-body) leading-[20px] font-[650]">Preview</h3>
          <span className="sm text-(length:--text-small) leading-[18px] [.demo-choices_&]:font-[400] [.pool-people_&]:ms-auto [.preview-person_&]:[overflow-wrap:anywhere] [.preview-header_>_&]:text-(length:--text-caption) [.preview-header_>_&]:whitespace-nowrap t2 text-secondary [.alert--refused_&]:text-refused-foreground">
            made {shortDate(preview.at, zone)}
          </span>
          <span className="sp flex-1 max-laptop:[.lead-title_&]:hidden max-phone:[.q-top_&]:hidden phone:max-poolcompact:[.q-top_&]:hidden" />
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
            <div
              className="row flex max-phone:[.lead-body_&]:flex-wrap max-phone:[.pool-panel_label&]:min-h-[44px] preview-person p-[9px_12px] [border-block-start:1px_solid_var(--color-rule)] items-start gap-control"
              key={assignmentKey(agent)}
            >
              <Avatar name={agent.name} />
              <div className="sp flex-1 max-laptop:[.lead-title_&]:hidden max-phone:[.q-top_&]:hidden phone:max-poolcompact:[.q-top_&]:hidden">
                <div className="row flex items-center gap-related max-phone:[.lead-body_&]:flex-wrap max-phone:[.pool-panel_label&]:min-h-[44px]">
                  <span className="b font-[620]">{agent.name}</span>
                  <span className="sp flex-1 max-laptop:[.lead-title_&]:hidden max-phone:[.q-top_&]:hidden phone:max-poolcompact:[.q-top_&]:hidden" />
                  <span className="sm text-(length:--text-small) leading-[18px] [.demo-choices_&]:font-[400] [.pool-people_&]:ms-auto [.preview-person_&]:[overflow-wrap:anywhere] [.preview-header_>_&]:text-(length:--text-caption) [.preview-header_>_&]:whitespace-nowrap t2 text-secondary [.alert--refused_&]:text-refused-foreground">
                    {items.length} {items.length === 1 ? "lead" : "leads"}
                  </span>
                </div>
                <div className="sm text-(length:--text-small) leading-[18px] [.demo-choices_&]:font-[400] [.pool-people_&]:ms-auto [.preview-person_&]:[overflow-wrap:anywhere] [.preview-header_>_&]:text-(length:--text-caption) [.preview-header_>_&]:whitespace-nowrap t2 text-secondary [.alert--refused_&]:text-refused-foreground">
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
      <header className="ph flex items-end gap-content p-[18px_24px_14px] [border-block-end:1px_solid_var(--color-rule)] [&_h1]:text-(length:--text-title) [&_h1]:leading-[30px] [&_h1]:font-[720] [&_h1]:[font-variation-settings:'wdth'_84] [&_h1]:[letter-spacing:0] [&_h1]:whitespace-nowrap max-phone:p-[16px_16px_10px] max-phone:items-start max-phone:flex-wrap max-phone:gap-related max-phone:[&_h1]:[font-size:24px] max-phone:[&_h1]:leading-[28px]">
        <div>
          <h1>Lead pool</h1>
          <div className="ph-sub text-(length:--text-small) text-secondary mt-[2px] max-phone:text-(length:--text-small)">
            {pool
              ? `${String(pool.total)} ${pool.total === 1 ? "lead has" : "leads have"} no owner${pool.oldestAt ? ` · the oldest has waited since ${shortDate(pool.oldestAt, zone)}` : ""}`
              : "New leads waiting for an owner"}
          </div>
        </div>
      </header>
      <div ref={feedback} role="status" aria-live="polite" aria-atomic="true" tabIndex={-1}>
        {success && (
          <div className="sticky-feedback p-[12px_24px] [border-block-end:1px_solid_var(--color-rule)]">
            <Icon name="check" /> {success}
          </div>
        )}
      </div>
      <div
        className="md grid flex-1 min-h-0 max-phone:block workspace-pool [grid-template-columns:minmax(0,_1fr)_var(--pool-width)] max-laptop:[grid-template-columns:minmax(0,_1fr)_340px] max-pane:[grid-template-columns:minmax(0,_1fr)] max-pane:overflow-auto [&[data-has-pool='false']]:[grid-template-columns:1fr]"
        data-has-pool={remote.status === "ready" && (pool?.total !== 0 || preview.kind === "stale")}
      >
        <div className="pane min-w-0 min-h-0 flex flex-col pool-list overflow-auto max-phone:overflow-visible max-phone:[&_thead]:hidden max-phone:[&_thead]:w-full max-phone:[&_tbody]:block max-phone:[&_tbody]:w-full max-phone:[&_tr]:grid max-phone:[&_tr]:w-full max-phone:[&_tr]:[grid-template-columns:44px_minmax(0,_1fr)] max-phone:[&_tr]:p-[8px_16px] max-phone:[&_tr]:[border-block-end:1px_solid_var(--color-rule)] max-phone:[&_td]:block max-phone:[&_td]:w-full max-phone:[&_td]:border-0 max-phone:[&_td]:h-auto max-phone:[&_td]:max-w-[none] max-phone:[&_td]:p-[2px_4px] max-phone:[&_td[data-label]::before]:[content:attr(data-label)_':_'] max-phone:[&_td[data-label]::before]:text-tertiary phone:max-poolwide:[&_[data-column='campaign']]:hidden phone:max-poolcompact:[&_[data-column='source']]:hidden phone:max-poolcompact:[&_[data-column='arrived']]:hidden">
          {query.isError && query.data && (
            <Refusal
              title="The latest pool could not be loaded"
              retry={() => {
                void query.refetch();
              }}
            >
              {failureMessage(query.error, "read")}
            </Refusal>
          )}
          {moreError && (
            <Refusal
              title="More leads could not be loaded"
              retry={() => {
                void more();
              }}
            >
              {moreError}
            </Refusal>
          )}
          {remote.status === "loading" ? (
            <Loading />
          ) : remote.status === "error" ? (
            <div className="pad p-[18px_24px] max-phone:p-content">
              <Refusal
                title="The lead pool could not be opened"
                retry={() => {
                  void refresh();
                }}
              >
                {failureMessage(remote.error, "read")}
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
                    <TableHead className="check-cell [.pool-list_.tbl_&]:w-[44px] phone:[.pool-list_.tbl_&]:px-[16px_4px] max-phone:[.pool-list_&]:[grid-row:1/7] max-phone:[.pool-list_.tbl_&]:p-0 max-phone:[.pool-list_td:not(&)]:[grid-column:2]">
                      <label className="check-target inline-flex items-center justify-center min-w-[28px] min-h-[28px] max-phone:min-w-[44px] max-phone:min-h-[44px]">
                        <Checkbox
                          aria-label="Select all shown leads"
                          disabled={pending || preview.kind === "stale"}
                          checked={
                            rows.length > 0 && rows.every((row) => selected.includes(row.id))
                          }
                          onCheckedChange={(v) => {
                            invalidate();
                            setSelected(v === true ? rows.slice(0, 100).map((row) => row.id) : []);
                          }}
                        />
                      </label>
                    </TableHead>
                    <TableHead>Lead</TableHead>
                    <TableHead data-column="campaign">Campaign</TableHead>
                    <TableHead data-column="source">Source</TableHead>
                    <TableHead data-column="arrived">Arrived</TableHead>
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
                        className={change ? "is-gone [.tbl_tbody_tr&_td]:text-tertiary" : undefined}
                      >
                        <TableCell className="check-cell [.pool-list_.tbl_&]:w-[44px] phone:[.pool-list_.tbl_&]:px-[16px_4px] max-phone:[.pool-list_&]:[grid-row:1/7] max-phone:[.pool-list_.tbl_&]:p-0 max-phone:[.pool-list_td:not(&)]:[grid-column:2]">
                          <label className="check-target inline-flex items-center justify-center min-w-[28px] min-h-[28px] max-phone:min-w-[44px] max-phone:min-h-[44px]">
                            <Checkbox
                              aria-label={`Select ${row.name ?? row.email}`}
                              checked={selected.includes(row.id) && !change}
                              disabled={pending || preview.kind === "stale"}
                              onCheckedChange={(v) => {
                                toggle(row.id, v === true);
                              }}
                            />
                          </label>
                        </TableCell>
                        <TableCell>
                          <span className="q-name font-[620] [overflow-wrap:anywhere] [.tbl_tbody_tr.is-gone_&]:[text-decoration:line-through] [.tbl_tbody_tr.is-gone_&]:font-[500] max-phone:[order:0] [.pool-list_&]:whitespace-nowrap [.pool-list_&]:[overflow-wrap:normal] phone:max-poolcompact:[flex-basis:100%] max-phone:[.pool-list_&]:whitespace-nowrap">
                            {row.name ?? row.email}
                          </span>
                        </TableCell>
                        <TableCell
                          data-column="campaign"
                          data-label="Campaign"
                          className="t2 text-secondary [.alert--refused_&]:text-refused-foreground"
                        >
                          {campaignLabel(row.origin?.campaign)}
                        </TableCell>
                        <TableCell
                          data-column="source"
                          data-label="Source"
                          className="t2 text-secondary [.alert--refused_&]:text-refused-foreground sm text-(length:--text-small) leading-[18px] [.demo-choices_&]:font-[400] [.pool-people_&]:ms-auto [.preview-person_&]:[overflow-wrap:anywhere] [.preview-header_>_&]:text-(length:--text-caption) [.preview-header_>_&]:whitespace-nowrap"
                        >
                          {sourceLabel(row.source)}
                        </TableCell>
                        <TableCell
                          data-column="arrived"
                          data-label="Arrived"
                          className="t2 text-secondary [.alert--refused_&]:text-refused-foreground sm text-(length:--text-small) leading-[18px] [.demo-choices_&]:font-[400] [.pool-people_&]:ms-auto [.preview-person_&]:[overflow-wrap:anywhere] [.preview-header_>_&]:text-(length:--text-caption) [.preview-header_>_&]:whitespace-nowrap"
                        >
                          {shortDate(row.createdAt, zone)}
                        </TableCell>
                        <TableCell
                          data-label="Previous owner"
                          className="sm text-(length:--text-small) leading-[18px] [.demo-choices_&]:font-[400] [.pool-people_&]:ms-auto [.preview-person_&]:[overflow-wrap:anywhere] [.preview-header_>_&]:text-(length:--text-caption) [.preview-header_>_&]:whitespace-nowrap t2 text-secondary [.alert--refused_&]:text-refused-foreground"
                        >
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
                              <span className="row flex items-center gap-related max-phone:[.lead-body_&]:flex-wrap max-phone:[.pool-panel_label&]:min-h-[44px]">
                                <Icon name="next" size="small" />
                                {agents.find((a) => a.ownerId === to.ownerId)?.name ??
                                  "Selected agent"}
                              </span>
                            ) : (
                              <span className="t3 text-tertiary">Not selected</span>
                            )}
                          </TableCell>
                        )}
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
              <div className="row flex items-center gap-related max-phone:[.lead-body_&]:flex-wrap max-phone:[.pool-panel_label&]:min-h-[44px] sm text-(length:--text-small) leading-[18px] [.demo-choices_&]:font-[400] [.pool-people_&]:ms-auto [.preview-person_&]:[overflow-wrap:anywhere] [.preview-header_>_&]:text-(length:--text-caption) [.preview-header_>_&]:whitespace-nowrap t2 text-secondary [.alert--refused_&]:text-refused-foreground pool-pager p-[12px_16px] flex-wrap">
                <span>
                  {preview.kind === "stale"
                    ? `Showing ${String(rows.length)} rows from the refused preview. ${String(pool?.total ?? 0)} leads remain in the pool.`
                    : `Showing ${String(rows.length)} of ${String(pool?.total ?? 0)} leads in the pool, newest first`}
                </span>
                <span className="sp flex-1 max-laptop:[.lead-title_&]:hidden max-phone:[.q-top_&]:hidden phone:max-poolcompact:[.q-top_&]:hidden" />
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
        {remote.status === "ready" && (pool?.total !== 0 || preview.kind === "stale") && (
          <section
            ref={panel}
            className="pane min-w-0 min-h-0 overflow-hidden flex flex-col max-phone:overflow-visible pane--side [border-inline-start:1px_solid_var(--color-rule)] max-pane:[.workspace-queue_&]:hidden max-pane:[.workspace-queue[data-detail='true']_&]:flex max-pane:[.workspace-queue[data-detail='true']_&]:border-0 max-phone:[.workspace-queue_&]:hidden max-phone:[.workspace-queue[data-detail='true']_&]:flex pad p-[18px_24px] pool-panel gap-[14px] overflow-y-auto max-pane:[border-inline-start:0] max-pane:[border-block-start:1px_solid_var(--color-rule)] max-pane:overflow-visible max-phone:p-content"
            aria-label="Assign leads"
            aria-busy={pending}
          >
            <h2 className="h2 text-(length:--text-panel) leading-[22px] font-[700] [font-variation-settings:'wdth'_86] [.pool-panel_&]:flex-none">
              {selected.length
                ? `Assign ${String(selected.length)} ${selected.length === 1 ? "lead" : "leads"}`
                : "Assign leads"}
            </h2>
            <Tabs
              className="pool-tabs flex flex-col gap-[14px] flex-1 min-h-0"
              value={method}
              onValueChange={(v) => {
                if (v !== "hand" && v !== "round") return;
                invalidate();
                setMethod(v);
                setChosen(
                  v === "hand" && agents[0]
                    ? [assignmentKey(agents[0])]
                    : agents.map(assignmentKey),
                );
              }}
            >
              <TabsList
                className="tabs--fill flex [&_button]:flex-1 [&_button]:justify-center"
                aria-label="Assignment method"
              >
                <TabsTrigger value="hand" disabled={pending}>
                  <Icon name="assign" size="small" />
                  To one person
                </TabsTrigger>
                <TabsTrigger value="round" disabled={pending}>
                  <Icon name="shuffle" size="small" />
                  Round-robin
                </TabsTrigger>
              </TabsList>
              <TabsContent
                value={method}
                className="pool-tab-panel flex flex-col gap-[14px] flex-1 min-h-0"
              >
                <div
                  ref={refusal}
                  tabIndex={-1}
                  role="alert"
                  aria-live="assertive"
                  aria-atomic="true"
                >
                  {error && (
                    <Refusal announce={false} title="Nothing was assigned">
                      {error}
                    </Refusal>
                  )}
                  {preview.kind === "stale" ? (
                    <Refusal announce={false} title="Nothing was assigned">
                      <p>
                        {preview.changed.length
                          ? `${String(preview.changed.length)} of these ${String(selected.length)} leads changed hands after your preview.`
                          : "These leads changed or are no longer visible after your preview."}
                      </p>
                      {[
                        ...Map.groupBy(
                          preview.changed,
                          (lead) =>
                            `${lead.custody.assignedBy?.name ?? "A staff member"}|${lead.custody.heldBy?.name ?? ""}|${lead.custody.assignedBy?.at ? shortDate(lead.custody.assignedBy.at, zone) : ""}`,
                        ).entries(),
                      ].map(([key, leads]) => {
                        const [by, to, at] = key.split("|");
                        return (
                          <p key={key}>
                            {by} assigned{" "}
                            {new Intl.ListFormat("en-GB", {
                              style: "long",
                              type: "conjunction",
                            }).format(leads.map((lead) => lead.name ?? "an unnamed lead"))}
                            {to ? ` to ${to}` : ""}
                            {at ? ` at ${at}` : ""}.
                          </p>
                        );
                      })}
                      <p>
                        {preview.remaining.length} still have no owner. Make a new preview to share
                        them out.
                      </p>
                    </Refusal>
                  ) : null}
                </div>
                {preview.kind !== "stale" &&
                  (method === "hand" ? (
                    <div className="field flex flex-col gap-compact">
                      <span
                        className="label text-(length:--text-small) font-[600]"
                        id="recipient-label"
                      >
                        Who gets them?
                      </span>
                      <RadioGroup
                        className="pool-people flex flex-col gap-compact"
                        aria-labelledby="recipient-label"
                        value={chosen[0] ?? ""}
                        onValueChange={(v) => {
                          invalidate();
                          setChosen([v]);
                        }}
                      >
                        {agents.map((agent) => (
                          <label
                            className="opt flex items-center gap-control min-h-[40px] p-[8px_10px] border-[1px] border-solid border-rule rounded-control [&[data-checked='true']]:border-primary [&[data-checked='true']]:bg-selected [.pool-people_&]:min-h-[44px] [.pool-people_&]:py-compact"
                            data-checked={chosen.includes(assignmentKey(agent))}
                            key={assignmentKey(agent)}
                          >
                            <RadioGroupItem value={assignmentKey(agent)} disabled={pending} />
                            <Avatar name={agent.name} />
                            <span className="b font-[620]">{agent.name}</span>
                            <span className="sm text-(length:--text-small) leading-[18px] [.demo-choices_&]:font-[400] [.pool-people_&]:ms-auto [.preview-person_&]:[overflow-wrap:anywhere] [.preview-header_>_&]:text-(length:--text-caption) [.preview-header_>_&]:whitespace-nowrap t2 text-secondary [.alert--refused_&]:text-refused-foreground">
                              {agent.openCount} in queue
                            </span>
                          </label>
                        ))}
                      </RadioGroup>
                    </div>
                  ) : (
                    <>
                      <div className="field flex flex-col gap-compact">
                        <span className="label text-(length:--text-small) font-[600]">
                          Share between
                        </span>
                        <div className="share-agents grid [grid-template-columns:1fr_1fr] gap-[0_12px] [&_label]:min-h-[32px] max-phone:[&_label]:min-h-[44px]">
                          {agents.map((agent) => (
                            <label
                              className="row flex items-center gap-related max-phone:[.lead-body_&]:flex-wrap max-phone:[.pool-panel_label&]:min-h-[44px]"
                              key={assignmentKey(agent)}
                            >
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
                              <span className="b font-[620]">{agent.name}</span>
                            </label>
                          ))}
                        </div>
                      </div>
                      <label className="row flex items-center gap-related max-phone:[.lead-body_&]:flex-wrap max-phone:[.pool-panel_label&]:min-h-[44px]">
                        <Checkbox
                          disabled={pending}
                          checked={exclude}
                          onCheckedChange={(v) => {
                            invalidate();
                            setExclude(v === true);
                          }}
                        />
                        <span className="b font-[620]">Skip a lead's previous owner</span>
                      </label>
                    </>
                  ))}
                {previewCard}
                {preview.kind === "preview" &&
                  exclude &&
                  preview.preview.items.some(
                    (item) =>
                      preview.rows.find((row) => row.id === item.leadId)?.previousOwner &&
                      recipients.some(
                        (agent) =>
                          agent.ownerId ===
                          preview.rows.find((row) => row.id === item.leadId)?.previousOwner?.id,
                      ),
                  ) && (
                    <p className="help text-(length:--text-caption) leading-[16px] text-tertiary [.composer_&]:flex-1">
                      Each lead skips its previous owner and goes to the next eligible agent.
                    </p>
                  )}
                {preview.kind !== "stale" && (
                  <p className="help text-(length:--text-caption) leading-[16px] text-tertiary [.composer_&]:flex-1">
                    {method === "hand"
                      ? "Only agents have a queue, so only agents are listed. Assigned leads land in their queue as not yet called. Moving a lead to someone else later keeps its status."
                      : "Nothing moves until you confirm. If one of these leads changes hands first, the preview is refused and nothing is assigned."}
                  </p>
                )}
                <div className="pool-submit mt-auto flex-none max-pane:mt-content col flex flex-col">
                  {preview.kind === "stale" ? (
                    <>
                      <Button
                        className="btn--block w-full [.sign-sheet_&]:flex max-phone:[.pool-panel_&]:min-h-[44px]"
                        size="lg"
                        data-repreview
                        disabled={pending || preview.remaining.length === 0}
                        onClick={() => {
                          void makePreview(preview.remaining);
                        }}
                      >
                        <Icon name="refresh" />
                        Preview the remaining {preview.remaining.length}{" "}
                        {preview.remaining.length === 1 ? "lead" : "leads"}
                      </Button>
                      <Button
                        variant="ghost"
                        onClick={() => {
                          invalidate();
                          setSelected([]);
                          void refresh();
                        }}
                      >
                        Cancel
                      </Button>
                    </>
                  ) : method === "round" && preview.kind === "editing" ? (
                    <Button
                      size="lg"
                      className="btn--block w-full [.sign-sheet_&]:flex max-phone:[.pool-panel_&]:min-h-[44px]"
                      disabled={pending || selected.length === 0 || chosen.length === 0}
                      onClick={() => {
                        void makePreview();
                      }}
                    >
                      Preview {selected.length} {selected.length === 1 ? "lead" : "leads"}
                    </Button>
                  ) : (
                    <Button
                      size="lg"
                      className="btn--block w-full [.sign-sheet_&]:flex max-phone:[.pool-panel_&]:min-h-[44px]"
                      disabled={pending || selected.length === 0 || chosen.length === 0}
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
        )}
      </div>
    </>
  );
}
