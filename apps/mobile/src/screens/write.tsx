import { useCallback, useEffect, useRef, useState } from "react";
import type { ComponentRef } from "react";
import {
  AccessibilityInfo,
  ActivityIndicator,
  Alert,
  AppState,
  BackHandler,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  Switch,
  TextInput,
  View,
  useWindowDimensions,
} from "react-native";
import { Stack, useFocusEffect, usePreventRemove, useRouter } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as Clipboard from "expo-clipboard";
import * as Crypto from "expo-crypto";
import * as Haptics from "expo-haptics";
import { useNetworkState } from "expo-network";
import { useSession } from "../api/session-provider.tsx";
import { useReadOptions } from "../api/use-read-options.ts";
import { clock, contextualDate } from "../core/dates.ts";
import { leadContact } from "../core/lead.ts";
import { sessionPerson } from "../core/session.ts";
import {
  appendQuickNote,
  closingAvailability,
  draftHasContent,
  formCommand,
  initialDraft,
  inOneHour,
} from "../core/write-form.ts";
import type { FormError } from "../core/write-form.ts";
import type { Operation, WriteView } from "../core/write-machine.ts";
import type { Command, Draft, WriteSnapshot } from "../core/write-model.ts";
import { entryNote } from "../core/write-model.ts";
import {
  entryCaption,
  operationName,
  removalWords,
  writeBand,
} from "../core/write-presentation.ts";
import { timelinePresentation } from "../core/timeline.ts";
import { type } from "../core/theme.ts";
import { backgroundWrite, dismissWrite } from "../core/write-dismissal.ts";
import { useHandoff } from "../ui/handoff.tsx";
import { Band, Button, Heading, IconButton, Screen, Slip, T } from "../ui/pieces.tsx";
import { CallbackFields } from "../ui/callback-fields.tsx";
import { Chip, Choice, Fade, KeptNote, ReasonChoice } from "../ui/write-controls.tsx";
import { useTheme } from "../ui/theme.ts";

