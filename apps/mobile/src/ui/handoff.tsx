import { useEffect, useState } from "react";
import { Linking, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import { handoffTarget } from "../core/handoff.ts";
import { Band, Button } from "./pieces.tsx";

interface Problem {
  channel: "call" | "whatsapp";
  phone: string;
  cause: "unavailable" | "failed" | "number";
}
export function useHandoff(
  onSuccess?: (channel: "call" | "whatsapp", at: Date) => void,
  leadName?: string,
  onStart?: (channel: "call" | "whatsapp") => void,
) {
  const [problem, setProblem] = useState<Problem | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => {
      setCopied(false);
    }, 2000);
    return () => {
      clearTimeout(timer);
    };
  }, [copied]);
  async function open(channel: "call" | "whatsapp", phone: string) {
    onStart?.(channel);
    setCopied(false);
    setProblem(null);
    const target = handoffTarget(channel, phone);
    if (!target) {
      setProblem({ channel, phone, cause: "number" });
      return;
    }
    const scheme = channel === "call" ? target : "whatsapp://send";
    try {
      if (!(await Linking.canOpenURL(scheme))) {
        setProblem({ channel, phone, cause: "unavailable" });
        return;
      }
      await Linking.openURL(target);
      const at = new Date();
      onSuccess?.(channel, at);
      return at;
    } catch {
      setProblem({ channel, phone, cause: "failed" });
    }
    return undefined;
  }
  const title = !problem
    ? ""
    : problem.cause === "number"
      ? problem.channel === "call"
        ? "The dialler cannot use this number"
        : "WhatsApp needs the country code"
      : problem.cause === "failed"
        ? problem.channel === "call"
          ? "The dialler did not open"
          : "WhatsApp did not open"
        : problem.channel === "call"
          ? "This phone cannot place calls"
          : "WhatsApp was not found on this phone";
  const band = problem ? (
    <Band
      title={title}
      text={
        problem.cause === "number"
          ? problem.channel === "call"
            ? "A manager can correct it on the web. Nothing was logged."
            : `${problem.phone} has none. A manager can correct it on the web.`
          : `Nothing was logged. ${problem.channel === "call" ? "Ring" : "Reach"} ${leadName ? `${leadName} on ` : ""}${problem.phone} another way.`
      }
      icon={problem.channel === "call" ? "phoneOff" : "messageOff"}
    >
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        {problem.cause === "failed" && (
          <Button
            small
            outline
            label="Try again"
            onPress={() => {
              void open(problem.channel, problem.phone);
            }}
          />
        )}
        {problem.channel === "whatsapp" && problem.cause !== "failed" && (
          <Button
            small
            outline
            label="Call instead"
            onPress={() => {
              void open("call", problem.phone);
            }}
          />
        )}
        <Button
          small
          outline
          icon="copy"
          label={copied ? "Number copied" : "Copy number"}
          onPress={() => {
            void Clipboard.setStringAsync(problem.phone).then(() => {
              setCopied(true);
            });
          }}
        />
      </View>
    </Band>
  ) : null;
  return { open, band };
}
