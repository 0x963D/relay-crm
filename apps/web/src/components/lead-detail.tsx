"use client";
import { NativeSelect } from "./ui/native-select";
import { useEffect, useState, useRef, type SyntheticEvent } from "react";
import { DEAD_REASONS, recordScope, scopeAdmits } from "@relay/domain";
import { api, type Inputs, type Outputs } from "@/lib/api";
import { failureMessage } from "@/lib/failures";
import {
  localCallback,
  shortDate,
  sourceLabel,
  custodyDate,
  callbackFields,
  dayLabel,
  callbackDate,
  overdueBy,
} from "@/lib/display";
import { Empty, Loading, Refusal, Signoff, Slip } from "./pieces";
import { Icon, type IconName } from "./icons";
import { Button } from "./ui/button";
import { Card } from "./ui/card";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "./ui/tabs";
import { RadioGroup, RadioGroupItem } from "./ui/radio-group";
import { Checkbox } from "./ui/checkbox";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { reads, readState } from "@/lib/reads";
import type { Profile } from "./queue";
type Lead = Outputs["leads"]["get"];
type Mode = "rest" | "attempt" | "callback" | "note" | "close";
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function object(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}
function timelineEntry(
  entry: Lead["timeline"][number],
  zone: string,
  lead: Lead,
): { title: string; body: string; icon: IconName } {
  const detail = object(entry.detail);
  if (entry.summary?.kind === "attempt")
    return {
      title: entry.summary.channel === "call" ? "Call attempt" : "WhatsApp attempt",
      body: entry.summary.note,
      icon: entry.summary.channel === "call" ? "call" : "whatsapp",
    };
  if (entry.summary?.kind === "note")
    return { title: "Note added", body: entry.summary.note, icon: "edit" };
  if (entry.kind === "assignment") {
    const to = object(detail?.to);
    const holder = to?.ownerId === lead.custody.heldBy?.id ? lead.custody.heldBy?.name : null;
    const fromPool = object(object(detail?.before)?.state)?.status === "new";
    return {
      title: holder ? `Assigned to ${holder}` : "Lead assigned",
      body: entry.actor
        ? `By ${entry.actor.name}${fromPool ? ", from the lead pool." : ". The lead kept its history."}`
        : "Assignment recorded",
      icon: "assign",
    };
  }
  if (entry.kind === "callback") {
    const change = object(detail?.change);
    const at = change?.at;
    return {
      title: change?.kind === "clear" ? "Callback cleared" : "Callback set",
      body: typeof at === "string" ? shortDate(new Date(at), zone) : "",
      icon: "callback",
    };
  }
  if (entry.kind === "closure") {
    const closing = object(detail?.closing);
    return {
      title: `Closed as ${typeof closing?.kind === "string" ? closing.kind : "recorded"}`,
      body:
        typeof closing?.note === "string"
          ? closing.note
          : typeof closing?.reason === "string"
            ? closing.reason === "wrongNumber"
              ? "Wrong number"
              : closing.reason === "doNotContact"
                ? "Do not contact"
                : "Duplicate"
            : "",
      icon: "done",
    };
  }
  return {
    title: entry.kind === "intake" ? "Lead received" : "Status changed",
    body:
      entry.kind === "intake"
        ? `${sourceLabel(lead.source)}${lead.attribution?.campaign ? ` · ${lead.attribution.campaign}` : ""}`
        : "",
    icon: entry.kind === "intake" ? "inbox" : "history",
  };
}
export function LeadDetail({
  id,
  profile,
  zone,
  action,
  onSaved,
  onBack,
}: {
  id: string;
  profile: Profile;
  zone: string;
  action: string | null;
  onSaved: () => void;
  onBack: () => void;
}) {
  const client = useQueryClient();
  const query = useQuery(reads.lead(id));
  const remote = readState(query);
  const [mode, setMode] = useState<Mode>(action ? "attempt" : "rest");
  const [channel, setChannel] = useState<"call" | "whatsApp">(
    action === "whatsapp" ? "whatsApp" : "call",
  );
  const [outcome, setOutcome] = useState<"noAnswer" | "spokeToThem">("noAnswer");
  const [closing, setClosing] = useState<"won" | "lost" | "dead">("lost");
  const [deadReason, setDeadReason] = useState<(typeof DEAD_REASONS)[number]>("duplicate");
  const [notes, setNotes] = useState({ attempt: "", note: "", close: "" });
  const noteKey = mode === "attempt" || mode === "close" ? mode : "note";
  const note = notes[noteKey];
  const setNote = (value: string) => {
    setNotes((drafts) => ({ ...drafts, [noteKey]: value }));
  };
  const callbackDraft = useRef<string | null>(null);
  const [callback, setCallback] = useState(false);
  const [day, setDay] = useState("");
  const [time, setTime] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [visible, setVisible] = useState(20);
  const [expanded, setExpanded] = useState(false);
  const [success, setSuccess] = useState<string | null>(null);
  const form = useRef<HTMLFormElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const feedback = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (mode !== "rest")
      form.current
        ?.querySelector<HTMLElement>(
          'button[role="radio"][aria-checked="true"], button[role="tab"][aria-selected="true"], button:not([role="radio"]):not([role="tab"]):not([disabled]), input:not([type="hidden"]), textarea, select',
        )
        ?.focus();
  }, [mode, remote.status]);
  function closeComposer() {
    setMode("rest");
    setError(null);
    requestAnimationFrame(() => {
      if (opener.current?.isConnected && opener.current.getClientRects().length)
        opener.current.focus();
      else feedback.current?.focus();
    });
  }
  const request = useRef<{ body: string; key: string } | null>(null);
  const tabValue = mode === "attempt" ? channel : mode === "close" ? closing : mode;
  function open(next: Mode, nextChannel?: "call" | "whatsApp") {
    request.current = null;
    setExpanded(false);
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (next === "callback" && query.data) {
      const state = query.data.lifecycle.state;
      if (
        state.status === "working" &&
        state.stage.kind === "callBack" &&
        callbackDraft.current !== state.stage.at.toISOString()
      ) {
        callbackDraft.current = state.stage.at.toISOString();
        const fields = callbackFields(state.stage.at, zone);
        setDay(fields.day);
        setTime(fields.time);
      }
    }
    setMode(next);
    if (nextChannel) setChannel(nextChannel);
    setError(null);
    setSuccess(null);
  }
  async function save(event: SyntheticEvent) {
    event.preventDefault();
    if (mode === "rest") return;
    setPending(true);
    setError(null);
    try {
      let key = crypto.randomUUID();
      let change: Inputs["leads"]["setCallback"]["change"] | undefined;
      if (mode === "callback" || (mode === "attempt" && callback)) {
        const at = localCallback(`${day}T${time}`, zone);
        if (!at) {
          setError("Choose a valid day and time for this timezone.");
          return;
        }
        change = { kind: "set", at };
      }
      const body = JSON.stringify({ mode, channel, outcome, closing, deadReason, note, change });
      if (request.current?.body === body) key = request.current.key;
      else request.current = { body, key };
      if (mode === "attempt")
        await api.leads.logAttempt.mutate({
          id,
          key,
          channel,
          outcome,
          note,
          ...(change ? { callback: change } : {}),
        });
      else if (mode === "note") await api.leads.addNote.mutate({ id, key, note });
      else if (mode === "callback" && change)
        await api.leads.setCallback.mutate({ id, key, change });
      else if (mode === "close") {
        const result = await api.leads.close.mutate({
          id,
          key,
          closing:
            closing === "won"
              ? { kind: "won" }
              : closing === "lost"
                ? { kind: "lost", note }
                : { kind: "dead", reason: deadReason },
        });
        setSuccess(
          result.accountId
            ? "Lead won. An account was opened and keeps this history."
            : `Lead closed as ${closing}. It has left the open queue.`,
        );
      }
      if (mode !== "close")
        setSuccess(
          mode === "attempt"
            ? outcome === "spokeToThem"
              ? "Attempt saved. The lead is marked as contacted."
              : "No-answer attempt saved. This does not mark the lead as contacted."
            : mode === "note"
              ? "Note added to the timeline."
              : "Callback saved.",
        );
      setNote("");
      await client.invalidateQueries({ queryKey: reads.lead(id).queryKey });
      closeComposer();
      onSaved();
      if (mode === "close") await client.invalidateQueries({ queryKey: ["agents"] });
    } catch (error) {
      setError(failureMessage(error));
    } finally {
      setPending(false);
    }
  }
  async function clearCallback() {
    setPending(true);
    setError(null);
    try {
      await api.leads.setCallback.mutate({
        id,
        key: crypto.randomUUID(),
        change: { kind: "clear" },
      });
      setSuccess("Callback cleared. The lead stays in the queue.");
      await client.invalidateQueries({ queryKey: reads.lead(id).queryKey });
      closeComposer();
      onSaved();
    } catch (error) {
      setError(failureMessage(error));
    } finally {
      setPending(false);
    }
  }
  if (remote.status === "loading") return <Loading />;
  if (remote.status === "error")
    return (
      <>
        <Button
          variant="ghost"
          className="mobile-back hidden max-pane:inline-flex"
          onClick={onBack}
        >
          <Icon name="back" />
          Back to queue
        </Button>
        <Empty
          icon="lock"
          title="You cannot open this lead"
          action={
            <Button variant="outline" onClick={onBack}>
              <Icon name="back" />
              Back to my queue
            </Button>
          }
        >
          {failureMessage(remote.error, "read")}
        </Empty>
      </>
    );
  const lead = remote.value;
  const state = lead.lifecycle.state;
  const isOpen =
    state.status === "new" || state.status === "assigned" || state.status === "working";
  const canEdit = isOpen && scopeAdmits(recordScope(profile, "lead", "edit"), state);
  const earlierCount = Math.max(
    0,
    lead.timeline.length - (mode === "rest" || expanded ? visible : 1),
  );
  const callbackAt =
    state.status === "working" && state.stage.kind === "callBack" ? state.stage.at : null;
  return (
    <>
      <div className="pad p-[18px_24px] max-phone:p-content lead-head [border-block-end:1px_solid_var(--color-rule)] flex flex-col gap-[14px] flex-none">
        <Button
          variant="ghost"
          className="mobile-back hidden max-pane:inline-flex"
          onClick={onBack}
        >
          <Icon name="back" />
          Back to queue
        </Button>
        <div>
          <div className="row flex items-center max-phone:[.lead-body_&]:flex-wrap max-phone:[.pool-panel_label&]:min-h-[44px] lead-title gap-control flex-wrap [&_h2]:text-(length:--text-lead) [&_h2]:leading-[26px] [&_h2]:font-[720] [&_h2]:[font-variation-settings:'wdth'_84] max-phone:[&_h2]:w-full phone:max-poolcompact:gap-x-compact phone:max-poolcompact:[&_h2]:[flex-basis:100%]">
            <h2>{lead.name ?? lead.email}</h2>
            <span className="sp flex-1 max-laptop:[.lead-title_&]:hidden max-phone:[.q-top_&]:hidden phone:max-poolcompact:[.q-top_&]:hidden" />
            {canEdit && (
              <>
                <Button
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
                  onClick={() => {
                    open("close");
                  }}
                >
                  Close lead
                </Button>
              </>
            )}
          </div>
          <div className="row flex items-center max-phone:[.lead-body_&]:flex-wrap max-phone:[.pool-panel_label&]:min-h-[44px] sm text-(length:--text-small) leading-[18px] [.demo-choices_&]:font-[400] [.pool-people_&]:ms-auto [.preview-person_&]:[overflow-wrap:anywhere] [.preview-header_>_&]:text-(length:--text-caption) [.preview-header_>_&]:whitespace-nowrap t2 text-secondary [.alert--refused_&]:text-refused-foreground lead-contact mt-tight gap-control flex-wrap">
            {!isOpen ? (
              <Slip
                kind={state.status === "won" ? "green" : "mute"}
                icon={state.status === "won" ? "done" : "ban"}
              >
                {state.status[0]?.toUpperCase()}
                {state.status.slice(1)}
              </Slip>
            ) : callbackAt ? (
              <Slip
                kind={callbackAt < new Date() ? "pink" : "canary"}
                icon={callbackAt < new Date() ? "alarm" : "callback"}
              >
                {callbackAt < new Date()
                  ? `Callback overdue ${overdueBy(callbackAt)}`
                  : `Callback ${callbackDate(callbackAt, zone)}`}
              </Slip>
            ) : (
              <Slip kind="mute" icon={lead.contactedAt ? "check" : "assign"}>
                {lead.contactedAt ? "Contacted" : "Not contacted"}
              </Slip>
            )}
            <span>{lead.phone ?? "No phone number"}</span>
            <span>{lead.email}</span>
          </div>
        </div>
        <div className="signoff grid gap-[20px] [grid-template-columns:repeat(3,_minmax(0,_1fr))] max-laptop:gap-group max-phone:[grid-template-columns:1fr] max-phone:gap-control">
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
        <dl className="attribution grid [grid-template-columns:1.5fr_1fr_1.15fr_0.75fr] gap-[20px] [&_dd]:[overflow-wrap:anywhere] max-laptop:[grid-template-columns:1fr_1fr] max-laptop:gap-group max-phone:gap-group">
          {(
            [
              ["Campaign", lead.attribution?.campaign],
              ["Ad set", lead.attribution?.adSet],
              ["Ad", lead.attribution?.ad],
              ["Form", lead.attribution?.form],
            ] as const
          ).map(([caption, value]) => (
            <div key={caption}>
              <dt className="cap text-(length:--text-caption) leading-[16px] text-tertiary [font-stretch:94%] [.sec_&]:font-[400] [.sec_&]:ms-auto [.timeline-heading_&]:flex-1 max-phone:[.queue-list_.sec_&]:text-(length:--text-caption)">
                {caption}
              </dt>
              <dd className="sm text-(length:--text-small) leading-[18px] [.demo-choices_&]:font-[400] [.pool-people_&]:ms-auto [.preview-person_&]:[overflow-wrap:anywhere] [.preview-header_>_&]:text-(length:--text-caption) [.preview-header_>_&]:whitespace-nowrap">
                {value ?? "Unknown"}
              </dd>
            </div>
          ))}
        </dl>
      </div>
      <div className="pad p-[18px_24px] max-phone:p-content lead-body flex flex-col gap-content">
        {query.isError && (
          <Refusal
            title="The latest lead could not be loaded"
            retry={() => {
              void query.refetch();
            }}
          >
            {failureMessage(query.error, "read")}
          </Refusal>
        )}
        <div role="status" aria-live="polite" aria-atomic="true" tabIndex={-1} ref={feedback}>
          {success && (
            <div className="alert flex gap-control p-[12px_14px] rounded-group border-[1px] border-solid border-control-border alert--info bg-selected [border-color:transparent] text-foreground">
              <Icon name="check" />
              <span>{success}</span>
            </div>
          )}
        </div>
        <div role="alert" aria-live="assertive" aria-atomic="true">
          {error && (
            <Refusal
              announce={false}
              title={mode === "close" ? "The lead was not closed" : "This was not saved"}
            >
              {error}
            </Refusal>
          )}
        </div>
        {mode !== "rest" && canEdit && (
          <Card className="composer p-[14px_16px] flex flex-col gap-group border-control-border">
            <Tabs
              value={tabValue}
              onValueChange={(value) => {
                if (mode === "attempt" && (value === "call" || value === "whatsApp"))
                  setChannel(value);
                if (mode === "close" && (value === "won" || value === "lost" || value === "dead"))
                  setClosing(value);
              }}
            >
              <form
                ref={form}
                onKeyDown={(event) => {
                  if (event.key === "Escape" && !pending) {
                    event.preventDefault();
                    closeComposer();
                  }
                }}
                className="col flex flex-col composer-form gap-[12px]"
                onSubmit={(event) => {
                  void save(event);
                }}
              >
                <div className="row flex items-center gap-related max-phone:[.lead-body_&]:flex-wrap max-phone:[.pool-panel_label&]:min-h-[44px] panel-head flex-wrap">
                  <h3 className="h2 text-(length:--text-panel) leading-[22px] font-[700] [font-variation-settings:'wdth'_86] [.pool-panel_&]:flex-none">
                    {mode === "attempt"
                      ? "Log an attempt"
                      : mode === "callback"
                        ? callbackAt
                          ? "Move callback"
                          : "Set a callback"
                        : mode === "note"
                          ? "Add a note"
                          : "Close this lead"}
                  </h3>
                  <span className="sp flex-1 max-laptop:[.lead-title_&]:hidden max-phone:[.q-top_&]:hidden phone:max-poolcompact:[.q-top_&]:hidden" />
                  {mode === "attempt" && (
                    <RadioGroup
                      className="channel-choices inline-flex flex-row p-[3px] rounded-group bg-muted gap-[2px] max-phone:[&_button]:min-h-[36px]"
                      aria-label="Attempt channel"
                      value={channel}
                      onValueChange={(value) => {
                        if (value === "call" || value === "whatsApp") setChannel(value);
                      }}
                    >
                      <RadioGroupItem value="call" aria-label="Call">
                        <Icon name="call" size="small" />
                        Call
                      </RadioGroupItem>
                      <RadioGroupItem value="whatsApp" aria-label="WhatsApp">
                        <Icon name="whatsapp" size="small" />
                        WhatsApp
                      </RadioGroupItem>
                    </RadioGroup>
                  )}
                  {mode === "close" && (
                    <TabsList aria-label="Close outcome">
                      <TabsTrigger value="won">
                        <Icon name="done" size="small" />
                        Won
                      </TabsTrigger>
                      <TabsTrigger value="lost">
                        <Icon name="error" size="small" />
                        Lost
                      </TabsTrigger>
                      <TabsTrigger value="dead">
                        <Icon name="ban" size="small" />
                        Dead
                      </TabsTrigger>
                    </TabsList>
                  )}
                </div>
                <TabsContent
                  className="composer-content flex flex-col gap-group"
                  value={tabValue}
                  aria-labelledby={undefined}
                  aria-label="Lead work"
                  role={mode === "attempt" || mode === "close" ? "tabpanel" : "region"}
                >
                  {mode === "attempt" && (
                    <>
                      <div className="field flex flex-col gap-compact">
                        <span
                          className="label text-(length:--text-small) font-[600]"
                          id="attempt-outcome"
                        >
                          What happened?
                        </span>
                        <RadioGroup
                          className="attempt-options grid [grid-template-columns:1fr_1fr] gap-control max-phone:[grid-template-columns:1fr]"
                          aria-labelledby="attempt-outcome"
                          value={outcome}
                          onValueChange={(v) => {
                            if (v === "noAnswer" || v === "spokeToThem") setOutcome(v);
                          }}
                        >
                          <label
                            className="opt flex items-center gap-control min-h-[40px] p-[8px_10px] border-[1px] border-solid border-rule rounded-control [&[data-checked='true']]:border-primary [&[data-checked='true']]:bg-selected [.pool-people_&]:min-h-[44px] [.pool-people_&]:py-compact"
                            data-checked={outcome === "noAnswer"}
                          >
                            <RadioGroupItem value="noAnswer" />
                            <span>
                              <span className="b font-[620]">No answer</span>
                              <br />
                              <span className="help text-(length:--text-caption) leading-[16px] text-tertiary [.composer_&]:flex-1">
                                Counts as no answer number {lead.noAnswerCount + 1}
                              </span>
                            </span>
                          </label>
                          <label
                            className="opt flex items-center gap-control min-h-[40px] p-[8px_10px] border-[1px] border-solid border-rule rounded-control [&[data-checked='true']]:border-primary [&[data-checked='true']]:bg-selected [.pool-people_&]:min-h-[44px] [.pool-people_&]:py-compact"
                            data-checked={outcome === "spokeToThem"}
                          >
                            <RadioGroupItem value="spokeToThem" />
                            <span>
                              <span className="b font-[620]">Spoke to them</span>
                              <br />
                              <span className="help text-(length:--text-caption) leading-[16px] text-tertiary [.composer_&]:flex-1">
                                Marks the lead as contacted
                              </span>
                            </span>
                          </label>
                        </RadioGroup>
                      </div>
                      {lead.phone && (
                        <p className="help text-(length:--text-caption) leading-[16px] text-tertiary [.composer_&]:flex-1">
                          Use your own {channel === "call" ? "phone" : "WhatsApp"}, then save what
                          happened.{" "}
                          <a
                            className="link [a&]:text-primary [a&]:font-[600] [a&]:[text-decoration:underline] [a&]:[text-underline-offset:3px] [a&]:[text-decoration-thickness:1px] [.alert--refused_a&]:text-refused-foreground"
                            href={
                              channel === "call"
                                ? `tel:${lead.phone}`
                                : `https://wa.me/${lead.phone.replace(/\D/g, "")}`
                            }
                            target={channel === "whatsApp" ? "_blank" : undefined}
                            rel="noreferrer"
                          >
                            {channel === "call" ? "Open phone" : "Open WhatsApp"}
                          </a>
                        </p>
                      )}
                    </>
                  )}
                  {(mode === "attempt" || mode === "callback") && (
                    <div className="callback-fields grid [grid-template-columns:auto_minmax(0,_1fr)_132px] gap-control [align-items:end] max-phone:[grid-template-columns:1fr_1fr]">
                      {mode === "attempt" && (
                        <label className="row flex items-center gap-related max-phone:[.lead-body_&]:flex-wrap max-phone:[.pool-panel_label&]:min-h-[44px] callback-check h-[36px] max-phone:[grid-column:1/-1] max-phone:min-h-[44px]">
                          <Checkbox
                            checked={callback}
                            onCheckedChange={(v) => {
                              setCallback(v === true);
                            }}
                          />
                          <span className="b font-[620]">Call back</span>
                        </label>
                      )}
                      {(mode === "callback" || callback) && (
                        <>
                          <label className="field flex flex-col gap-compact">
                            <span className="label text-(length:--text-small) font-[600]">Day</span>
                            <Input
                              type="date"
                              aria-label="Day"
                              aria-describedby="callback-day-words"
                              required
                              value={day}
                              onChange={(e) => {
                                setDay(e.target.value);
                              }}
                            />
                            {day && (
                              <span
                                id="callback-day-words"
                                className="help text-(length:--text-caption) leading-[16px] text-tertiary [.composer_&]:flex-1"
                              >
                                {dayLabel(new Date(`${day}T12:00:00Z`), "UTC")}
                              </span>
                            )}
                          </label>
                          <label className="field flex flex-col gap-compact">
                            <span className="label text-(length:--text-small) font-[600]">
                              Time
                            </span>
                            <Input
                              type="time"
                              required
                              value={time}
                              onChange={(e) => {
                                setTime(e.target.value);
                              }}
                            />
                          </label>
                          <p className="help text-(length:--text-caption) leading-[16px] text-tertiary [.composer_&]:flex-1">
                            Times use {zone}.
                          </p>
                        </>
                      )}
                    </div>
                  )}
                  {(mode === "attempt" ||
                    mode === "note" ||
                    (mode === "close" && closing === "lost")) && (
                    <label className="field flex flex-col gap-compact">
                      <span
                        className="label text-(length:--text-small) font-[600]"
                        id="work-note-label"
                      >
                        {mode === "close" ? "Why was it lost?" : "Note"}
                      </span>
                      <Textarea
                        aria-labelledby="work-note-label"
                        aria-describedby={mode === "close" ? "lost-help" : undefined}
                        required={mode === "attempt" || mode === "note" || closing === "lost"}
                        maxLength={4000}
                        value={note}
                        onChange={(e) => {
                          setNote(e.target.value);
                        }}
                      />
                      {mode === "close" && (
                        <span
                          className="help text-(length:--text-caption) leading-[16px] text-tertiary [.composer_&]:flex-1"
                          id="lost-help"
                        >
                          Required, in your own words. There are no categories to pick. The reason
                          is saved on the timeline with your name.
                        </span>
                      )}
                    </label>
                  )}
                  {mode === "close" && closing === "dead" && (
                    <label className="field flex flex-col gap-compact">
                      <span className="label text-(length:--text-small) font-[600]">
                        Why is this lead dead?
                      </span>
                      <NativeSelect
                        className="input flex items-center gap-related h-[36px] px-control border-[1px] border-solid border-control-border rounded-control bg-surface text-foreground text-(length:--text-body) [.sign-sheet_&]:h-[44px] [.sign-sheet_&]:w-full max-phone:min-h-[44px] [&:focus-visible]:[outline:none] [&:focus-visible]:border-primary [&:focus-visible]:[box-shadow:0_0_0_3px_var(--color-selected)]"
                        value={deadReason}
                        onChange={(e) => {
                          const reason = DEAD_REASONS.find((v) => v === e.target.value);
                          if (reason) setDeadReason(reason);
                        }}
                      >
                        <option value="duplicate">Duplicate</option>
                        <option value="wrongNumber">Wrong number</option>
                        <option value="doNotContact">Do not contact</option>
                      </NativeSelect>
                      <span className="help text-(length:--text-caption) leading-[16px] text-tertiary [.composer_&]:flex-1">
                        Wrong number needs an attempt in this assignment first.
                      </span>
                    </label>
                  )}
                  {mode === "close" && (
                    <dl className="kv grid gap-[4px_12px] text-(length:--text-small) leading-[18px] [&_dt]:text-tertiary closure-info [grid-template-columns:52px_1fr] bg-muted p-group rounded-control">
                      <dt className="b font-[620]">Won</dt>
                      <dd>Creates an account and keeps this history. Final.</dd>
                      <dt className="b font-[620]">Lost</dt>
                      <dd>Needs a written reason. Reopens only if they enquire again.</dd>
                      <dt className="b font-[620]">Dead</dt>
                      <dd>For a duplicate, wrong number or do-not-contact request. Final.</dd>
                    </dl>
                  )}
                  <div className="row flex items-center gap-related max-phone:[.lead-body_&]:flex-wrap max-phone:[.pool-panel_label&]:min-h-[44px] form-actions flex-wrap">
                    <span className="help text-(length:--text-caption) leading-[16px] text-tertiary [.composer_&]:flex-1">
                      {mode === "close"
                        ? "Closing is saved to the timeline and cannot be undone here."
                        : mode === "attempt"
                          ? outcome === "noAnswer"
                            ? `Saves as ${channel === "call" ? "call" : "WhatsApp"} attempt, no answer ×${String(lead.noAnswerCount + 1)}${callback && localCallback(`${day}T${time}`, zone) ? `, callback ${callbackDate(localCallback(`${day}T${time}`, zone), zone)}` : ""}. The lead moves to ${callback ? (day === callbackFields(new Date(), zone).day ? "Due today" : "Later") : "No callback set"} in the queue. This does not mark the lead as contacted.`
                            : `Saves a ${channel === "call" ? "call" : "WhatsApp"} attempt and marks the lead as contacted. The lead moves to ${callback ? (day === callbackFields(new Date(), zone).day ? "Due today" : "Later") : "No callback set"} in the queue.`
                          : "Saved entries cannot be edited or deleted."}
                    </span>
                    <Button
                      variant="ghost"
                      disabled={pending}
                      onClick={() => {
                        closeComposer();
                        setError(null);
                      }}
                    >
                      Cancel
                    </Button>
                    <Button type="submit" disabled={pending}>
                      {pending
                        ? "Saving…"
                        : mode === "close"
                          ? `Close as ${closing}`
                          : mode === "attempt"
                            ? "Save attempt"
                            : mode === "callback"
                              ? "Save callback"
                              : "Save note"}
                    </Button>
                  </div>
                  {mode === "callback" && callbackAt && (
                    <Button
                      variant="destructive"
                      disabled={pending}
                      onClick={() => {
                        void clearCallback();
                      }}
                    >
                      Clear callback
                    </Button>
                  )}
                </TabsContent>
              </form>
            </Tabs>
          </Card>
        )}
        <div className="row flex items-center gap-related max-phone:[.lead-body_&]:flex-wrap max-phone:[.pool-panel_label&]:min-h-[44px] timeline-heading flex-wrap">
          <h3 className="h3 text-(length:--text-body) leading-[20px] font-[650]">Timeline</h3>
          <span className="cap text-(length:--text-caption) leading-[16px] text-tertiary [font-stretch:94%] [.sec_&]:font-[400] [.sec_&]:ms-auto [.timeline-heading_&]:flex-1 max-phone:[.queue-list_.sec_&]:text-(length:--text-caption)">
            Saved entries cannot be edited or deleted
          </span>
          {lead.timeline.length > (mode === "rest" || expanded ? visible : 1) && (
            <Button
              variant="ghost"
              onClick={() => {
                if (mode !== "rest" && !expanded) setExpanded(true);
                else setVisible((n) => n + 20);
              }}
            >
              Show {earlierCount} earlier {earlierCount === 1 ? "entry" : "entries"}
            </Button>
          )}
          {canEdit && (
            <div className="tl-actions flex gap-related flex-wrap" hidden={mode !== "rest"}>
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
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  open("note");
                }}
              >
                Add note
              </Button>
            </div>
          )}
        </div>
        <ul className="tl flex flex-col">
          {lead.timeline.slice(0, mode === "rest" || expanded ? visible : 1).map((entry) => {
            const display = timelineEntry(entry, zone, lead);
            return (
              <li
                className="tl-item grid [grid-template-columns:28px_1fr] gap-control pb-[14px] relative [&::before]:[content:''] [&::before]:absolute [&::before]:[inset-block:28px_0] [&::before]:[inset-inline-start:13.5px] [&::before]:w-[1px] [&::before]:bg-rule [&:last-child::before]:hidden"
                key={entry.id}
              >
                <span className="tl-dot w-[28px] h-[28px] [border-radius:50%] bg-muted text-secondary grid place-items-center relative [z-index:1]">
                  <Icon name={display.icon} size="small" />
                </span>
                <div>
                  <div className="tl-head flex items-baseline gap-related flex-wrap">
                    <span className="b font-[620]">{display.title}</span>
                    {entry.summary?.kind === "attempt" && (
                      <Slip icon={entry.summary.outcome === "noAnswer" ? "missed" : "check"}>
                        {entry.summary.outcome === "noAnswer"
                          ? `No answer ×${String(entry.summary.noAnswerCount ?? 1)}`
                          : "Spoke to them"}
                      </Slip>
                    )}
                    {entry.summary?.kind === "attempt" && entry.summary.callbackAt && (
                      <Slip kind="line" icon="callback">
                        Callback {callbackDate(entry.summary.callbackAt, zone)}
                      </Slip>
                    )}
                    <time
                      className="tl-time text-(length:--text-caption) text-tertiary ms-auto whitespace-nowrap"
                      dateTime={entry.at.toISOString()}
                    >
                      {shortDate(entry.at, zone)}
                    </time>
                  </div>
                  {display.body && (
                    <p className="tl-body text-(length:--text-small) leading-[19px] text-secondary mt-[2px] [overflow-wrap:anywhere]">
                      {display.body}
                    </p>
                  )}
                  {entry.actor && entry.kind !== "assignment" && (
                    <div className="tl-body text-(length:--text-small) leading-[19px] mt-[2px] [overflow-wrap:anywhere] text-secondary">
                      {entry.actor.name}
                    </div>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </>
  );
}
