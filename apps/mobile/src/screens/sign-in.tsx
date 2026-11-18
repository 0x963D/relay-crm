import { useEffect, useRef, useState } from "react";
import type { ComponentRef } from "react";
import {
  AccessibilityInfo,
  AppState,
  BackHandler,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  TextInput,
  View,
} from "react-native";
import { useQuery } from "@tanstack/react-query";
import { parseEmail } from "@relay/domain";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Svg, { Path } from "react-native-svg";
import { auth } from "../api/client.ts";
import { server } from "../api/server.ts";
import { useSession } from "../api/session-provider.tsx";
import type { Credential } from "../core/session.ts";
import { useReadOptions } from "../api/use-read-options.ts";
import { failureWording, remainingSeconds, RequestFailure } from "../core/failure.ts";
import { families, type } from "../core/theme.ts";
import { Band, Button, Icon, IconButton, Screen, Sheet, T } from "../ui/pieces.tsx";
import { useTheme } from "../ui/theme.ts";
import { RemoveSignIn } from "../ui/remove-sign-in.tsx";
import { signInOptions } from "../core/session-display.ts";

interface Message {
  title: string;
  text: string;
  kind: "neutral" | "refused" | "wait";
}
export function SignIn({
  modal,
  onBusyChange,
  onAuthenticated,
}: {
  modal?: "form" | "kept";
  onBusyChange?: (busy: boolean) => void;
  onAuthenticated?: () => void;
} = {}) {
  const c = useTheme();
  const inset = useSafeAreaInsets();
  const session = useSession();
  const router = useRouter();
  const signIn = signInOptions(session.state, modal !== undefined);
  const [email, setEmail] = useState(signIn.email);
  const [step, setStep] = useState<"email" | "code">("email");
  const [digits, setDigits] = useState("");
  const [emailFocused, setEmailFocused] = useState(false);
  const [busy, setBusy] = useState(false);
  const [keyboard, setKeyboard] = useState(false);
  const [fieldError, setFieldError] = useState(false);
  const [codeState, setCodeState] = useState<"ready" | "expired" | "used">("ready");
  const [message, setMessage] = useState<Message | null>(null);
  const [pause, setPause] = useState<{ until: number } | null>(null);
  const [now, setNow] = useState(Date.now());
  const input = useRef<ComponentRef<typeof TextInput>>(null);
  const working = useRef(false);
  const info = useQuery(useReadOptions().info);
  const seconds = pause ? remainingSeconds(pause.until, now) : 0;
  const paused = seconds > 0;
  const ended = session.state.kind === "ended";
  useEffect(() => {
    onBusyChange?.(busy);
  }, [busy, onBusyChange]);
  function useDifferentEmail() {
    setStep("email");
    setDigits("");
    setCodeState("ready");
    if (!paused) setMessage(null);
  }
  useEffect(() => {
    if (step !== "code") return;
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      if (!busy) useDifferentEmail();
      return true;
    });
    return () => {
      subscription.remove();
    };
  }, [step, busy, paused]);
  useEffect(() => {
    const shown = Keyboard.addListener("keyboardDidShow", () => {
      setKeyboard(true);
    });
    const hidden = Keyboard.addListener("keyboardDidHide", () => {
      setKeyboard(false);
    });
    return () => {
      shown.remove();
      hidden.remove();
    };
  }, []);
  useEffect(() => {
    if (!pause) return;
    const tick = () => {
      setNow(Date.now());
    };
    const timer = setInterval(tick, 250);
    const subscription = AppState.addEventListener("change", tick);
    return () => {
      clearInterval(timer);
      subscription.remove();
    };
  }, [pause]);
  useEffect(() => {
    if (!pause) return;
    if (seconds === 30 || seconds === 10 || seconds === 0)
      AccessibilityInfo.announceForAccessibility(`Try again in ${String(seconds)} seconds`);
    if (seconds === 0) {
      setPause(null);
      setMessage(null);
      input.current?.focus();
    }
  }, [pause, seconds]);
  async function accept(credential: Credential) {
    const prior = ended ? session.state.personId : null;
    await session.accept(credential, email);
    onAuthenticated?.();
    if (prior !== credential.user.id) {
      router.dismissAll();
      router.replace("/");
    } else if (modal) router.back();
  }
  async function perform(action: "send" | "signIn" | "demo", code = digits) {
    if (working.current || paused) return;
    if (action !== "demo") {
      const parsed = parseEmail(email);
      if (!parsed.ok) {
        setFieldError(true);
        input.current?.focus();
        return;
      }
      setEmail(parsed.value);
    }
    working.current = true;
    setBusy(true);
    setMessage(null);
    setFieldError(false);
    try {
      if (action === "demo") await accept(await auth.demo());
      else if (action === "send") {
        await auth.sendCode(email.trim());
        setStep("code");
        setDigits("");
        setCodeState("ready");
        setTimeout(() => input.current?.focus(), 100);
      } else await accept(await auth.signIn(email.trim(), code));
    } catch (error) {
      if (error instanceof RequestFailure) {
        if (error.failure.kind === "http" && error.failure.status === 429) {
          const delay = error.retryAfter ?? 60;
          setPause({ until: Date.now() + delay * 1000 });
          setNow(Date.now());
          Keyboard.dismiss();
          setMessage({
            kind: "wait",
            title: delay === 60 ? "Sign-in is paused for a minute" : "Sign-in is paused",
            text: "Too many requests arrived close together. Nothing was checked or sent.",
          });
        } else if (error.code === "INVALID_OTP") {
          setDigits("");
          input.current?.focus();
          setMessage({
            kind: "refused",
            title: "That code did not work",
            text: "Check all six digits. It allows three wrong tries.",
          });
        } else if (error.code === "OTP_EXPIRED") {
          setCodeState("expired");
          setMessage({
            kind: "refused",
            title: "That code ran out of time",
            text: "Each one lasts 5 minutes.",
          });
        } else if (error.code === "TOO_MANY_ATTEMPTS") {
          setCodeState("used");
          setMessage({
            kind: "refused",
            title: "That code is used up",
            text: "It took three wrong tries, so it no longer works.",
          });
        } else if (
          action === "demo" &&
          error.failure.kind === "http" &&
          [403, 404].includes(error.failure.status)
        )
          setMessage({
            kind: "neutral",
            title: "The demo is unavailable",
            text: "It may be back after tonight's reset.",
          });
        else if (error.failure.kind === "http" && error.failure.status === 404)
          setMessage({
            kind: "neutral",
            title: "Sign-in is unavailable",
            text: "Ask your manager for help.",
          });
        else if (
          (error.failure.kind === "http" || error.failure.kind === "refused") &&
          error.failure.status === 400 &&
          action === "send"
        )
          setFieldError(true);
        else setMessage({ kind: "neutral", ...failureWording(error.failure) });
      } else
        setMessage({
          kind: "neutral",
          title: "Sign-in could not finish",
          text: "This phone could not keep the session securely. Try again.",
        });
    } finally {
      working.current = false;
      setBusy(false);
    }
  }
  const locked = codeState !== "ready";
  const label = paused
    ? `Try again in ${String(seconds)} s`
    : busy
      ? step === "email"
        ? "Sending…"
        : "Signing in…"
      : step === "email"
        ? "Send me a code"
        : locked
          ? "Send a new one"
          : "Sign in";
  return (
    <Screen>
      <KeyboardAvoidingView
        style={{ flex: 1, paddingTop: inset.top }}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
      >
        {!keyboard && (
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 12,
              paddingHorizontal: 20,
              paddingVertical: 28,
            }}
          >
            <View
              style={{
                width: 44,
                height: 44,
                borderRadius: 12,
                backgroundColor: c.onCarbon,
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <Svg width={28} height={28} viewBox="0 0 28 28" accessible={false}>
                <Path
                  d="M3 10q5-6 11 0t11 0M3 17q5-6 11 0t11 0"
                  fill="none"
                  stroke={c.carbon}
                  strokeWidth={2}
                />
              </Svg>
            </View>
            <T variant="heading" color={c.onCarbon} style={{ fontFamily: families.semibold }}>
              Relay CRM
            </T>
          </View>
        )}
        <Sheet style={{ marginTop: keyboard ? 12 : 0 }}>
          <ScrollView
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={{
              paddingTop: step === "code" ? 12 : 28,
              paddingHorizontal: 20,
              paddingBottom: inset.bottom + 12,
              flexGrow: 1,
              gap: 16,
            }}
          >
            {modal && (
              <IconButton
                icon="close"
                label="Cancel"
                disabled={busy}
                outline
                onPress={() => {
                  router.back();
                }}
              />
            )}
            {step === "code" && (
              <Pressable
                accessibilityRole="button"
                onPress={() => {
                  if (!busy) useDifferentEmail();
                }}
                style={{ minHeight: 48, flexDirection: "row", alignItems: "center", gap: 8 }}
              >
                <Icon name="back" color={c.ink} size={16} />
                <T variant="small" color={c.ink}>
                  Use a different email
                </T>
              </Pressable>
            )}
            <View style={{ gap: 12 }}>
              <T accessibilityRole="header" variant="display">
                {step === "code" ? "Enter your code" : ended ? "Your session ended" : "Sign in"}
              </T>
              <T color={c.text2}>
                {step === "code" ? (
                  <>
                    If{" "}
                    <T style={{ fontFamily: families.semibold }} color={c.text2}>
                      {email}
                    </T>{" "}
                    has an account, six digits are on their way. They work once, for 5 minutes.
                  </>
                ) : modal ? (
                  "Sessions last up to 24 hours"
                ) : ended ? (
                  "Sessions last up to 24 hours. Sign in again to pick up where you were."
                ) : (
                  "A 6-digit code is sent to your inbox. There is no password."
                )}
              </T>
            </View>
            {modal && step === "email" && (
              <T color={c.text2}>
                {modal === "form"
                  ? "Sign in again to save what you typed. It stays on this phone meanwhile."
                  : "Sign in again to carry on. What is on this phone stays as it is."}
              </T>
            )}
            {step === "email" ? (
              <View style={{ gap: 8, marginTop: 6 }}>
                <T variant="small" style={{ fontFamily: families.semibold }}>
                  Work email
                </T>
                <View
                  style={{
                    borderWidth: fieldError || emailFocused ? 2 : 1,
                    borderColor: fieldError ? c.refusedFg : emailFocused ? c.ink : c.control,
                    borderRadius: 10,
                    minHeight: 52,
                    paddingHorizontal: 14,
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 8,
                  }}
                >
                  <Icon name="mail" color={c.text3} />
                  <TextInput
                    ref={input}
                    accessibilityLabel="Work email"
                    onFocus={() => {
                      setEmailFocused(true);
                    }}
                    onBlur={() => {
                      setEmailFocused(false);
                    }}
                    value={email}
                    onChangeText={setEmail}
                    editable={!busy && !paused}
                    keyboardType="email-address"
                    textContentType="emailAddress"
                    autoComplete="email"
                    autoCapitalize="none"
                    autoCorrect={false}
                    onSubmitEditing={() => {
                      void perform("send");
                    }}
                    maxFontSizeMultiplier={2}
                    style={{ ...type.body, color: c.text, flex: 1, paddingVertical: 14 }}
                    selectionColor={c.ink}
                  />
                </View>
                {fieldError && (
                  <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
                    <Icon name="error" size={14} color={c.refusedFg} />
                    <T
                      variant="caption"
                      color={c.refusedFg}
                      style={{ fontFamily: families.semibold, flex: 1 }}
                    >
                      Enter the email address your manager set up for you.
                    </T>
                  </View>
                )}
              </View>
            ) : (
              <View style={{ minHeight: 60 }}>
                <View
                  accessible={false}
                  importantForAccessibility="no-hide-descendants"
                  style={{ flexDirection: "row", gap: 8 }}
                >
                  {Array.from({ length: 6 }, (_, index) => (
                    <View
                      key={index}
                      style={{
                        flex: 1,
                        minHeight: 60,
                        borderRadius: 10,
                        borderWidth: locked ? 0 : digits.length === index ? 2 : 1,
                        borderColor: digits.length === index ? c.ink : c.control,
                        backgroundColor: locked ? c.mute : c.sheet,
                        justifyContent: "center",
                        alignItems: "center",
                      }}
                    >
                      <T
                        variant="title"
                        maxFontSizeMultiplier={1.5}
                        style={{ fontFamily: families.semibold }}
                      >
                        {locked ? "" : digits[index]}
                      </T>
                    </View>
                  ))}
                </View>
                <TextInput
                  key="code"
                  ref={input}
                  accessibilityLabel="6-digit code"
                  value={digits}
                  onChangeText={(value) => {
                    const next = value.replaceAll(/\D/g, "").slice(0, 6);
                    setDigits(next);
                    if (next.length === 6) void perform("signIn", next);
                  }}
                  keyboardType="number-pad"
                  textContentType="oneTimeCode"
                  autoComplete="one-time-code"
                  editable={!locked && !paused && !busy}
                  autoFocus
                  maxLength={6}
                  caretHidden
                  style={{
                    position: "absolute",
                    width: "100%",
                    height: "100%",
                    opacity: 0.02,
                    color: c.text,
                  }}
                />
              </View>
            )}
            {message && (
              <Band
                {...message}
                icon={paused ? "hourglass" : message.kind === "refused" ? "error" : "help"}
              />
            )}
            <Button
              label={label}
              accessibilityLabel={paused ? `Try again in ${String(seconds)} seconds` : label}
              busy={busy}
              disabled={paused || (step === "code" && !locked && digits.length !== 6)}
              onPress={() => {
                void perform(step === "email" || locked ? "send" : "signIn");
              }}
            />
            {signIn.remove && <RemoveSignIn />}
            {step === "code" && !locked && (
              <View
                style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 8 }}
              >
                <T variant="small" color={c.text2}>
                  No email yet?
                </T>
                <Pressable
                  disabled={busy || paused}
                  accessibilityRole="button"
                  onPress={() => {
                    void perform("send");
                  }}
                  style={{ minHeight: 48, justifyContent: "center" }}
                >
                  <T variant="small" color={c.ink} style={{ textDecorationLine: "underline" }}>
                    Send a new code
                  </T>
                </Pressable>
              </View>
            )}
            {step === "email" && info.data?.demo && info.data.demoAgentName && (
              <View style={{ gap: 16, borderTopWidth: 1, borderTopColor: c.rule, paddingTop: 20 }}>
                <T variant="small" color={c.text2}>
                  Just looking? The data here is invented and resets every night.
                </T>
                <Button
                  outline
                  label={`Open the demo as ${info.data.demoAgentName}`}
                  busy={busy}
                  disabled={paused}
                  onPress={() => {
                    void perform("demo");
                  }}
                />
              </View>
            )}
            {!keyboard && (
              <View style={{ flex: 1, justifyContent: "flex-end", paddingTop: 40 }}>
                <T variant="caption" color={c.text3} style={{ textAlign: "center" }}>
                  For sales agents. Ask your manager if you need an account.
                </T>
                <T
                  variant="caption"
                  color={c.text3}
                  style={{ textAlign: "center" }}
                  numberOfLines={1}
                  ellipsizeMode="middle"
                >
                  {new URL(server).host}
                </T>
              </View>
            )}
          </ScrollView>
        </Sheet>
      </KeyboardAvoidingView>
    </Screen>
  );
}
