import { useEffect, useRef, useState } from "react";
import type { ComponentRef } from "react";
import {
  AccessibilityInfo,
  Modal,
  PanResponder,
  Pressable,
  ScrollView,
  View,
  useWindowDimensions,
} from "react-native";
import * as Clipboard from "expo-clipboard";
import { useRouter } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { failureFrom } from "../api/client.ts";
import { useReadOptions, useReadOnReturn } from "../api/use-read-options.ts";
import { useSession } from "../api/session-provider.tsx";
import { readFailureText, RequestFailure } from "../core/failure.ts";
import { clock, contextualDate, overdue } from "../core/dates.ts";
import { knownLeadState, leadContact } from "../core/lead.ts";
import { sessionPerson } from "../core/session.ts";
import { attemptOutcome, sourceLabel } from "../core/queue.ts";
import { timelinePresentation } from "../core/timeline.ts";
import { useHandoff } from "../ui/handoff.tsx";
import {
  Avatar,
  Band,
  Button,
  Empty,
  Header,
  Icon,
  IconButton,
  Screen,
  Sheet,
  Skeleton,
  Slip,
  T,
} from "../ui/pieces.tsx";
import { useElevation, useTheme } from "../ui/theme.ts";
import { Fade, openWrite, ReviewBand, WriteNotice } from "../ui/write-controls.tsx";
import { useWriteFeedback } from "../api/write-feedback.tsx";
import { canOfferCall } from "../core/handoff.ts";
import type { Operation } from "../core/write-machine.ts";

