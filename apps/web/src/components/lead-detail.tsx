"use client";
import { useEffect, useState, useRef, type SyntheticEvent } from "react";
import { DEAD_REASONS, recordScope, scopeAdmits } from "@relay/domain";
import { api, type Inputs, type Outputs } from "@/lib/api";
import { failureMessage } from "@/lib/failures";
import { localCallback, shortDate, sourceLabel } from "@/lib/display";
import { Avatar, Empty, Loading, Refusal, Signoff, Slip } from "./pieces";
import { Icon, type IconName } from "./icons";
import { Button } from "./ui/button";
import { Card } from "./ui/card";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "./ui/tabs";
import { RadioGroup, RadioGroupItem } from "./ui/radio-group";
import { Checkbox } from "./ui/checkbox";
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
  if (entry.kind === "assignment")
    return {
      title: "Lead assigned",
      body: entry.actor
        ? `By ${entry.actor.name}, from the lead pool or a previous assignment.`
        : "Assignment recorded",
      icon: "assign",
    };
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
            ? closing.reason
            : "",
      icon: "done",
    };
  }
  return {
    title: entry.kind === "intake" ? "Lead received" : "Status changed",
    body: "",
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
  const [remote, setRemote] = useState<Remote<Lead>>({ status: "loading" });
  const [revision, setRevision] = useState(0);
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
  const [success, setSuccess] = useState<string | null>(null);
  useEffect(() => {
    const c = new AbortController();
    setRemote({ status: "loading" });
    void api.leads.get.query({ id }, { signal: c.signal }).then(
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
  }, [id, revision]);
  const request = useRef<{ body: string; key: string } | null>(null);
  const tabValue = mode === "attempt" ? channel : mode === "close" ? closing : mode;
  function open(next: Mode, nextChannel?: "call" | "whatsApp") {
    request.current = null;
    setMode(next);
    if (nextChannel) setChannel(nextChannel);
    setError(null);
    setSuccess(null);
    setNote("");
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
      setMode("rest");
      setNote("");
      setRevision((r) => r + 1);
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
      setMode("rest");
      setRevision((r) => r + 1);
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
          {failureMessage(remote.error)}
        </Empty>
      </>
    );
  const lead = remote.value;
  const state = lead.lifecycle.state;
  const isOpen =
    state.status === "new" || state.status === "assigned" || state.status === "working";
  const canEdit = isOpen && scopeAdmits(recordScope(profile, "lead", "edit"), state);
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
              <Slip kind={callbackAt < new Date() ? "pink" : "canary"} icon="callback">
                Callback {shortDate(callbackAt, zone)}
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
            time={
              lead.custody.receivedFrom ? shortDate(lead.custody.receivedFrom.at, zone) : "Unknown"
            }
            icon="inbox"
          />
          <Signoff
            caption="Assigned by"
            name={lead.custody.assignedBy?.name ?? null}
            time={
              lead.custody.assignedBy?.at ? shortDate(lead.custody.assignedBy.at, zone) : undefined
            }
          />
          <Signoff
            caption="Held by"
            name={lead.custody.heldBy?.name ?? null}
            time={
              lead.custody.heldBy?.since ? shortDate(lead.custody.heldBy.since, zone) : undefined
            }
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
        {success && (
          <div className="alert alert--info" role="status">
            <Icon name="check" />
            <span>{success}</span>
          </div>
        )}
        {error && (
          <Refusal title={mode === "close" ? "The lead was not closed" : "This was not saved"}>
            {error}
          </Refusal>
        )}
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
                    <TabsList aria-label="Attempt channel">
                      <TabsTrigger value="call">
                        <Icon name="call" size="small" />
                        Call
                      </TabsTrigger>
                      <TabsTrigger value="whatsApp">
                        <Icon name="whatsapp" size="small" />
                        WhatsApp
                      </TabsTrigger>
                    </TabsList>
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
                  role={mode === "attempt" || mode === "close" ? "tabpanel" : undefined}
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
                      <span className="label">
                        {mode === "close" ? "Why was it lost?" : "Note"}
                      </span>
                      <Textarea
                        required
                        maxLength={4000}
                        value={note}
                        onChange={(e) => {
                          setNote(e.target.value);
                        }}
                      />
                      {mode === "close" && (
                        <span className="help">
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
                            ? "Saves an attempt. This does not mark the lead as contacted."
                            : "Saves an attempt and marks the lead as contacted."
                          : "Saved entries cannot be edited or deleted."}
                    </span>
                    <Button
                      variant="ghost"
                      disabled={pending}
                      onClick={() => {
                        setMode("rest");
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
          {canEdit && mode === "rest" && (
            <div className="tl-actions">
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
          {lead.timeline.slice(0, visible).map((entry) => {
            const display = timelineEntry(entry, zone);
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
                        Callback {shortDate(entry.summary.callbackAt, zone)}
                      </Slip>
                    )}
                    <time className="tl-time" dateTime={entry.at.toISOString()}>
                      {shortDate(entry.at, zone)}
                    </time>
                  </div>
                  {display.body && <p className="tl-body">{display.body}</p>}
                  {entry.actor && (
                    <div className="tl-body t3">
                      <Avatar name={entry.actor.name} />
                      <span> {entry.actor.name}</span>
                    </div>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
        {lead.timeline.length > visible && (
          <Button
            variant="ghost"
            onClick={() => {
              setVisible((n) => n + 20);
            }}
          >
            Show earlier entries
          </Button>
        )}
      </div>
    </>
  );
}