const idle: WriteSnapshot = {
  state: "editing",
  view: "unchanged",
  entry: null,
  storageError: null,
  receipt: null,
};
export function WriteScreen({
  id,
  operation,
  channel,
  phone,
}: {
  id: string;
  operation: Operation;
  channel: "call" | "whatsApp";
  phone: string | undefined;
}) {
  const c = useTheme();
  const session = useSession();
  const reachability = useNetworkState();
  const owner = session.phone;
  const router = useRouter();
  const options = useReadOptions();
  const lead = useQuery(options.lead(id));
  const queue = useQuery(options.queue);
  const zone = queue.data?.timeZone;
  const insets = useSafeAreaInsets();
  const { fontScale, height } = useWindowDimensions();
  const contact = leadContact(id, lead.data, queue.data, lead.isError);
  const callback =
    lead.data?.lifecycle.state.status === "working" &&
    lead.data.lifecycle.state.stage.kind === "callBack"
      ? lead.data.lifecycle.state.stage.at
      : null;
  const snapshot = owner?.snapshot(id) ?? idle;
  const [shown, setShown] = useState(snapshot);
  const [draft, setDraft] = useState(() =>
    initialDraft({ id, name: contact.name, operation, callback, channel, now: new Date() }),
  );
  const initial = useRef(draft);
  const currentDraft = useRef(draft);
  currentDraft.current = draft;
  const initialized = useRef(false);
  const dirty = useRef(false);
  const draftTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const busyUntil = useRef(0);
  const retryBand = useRef<WriteSnapshot | null>(null);
  const [offlineBusy, setOfflineBusy] = useState(false);
  const [confirmation, setConfirmation] = useState<{ command: Command; readyAt: number } | null>(
    null,
  );
  const [confirmReady, setConfirmReady] = useState(false);
  const frozenClosing = useRef<Command | null>(null);
  const [error, setError] = useState<FormError | null>(null);
  const [draftFailed, setDraftFailed] = useState(false);
  const [restored, setRestored] = useState<string | null>(null);
  const [keyboard, setKeyboard] = useState(false);
  const [copy, setCopy] = useState(false);
  const [closeVersion, setCloseVersion] = useState(0);
  const [leaving, setLeaving] = useState(false);
  const [signedAgain, setSignedAgain] = useState(false);
  const [presented, setPresented] = useState(false);
  const noteInput = useRef<ComponentRef<typeof TextInput>>(null);
  const scroll = useRef<ComponentRef<typeof ScrollView>>(null);
  const scrollOffset = useRef(0);
  const band = useRef<ComponentRef<typeof View>>(null);
  const handoff = useHandoff(
    (openedChannel, at) => {
      change({
        channel: openedChannel === "call" ? "call" : "whatsApp",
        handoff: { channel: openedChannel === "call" ? "call" : "whatsApp", at: at.toISOString() },
      });
    },
    undefined,
    (openedChannel) => {
      change({ channel: openedChannel === "call" ? "call" : "whatsApp" });
    },
  );
  const handoffStarted = useRef(false);
  const signedIn = session.state.kind === "signedIn";
  const wasSignedIn = useRef(signedIn);
  const correctionRead = useRef<{ view: WriteView; updatedAt: number } | null>(null);
  useEffect(() => {
    const correction =
      snapshot.state === "editing" &&
      ["closingUnavailable", "wrongNumberUnavailable", "past"].includes(snapshot.view);
    if (!correction && snapshot.state !== "refused" && snapshot.state !== "refusedAfterUnknown")
      return;
    if (correction) correctionRead.current = { view: snapshot.view, updatedAt: lead.dataUpdatedAt };
    void lead.refetch({ cancelRefetch: false });
  }, [snapshot.state, snapshot.view, snapshot.entry?.refusal]);
  const busy =
    offlineBusy ||
    [snapshot.state, shown.state].some(
      (state) => state === "storing" || state === "sendingFirst" || state === "sendingRetry",
    );
  const editing =
    shown.state === "editing" ||
    shown.state === "storageFailed" ||
    (busy && retryBand.current === null);
  const busyLabel = offlineBusy
    ? "Try again"
    : snapshot.state === "storing" || shown.state === "storing"
      ? "Storing…"
      : "Sending…";
  const hasContent = draftHasContent(draft, initial.current);
  const openingOwner = useRef(owner);
  const protectedForm =
    !leaving &&
    owner === openingOwner.current &&
    (busy || confirmation !== null || (editing && hasContent));
  const disablePrevention = usePreventRemove(protectedForm, () => {
    dismiss();
  });
  function leave(toQueue = false) {
    setLeaving(true);
    disablePrevention();
    if (toQueue) router.dismissTo("/");
    else router.back();
  }
  async function keepDraft() {
    if (!owner || !initialized.current || !dirty.current) return;
    try {
      const current = currentDraft.current;
      await owner.keepDraft(
        draftHasContent(current, initial.current) ? current : null,
        id,
        operation,
      );
      setDraftFailed(false);
    } catch {
      setDraftFailed(true);
    }
  }
  function change(next: Partial<Draft>) {
    if (frozenClosing.current) return;
    dirty.current = true;
    setDraft((prior) => ({ ...prior, ...next, changedAt: new Date().toISOString() }));
    setError(null);
  }
  function revealNote() {
    scroll.current?.measureInWindow((_x, top) => {
      noteInput.current?.measureInWindow((_inputX, inputTop) => {
        scroll.current?.scrollTo({
          y: Math.max(0, scrollOffset.current + inputTop - top - 8),
          animated: false,
        });
      });
    });
  }
  function withdrawConfirmation() {
    frozenClosing.current = null;
    setConfirmation(null);
  }
  useEffect(() => {
    if (!session.phoneReady || initialized.current || (!lead.data && !snapshot.entry)) return;
    const baseline = initialDraft({
      id,
      name: contact.name,
      operation,
      callback: zone ? callback : null,
      channel,
      now: new Date(),
    });
    initial.current = baseline;
    owner?.begin(id);
    const stored = owner?.draft(id, operation);
    setDraft(snapshot.entry?.draft ?? stored ?? baseline);
    dirty.current = stored !== null && stored !== undefined;
    initialized.current = true;
    openingOwner.current = owner;
    if (stored) setRestored(stored.changedAt);
  }, [session.phoneReady, lead.data, owner, snapshot.entry]);
  useEffect(() => {
    if (!restored) return;
    const timer = setTimeout(() => {
      setRestored(null);
    }, 4000);
    return () => {
      clearTimeout(timer);
    };
  }, [restored]);
  useEffect(() => {
    if (!initialized.current || !editing || confirmation) return;
    clearTimeout(draftTimer.current);
    if (AppState.currentState !== "active") {
      void keepDraft();
      return;
    }
    draftTimer.current = setTimeout(() => {
      void keepDraft();
    }, 500);
    return () => {
      clearTimeout(draftTimer.current);
    };
  }, [draft, editing, confirmation]);
  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => {
      if (state !== "active") {
        withdrawConfirmation();
        if (backgroundWrite(snapshot.state) === "keepDraft") {
          clearTimeout(draftTimer.current);
          void keepDraft();
        }
      }
    });
    return () => {
      sub.remove();
    };
  }, [editing, owner]);
  useEffect(() => {
    const show = Keyboard.addListener("keyboardDidShow", () => {
      setKeyboard(true);
      if (noteInput.current?.isFocused()) revealNote();
    });
    const hide = Keyboard.addListener("keyboardDidHide", () => {
      setKeyboard(false);
    });
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);
  useEffect(() => {
    if (!signedIn) {
      withdrawConfirmation();
      setSignedAgain(false);
    } else if (!wasSignedIn.current) setSignedAgain(true);
    wasSignedIn.current = signedIn;
  }, [signedIn]);
  useEffect(() => {
    const currentBusy =
      snapshot.state === "storing" ||
      snapshot.state === "sendingFirst" ||
      snapshot.state === "sendingRetry";
    const delay = currentBusy ? 0 : Math.max(0, busyUntil.current - Date.now());
    const timer = setTimeout(() => {
      setShown(snapshot);
    }, delay);
    return () => {
      clearTimeout(timer);
    };
  }, [snapshot.state, snapshot.view, snapshot.entry, snapshot.storageError, snapshot.receipt]);
  useEffect(() => {
    if (!confirmation) {
      setConfirmReady(false);
      return;
    }
    const timer = setTimeout(
      () => {
        setConfirmReady(true);
      },
      Math.max(0, confirmation.readyAt - Date.now()),
    );
    return () => {
      clearTimeout(timer);
    };
  }, [confirmation]);
  useEffect(() => {
    if (shown.state === "saved" && shown.receipt) {
      if (
        shown.entry?.command.operation === "close" &&
        shown.entry.command.payload.closing.kind === "won" &&
        shown.receipt.accountId
      ) {
        setLeaving(true);
        disablePrevention();
        router.replace({
          pathname: "/won/[id]",
          params: { id },
        });
      } else leave(shown.entry?.command.operation === "close");
    } else if (
      [
        "storageFailed",
        "neverSubmitted",
        "unknown",
        "notSaved",
        "refused",
        "refusedAfterUnknown",
      ].includes(shown.state)
    ) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(
        () => undefined,
      );
      const timer = setTimeout(() => {
        if (band.current) AccessibilityInfo.sendAccessibilityEvent(band.current, "focus");
      }, 150);
      return () => {
        clearTimeout(timer);
      };
    }
    if (shown.state === "editing" && shown.view === "past")
      setError({ field: "time", text: "That is in the past. Choose a later one." });
    return undefined;
  }, [shown.state, shown.view]);
  useEffect(() => {
    if (snapshot.state !== "editing") return;
    const kept = owner?.draft(id, operation);
    if (kept && initialized.current) {
      setDraft(kept);
      dirty.current = true;
    }
  }, [snapshot.state]);
  const dismissCurrent = useRef(dismiss);
  dismissCurrent.current = dismiss;
  useFocusEffect(
    useCallback(() => {
      void owner?.repair(id);
      const sub = BackHandler.addEventListener("hardwareBackPress", () => {
        dismissCurrent.current();
        return true;
      });
      return () => {
        sub.remove();
      };
    }, [owner, id]),
  );
  useEffect(() => {
    if (!presented || !phone || !initialized.current || handoffStarted.current || snapshot.entry)
      return;
    handoffStarted.current = true;
    void handoff.open(channel === "whatsApp" ? "whatsapp" : "call", phone);
  }, [presented, phone, session.phoneReady, lead.data]);
  function signIn() {
    router.push({ pathname: "/sign-in", params: { surface: editing ? "form" : "review" } });
  }
  function dismiss() {
    if (leaving) return;
    if (busy) return;
    const action = dismissWrite(shown.state, hasContent, confirmation !== null);
    if (action === "blocked") return;
    if (action === "withdrawConfirmation") {
      withdrawConfirmation();
      return;
    }
    if (action === "discardDraft") {
      Alert.alert(
        `Discard this ${operation === "close" ? "closing" : operation}?`,
        "What you typed will be lost.",
        [
          { text: "Keep editing", style: "cancel" },
          {
            text: "Discard",
            style: "destructive",
            onPress: () => {
              clearTimeout(draftTimer.current);
              void owner
                ?.keepDraft(null, id, operation)
                .then(() => {
                  dirty.current = false;
                  leave();
                })
                .catch(() => {
                  setDraftFailed(true);
                });
            },
          },
        ],
      );
    } else leave();
  }
  async function submit(clear = false) {
    if (!owner || busy || frozenClosing.current || !session.phoneReady) return;
    if (!signedIn) {
      signIn();
      return;
    }
    if (!zone && (operation === "callback" || draft.callbackAt !== null)) return;
    setCloseVersion((version) => version + 1);
    if (error?.field === "time" && !clear) return;
    const command = formCommand(draft, Crypto.randomUUID(), new Date(), clear);
    if ("field" in command) {
      setError(command);
      if (command.field === "note") {
        revealNote();
        noteInput.current?.focus();
      }
      return;
    }
    if (operation === "close") {
      Keyboard.dismiss();
      frozenClosing.current = command;
      setConfirmation({ command, readyAt: Date.now() + 400 });
      await keepDraft();
      return;
    }
    busyUntil.current = Date.now() + 400;
    retryBand.current = null;
    clearTimeout(draftTimer.current);
    Keyboard.dismiss();
    await owner.save(command, draft, networkOffline());
  }
  function networkOffline() {
    return reachability.isConnected === false || reachability.isInternetReachable === false;
  }
  const correctionLoaded =
    correctionRead.current?.view === snapshot.view &&
    lead.dataUpdatedAt > correctionRead.current.updatedAt;
  const latestRefusal = correctionLoaded
    ? null
    : snapshot.view === "closingUnavailable"
      ? "invalidTransition"
      : snapshot.view === "wrongNumberUnavailable"
        ? "wrongNumberNeedsAnAttempt"
        : null;
  const availability = lead.data
    ? closingAvailability(lead.data, new Date(), latestRefusal)
    : { won: false, lost: false, duplicate: false, wrongNumber: false, doNotContact: false };
  const locked = !editing || busy || confirmation !== null || !initialized.current;
  const title =
    operation === "attempt"
      ? "Log an attempt"
      : operation === "note"
        ? "Add a note"
        : operation === "callback"
          ? callback
            ? "Move callback"
            : "Set a callback"
          : "Close this lead";
  const words = writeBand(
    busy && retryBand.current ? retryBand.current : shown,
    signedIn,
    lead.data,
    zone,
  );
  const currentNote = shown.entry ? entryNote(shown.entry) : draft.note;
  const refusal = shown.entry?.refusal;
  const frozenRefused = shown.state === "refused" || shown.state === "refusedAfterUnknown";
  const signInBand = editing && !signedIn;
  const caption = entryCaption(shown);
  const shortcutPhrases =
    draft.channel === "call"
      ? ["Rang out", "Left a voicemail", "Line busy"]
      : ["Message sent, no reply", "One tick only"];
  const noteField = (reason = false) => (
    <View style={{ gap: 8 }}>
      {(operation !== "note" || draft.note.trim().length >= 3500) && (
        <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 8 }}>
          {operation !== "note" && <T variant="small">{reason ? "Reason" : "Note"}</T>}
          {draft.note.trim().length >= 3500 && (
            <T variant="caption" color={draft.note.trim().length >= 4000 ? c.refusedFg : c.text3}>
              {draft.note.trim().length} / 4,000
            </T>
          )}
        </View>
      )}
      <TextInput
        ref={noteInput}
        onFocus={revealNote}
        accessibilityLabel={reason ? "Reason" : "Note"}
        accessibilityHint={error?.field === "note" ? error.text : undefined}
        autoFocus={operation === "note"}
        multiline
        editable={!locked}
        maxLength={4000}
        value={draft.note}
        onChangeText={(note) => {
          change({ note });
        }}
        placeholder={operation === "attempt" ? "What was said, or what you tried" : undefined}
        placeholderTextColor={c.text3}
        selectionColor={c.ink}
        maxFontSizeMultiplier={2}
        textAlignVertical="top"
        style={{
          ...type.body,
          color: c.text,
          borderWidth: error?.field === "note" ? 2 : 1,
          borderColor: error?.field === "note" ? c.refusedFg : c.control,
          borderRadius: 10,
          padding: 14,
          minHeight: reason ? 70 : operation === "note" ? 114 : 92,
          maxHeight: Math.max(92, Math.min(reason ? 158 : 202, height * 0.35)),
        }}
      />
      {error?.field === "note" && (
        <T role="alert" variant="caption" color={c.refusedFg}>
          {error.text}
        </T>
      )}
    </View>
  );
  if (initialized.current && owner !== openingOwner.current)
    return (
      <Screen>
        <View />
      </Screen>
    );
  return (
    <Screen>
      <Stack.Screen
        options={{ gestureEnabled: !busy && !confirmation }}
        listeners={{
          transitionEnd: (event) => {
            if (!event.data.closing) setPresented(true);
          },
        }}
      />
      <KeyboardAvoidingView
        style={{ flex: 1, backgroundColor: c.sheet }}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
      >
        <View
          style={{
            paddingTop: Platform.OS === "android" ? insets.top : 12,
            borderBottomWidth: 1,
            borderBottomColor: c.rule,
            paddingBottom: 12,
          }}
        >
          {Platform.OS === "ios" && (
            <View
              style={{
                width: 36,
                height: 5,
                borderRadius: 3,
                backgroundColor: c.rule2,
                alignSelf: "center",
                marginBottom: 8,
              }}
            />
          )}
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingEnd: 16 }}>
            <IconButton icon="close" label="Cancel" disabled={busy} onPress={dismiss} />
            <View style={{ flex: 1, gap: 4 }}>
              <Heading>{title}</Heading>
              <T variant="small" color={c.text2} numberOfLines={1}>
                {draft.leadName}
                {draft.handoff && zone
                  ? ` · ${draft.handoff.channel === "call" ? "dialler opened" : "WhatsApp link opened"} ${clock(new Date(draft.handoff.at), zone)}`
                  : ""}
              </T>
              {draftFailed ? (
                <T variant="caption" color={c.waitFg}>
                  Not kept on this phone yet
                </T>
              ) : restored && zone ? (
                <T variant="caption" color={c.text3}>
                  Restored from {clock(new Date(restored), zone)}
                </T>
              ) : null}
            </View>
          </View>
        </View>
        <ScrollView
          ref={scroll}
          onScroll={(event) => {
            scrollOffset.current = event.nativeEvent.contentOffset.y;
          }}
          scrollEventThrottle={16}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ padding: 16, gap: 22, paddingBottom: 24 }}
        >
          {session.phoneError ? (
            <Band
              kind="wait"
              title="This phone could not load its entries"
              text="Try loading them before saving anything here."
            >
              <Button
                small
                outline
                label="Try again"
                onPress={() => {
                  void session.reloadPhone();
                }}
              />
            </Band>
          ) : !initialized.current ? (
            lead.isError ? (
              <Band title="The lead could not be loaded" text="Try loading it again before saving.">
                <Button
                  small
                  outline
                  label="Try again"
                  onPress={() => {
                    void lead.refetch();
                  }}
                />
              </Band>
            ) : (
              <ActivityIndicator accessibilityLabel="Loading form" color={c.ink} />
            )
          ) : null}
          {!editing && shown.entry ? (
            <Fade identity={shown.state}>
              <View style={{ gap: 12 }}>
                <T variant="caption" color={c.text3}>
                  {caption}
                </T>
                <View
                  style={{
                    borderWidth: 1,
                    borderStyle: "dashed",
                    borderColor: frozenRefused ? c.refusedFg : c.waitFg,
                    borderRadius: 12,
                    padding: 14,
                    gap: 8,
                  }}
                >
                  <T variant="bodyStrong">
                    {shown.entry.command.operation === "attempt"
                      ? `${shown.entry.command.payload.channel === "call" ? "Call" : "WhatsApp"} attempt`
                      : operationName(shown.entry)}
                  </T>
                  {shown.entry.command.operation === "attempt" && (
                    <T variant="small">
                      {shown.entry.command.payload.outcome === "spokeToThem"
                        ? "Spoke to them"
                        : "No answer"}
                      {shown.entry.command.payload.callback?.kind === "set" && zone
                        ? ` · Callback ${contextualDate(new Date(shown.entry.command.payload.callback.at), new Date(), zone, "callback")}`
                        : ""}
                    </T>
                  )}
                  {currentNote ? <KeptNote text={currentNote} /> : null}
                </View>
                {(shown.state === "neverSubmitted" || shown.state === "notSaved") &&
                  !shown.storageError && (
                    <Button
                      small
                      outline
                      icon="edit"
                      label="Edit this entry"
                      onPress={() => {
                        void owner?.edit(id);
                      }}
                    />
                  )}
                {frozenRefused && (
                  <Button
                    small
                    outline
                    label="Delete this copy"
                    onPress={() => {
                      remove();
                    }}
                  />
                )}
                {refusal === "idempotencyConflict" && (
                  <View style={{ gap: 12 }}>
                    <T variant="subheading">Current lead history</T>
                    {lead.isError ? (
                      <>
                        <T>The history could not be loaded.</T>
                        <Button
                          small
                          outline
                          label="Load history"
                          onPress={() => {
                            void lead.refetch();
                          }}
                        />
                      </>
                    ) : (
                      lead.data?.timeline.slice(0, 3).map((entry) => {
                        const p = timelinePresentation(
                          entry,
                          lead.data,
                          sessionPerson(session.state) ?? "",
                          new Date(),
                          zone,
                        );
                        return (
                          <View key={entry.id} style={{ gap: 4 }}>
                            <T variant="bodyStrong">{p.title}</T>
                            <T variant="caption" color={c.text3}>
                              {p.time}
                            </T>
                            <T variant="secondary">{p.body}</T>
                          </View>
                        );
                      })
                    )}
                  </View>
                )}
              </View>
            </Fade>
          ) : (
            <View pointerEvents={locked ? "none" : "auto"} style={{ gap: 22 }}>
              {handoff.band}
              {operation === "attempt" && (
                <>
                  <View
                    accessibilityRole="radiogroup"
                    accessibilityLabel="Channel"
                    style={{
                      flexDirection: fontScale >= 1.6 ? "column" : "row",
                      gap: 8,
                      backgroundColor: c.mute,
                      padding: 4,
                      borderRadius: 10,
                    }}
                  >
                    <Chip
                      segment
                      label="Call"
                      selected={draft.channel === "call"}
                      readOnly={locked}
                      onPress={() => {
                        change({ channel: "call" });
                      }}
                    />
                    <Chip
                      segment
                      label="WhatsApp"
                      selected={draft.channel === "whatsApp"}
                      readOnly={locked}
                      onPress={() => {
                        change({ channel: "whatsApp" });
                      }}
                    />
                  </View>
                  <View style={{ gap: 8 }}>
                    <T variant="small">What happened?</T>
                    <Choice
                      title="No answer"
                      description={`Makes the unanswered count ${String((lead.data?.noAnswerCount ?? 0) + 1)}`}
                      selected={draft.outcome === "noAnswer"}
                      readOnly={locked}
                      onPress={() => {
                        change({ outcome: "noAnswer" });
                      }}
                    />
                    <Choice
                      title="Spoke to them"
                      description="Records a conversation"
                      selected={draft.outcome === "spokeToThem"}
                      readOnly={locked}
                      onPress={() => {
                        change({ outcome: "spokeToThem" });
                      }}
                    />
                  </View>
                </>
              )}
              {(operation === "attempt" || operation === "note") && (
                <View style={{ gap: 8 }}>
                  {noteField()}
                  {operation === "note" && (
                    <T variant="caption" color={c.text3}>
                      Saved entries cannot be edited or deleted.
                    </T>
                  )}
                  {operation === "attempt" && draft.outcome === "noAnswer" && (
                    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                      {shortcutPhrases.map((phrase) => (
                        <Chip
                          key={phrase}
                          label={phrase}
                          accessibilityLabel={`Add ${phrase} to the note`}
                          disabled={appendQuickNote(draft.note, phrase) === null}
                          readOnly={locked}
                          onPress={() => {
                            const note = appendQuickNote(draft.note, phrase);
                            if (note !== null) change({ note });
                          }}
                        />
                      ))}
                    </View>
                  )}
                </View>
              )}
              {(operation === "attempt" || operation === "callback") && (
                <View style={{ gap: 12 }}>
                  {operation === "attempt" && (
                    <Pressable
                      accessibilityRole="switch"
                      accessibilityLabel="Call back"
                      accessibilityState={{
                        checked: draft.callbackAt !== null,
                        disabled: locked || !zone,
                      }}
                      disabled={locked || !zone}
                      onPress={() => {
                        change({
                          callbackAt: draft.callbackAt
                            ? null
                            : (callback && callback > new Date()
                                ? callback
                                : inOneHour(new Date())
                              ).toISOString(),
                        });
                      }}
                      style={{ minHeight: 52, flexDirection: "row", gap: 8, alignItems: "center" }}
                    >
                      <T variant="bodyStrong" style={{ flex: 1 }}>
                        Call back
                      </T>
                      {zone ? (
                        <Switch
                          accessible={false}
                          pointerEvents="none"
                          disabled={locked}
                          value={draft.callbackAt !== null}
                          trackColor={{ false: c.control, true: c.ink }}
                          onValueChange={(on) => {
                            change({
                              callbackAt: on
                                ? (callback && callback > new Date()
                                    ? callback
                                    : inOneHour(new Date())
                                  ).toISOString()
                                : null,
                            });
                          }}
                        />
                      ) : (
                        <>
                          <ActivityIndicator size="small" color={c.text3} />
                          <T variant="caption" color={c.text3}>
                            Loading times
                          </T>
                        </>
                      )}
                    </Pressable>
                  )}
                  {(draft.callbackAt !== null || operation === "callback") && (
                    <>
                      {operation === "callback" && callback && (
                        <Slip
                          kind={callback < new Date() ? "refused" : "wait"}
                          icon="calendar"
                          text={
                            zone
                              ? `${callback < new Date() ? "Overdue since" : "Callback"} ${contextualDate(callback, new Date(), zone, "callback")}`
                              : "Callback set"
                          }
                        />
                      )}
                      <CallbackFields
                        error={error?.field === "time" ? error.text : null}
                        value={draft.callbackAt ?? inOneHour(new Date()).toISOString()}
                        zone={zone}
                        disabled={locked}
                        closeVersion={closeVersion}
                        onChange={(at) => {
                          change({ callbackAt: at });
                        }}
                        onError={(text) => {
                          setError(text ? { field: "time", text } : null);
                        }}
                      />
                    </>
                  )}
                  {error?.field === "time" && (
                    <T role="alert" variant="caption" color={c.refusedFg}>
                      {error.text}
                    </T>
                  )}
                  {callback && operation === "attempt" && (
                    <T variant="small" color={c.text2}>
                      {!zone
                        ? "Saving removes the callback this lead has."
                        : draft.callbackAt
                          ? callback < new Date()
                            ? `It replaces the one overdue since ${contextualDate(callback, new Date(), zone, "callback")}.`
                            : ""
                          : `Leaving this off removes the one ${callback < new Date() ? "overdue since" : "set for"} ${contextualDate(callback, new Date(), zone, "callback")}.`}
                    </T>
                  )}
                  {zone && !error && (
                    <T variant="small" color={c.text2}>
                      After saving, this lead moves to{" "}
                      {draft.callbackAt
                        ? new Intl.DateTimeFormat("en-GB", {
                            timeZone: zone,
                            dateStyle: "short",
                          }).format(new Date(draft.callbackAt)) ===
                          new Intl.DateTimeFormat("en-GB", {
                            timeZone: zone,
                            dateStyle: "short",
                          }).format(new Date())
                          ? "Due today"
                          : "Later"
                        : "No callback set"}{" "}
                      in your queue.
                    </T>
                  )}
                  {operation === "callback" && callback && (
                    <>
                      <Button
                        outline
                        label="Clear callback"
                        disabled={locked}
                        onPress={() => {
                          void submit(true);
                        }}
                      />
                      <T variant="caption" color={c.text3}>
                        The lead stays in your queue with no time set.
                      </T>
                    </>
                  )}
                </View>
              )}
              {operation === "close" && (
                <View style={{ gap: 8 }}>
                  {!availability.won && (
                    <Band
                      kind="info"
                      title="Won and lost are not open yet"
                      text="They need an attempt or a callback on this lead first."
                    />
                  )}
                  <Choice
                    title="Won"
                    description={
                      availability.won
                        ? "Opens an account and keeps this history. Final."
                        : "Needs an attempt or a callback first"
                    }
                    selected={draft.closing === "won"}
                    disabled={!availability.won}
                    readOnly={locked}
                    onPress={() => {
                      change({ closing: "won" });
                    }}
                  />
                  <Choice
                    title="Lost"
                    description={
                      availability.lost
                        ? "Reopens only if they enquire again."
                        : "Needs an attempt or a callback first"
                    }
                    selected={draft.closing === "lost"}
                    disabled={!availability.lost}
                    readOnly={locked}
                    onPress={() => {
                      change({ closing: "lost" });
                    }}
                  >
                    {noteField(true)}
                    <T variant="caption" color={c.text3}>
                      Required. It is saved on the timeline with your name.
                    </T>
                  </Choice>
                  <Choice
                    title="Dead"
                    description="For a lead that should never be called again. Final."
                    selected={draft.closing === "dead"}
                    disabled={!availability.duplicate}
                    readOnly={locked}
                    onPress={() => {
                      change({ closing: "dead" });
                    }}
                  >
                    {(
                      [
                        ["duplicate", "Duplicate"],
                        ["wrongNumber", "Wrong number"],
                        ["doNotContact", "Do not contact"],
                      ] as const
                    ).map(([reason, label]) => (
                      <ReasonChoice
                        key={reason}
                        title={label}
                        selected={draft.reason === reason}
                        disabled={!availability[reason]}
                        readOnly={locked}
                        onPress={() => {
                          change({ reason });
                        }}
                      />
                    ))}
                  </Choice>
                  <T variant="caption" color={c.text3}>
                    Closing is saved to the timeline and cannot be undone here.
                  </T>
                </View>
              )}
            </View>
          )}
        </ScrollView>
        <View
          style={{
            borderTopWidth: 1,
            borderTopColor: c.rule,
            paddingHorizontal: 16,
            paddingTop: 12,
            paddingBottom: (keyboard ? 0 : insets.bottom) + 12,
            gap: 12,
          }}
        >
          {words && (
            <View ref={band} accessible accessibilityLabel={`${words.title}. ${words.text}`}>
              <Fade identity={`${shown.state}-${shown.view}`}>
                <Band {...words} />
              </Fade>
            </View>
          )}
          {signInBand ? (
            <Band
              kind="wait"
              icon="lock"
              title="Your session ended"
              text="What you typed stays on this phone. It can be saved once you are back in."
            />
          ) : signedAgain && editing ? (
            <Band
              kind="done"
              icon="check"
              title="You are signed in again"
              text="Nothing was sent while you were away."
            />
          ) : null}
          {copy && (
            <T role="status" accessibilityLiveRegion="polite" variant="small">
              Note copied
            </T>
          )}
          {confirmation ? (
            <Fade identity="confirm">
              <View style={{ gap: 12 }}>
                <T variant="heading">
                  Close {draft.leadName} as{" "}
                  {confirmation.command.operation === "close"
                    ? confirmation.command.payload.closing.kind
                    : ""}
                  ?
                </T>
                {confirmation.command.operation === "close" &&
                  confirmation.command.payload.closing.kind === "won" && (
                    <T variant="small">The lead becomes an account.</T>
                  )}
                <T variant="small">It leaves your queue.</T>
                <T variant="small">
                  {confirmation.command.operation === "close" &&
                  confirmation.command.payload.closing.kind === "lost"
                    ? "It reopens only if they enquire again."
                    : "There is no undo."}
                </T>
                <View
                  style={{ flexDirection: fontScale >= 1.6 ? "column-reverse" : "row", gap: 10 }}
                >
                  <Button
                    outline
                    style={{ flex: fontScale < 1.6 ? 1 : undefined }}
                    label="Go back"
                    onPress={() => {
                      withdrawConfirmation();
                    }}
                  />
                  <Button
                    style={{ flex: fontScale < 1.6 ? 1 : undefined }}
                    label="Yes, close it"
                    disabled={!confirmReady}
                    onPress={() => {
                      if (Date.now() < confirmation.readyAt || !signedIn) return;
                      const frozen = confirmation.command;
                      withdrawConfirmation();
                      busyUntil.current = Date.now() + 400;
                      void owner?.save(frozen, draft, networkOffline());
                    }}
                  />
                </View>
              </View>
            </Fade>
          ) : editing ? (
            <View style={{ flexDirection: fontScale >= 1.6 ? "column-reverse" : "row", gap: 10 }}>
              {shown.state === "storageFailed" && draft.note && (
                <Button
                  outline
                  style={{ flex: 1 }}
                  icon="copy"
                  label="Copy my note"
                  onPress={() => {
                    void copyNote();
                  }}
                />
              )}
              <Button
                style={{ flex: 1 }}
                label={
                  busy
                    ? busyLabel
                    : !signedIn
                      ? "Sign in again"
                      : shown.state === "storageFailed"
                        ? "Try again"
                        : operation === "close"
                          ? draft.closing
                            ? `Close as ${draft.closing}`
                            : "Choose an outcome"
                          : "Save"
                }
                busy={busy}
                disabled={
                  !session.phoneReady ||
                  !initialized.current ||
                  ((operation === "callback" || draft.callbackAt !== null) && !zone) ||
                  (operation === "close" &&
                    (!draft.closing ||
                      (draft.closing === "won" && !availability.won) ||
                      (draft.closing === "lost" && (!availability.lost || !draft.note.trim())) ||
                      (draft.closing === "dead" && (!draft.reason || !availability[draft.reason]))))
                }
                onPress={() => {
                  void submit();
                }}
              />
            </View>
          ) : (
            <View style={{ flexDirection: fontScale >= 1.6 ? "column-reverse" : "row", gap: 10 }}>
              {frozenRefused ? (
                <>
                  {currentNote ? (
                    <Button
                      outline
                      style={{ flex: 1 }}
                      icon="copy"
                      label="Copy my note"
                      onPress={() => {
                        void copyNote();
                      }}
                    />
                  ) : null}
                  <Button
                    style={{ flex: 1 }}
                    label={
                      refusal === "accessDenied"
                        ? "Back to queue"
                        : refusal === "leadClosed"
                          ? "See its history"
                          : "See the lead"
                    }
                    onPress={() => {
                      if (refusal === "accessDenied") leave(true);
                      else {
                        setLeaving(true);
                        disablePrevention();
                        router.dismissTo({ pathname: "/lead/[id]", params: { id } });
                      }
                    }}
                  />
                </>
              ) : (
                <>
                  <Button
                    outline
                    style={{ flex: 1 }}
                    label="Discard"
                    disabled={busy}
                    onPress={remove}
                  />
                  <Button
                    style={{ flex: 1 }}
                    label={busy ? busyLabel : signedIn ? "Try again" : "Sign in again"}
                    busy={busy}
                    onPress={() => {
                      if (!signedIn) signIn();
                      else {
                        busyUntil.current = Date.now() + 400;
                        retryBand.current = shown;
                        if (networkOffline()) {
                          setOfflineBusy(true);
                          setTimeout(() => {
                            setOfflineBusy(false);
                          }, 400);
                        }
                        void owner?.retry(id, networkOffline());
                      }
                    }}
                  />
                </>
              )}
            </View>
          )}
        </View>
      </KeyboardAvoidingView>
    </Screen>
  );
  async function copyNote() {
    await Clipboard.setStringAsync(currentNote);
    setCopy(true);
    setTimeout(() => {
      setCopy(false);
    }, 4000);
  }
  function remove() {
    const words = removalWords(shown, currentNote.length > 0);
    Alert.alert(words.title, words.text, [
      { text: "Keep it", style: "cancel" },
      {
        text: words.action,
        style: "destructive",
        onPress: () => {
          void owner?.discard(id).then(() => {
            if (!owner.entries().some((entry) => entry.command.payload.id === id)) leave();
          });
        },
      },
    ]);
  }
}