export function LeadScreen({ id }: { id: string }) {
  const c = useTheme();
  const sheetElevation = useElevation(2);
  const inset = useSafeAreaInsets();
  const { fontScale } = useWindowDimensions();
  const session = useSession();
  const router = useRouter();
  const [expanded, setExpanded] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const [copied, setCopied] = useState(false);
  const [more, setMore] = useState(false);
  const historyScroll = useRef<ComponentRef<typeof ScrollView>>(null);
  const historyTop = useRef(0);
  const { notice } = useWriteFeedback();
  useEffect(() => {
    if (notice?.entry.command.payload.id !== id || !notice.toast) return;
    setScrolled(true);
    const timer = setTimeout(() => {
      historyScroll.current?.scrollTo({ y: historyTop.current, animated: false });
    }, 400);
    return () => {
      clearTimeout(timer);
    };
  }, [id, notice?.entry.command.payload.id, notice?.entry.command.payload.key, notice?.toast]);
  const moreButton = useRef<ComponentRef<typeof View>>(null);
  const sheetTitle = useRef<ComponentRef<typeof View>>(null);
  const openedMore = useRef(false);
  const swipe = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_event, gesture) =>
        gesture.dy > 10 && Math.abs(gesture.dx) < 20,
      onPanResponderRelease: (_event, gesture) => {
        if (gesture.dy > 40) setMore(false);
      },
    }),
  ).current;
  useEffect(() => {
    if (more) {
      openedMore.current = true;
      return;
    }
    if (!openedMore.current) return;
    const timer = setTimeout(() => {
      if (moreButton.current) AccessibilityInfo.sendAccessibilityEvent(moreButton.current, "focus");
    }, 250);
    return () => {
      clearTimeout(timer);
    };
  }, [more]);
  const handoff = useHandoff();
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => {
      setCopied(false);
    }, 2000);
    return () => {
      clearTimeout(timer);
    };
  }, [copied]);
  const options = useReadOptions();
  const query = useQuery(options.lead(id));
  const queue = useQuery({ ...options.queue, enabled: false });
  useReadOnReturn(query.refetch);
  const denied =
    query.error instanceof RequestFailure &&
    query.error.failure.kind === "refused" &&
    query.error.failure.reason === "accessDenied";
  const lead = denied ? undefined : query.data;
  const zone = queue.data?.timeZone;
  const now = new Date();
  const person = sessionPerson(session.state) ?? "";
  const contact = leadContact(id, lead, queue.data, query.isError);
  const actualName = contact.name;
  const actualPhone = contact.phone;
  const actualEmail = contact.email;
  const callablePhone = contact.callablePhone;
  const held = session.phone?.entries().some((entry) => entry.command.payload.id === id);
  function open(channel: "call" | "whatsApp") {
    if (!callablePhone) return;
    if (held) void handoff.open(channel === "call" ? "call" : "whatsapp", callablePhone);
    else openWrite(router, "attempt", id, channel, callablePhone);
  }
  const state = lead?.lifecycle.state;
  const statusKnown = state
    ? knownLeadState(state.status, state.status === "working" ? state.stage.kind : undefined)
    : false;
  const closed = state?.status === "won" || state?.status === "lost" || state?.status === "dead";
  const callback =
    state?.status === "working" && state.stage.kind === "callBack" ? state.stage.at : null;
  const closure = lead?.timeline.find((entry) => entry.kind === "closure");
  function copy(value: string | null) {
    if (value)
      void Clipboard.setStringAsync(value).then(() => {
        setCopied(true);
      });
  }
  function backToQueue() {
    router.dismissTo("/");
  }
  function detail(label: string, value: string) {
    return (
      <View key={label} style={{ flex: 1, gap: 4 }}>
        <T variant="caption" color={c.text3}>
          {label}
        </T>
        <T variant="secondary">{value}</T>
      </View>
    );
  }
  function custody(
    holder: { id: string; name: string } | null,
    at: Date | null,
    assigned: boolean,
  ) {
    const display = holder ? (holder.id === person ? "You" : holder.name) : "Not recorded";
    const date = at ? contextualDate(at, now, zone, "custody") : "";
    return (
      <View
        accessible
        accessibilityLabel={`${assigned ? "Assigned by" : "Held by"} ${display}${date ? `, ${assigned ? "" : "from "}${date}` : ""}`}
        style={{ flex: 1, gap: 5 }}
      >
        <View
          style={{
            borderBottomWidth: 1,
            borderBottomColor: c.text,
            paddingBottom: 7,
            minHeight: 32,
            flexDirection: "row",
            alignItems: "center",
            gap: 8,
          }}
        >
          {holder && <Avatar name={holder.name} size={26} />}
          <T variant="bodyStrong" color={holder ? c.text : c.text3} style={{ flexShrink: 1 }}>
            {display}
          </T>
        </View>
        <T variant="caption" color={c.text3}>
          {assigned ? "Assigned by" : "Held by"}
          {date ? ` · ${assigned ? "" : "from "}${date}` : ""}
        </T>
      </View>
    );
  }
  return (
    <Screen>
      <Header
        back
        title={actualName}
        summary={
          denied || scrolled ? undefined : (
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
              <Pressable
                accessibilityRole={actualPhone ? "button" : "text"}
                accessibilityLabel={
                  actualPhone === "" || actualPhone === null ? "No phone number" : actualPhone
                }
                accessibilityActions={
                  actualPhone ? [{ name: "copy", label: "Copy phone number" }] : []
                }
                onAccessibilityAction={(event) => {
                  if (event.nativeEvent.actionName === "copy") copy(actualPhone);
                }}
                onPress={() => {
                  copy(actualPhone);
                }}
                onLongPress={() => {
                  copy(actualPhone);
                }}
                style={{ minHeight: 48, justifyContent: "center" }}
              >
                <T variant="small" color={c.onCarbon2}>
                  {actualPhone === "" || actualPhone === null ? "No phone number" : actualPhone}
                </T>
              </Pressable>
              {actualEmail && (
                <T
                  variant="small"
                  color={c.onCarbon2}
                  accessible={false}
                  style={{ alignSelf: "center" }}
                >
                  ·
                </T>
              )}
              <Pressable
                accessibilityRole={actualEmail ? "button" : "text"}
                accessibilityLabel={actualEmail}
                accessibilityActions={
                  actualEmail ? [{ name: "copy", label: "Copy email address" }] : []
                }
                onAccessibilityAction={(event) => {
                  if (event.nativeEvent.actionName === "copy") copy(actualEmail);
                }}
                onPress={() => {
                  copy(actualEmail);
                }}
                onLongPress={() => {
                  copy(actualEmail);
                }}
                style={{ flexShrink: 1, minHeight: 48, justifyContent: "center" }}
              >
                <T variant="small" color={c.onCarbon2} ellipsizeMode="middle" numberOfLines={1}>
                  {actualEmail}
                </T>
              </Pressable>
            </View>
          )
        }
      />
      <Sheet>
        {denied ? (
          <Empty
            title="This lead is no longer yours"
            text="Its owner or your access changed while it was open. Nothing you saved earlier is lost."
            icon="lock"
            action="Back to queue"
            onPress={backToQueue}
          />
        ) : !lead ? (
          query.isPending ? (
            <Skeleton lead />
          ) : (
            <Empty
              title="The lead could not be loaded"
              text={readFailureText(failureFrom(query.error))}
              icon="offline"
              action="Try again"
              onPress={() => {
                void query.refetch({ cancelRefetch: false });
              }}
            />
          )
        ) : (
          <ScrollView
            ref={historyScroll}
            onScroll={(event) => {
              setScrolled(event.nativeEvent.contentOffset.y > 8);
            }}
            scrollEventThrottle={100}
            contentContainerStyle={{ padding: 16, paddingBottom: 24, gap: 24 }}
          >
            {handoff.band}
            {query.isError && (
              <Band
                title="The lead could not refresh"
                text="This screen shows the last loaded history."
                icon="offline"
              >
                <Button
                  small
                  outline
                  label="Try again"
                  onPress={() => {
                    void query.refetch({ cancelRefetch: false });
                  }}
                />
              </Band>
            )}
            {closed && closure && closure.actor?.id !== person && (
              <Band
                kind="info"
                icon="help"
                title={`${closure.actor ? `${closure.actor.name} closed this lead` : "This lead was closed"}${zone ? ` at ${clock(closure.at, zone)}` : ""}`}
                text="Nothing more can be logged here. The reason is in the timeline."
              />
            )}
            <Slip
              kind={
                !statusKnown
                  ? "mute"
                  : closed
                    ? state.status === "won"
                      ? "done"
                      : "mute"
                    : callback
                      ? callback < now
                        ? "refused"
                        : "wait"
                      : "mute"
              }
              icon={
                closed
                  ? state.status === "won"
                    ? "done"
                    : "ban"
                  : callback
                    ? callback < now
                      ? "alarm"
                      : "calendar"
                    : lead.contactedAt
                      ? "check"
                      : "person"
              }
              text={
                !statusKnown
                  ? "Status recorded"
                  : closed
                    ? state.status === "won"
                      ? "Won"
                      : state.status === "lost"
                        ? "Lost"
                        : "Dead"
                    : callback
                      ? callback < now
                        ? `Callback overdue ${overdue(callback, now, zone).replace(/^Since/, "since")}`
                        : `Callback ${contextualDate(callback, now, zone, "callback")}`
                      : lead.contactedAt
                        ? "Contacted"
                        : "Not contacted"
              }
            />
            <View style={{ flexDirection: fontScale >= 1.3 ? "column" : "row", gap: 16 }}>
              {custody(lead.custody.assignedBy, lead.custody.assignedBy?.at ?? null, true)}
              {custody(lead.custody.heldBy, lead.custody.heldBy?.since ?? null, false)}
            </View>
            <View style={{ gap: 14 }}>
              <View style={{ flexDirection: fontScale >= 1.3 ? "column" : "row", gap: 14 }}>
                {detail("Campaign", lead.attribution?.campaign ?? "No campaign")}
                {detail("Source", sourceLabel(lead.source))}
              </View>
              <View style={{ flexDirection: fontScale >= 1.3 ? "column" : "row", gap: 14 }}>
                {detail(
                  "First contacted",
                  lead.contactedAt
                    ? contextualDate(lead.contactedAt, now, zone, "timeline")
                    : "Not yet",
                )}
                {detail("Unanswered attempts", String(lead.noAnswerCount))}
              </View>
            </View>
            <View
              onLayout={(event) => {
                historyTop.current = event.nativeEvent.layout.y;
              }}
              style={{ gap: 18 }}
            >
              <View
                style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "baseline", gap: 8 }}
              >
                <T variant="subheading">Timeline</T>
                <T variant="caption" color={c.text3}>
                  Saved entries cannot be edited or deleted
                </T>
              </View>
              <View
                accessibilityRole="list"
                accessibilityLabel={`Lead history, ${String(lead.timeline.length)} entries`}
              >
                {lead.timeline.slice(0, expanded ? undefined : 3).map((entry) => {
                  const p = timelinePresentation(entry, lead, person, now, zone);
                  const summary = entry.summary;
                  return (
                    <Fade key={entry.id} identity={entry.id}>
                      <View
                        accessible
                        accessibilityLabel={`${p.title}. ${summary?.kind === "attempt" ? `${attemptOutcome(summary.outcome, summary.noAnswerCount ?? 1).text}. ` : ""}${p.callback ? `${p.callback}. ` : ""}${p.time}. ${p.body}${p.actor ? `. By ${p.actor}.` : ""}`}
                        style={{ flexDirection: "row", gap: 12 }}
                      >
                        <View style={{ alignItems: "center", width: 28 }}>
                          <View
                            style={{
                              width: 28,
                              height: 28,
                              borderRadius: 14,
                              alignItems: "center",
                              justifyContent: "center",
                              backgroundColor: c.mute,
                            }}
                          >
                            <Icon name={p.icon} color={c.text3} size={14} />
                          </View>
                          <View style={{ width: 1, backgroundColor: c.rule, flex: 1 }} />
                        </View>
                        <View style={{ flex: 1, gap: 6, paddingBottom: 18 }}>
                          <View
                            style={{
                              flexDirection: fontScale >= 1.3 ? "column" : "row",
                              gap: 8,
                              alignItems: fontScale >= 1.3 ? "flex-start" : "baseline",
                            }}
                          >
                            <T
                              variant="bodyStrong"
                              style={{ flex: fontScale < 1.3 ? 1 : undefined }}
                            >
                              {p.title}
                            </T>
                            <T variant="caption" color={c.text3}>
                              {p.time}
                            </T>
                          </View>
                          {summary?.kind === "attempt" && (
                            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
                              <Slip
                                {...attemptOutcome(summary.outcome, summary.noAnswerCount ?? 1)}
                              />
                              {summary.callbackAt && (
                                <Slip
                                  kind="outline"
                                  icon="calendar"
                                  text={`Callback ${contextualDate(summary.callbackAt, now, zone, "callback")}`}
                                />
                              )}
                            </View>
                          )}
                          {p.body ? (
                            <T variant="secondary" color={c.text2}>
                              {p.body}
                            </T>
                          ) : null}
                          {p.actor && (
                            <T variant="caption" color={c.text3}>
                              {p.actor}
                            </T>
                          )}
                        </View>
                      </View>
                    </Fade>
                  );
                })}
              </View>
              {!expanded && lead.timeline.length > 3 && (
                <Pressable
                  accessibilityRole="button"
                  onPress={() => {
                    setExpanded(true);
                  }}
                  style={{ minHeight: 48, justifyContent: "center", paddingStart: 40 }}
                >
                  <T variant="small" color={c.ink}>
                    Show {lead.timeline.length - 3} earlier{" "}
                    {lead.timeline.length === 4 ? "entry" : "entries"}
                  </T>
                </Pressable>
              )}
            </View>
          </ScrollView>
        )}
        {copied && (
          <View
            accessible
            role="status"
            accessibilityLiveRegion="polite"
            accessibilityLabel="Copied"
            style={{ padding: 12 }}
          >
            <T variant="small">Copied</T>
          </View>
        )}
        {!denied && (
          <View
            style={{
              borderTopWidth: 1,
              borderTopColor: c.rule,
              paddingTop: 12,
              paddingHorizontal: 16,
              paddingBottom: inset.bottom + 12,
              gap: 12,
            }}
          >
            <ReviewBand id={id} zone={zone} />
            <WriteNotice
              id={id}
              zone={zone}
              updatedAt={query.dataUpdatedAt}
              readFailed={query.isError}
            />
            {closed ? (
              <Button outline label="Back to queue" onPress={backToQueue} />
            ) : (
              <>
                <View style={{ flexDirection: fontScale >= 1.6 ? "column" : "row", gap: 10 }}>
                  <Button
                    style={{ flex: fontScale < 1.6 ? 1 : undefined }}
                    icon="phone"
                    label="Call"
                    disabled={!canOfferCall(callablePhone)}
                    onPress={() => {
                      open("call");
                    }}
                  />
                  <Button
                    style={{ flex: fontScale < 1.6 ? 1 : undefined }}
                    outline
                    icon="whatsapp"
                    label="WhatsApp"
                    disabled={!callablePhone}
                    onPress={() => {
                      open("whatsApp");
                    }}
                  />
                  <IconButton
                    ref={moreButton}
                    outline
                    large
                    icon="more"
                    label="More actions"
                    disabled={!lead}
                    onPress={() => {
                      setMore(true);
                    }}
                  />
                </View>
              </>
            )}
          </View>
        )}
      </Sheet>
      <Modal
        onShow={() => {
          if (sheetTitle.current)
            AccessibilityInfo.sendAccessibilityEvent(sheetTitle.current, "focus");
        }}
        visible={more}
        transparent
        animationType="slide"
        onRequestClose={() => {
          setMore(false);
        }}
      >
        <View style={{ flex: 1, justifyContent: "flex-end", backgroundColor: c.scrim }}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Close"
            onPress={() => {
              setMore(false);
            }}
            style={{ flex: 1 }}
          />
          <View
            accessibilityViewIsModal
            accessibilityRole="menu"
            style={{
              ...sheetElevation,
              backgroundColor: c.sheet,
              borderTopStartRadius: 20,
              borderTopEndRadius: 20,
              padding: 16,
              paddingBottom: inset.bottom + 12,
              gap: 8,
            }}
          >
            <View
              {...swipe.panHandlers}
              style={{ minHeight: 44, justifyContent: "center", alignItems: "center" }}
            >
              <View style={{ width: 36, height: 5, borderRadius: 3, backgroundColor: c.rule2 }} />
            </View>
            <View
              ref={sheetTitle}
              accessible
              accessibilityRole="header"
              accessibilityLabel="More actions"
            >
              <T variant="heading">More actions</T>
            </View>
            {held && <T variant="small">Review the kept entry first.</T>}
            {(
              [
                ["attempt", "Log an attempt"],
                ["note", "Add a note"],
                ["callback", callback ? "Move callback" : "Set a callback"],
                ["close", "Close this lead"],
              ] satisfies [Operation, string][]
            ).map(([operation, label]) => (
              <Pressable
                key={operation}
                accessibilityRole="menuitem"
                accessibilityState={{ disabled: held === true }}
                disabled={held}
                onPress={() => {
                  setMore(false);
                  openWrite(router, operation, id);
                }}
                style={{
                  minHeight: 56,
                  justifyContent: "center",
                  borderTopWidth: operation === "close" ? 8 : 0,
                  borderTopColor: c.mute,
                }}
              >
                <T color={held ? c.text3 : c.text}>
                  {label}
                  {operation === "callback" && callback && zone
                    ? ` · ${contextualDate(callback, now, zone, "callback")}`
                    : ""}
                </T>
              </Pressable>
            ))}
          </View>
        </View>
      </Modal>
    </Screen>
  );
}
