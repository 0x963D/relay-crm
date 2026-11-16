"use client";
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
import { reads } from "@/lib/reads";
import type { Profile, Remote } from "./queue";
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
  const remote: Remote<Lead> = query.data
    ? { status: "ready", value: query.data }
    : query.isError
      ? { status: "error", error: query.error }
      : { status: "loading" };
  const [mode, setMode] = useState<Mode>(action ? "attempt" : "rest");
  const [channel, setChannel] = useState<"call" | "whatsApp">(
    action === "whatsapp" ? "whatsApp" : "call",
  );
  const [outcome, setOutcome] = useState<"noAnswer" | "spokeToThem">("noAnswer");
  const [closing, setClosing] = useState<"won" | "lost" | "dead">("lost");
  const [deadReason, setDeadReason] = useState<(typeof DEAD_REASONS)[number]>("duplicate");
  const [note, setNote] = useState("");
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
        ?.querySelector<HTMLElement>("button:not([disabled]), input, textarea, select")
        ?.focus();
  }, [mode]);
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
      if (state.status === "working" && state.stage.kind === "callBack") {
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
      closeComposer();
      setNote("");
      await client.invalidateQueries({ queryKey: reads.lead(id).queryKey });
      onSaved();
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
      closeComposer();
      await client.invalidateQueries({ queryKey: reads.lead(id).queryKey });
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
        <Button variant="ghost" className="mobile-back" onClick={onBack}>
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
      <div className="pad lead-head">
        <Button variant="ghost" className="mobile-back" onClick={onBack}>
          <Icon name="back" />
          Back to queue
        </Button>
        <div>
          <div className="row lead-title">
            <h2>{lead.name ?? lead.email}</h2>
            <span className="sp" />
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
          <div className="row sm t2 lead-contact">
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
        <div className="signoff">
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
        <dl className="attribution">
          {(
            [
              ["Campaign", lead.attribution?.campaign],
              ["Ad set", lead.attribution?.adSet],
              ["Ad", lead.attribution?.ad],
              ["Form", lead.attribution?.form],
            ] as const
          ).map(([caption, value]) => (
            <div key={caption}>
              <dt className="cap">{caption}</dt>
              <dd className="sm">{value ?? "Unknown"}</dd>
            </div>
          ))}
        </dl>
      </div>
      <div className="pad lead-body">
        <div role="status" aria-live="polite" aria-atomic="true" tabIndex={-1} ref={feedback}>
          {success && (
            <div className="alert alert--info">
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
          <Card className="composer">
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
                className="col composer-form"
                onSubmit={(event) => {
                  void save(event);
                }}
              >
                <div className="row panel-head">
                  <h3 className="h2">
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
                  <span className="sp" />
                  {mode === "attempt" && (
                    <RadioGroup
                      className="tabs channel-choices"
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
                  className="composer-content"
                  value={tabValue}
                  aria-labelledby={undefined}
                  aria-label="Lead work"
                  role={mode === "attempt" || mode === "close" ? "tabpanel" : "region"}
                >
                  {mode === "attempt" && (
                    <>
                      <div className="field">
                        <span className="label" id="attempt-outcome">
                          What happened?
                        </span>
                        <RadioGroup
                          className="attempt-options"
                          aria-labelledby="attempt-outcome"
                          value={outcome}
                          onValueChange={(v) => {
                            if (v === "noAnswer" || v === "spokeToThem") setOutcome(v);
                          }}
                        >
                          <label className="opt" data-checked={outcome === "noAnswer"}>
                            <RadioGroupItem value="noAnswer" />
                            <span>
                              <span className="b">No answer</span>
                              <br />
                              <span className="help">
                                Counts as no answer number {lead.noAnswerCount + 1}
                              </span>
                            </span>
                          </label>
                          <label className="opt" data-checked={outcome === "spokeToThem"}>
                            <RadioGroupItem value="spokeToThem" />
                            <span>
                              <span className="b">Spoke to them</span>
                              <br />
                              <span className="help">Marks the lead as contacted</span>
                            </span>
                          </label>
                        </RadioGroup>
                      </div>
                      {lead.phone && (
                        <p className="help">
                          Use your own {channel === "call" ? "phone" : "WhatsApp"}, then save what
                          happened.{" "}
                          <a
                            className="link"
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
                    <div className="callback-fields">
                      {mode === "attempt" && (
                        <label className="row callback-check">
                          <Checkbox
                            checked={callback}
                            onCheckedChange={(v) => {
                              setCallback(v === true);
                            }}
                          />
                          <span className="b">Call back</span>
                        </label>
                      )}
                      {(mode === "callback" || callback) && (
                        <>
                          <label className="field">
                            <span className="label">Day</span>
                            <Input
                              type="date"
                              required
                              value={day}
                              onChange={(e) => {
                                setDay(e.target.value);
                              }}
                            />
                            {day && (
                              <span className="help">
                                {dayLabel(new Date(`${day}T12:00:00Z`), "UTC")}
                              </span>
                            )}
                          </label>
                          <label className="field">
                            <span className="label">Time</span>
                            <Input
                              type="time"
                              required
                              value={time}
                              onChange={(e) => {
                                setTime(e.target.value);
                              }}
                            />
                          </label>
                          <p className="help">Times use {zone}.</p>
                        </>
                      )}
                    </div>
                  )}
                  {(mode === "attempt" ||
                    mode === "note" ||
                    (mode === "close" && closing === "lost")) && (
                    <label className="field">
                      <span className="label" id="work-note-label">
                        {mode === "close" ? "Why was it lost?" : "Note"}
                      </span>
                      <Textarea
                        aria-labelledby="work-note-label"
                        aria-describedby={mode === "close" ? "lost-help" : undefined}
                        required={
                          mode === "attempt" ||
                          mode === "note" ||
                          (mode === "close" && closing === "lost")
                        }
                        maxLength={4000}
                        value={note}
                        onChange={(e) => {
                          setNote(e.target.value);
                        }}
                      />
                      {mode === "close" && (
                        <span className="help" id="lost-help">
                          Required, in your own words. There are no categories to pick. The reason
                          is saved on the timeline with your name.
                        </span>
                      )}
                    </label>
                  )}
                  {mode === "close" && closing === "dead" && (
                    <label className="field">
                      <span className="label">Why is this lead dead?</span>
                      <select
                        className="input"
                        value={deadReason}
                        onChange={(e) => {
                          const reason = DEAD_REASONS.find((v) => v === e.target.value);
                          if (reason) setDeadReason(reason);
                        }}
                      >
                        <option value="duplicate">Duplicate</option>
                        <option value="wrongNumber">Wrong number</option>
                        <option value="doNotContact">Do not contact</option>
                      </select>
                      <span className="help">
                        Wrong number needs an attempt in this assignment first.
                      </span>
                    </label>
                  )}
                  {mode === "close" && (
                    <dl className="kv closure-info">
                      <dt className="b">Won</dt>
                      <dd>Creates an account and keeps this history. Final.</dd>
                      <dt className="b">Lost</dt>
                      <dd>Needs a written reason. Reopens only if they enquire again.</dd>
                      <dt className="b">Dead</dt>
                      <dd>For a duplicate, wrong number or do-not-contact request. Final.</dd>
                    </dl>
                  )}
                  <div className="row form-actions">
                    <span className="help">
                      {mode === "close"
                        ? "Closing is saved to the timeline and cannot be undone here."
                        : mode === "attempt"
                          ? outcome === "noAnswer"
                            ? `Saves as ${channel === "call" ? "call" : "WhatsApp"} attempt, no answer �${String(lead.noAnswerCount + 1)}${callback && localCallback(`${day}T${time}`, zone) ? `, callback ${callbackDate(localCallback(`${day}T${time}`, zone), zone)}` : ""}. The lead moves to ${callback ? (day === callbackFields(new Date(), zone).day ? "Due today" : "Later") : "No callback set"} in the queue. This does not mark the lead as contacted.`
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
        <div className="row timeline-heading">
          <h3 className="h3">Timeline</h3>
          <span className="cap">Saved entries cannot be edited or deleted</span>
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
            <div className="tl-actions" hidden={mode !== "rest"}>
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
        <ul className="tl">
          {lead.timeline.slice(0, mode === "rest" || expanded ? visible : 1).map((entry) => {
            const display = timelineEntry(entry, zone, lead);
            return (
              <li className="tl-item" key={entry.id}>
                <span className="tl-dot">
                  <Icon name={display.icon} size="small" />
                </span>
                <div>
                  <div className="tl-head">
                    <span className="b">{display.title}</span>
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
                    <time className="tl-time" dateTime={entry.at.toISOString()}>
                      {shortDate(entry.at, zone)}
                    </time>
                  </div>
                  {display.body && <p className="tl-body">{display.body}</p>}
                  {entry.actor && entry.kind !== "assignment" && (
                    <div className="tl-body t3">{entry.actor.name}</div>
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
