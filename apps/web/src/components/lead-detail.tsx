"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { recordScope, scopeAdmits } from "@relay/domain";
import { useTRPC } from "@/lib/trpc/client";
import { failureCode, failureMessage } from "@/lib/failures";
import { callbackDate, custodyDate, overdueLabel, sourceLabel } from "@/lib/display";
import { Button } from "./ui/button";
import { Icon } from "./icons";
import { Empty, Refusal, Signoff, Slip } from "./pieces";
import { LeadTimeline } from "./lead-timeline";
import { LeadComposer, type ComposerMode } from "./lead-composer";
import type { Profile } from "./queue";
export function LeadDetail({ id, profile, zone }: { id: string; profile: Profile; zone: string }) {
  const trpc = useTRPC();
  const client = useQueryClient();
  const params = useParams<{ agentId?: string }>();
  const search = useSearchParams();
  const action = search.get("action");
  const { data: lead, error: readError } = useSuspenseQuery(trpc.leads.get.queryOptions({ id }));
  const [mode, setMode] = useState<ComposerMode | null>(action ? "attempt" : null);
  const [composerMode, setComposerMode] = useState<ComposerMode>(action ? "attempt" : "note");
  const [revision, setRevision] = useState(0);
  const [channel, setChannel] = useState<"call" | "whatsApp">(
    action === "whatsapp" ? "whatsApp" : "call",
  );
  const [message, setMessage] = useState<{ kind: "success" | "error"; text: string } | null>(null);
  const [visible, setVisible] = useState(20);
  const [expanded, setExpanded] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const feedback = useRef<HTMLDivElement>(null);
  const refusal = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const state = lead.lifecycle.state;
  const isOpen =
    state.status === "new" || state.status === "assigned" || state.status === "working";
  const canEdit = isOpen && scopeAdmits(recordScope(profile, "lead", "edit"), state);
  const callbackAt =
    state.status === "working" && state.stage.kind === "callBack" ? state.stage.at : null;
  const basePath = params.agentId ? `/agents/${params.agentId}` : "/queue";
  useEffect(() => {
    if (matchMedia("(max-width: 767px)").matches && !action) heading.current?.focus();
  }, [id, action]);
  useEffect(() => {
    if (message?.kind === "error") refusal.current?.focus();
    if (message?.kind === "success") feedback.current?.focus();
  }, [message]);
  async function refresh(closed = false) {
    await Promise.all([
      client.invalidateQueries({ queryKey: trpc.leads.get.queryKey({ id }) }),
      ...(lead.custody.heldBy
        ? [
            client.invalidateQueries({
              queryKey: trpc.leads.queue.queryKey({ agentId: lead.custody.heldBy.id }),
            }),
          ]
        : []),
      ...(closed ? [client.invalidateQueries({ queryKey: trpc.leads.agents.queryKey() })] : []),
      ...(closed && state.status === "new"
        ? [client.invalidateQueries({ queryKey: trpc.leads.pool.queryKey() })]
        : []),
    ]);
  }
  async function failed(error: unknown) {
    setMessage({ kind: "error", text: failureMessage(error) });
    if (failureCode(error)) await refresh();
  }
  async function saved(text: string, closed = false) {
    await refresh(closed);
    setMode(null);
    setRevision((value) => value + 1);
    setMessage({ kind: "success", text });
  }
  const attempt = useMutation(
    trpc.leads.logAttempt.mutationOptions({
      onError: failed,
      onSuccess: (_data, input) =>
        saved(
          input.outcome === "spokeToThem"
            ? "Attempt saved. The lead is marked as contacted."
            : "No-answer attempt saved. This does not mark the lead as contacted.",
        ),
    }),
  );
  const note = useMutation(
    trpc.leads.addNote.mutationOptions({
      onError: failed,
      onSuccess: () => saved("Note added to the timeline."),
    }),
  );
  const linkAttempt = useMutation(
    trpc.leads.logAttempt.mutationOptions({
      onError: failed,
      onSuccess: async () => {
        await refresh();
        setMessage({
          kind: "success",
          text: "Link attempt saved. This does not mark the lead as contacted.",
        });
      },
    }),
  );
  const callback = useMutation(
    trpc.leads.setCallback.mutationOptions({
      onError: failed,
      onSuccess: (_data, input) =>
        saved(
          input.change.kind === "clear"
            ? "Callback cleared. The lead stays in the queue."
            : "Callback saved.",
        ),
    }),
  );
  const close = useMutation(
    trpc.leads.close.mutationOptions({
      onError: failed,
      onSuccess: async (data, input) => {
        if (data.accountId)
          await client.invalidateQueries({ queryKey: trpc.accounts.list.queryKey() });
        await saved(
          data.accountId
            ? "Lead won. An account was opened and keeps this history."
            : `Lead closed as ${input.closing.kind}. It has left the open queue.`,
          true,
        );
      },
    }),
  );
  const busy =
    attempt.isPending ||
    linkAttempt.isPending ||
    note.isPending ||
    callback.isPending ||
    close.isPending;
  function open(next: ComposerMode, nextChannel = channel) {
    if (busy) return;
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setChannel(nextChannel);
    setMode(next);
    setComposerMode(next);
    setExpanded(false);
    setMessage(null);
  }
  function cancel() {
    setMode(null);
    setMessage(null);
    requestAnimationFrame(() => {
      if (opener.current?.isConnected) opener.current.focus();
      else heading.current?.focus();
    });
  }
  if (failureCode(readError) === "accessDenied")
    return (
      <Empty
        icon="lock"
        title="You cannot open this lead"
        action={
          <Button asChild variant="outline">
            <Link href={basePath}>Back to queue</Link>
          </Button>
        }
      >
        {failureMessage(readError, "read")}
      </Empty>
    );
  const shown = mode && !expanded ? 1 : visible;
  return (
    <>
      <h1 className="sr-only md:hidden">Lead detail</h1>
      <header className="space-y-5 border-b p-4 @lg/detail:p-6">
        <Button asChild variant="ghost" className="md:hidden">
          <Link href={basePath}>
            <Icon name="back" />
            Back to queue
          </Link>
        </Button>
        <div className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 ref={heading} tabIndex={-1} className="text-2xl font-bold">
              {lead.name ?? lead.email}
            </h2>
            {canEdit && (
              <div className="flex flex-wrap gap-2">
                <Button
                  busy={busy}
                  disabled={!lead.phone}
                  onClick={() => {
                    open("attempt", "call");
                  }}
                >
                  <Icon name="call" />
                  Call
                </Button>
                <Button
                  variant="outline"
                  busy={busy}
                  disabled={!lead.phone}
                  onClick={() => {
                    open("attempt", "whatsApp");
                  }}
                >
                  <Icon name="whatsapp" />
                  WhatsApp
                </Button>
                <Button
                  variant="outline"
                  busy={busy}
                  onClick={() => {
                    open("close");
                  }}
                >
                  Close lead
                </Button>
                <Button
                  variant="ghost"
                  busy={busy}
                  onClick={() => {
                    open("note");
                  }}
                >
                  Add note
                </Button>
              </div>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-caption text-secondary-foreground">
            {!isOpen ? (
              <Slip
                kind={state.status === "won" ? "complete" : "neutral"}
                icon={state.status === "won" ? "done" : "ban"}
              >
                {state.status[0]?.toUpperCase()}
                {state.status.slice(1)}
              </Slip>
            ) : callbackAt ? (
              <Slip
                kind={callbackAt < new Date() ? "refused" : "waiting"}
                icon={callbackAt < new Date() ? "alarm" : "callback"}
              >
                {callbackAt < new Date()
                  ? overdueLabel(callbackAt, zone).replace("Overdue", "Callback overdue")
                  : `Callback ${callbackDate(callbackAt, zone)}`}
              </Slip>
            ) : (
              <Slip icon={lead.contactedAt ? "check" : "assign"}>
                {lead.contactedAt ? "Contacted" : "Not contacted"}
              </Slip>
            )}
            <span>{lead.phone ?? "No phone number"}</span>
            <span className="break-all">{lead.email}</span>
          </div>
        </div>
        <div className="grid gap-4 @2xl/detail:grid-cols-custody">
          <Signoff
            caption="Received from"
            name={sourceLabel(lead.custody.receivedFrom?.source)}
            time={custodyDate(lead.custody.receivedFrom?.at ?? null, zone)}
            icon="inbox"
          />
          <Signoff
            caption="Assigned by"
            name={lead.custody.assignedBy?.name ?? null}
            time={custodyDate(lead.custody.assignedBy?.at ?? null, zone)}
          />
          <Signoff
            caption="Held by"
            name={lead.custody.heldBy?.name ?? null}
            time={custodyDate(lead.custody.heldBy?.since ?? null, zone, true)}
          />
        </div>
        <dl className="grid grid-cols-2 gap-4 @2xl/detail:grid-cols-4">
          {(
            [
              ["Campaign", lead.attribution?.campaign],
              ["Ad set", lead.attribution?.adSet],
              ["Ad", lead.attribution?.ad],
              ["Form", lead.attribution?.form],
            ] as const
          ).map(([caption, value]) => (
            <div key={caption}>
              <dt className="text-xs text-muted-foreground">{caption}</dt>
              <dd className="mt-1 truncate text-caption" title={value ?? undefined}>
                {value ?? "Unknown"}
              </dd>
            </div>
          ))}
        </dl>
      </header>
      <div className="flex flex-col gap-4 p-4 @lg/detail:p-6">
        <div ref={feedback} role="status" aria-live="polite" aria-atomic="true" tabIndex={-1}>
          {message?.kind === "success" && (
            <p className="flex items-start gap-2 rounded-md bg-complete p-3 text-complete-foreground">
              <Icon name="check" />
              {message.text}
            </p>
          )}
        </div>
        <div ref={refusal} role="alert" aria-live="assertive" aria-atomic="true" tabIndex={-1}>
          {message?.kind === "error" && (
            <Refusal announce={false} title="Your change could not be completed">
              {message.text}
            </Refusal>
          )}
        </div>
        {readError && message?.kind !== "error" && (
          <Refusal title="The latest lead could not be loaded" retry={() => void refresh()}>
            {failureMessage(readError, "read")}
          </Refusal>
        )}
        {canEdit && (
          <div hidden={!mode}>
            <LeadComposer
              key={`${composerMode}:${String(revision)}`}
              active={!!mode}
              mode={composerMode}
              channel={channel}
              lead={lead}
              zone={zone}
              busy={busy}
              onCancel={cancel}
              onLaunch={(channel) => {
                setMessage(null);
                linkAttempt.mutate({
                  id,
                  key: crypto.randomUUID(),
                  channel,
                  outcome: "noAnswer",
                  note: `Opened the ${channel === "call" ? "dialler" : "WhatsApp"} link. No conversation recorded.`,
                });
              }}
              onInvalid={(text) => {
                setMessage({ kind: "error", text });
              }}
              onSubmit={(command) => {
                if (busy) return;
                setMessage(null);
                switch (command.kind) {
                  case "attempt":
                    attempt.mutate(command.input);
                    break;
                  case "note":
                    note.mutate(command.input);
                    break;
                  case "callback":
                    callback.mutate(command.input);
                    break;
                  case "close":
                    close.mutate(command.input);
                    break;
                }
              }}
            />
          </div>
        )}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <h3 className="font-semibold">Timeline</h3>
          <p className="text-xs text-muted-foreground">Saved entries cannot be edited or deleted</p>
          {lead.timeline.length > shown && (
            <Button
              variant="link"
              onClick={() => {
                setExpanded(true);
                setVisible((value) => value + 20);
              }}
            >
              Show {lead.timeline.length - shown} earlier{" "}
              {lead.timeline.length - shown === 1 ? "entry" : "entries"}
            </Button>
          )}
          {canEdit && (
            <div
              hidden={!!mode}
              className="flex w-full flex-wrap gap-2 @2xl/detail:ms-auto @2xl/detail:w-auto"
            >
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  open("attempt");
                }}
              >
                <Icon name="edit" />
                Log an attempt
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  open("callback");
                }}
              >
                <Icon name="callback" />
                {callbackAt ? "Move callback" : "Set callback"}
              </Button>
            </div>
          )}
        </div>
        <LeadTimeline lead={lead} zone={zone} limit={shown} />
      </div>
    </>
  );
}
