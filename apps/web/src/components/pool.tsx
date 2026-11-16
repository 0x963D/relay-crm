"use client";
import { useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useTRPC, useTRPCClient } from "@/lib/trpc/client";
import { usePagedQuery } from "@/lib/trpc/use-paged-query";
import { failureCode, failureMessage } from "@/lib/failures";
import { callbackDate, campaignLabel, sourceLabel } from "@/lib/display";
import { cn } from "@/lib/utils";
import { Avatar, Empty, Loading, PageHeader, Refusal, Slip } from "./pieces";
import { Icon } from "./icons";
import { Button } from "./ui/button";
import { ShowMore } from "./show-more";
import { Checkbox } from "./ui/checkbox";
import { Field } from "./ui/field";
import { NativeSelect } from "./ui/native-select";
import { RadioGroup, RadioGroupItem } from "./ui/radio-group";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "./ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./ui/table";
import { assignmentKey, type Plan } from "@/lib/assignment";
import { AssignmentPreview, StaleAssignment } from "./assignment-preview";
export function PoolScreen({ zone }: { zone: string }) {
  const trpc = useTRPC();
  const api = useTRPCClient();
  const client = useQueryClient();
  const [limit, setLimit] = useState(14);
  const pageQuery = usePagedQuery(trpc.leads.pool.queryOptions({ limit, offset: 0 }), "pool", {
    limit,
    read: (page, signal) => api.leads.pool.query(page, { signal }),
    merge: (a, b) => ({ ...b, rows: [...a.rows, ...b.rows] }),
  });
  const pool = pageQuery.data;
  const { data: agents } = useSuspenseQuery(trpc.leads.agents.queryOptions({ offset: 0 }));
  const [selected, setSelected] = useState<string[]>([]);
  const [method, setMethod] = useState<"hand" | "round">("hand");
  const [chosen, setChosen] = useState<string[]>(agents[0] ? [assignmentKey(agents[0])] : []);
  const [exclude, setExclude] = useState(true);
  const [plan, setPlan] = useState<Plan>({ kind: "editing" });
  const [message, setMessage] = useState<{ kind: "success" | "error"; text: string } | null>(null);
  const [mobilePanel, setMobilePanel] = useState(false);
  const feedback = useRef<HTMLDivElement>(null);
  const refusal = useRef<HTMLDivElement>(null);
  const previewHeading = useRef<HTMLHeadingElement>(null);
  const panelHeading = useRef<HTMLHeadingElement>(null);
  const retry = useRef<HTMLButtonElement>(null);
  const rows = plan.kind === "stale" ? plan.rows : (pool?.rows ?? []);
  const recipients = agents.filter((agent) => chosen.includes(assignmentKey(agent)));
  const people = agents
    .filter(
      (agent, index) => agents.findIndex((other) => other.ownerId === agent.ownerId) === index,
    )
    .map((agent) => recipients.find((recipient) => recipient.ownerId === agent.ownerId) ?? agent);
  useEffect(() => {
    if (message?.kind === "success") feedback.current?.focus();
    if (message?.kind === "error") refusal.current?.focus();
  }, [message]);
  useEffect(() => {
    if (plan.kind === "preview") previewHeading.current?.focus();
    if (plan.kind === "stale") (retry.current ?? refusal.current)?.focus();
  }, [plan]);
  useEffect(() => {
    if (mobilePanel) panelHeading.current?.focus();
  }, [mobilePanel]);
  async function refresh() {
    await Promise.all([
      client.invalidateQueries({ queryKey: trpc.leads.pool.queryKey() }),
      client.invalidateQueries({ queryKey: trpc.leads.agents.queryKey() }),
      ...recipients.map((agent) =>
        client.invalidateQueries({
          queryKey: trpc.leads.queue.queryKey({ agentId: agent.ownerId }),
        }),
      ),
      ...selected.map((id) =>
        client.invalidateQueries({ queryKey: trpc.leads.get.queryKey({ id }) }),
      ),
    ]);
  }
  async function failed(error: unknown) {
    setMessage({ kind: "error", text: failureMessage(error) });
    if (failureCode(error)) await refresh();
  }
  function edit() {
    setPlan({ kind: "editing" });
    setMessage(null);
  }
  function toggle(id: string, on: boolean) {
    edit();
    if (on && selected.length >= 100) {
      setMessage({
        kind: "error",
        text: "Select at most 100 leads at a time. Assign these leads before selecting more.",
      });
      return;
    }
    setSelected((ids) => (on ? [...new Set([...ids, id])] : ids.filter((value) => value !== id)));
  }
  const previewMutation = useMutation(
    trpc.distribution.preview.mutationOptions({
      onError: failed,
      onSuccess: (preview, input) => {
        setSelected(input.leadIds);
        setPlan({ kind: "preview", preview, rows, at: new Date() });
      },
    }),
  );
  async function assigned() {
    const names = [...new Set(recipients.map((agent) => agent.name))];
    const destination =
      names.length === 1 ? `${String(names[0])}'s queue` : "the receiving agents' queues";
    setMessage({
      kind: "success",
      text: `${String(selected.length)} ${selected.length === 1 ? "lead was" : "leads were"} assigned. ${selected.length === 1 ? "It appears" : "They appear"} as not yet called in ${destination}.`,
    });
    setSelected([]);
    setPlan({ kind: "editing" });
    setMobilePanel(false);
    await refresh();
  }
  const assignMutation = useMutation(
    trpc.leads.assign.mutationOptions({ onError: failed, onSuccess: assigned }),
  );
  const submitMutation = useMutation(
    trpc.distribution.submit.mutationOptions({
      onSuccess: assigned,
      onError: async (error) => {
        if (failureCode(error) !== "stalePreview" || plan.kind !== "preview") {
          await failed(error);
          return;
        }
        const current = await Promise.allSettled(
          selected.map((id) => client.query(trpc.leads.get.queryOptions({ id }, { staleTime: 0 }))),
        );
        const readable = current.flatMap((result) =>
          result.status === "fulfilled" ? [result.value] : [],
        );
        setPlan({
          ...plan,
          kind: "stale",
          changed: readable.filter((lead) => lead.lifecycle.state.status !== "new"),
          remaining: readable
            .filter((lead) => lead.lifecycle.state.status === "new")
            .map((lead) => lead.id),
        });
        await refresh();
      },
    }),
  );
  const busy = previewMutation.isPending || assignMutation.isPending || submitMutation.isPending;
  function makePreview(ids = selected) {
    if (busy) return;
    setMessage(null);
    previewMutation.mutate({
      leadIds: ids,
      agents: recipients.map(({ ownerId, teamId }) => ({ ownerId, teamId })),
      excludePreviousOwner: exclude,
    });
  }
  function assign() {
    if (busy) return;
    setMessage(null);
    if (method === "round" && plan.kind === "preview")
      submitMutation.mutate({
        previewId: plan.preview.id,
        fingerprint: plan.preview.fingerprint,
        key: plan.preview.id,
      });
    else if (method === "hand" && recipients[0])
      assignMutation.mutate({
        leadIds: selected,
        to: { ownerId: recipients[0].ownerId, teamId: recipients[0].teamId },
      });
  }
  if (!pool) {
    if (pageQuery.error)
      return (
        <Refusal title="The pool could not be loaded" retry={() => void pageQuery.refetch()}>
          {failureMessage(pageQuery.error, "read")}
        </Refusal>
      );
    return <Loading label="Loading pool" />;
  }
  const hasMore = pool.rows.length < pool.total;
  return (
    <>
      <PageHeader title="Lead pool">
        {pool.total} {pool.total === 1 ? "lead has" : "leads have"} no owner
        {pool.oldestAt ? ` · the oldest has waited since ${callbackDate(pool.oldestAt, zone)}` : ""}
      </PageHeader>
      <div ref={feedback} role="status" aria-live="polite" aria-atomic="true" tabIndex={-1}>
        {message?.kind === "success" && (
          <p className="flex items-start gap-2 border-b bg-complete px-6 py-3 text-complete-foreground">
            <Icon name="check" />
            {message.text}
          </p>
        )}
      </div>
      <div className="flex min-h-0 flex-1">
        <section
          aria-label="Lead pool"
          className={cn(
            "@container/pool min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain",
            mobilePanel && "hidden md:block",
          )}
        >
          {pool.total === 0 && plan.kind !== "stale" ? (
            <Empty icon="inbox" title="The pool is empty">
              New enquiries appear here until they have an owner.
            </Empty>
          ) : (
            <Table className="table-fixed" aria-label="Unassigned leads">
              <TableHeader>
                <TableRow>
                  <TableHead className="w-16 ps-4 md:w-11">
                    <Checkbox
                      aria-label="Select all visible leads"
                      disabled={busy || plan.kind === "stale"}
                      checked={rows.length > 0 && rows.every((row) => selected.includes(row.id))}
                      onCheckedChange={(value) => {
                        edit();
                        setSelected(value === true ? rows.slice(0, 100).map((row) => row.id) : []);
                      }}
                    />
                  </TableHead>
                  <TableHead>Lead</TableHead>
                  <TableHead className="hidden @xl/pool:table-cell">Campaign</TableHead>
                  <TableHead className="hidden @3xl/pool:table-cell">Source</TableHead>
                  <TableHead className="hidden @2xl/pool:table-cell">Arrived</TableHead>
                  <TableHead className="hidden @3xl/pool:table-cell">Previous owner</TableHead>
                  {plan.kind !== "editing" && <TableHead>Goes to</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => {
                  const changed =
                    plan.kind === "stale"
                      ? plan.changed.find((lead) => lead.id === row.id)
                      : undefined;
                  const destination =
                    plan.kind !== "editing"
                      ? plan.preview.items.find((item) => item.leadId === row.id)?.to
                      : undefined;
                  const person = agents.find(
                    (agent) =>
                      agent.ownerId === destination?.ownerId && agent.teamId === destination.teamId,
                  );
                  return (
                    <TableRow
                      key={row.id}
                      data-state={selected.includes(row.id) && !changed ? "selected" : undefined}
                      className={cn(
                        "h-11 data-[state=selected]:bg-accent",
                        changed && "text-muted-foreground",
                      )}
                    >
                      <TableCell className="ps-4 align-top">
                        <Checkbox
                          aria-label={`Select ${row.name ?? row.email}`}
                          checked={selected.includes(row.id) && !changed}
                          disabled={busy || plan.kind === "stale"}
                          onCheckedChange={(value) => {
                            toggle(row.id, value === true);
                          }}
                        />
                      </TableCell>
                      <TableCell className="whitespace-normal">
                        <span className={cn("font-semibold", changed && "line-through")}>
                          {row.name ?? row.email}
                        </span>
                        <span className="mt-1 block text-caption text-secondary-foreground @xl/pool:hidden">
                          {campaignLabel(row.origin?.campaign)}
                        </span>
                        <span className="mt-1 block text-xs text-muted-foreground @3xl/pool:hidden">
                          {sourceLabel(row.source)} · {callbackDate(row.createdAt, zone)}
                        </span>
                        {row.previousOwner && (
                          <span className="block text-xs text-muted-foreground @3xl/pool:hidden">
                            Previously {row.previousOwner.name}
                          </span>
                        )}
                      </TableCell>
                      <TableCell
                        className="hidden truncate text-caption text-secondary-foreground @xl/pool:table-cell"
                        title={row.origin?.campaign ?? undefined}
                      >
                        {campaignLabel(row.origin?.campaign)}
                      </TableCell>
                      <TableCell className="hidden whitespace-normal text-caption text-secondary-foreground @3xl/pool:table-cell">
                        {sourceLabel(row.source)}
                      </TableCell>
                      <TableCell className="hidden whitespace-normal text-caption text-secondary-foreground @2xl/pool:table-cell">
                        {callbackDate(row.createdAt, zone)}
                      </TableCell>
                      <TableCell className="hidden whitespace-normal text-caption text-secondary-foreground @3xl/pool:table-cell">
                        {row.previousOwner?.name ?? "None"}
                      </TableCell>
                      {plan.kind !== "editing" && (
                        <TableCell className="whitespace-normal text-caption">
                          {changed ? (
                            <Slip kind="refused" icon="assign">
                              {changed.custody.heldBy
                                ? `With ${changed.custody.heldBy.name} since ${callbackDate(changed.custody.heldBy.since, zone)}`
                                : "No longer in the pool"}
                            </Slip>
                          ) : person ? (
                            <span className="flex items-center gap-1.5 font-semibold">
                              <Icon name="next" size="small" />
                              {person.name}
                              {agents.filter((agent) => agent.ownerId === person.ownerId).length >
                                1 && (
                                <span className="block text-xs font-normal text-muted-foreground">
                                  {person.team}
                                </span>
                              )}
                            </span>
                          ) : (
                            "Not selected"
                          )}
                        </TableCell>
                      )}
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
          {pageQuery.error && (
            <Refusal
              title="More leads could not be loaded"
              retry={() => {
                void pageQuery.refetch();
              }}
            >
              {failureMessage(pageQuery.error, "read")}
            </Refusal>
          )}
          <div className="flex flex-wrap items-center justify-between gap-3 p-4 text-caption text-secondary-foreground">
            <p>
              {plan.kind === "stale"
                ? `Showing ${String(rows.length - plan.changed.length)} still in the pool, and ${String(plan.changed.length)} that changed hands`
                : `Showing ${String(rows.length)} of ${String(pool.total)}, newest first`}
            </p>
            {(hasMore || limit > 14) && plan.kind !== "stale" && (
              <ShowMore
                size="sm"
                more={hasMore}
                busy={pageQuery.isFetching}
                noun="leads"
                onMore={() => { setLimit((value) => value + 14); }}
              />
            )}
          </div>
        </section>
        {(pool.total > 0 || plan.kind === "stale") && (
          <section
            aria-label="Assign leads"
            className={cn(
              "@container/assignment min-h-0 w-full shrink-0 flex-col border-s md:flex md:w-96",
              mobilePanel ? "flex" : "hidden",
            )}
          >
            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain p-4 @sm/assignment:p-6">
              <Button
                variant="ghost"
                className="md:hidden"
                onClick={() => {
                  setMobilePanel(false);
                }}
              >
                <Icon name="back" />
                Back to leads
              </Button>
              <h2 ref={panelHeading} tabIndex={-1} className="text-panel font-bold">
                Assign {selected.length} {selected.length === 1 ? "lead" : "leads"}
              </h2>
              <Tabs
                value={method}
                onValueChange={(value) => {
                  if (busy) return;
                  if (value === "hand" || value === "round") {
                    setMethod(value);
                    edit();
                    setChosen(
                      value === "round"
                        ? people.map(assignmentKey)
                        : agents[0]
                          ? [assignmentKey(agents[0])]
                          : [],
                    );
                  }
                }}
              >
                <TabsList aria-label="Assignment method" className="w-full">
                  <TabsTrigger value="hand">
                    <Icon name="assign" size="small" />
                    To one person
                  </TabsTrigger>
                  <TabsTrigger value="round">
                    <Icon name="shuffle" size="small" />
                    Round-robin
                  </TabsTrigger>
                </TabsList>
                <TabsContent
                  value={method}
                  aria-label="Assignment options"
                  className="space-y-4 pt-3"
                >
                  <div
                    ref={refusal}
                    role="alert"
                    aria-live="assertive"
                    aria-atomic="true"
                    tabIndex={-1}
                  >
                    {message?.kind === "error" && (
                      <Refusal announce={false} title="Assignment could not be completed">
                        {message.text}
                      </Refusal>
                    )}
                    {plan.kind === "stale" && (
                      <StaleAssignment plan={plan} selectedCount={selected.length} zone={zone} />
                    )}
                  </div>
                  {plan.kind !== "stale" &&
                    (method === "hand" ? (
                      <fieldset className="space-y-2">
                        <legend className="text-caption font-semibold">Who gets them?</legend>
                        <RadioGroup
                          aria-label="Who gets them?"
                          value={chosen[0] ?? ""}
                          onValueChange={(value) => {
                            edit();
                            setChosen([value]);
                          }}
                        >
                          {people.map((agent) => (
                            <label
                              key={assignmentKey(agent)}
                              className={cn(
                                "flex min-h-11 items-center gap-2 rounded-md border px-3 py-2",
                                chosen.includes(assignmentKey(agent)) && "border-primary bg-accent",
                              )}
                            >
                              <RadioGroupItem value={assignmentKey(agent)} disabled={busy} />
                              <Avatar name={agent.name} />
                              <span className="flex-1">
                                <span className="font-semibold">{agent.name}</span>
                              </span>
                              <span className="text-caption text-secondary-foreground">
                                {agent.openCount} in queue
                              </span>
                            </label>
                          ))}
                        </RadioGroup>
                      </fieldset>
                    ) : (
                      <>
                        <fieldset className="space-y-2">
                          <legend className="text-caption font-semibold">Share between</legend>
                          <div className="grid gap-2 @xs/assignment:grid-cols-2">
                            {people.map((agent) => (
                              <label
                                key={assignmentKey(agent)}
                                className="flex min-h-9 items-center gap-2"
                              >
                                <Checkbox
                                  checked={chosen.includes(assignmentKey(agent))}
                                  disabled={busy}
                                  onCheckedChange={(value) => {
                                    edit();
                                    setChosen((ids) =>
                                      value === true
                                        ? [
                                            ...ids.filter(
                                              (id) => !id.startsWith(`${agent.ownerId}:`),
                                            ),
                                            assignmentKey(agent),
                                          ]
                                        : ids.filter((id) => id !== assignmentKey(agent)),
                                    );
                                  }}
                                />
                                <Avatar name={agent.name} />
                                <span className="font-semibold">{agent.name}</span>
                              </label>
                            ))}
                          </div>
                        </fieldset>
                        <label className="flex min-h-9 items-center gap-2 font-semibold">
                          <Checkbox
                            checked={exclude}
                            disabled={busy}
                            onCheckedChange={(value) => {
                              edit();
                              setExclude(value === true);
                            }}
                          />
                          Skip a lead's previous owner
                        </label>
                      </>
                    ))}
                  {plan.kind === "editing" &&
                    recipients
                      .filter(
                        (person) =>
                          agents.filter((agent) => agent.ownerId === person.ownerId).length > 1,
                      )
                      .map((person) => (
                        <Field key={person.ownerId} label={`Team for ${person.name}`}>
                          {(control) => (
                            <NativeSelect
                              {...control}
                              value={assignmentKey(person)}
                              disabled={busy}
                              onChange={(event) => {
                                edit();
                                setChosen((ids) =>
                                  ids.map((id) =>
                                    id.startsWith(`${person.ownerId}:`) ? event.target.value : id,
                                  ),
                                );
                              }}
                            >
                              {agents
                                .filter((agent) => agent.ownerId === person.ownerId)
                                .map((agent) => (
                                  <option key={agent.teamId} value={assignmentKey(agent)}>
                                    {agent.team}
                                  </option>
                                ))}
                            </NativeSelect>
                          )}
                        </Field>
                      ))}
                  {plan.kind !== "editing" && (
                    <AssignmentPreview
                      plan={plan}
                      recipients={recipients}
                      zone={zone}
                      previewHeading={previewHeading}
                    />
                  )}
                  {plan.kind !== "stale" && (
                    <p className="text-xs text-muted-foreground">
                      {method === "hand"
                        ? "Only agents have a queue, so only agents are listed. Assigned leads land in their queue as not yet called. Moving a lead to someone else later keeps its status."
                        : "Nothing moves until you confirm. If one of these leads changes hands first, the preview is refused and nothing is assigned."}
                    </p>
                  )}
                </TabsContent>
              </Tabs>
            </div>
            <div className="shrink-0 space-y-2 border-t bg-background p-4">
              {plan.kind === "stale" ? (
                <>
                  {plan.remaining.length > 0 && (
                    <Button
                      ref={retry}
                      size="lg"
                      className="w-full whitespace-normal"
                      busy={busy}
                      onClick={() => {
                        makePreview(plan.remaining);
                      }}
                    >
                      <Icon name="refresh" />
                      Preview the remaining {plan.remaining.length}{" "}
                      {plan.remaining.length === 1 ? "lead" : "leads"}
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    className="w-full"
                    onClick={() => {
                      edit();
                      setSelected([]);
                      void refresh();
                    }}
                  >
                    Cancel
                  </Button>
                </>
              ) : (
                <Button
                  size="lg"
                  className="w-full whitespace-normal"
                  busy={busy}
                  disabled={!selected.length || !chosen.length}
                  onClick={() => {
                    if (method === "round" && plan.kind === "editing") makePreview();
                    else assign();
                  }}
                >
                  {busy
                    ? "Please wait…"
                    : `${method === "round" && plan.kind === "editing" ? "Preview" : "Assign"} ${String(selected.length)} ${selected.length === 1 ? "lead" : "leads"}${method === "hand" && recipients[0] ? ` to ${recipients[0].name}` : ""}`}
                </Button>
              )}
            </div>
          </section>
        )}
      </div>
      {!mobilePanel && pool.total > 0 && (
        <div className="shrink-0 border-t bg-background p-3 md:hidden">
          <Button
            className="w-full"
            disabled={!selected.length}
            onClick={() => {
              setMobilePanel(true);
            }}
          >
            Assign {selected.length} selected {selected.length === 1 ? "lead" : "leads"}
          </Button>
        </div>
      )}
    </>
  );
}
