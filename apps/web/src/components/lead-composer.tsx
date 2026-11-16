"use client";
import { useEffect, useRef, useState, type SyntheticEvent } from "react";
import { DEAD_REASONS } from "@relay/domain";
import type { Inputs, Outputs } from "@/lib/api";
import { callbackFields, callbackDate, localCallback, dayLabel } from "@/lib/display";
import { cn } from "@/lib/utils";
import { Card } from "./ui/card";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";
import { NativeSelect } from "./ui/native-select";
import { Checkbox } from "./ui/checkbox";
import { RadioGroup, RadioGroupItem } from "./ui/radio-group";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "./ui/tabs";
import { Icon } from "./icons";
export type ComposerMode = "attempt" | "callback" | "note" | "close";
type Command =
  | { kind: "attempt"; input: Inputs["leads"]["logAttempt"] }
  | { kind: "note"; input: Inputs["leads"]["addNote"] }
  | { kind: "callback"; input: Inputs["leads"]["setCallback"] }
  | { kind: "close"; input: Inputs["leads"]["close"] };
export function LeadComposer({
  active,
  mode,
  channel: initialChannel,
  lead,
  zone,
  busy,
  onSubmit,
  onCancel,
  onInvalid,
}: {
  active: boolean;
  mode: ComposerMode;
  channel: "call" | "whatsApp";
  lead: Outputs["leads"]["get"];
  zone: string;
  busy: boolean;
  onSubmit: (command: Command) => void;
  onCancel: () => void;
  onInvalid: (text: string) => void;
}) {
  const state = lead.lifecycle.state;
  const callbackAt =
    state.status === "working" && state.stage.kind === "callBack" ? state.stage.at : null;
  const fields =
    callbackAt && mode === "callback" ? callbackFields(callbackAt, zone) : { day: "", time: "" };
  const [channel, setChannel] = useState(initialChannel);
  const [outcome, setOutcome] = useState<"noAnswer" | "spokeToThem">("noAnswer");
  const [closing, setClosing] = useState<"won" | "lost" | "dead">("lost");
  const [deadReason, setDeadReason] = useState<(typeof DEAD_REASONS)[number]>("duplicate");
  const [note, setNote] = useState("");
  const [callback, setCallback] = useState(false);
  const [day, setDay] = useState(fields.day);
  const [time, setTime] = useState(fields.time);
  const request = useRef<{ body: string; key: string } | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const firstChannel = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (active) (firstChannel.current ?? heading.current)?.focus();
  }, [active]);
  const title =
    mode === "attempt"
      ? "Log an attempt"
      : mode === "note"
        ? "Add a note"
        : mode === "close"
          ? "Close this lead"
          : callbackAt
            ? "Move callback"
            : "Set a callback";
  const tab = mode === "close" ? closing : mode;
  function keyFor(body: unknown) {
    const serialized = JSON.stringify(body);
    if (request.current?.body !== serialized)
      request.current = { body: serialized, key: crypto.randomUUID() };
    return request.current.key;
  }
  function submit(event: SyntheticEvent) {
    event.preventDefault();
    if (busy) return;
    const at = localCallback(`${day}T${time}`, zone);
    if ((mode === "callback" || (mode === "attempt" && callback)) && !at) {
      onInvalid("Choose a valid day and time for this timezone.");
      return;
    }
    const change = at ? { kind: "set" as const, at } : undefined;
    const key = keyFor({ mode, channel, outcome, closing, deadReason, note, change, callback });
    const id = lead.id;
    if (mode === "attempt")
      onSubmit({
        kind: mode,
        input: {
          id,
          key,
          channel,
          outcome,
          note,
          ...(callback && change ? { callback: change } : {}),
        },
      });
    if (mode === "note") onSubmit({ kind: mode, input: { id, key, note } });
    if (mode === "callback" && change) onSubmit({ kind: mode, input: { id, key, change } });
    if (mode === "close")
      onSubmit({
        kind: mode,
        input: {
          id,
          key,
          closing:
            closing === "won"
              ? { kind: "won" }
              : closing === "lost"
                ? { kind: "lost", note }
                : { kind: "dead", reason: deadReason },
        },
      });
  }
  const selectedDay = day ? localCallback(`${day}T12:00`, zone) : null;
  const at = localCallback(`${day}T${time}`, zone);
  const destination = callback
    ? day === callbackFields(new Date(), zone).day
      ? "Due today"
      : "Later"
    : "No callback set";
  const summary =
    outcome === "noAnswer"
      ? `Saves as ${channel === "call" ? "call" : "WhatsApp"} attempt, no answer ×${String(lead.noAnswerCount + 1)}${callback && at ? `, callback ${callbackDate(at, zone)}` : ""}. The lead moves to ${destination} in the queue. This does not mark the lead as contacted.`
      : `Saves a ${channel === "call" ? "call" : "WhatsApp"} attempt and marks the lead as contacted. The lead moves to ${destination} in the queue.`;
  return (
    <Card className="gap-3 rounded-lg border-input p-4 shadow-none">
      <Tabs
        value={tab}
        onValueChange={(value) => {
          if (value === "won" || value === "lost" || value === "dead") setClosing(value);
        }}
      >
        <form
          onSubmit={submit}
          onKeyDown={(event) => {
            if (event.key === "Escape" && !busy) {
              event.preventDefault();
              onCancel();
            }
          }}
          className="space-y-3"
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h3 ref={heading} tabIndex={-1} className="text-panel font-bold">
              {title}
            </h3>
            {mode === "attempt" && (
              <RadioGroup
                aria-label="Attempt channel"
                value={channel}
                className="flex rounded-md bg-muted p-1"
                onValueChange={(value) => {
                  if (value === "call" || value === "whatsApp") setChannel(value);
                }}
              >
                {(["call", "whatsApp"] as const).map((value) => (
                  <label
                    key={value}
                    className={cn(
                      "flex min-h-11 items-center gap-2 rounded px-2 @lg/detail:min-h-7",
                      channel === value && "bg-background",
                    )}
                  >
                    <RadioGroupItem
                      ref={value === "call" ? firstChannel : undefined}
                      value={value}
                    />
                    <Icon name={value === "call" ? "call" : "whatsapp"} size="small" />
                    {value === "call" ? "Call" : "WhatsApp"}
                  </label>
                ))}
              </RadioGroup>
            )}
            {mode === "close" && (
              <TabsList aria-label="Close outcome">
                <TabsTrigger value="won">Won</TabsTrigger>
                <TabsTrigger value="lost">Lost</TabsTrigger>
                <TabsTrigger value="dead">Dead</TabsTrigger>
              </TabsList>
            )}
          </div>
          <TabsContent
            value={tab}
            role={mode === "close" ? "tabpanel" : "region"}
            aria-labelledby={undefined}
            aria-label="Lead work"
            className="space-y-3"
          >
            {mode === "attempt" && (
              <>
                <fieldset className="space-y-2">
                  <legend className="text-caption font-semibold">What happened?</legend>
                  <RadioGroup
                    aria-label="What happened?"
                    value={outcome}
                    className="grid gap-2 @lg/detail:grid-cols-2"
                    onValueChange={(value) => {
                      if (value === "noAnswer" || value === "spokeToThem") setOutcome(value);
                    }}
                  >
                    {(["noAnswer", "spokeToThem"] as const).map((value) => (
                      <label
                        key={value}
                        className={cn(
                          "flex items-center gap-2 rounded-md border p-3",
                          outcome === value && "border-primary bg-accent",
                        )}
                      >
                        <RadioGroupItem
                          value={value}
                          aria-label={value === "noAnswer" ? "No answer" : "Spoke to them"}
                        />
                        <span>
                          <span className="font-semibold">
                            {value === "noAnswer" ? "No answer" : "Spoke to them"}
                          </span>
                          <span className="block text-xs text-muted-foreground">
                            {value === "noAnswer"
                              ? `Counts as no answer number ${String(lead.noAnswerCount + 1)}`
                              : "Marks the lead as contacted"}
                          </span>
                        </span>
                      </label>
                    ))}
                  </RadioGroup>
                </fieldset>
              </>
            )}
            {(mode === "callback" || mode === "attempt") && (
              <div
                className={cn(
                  "grid items-start gap-3",
                  mode === "attempt" && "@lg/detail:grid-cols-[auto_1fr]",
                )}
              >
                {mode === "attempt" && (
                  <label className="flex min-h-9 items-center gap-2 font-semibold">
                    <Checkbox
                      checked={callback}
                      onCheckedChange={(value) => {
                        setCallback(value === true);
                      }}
                    />
                    Call back
                  </label>
                )}
                {(mode === "callback" || callback) && (
                  <div className="grid grid-cols-2 gap-3">
                    <label className="space-y-1">
                      <span className="text-caption font-semibold">Day</span>
                      <Input
                        type="date"
                        aria-label="Day"
                        aria-describedby="callback-day-label"
                        required
                        value={day}
                        onChange={(event) => {
                          setDay(event.target.value);
                        }}
                      />
                      <span id="callback-day-label" className="block text-xs text-muted-foreground">
                        {selectedDay ? dayLabel(selectedDay, zone) : "Choose a day"}
                      </span>
                    </label>
                    <label className="space-y-1">
                      <span className="text-caption font-semibold">Time</span>
                      <Input
                        type="time"
                        aria-label="Time"
                        aria-describedby="callback-time-zone"
                        required
                        value={time}
                        onChange={(event) => {
                          setTime(event.target.value);
                        }}
                      />
                      <span id="callback-time-zone" className="block text-xs text-muted-foreground">
                        {zone}
                      </span>
                    </label>
                  </div>
                )}
              </div>
            )}
            {(mode === "attempt" ||
              mode === "note" ||
              (mode === "close" && closing === "lost")) && (
              <label className="block space-y-1">
                <span className="text-caption font-semibold">
                  {mode === "close" ? "Why was it lost?" : "Note"}
                </span>
                <Textarea
                  aria-label={mode === "close" ? "Why was it lost?" : "Note"}
                  required
                  value={note}
                  onChange={(event) => {
                    setNote(event.target.value);
                  }}
                  rows={1}
                  className="min-h-10"
                />
                {mode === "close" && (
                  <span className="block text-xs text-muted-foreground">
                    Required, in your own words. There are no categories to pick. The reason is
                    saved on the timeline with your name.
                  </span>
                )}
              </label>
            )}
            {mode === "close" && closing === "dead" && (
              <label className="block space-y-1">
                <span className="text-caption font-semibold">Why is this lead dead?</span>
                <NativeSelect
                  value={deadReason}
                  onChange={(event) => {
                    const reason = DEAD_REASONS.find((value) => value === event.target.value);
                    if (reason) setDeadReason(reason);
                  }}
                >
                  <option value="duplicate">Duplicate</option>
                  <option value="wrongNumber">Wrong number</option>
                  <option value="doNotContact">Do not contact</option>
                </NativeSelect>
                <span className="block text-xs text-muted-foreground">
                  Wrong number needs an attempt in this assignment first.
                </span>
              </label>
            )}
            {mode === "close" && (
              <dl className="grid grid-cols-1 gap-x-3 gap-y-1 rounded-md bg-muted p-3 text-caption @lg/detail:grid-cols-[auto_1fr]">
                <dt className="font-semibold">Won</dt>
                <dd>Creates an account and keeps this history. Final.</dd>
                <dt className="font-semibold">Lost</dt>
                <dd>Needs a written reason. Reopens only if they enquire again.</dd>
                <dt className="font-semibold">Dead</dt>
                <dd>For a duplicate, wrong number or do-not-contact request. Final.</dd>
              </dl>
            )}
            <p role="status" aria-live="polite" className="text-xs text-muted-foreground">
              {mode === "attempt"
                ? summary
                : mode === "close"
                  ? "Closing is saved to the timeline and cannot be undone here."
                  : "Saved entries cannot be edited or deleted."}
            </p>
            <div className="flex flex-wrap justify-end gap-2">
              <Button type="button" variant="ghost" busy={busy} onClick={onCancel}>
                Cancel
              </Button>
              <Button type="submit" busy={busy}>
                {busy ? "Saving…" : mode === "close" ? `Close as ${closing}` : `Save ${mode}`}
              </Button>
            </div>
            {mode === "callback" && callbackAt && (
              <Button
                type="button"
                variant="destructive"
                busy={busy}
                onClick={() => {
                  const change = { kind: "clear" as const };
                  onSubmit({
                    kind: "callback",
                    input: { id: lead.id, key: keyFor(change), change },
                  });
                }}
              >
                Clear callback
              </Button>
            )}
          </TabsContent>
        </form>
      </Tabs>
    </Card>
  );
}
