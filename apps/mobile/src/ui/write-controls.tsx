import { entriesFact } from "../core/write-presentation.ts";
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Animated, Easing, Platform, Pressable, View } from "react-native";
import * as Haptics from "expo-haptics";
import { useRouter } from "expo-router";
import { useSession } from "../api/session-provider.tsx";
import { useWriteFeedback } from "../api/write-feedback.tsx";
import { reviewTitle, successWords } from "../core/write-presentation.ts";
import { clock } from "../core/dates.ts";
import type { Operation } from "../core/write-machine.ts";
import { Band, Button, T } from "./pieces.tsx";
import { useElevation, useReducedMotion, useTheme } from "./theme.ts";

export function openWrite(
  router: ReturnType<typeof useRouter>,
  operation: Operation,
  id: string,
  channel?: "call" | "whatsApp",
  phone?: string,
) {
  router.push({
    pathname: "/write/[operation]",
    params: { operation, id, ...(channel ? { channel } : {}), ...(phone ? { phone } : {}) },
  });
}
export function Fade({ children, identity }: { children: ReactNode; identity: string }) {
  const opacity = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    opacity.setValue(0);
    const animation = Animated.timing(opacity, {
      toValue: 1,
      duration: 150,
      useNativeDriver: true,
    });
    animation.start();
    return () => {
      animation.stop();
    };
  }, [identity, opacity]);
  return <Animated.View style={{ opacity }}>{children}</Animated.View>;
}
function SavedToast({ children }: { children: ReactNode }) {
  const elevation = useElevation(2);
  const opacity = useRef(new Animated.Value(0)).current;
  const reduced = useReducedMotion();
  useEffect(() => {
    const enter = Animated.timing(opacity, {
      toValue: 1,
      duration: 200,
      easing: Easing.bezier(0.16, 1, 0.3, 1),
      useNativeDriver: true,
    });
    enter.start();
    const timer = setTimeout(() => {
      Animated.timing(opacity, {
        toValue: 0,
        duration: 150,
        easing: Easing.bezier(0.7, 0, 0.84, 0),
        useNativeDriver: true,
      }).start();
    }, 4200);
    return () => {
      clearTimeout(timer);
      enter.stop();
      opacity.stopAnimation();
    };
  }, [opacity]);
  return (
    <Animated.View
      style={{
        ...elevation,
        opacity,
        transform: [
          {
            translateY: reduced
              ? 0
              : opacity.interpolate({ inputRange: [0, 1], outputRange: [12, 0] }),
          },
        ],
      }}
    >
      {children}
    </Animated.View>
  );
}
export function KeptNote({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const [long, setLong] = useState(false);
  return (
    <View style={{ gap: 8 }}>
      <View
        style={{ height: 0 }}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        <T
          accessible={false}
          variant="secondary"
          onTextLayout={(event) => {
            setLong(event.nativeEvent.lines.length > 6);
          }}
          style={{ position: "absolute", width: "100%", opacity: 0 }}
        >
          {text}
        </T>
      </View>
      <T variant="secondary" numberOfLines={expanded ? undefined : 6}>
        {text}
      </T>
      {long && !expanded && (
        <Button
          small
          outline
          label="Show all"
          onPress={() => {
            setExpanded(true);
          }}
        />
      )}
    </View>
  );
}
export function Choice({
  title,
  description,
  selected,
  disabled = false,
  readOnly = false,
  onPress,
  children,
}: {
  title: string;
  description?: string | undefined;
  selected: boolean;
  disabled?: boolean;
  readOnly?: boolean;
  onPress: () => void;
  children?: ReactNode;
}) {
  const c = useTheme();
  return (
    <View
      style={{
        borderRadius: 12,
        borderWidth: disabled ? 0 : selected ? 2 : 1,
        borderColor: selected ? c.ink : c.control,
        backgroundColor: disabled ? c.mute : selected ? c.inkTint : c.sheet,
      }}
    >
      <Pressable
        accessibilityRole="radio"
        accessibilityState={{ checked: selected, disabled: disabled || readOnly }}
        accessibilityLabel={title}
        accessibilityHint={description}
        disabled={disabled || readOnly}
        onPress={() => {
          if (!selected) void Haptics.selectionAsync().catch(() => undefined);
          onPress();
        }}
        style={{
          minHeight: 60,
          paddingVertical: 12,
          paddingHorizontal: 14,
          flexDirection: "row",
          gap: 10,
          alignItems: "center",
        }}
      >
        <View
          style={{
            width: 22,
            height: 22,
            borderRadius: 11,
            borderWidth: selected ? 6 : 1,
            borderColor: selected ? c.ink : c.control,
          }}
        />
        <View style={{ flex: 1, gap: 3 }}>
          <T variant="bodyStrong" color={disabled ? c.text3 : c.text}>
            {title}
          </T>
          {description && !disabled && (
            <T variant="caption" color={c.text2}>
              {description}
            </T>
          )}
        </View>
      </Pressable>
      {selected && children && (
        <View style={{ paddingHorizontal: 14, paddingBottom: 12, gap: 8 }}>{children}</View>
      )}
    </View>
  );
}
export function Chip({
  label,
  selected = false,
  disabled = false,
  onPress,
  accessibilityLabel,
  readOnly = false,
  segment = false,
}: {
  label: string;
  selected?: boolean;
  disabled?: boolean;
  onPress: () => void;
  accessibilityLabel?: string;
  readOnly?: boolean;
  segment?: boolean;
}) {
  const c = useTheme();
  const elevation = useElevation(1);
  return (
    <Pressable
      accessibilityRole={segment ? "radio" : "button"}
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={
        segment
          ? { checked: selected, disabled: disabled || readOnly }
          : { selected, disabled: disabled || readOnly }
      }
      disabled={disabled || readOnly}
      onPress={() => {
        if (segment && !selected) void Haptics.selectionAsync().catch(() => undefined);
        onPress();
      }}
      style={({ pressed }) => ({
        ...(segment && selected ? elevation : {}),
        minHeight: Platform.OS === "android" ? 48 : 44,
        minWidth: 44,
        flexGrow: segment ? 1 : undefined,
        alignItems: "center",
        justifyContent: "center",
        paddingHorizontal: 14,
        paddingVertical: 10,
        borderRadius: segment ? 7 : 999,
        borderWidth: segment || disabled ? 0 : 1,
        borderColor: selected ? c.ink : c.control,
        backgroundColor: disabled
          ? c.mute
          : segment
            ? selected
              ? c.sheet
              : c.mute
            : selected
              ? c.inkTint
              : c.sheet,
        opacity: pressed ? 0.85 : 1,
      })}
    >
      <T variant="small" color={disabled ? c.text3 : selected ? c.ink : c.text2}>
        {label}
      </T>
    </Pressable>
  );
}
export function ReasonChoice({
  title,
  selected,
  disabled,
  readOnly,
  onPress,
}: {
  title: string;
  selected: boolean;
  disabled: boolean;
  readOnly: boolean;
  onPress: () => void;
}) {
  const c = useTheme();
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityLabel={title}
      accessibilityHint={disabled ? "Needs an attempt first" : undefined}
      accessibilityState={{ checked: selected, disabled: disabled || readOnly }}
      disabled={disabled || readOnly}
      onPress={() => {
        void Haptics.selectionAsync().catch(() => undefined);
        onPress();
      }}
      style={{
        minHeight: 48,
        paddingVertical: 12,
        flexDirection: "row",
        alignItems: "center",
        gap: 10,
        borderBottomWidth: 1,
        borderBottomColor: c.rule2,
      }}
    >
      <View
        style={{
          width: 22,
          height: 22,
          borderRadius: 11,
          borderWidth: selected ? 6 : 1,
          borderColor: selected ? c.ink : c.controlOnTint,
        }}
      />
      <T style={{ flex: 1 }} color={disabled ? c.text3 : c.text}>
        {title}
      </T>
      {disabled && (
        <T variant="caption" color={c.text3}>
          Needs an attempt first
        </T>
      )}
    </Pressable>
  );
}
export function ReviewBand({ id, zone }: { id: string; zone?: string | undefined }) {
  const session = useSession();
  const router = useRouter();
  const entry = session.phone?.entries().find((item) => item.command.payload.id === id);
  if (!entry || !session.phone) return null;
  const snapshot = session.phone.snapshot(id);
  return (
    <Band
      kind="wait"
      icon="hourglass"
      title={reviewTitle(entry, snapshot, zone)}
      text={
        snapshot.state === "saved"
          ? snapshot.storageError
            ? "This phone could not clear its copy."
            : ""
          : "Open it before logging anything else here."
      }
    >
      <Button
        small
        outline
        label={snapshot.state === "saved" ? "Clear it" : "Review"}
        busy={snapshot.state === "saved" && snapshot.storageError === null}
        onPress={() => {
          if (snapshot.state === "saved")
            session.phone?.run(() => session.phone?.repair(id) ?? Promise.resolve());
          else openWrite(router, entry.command.operation, id);
        }}
      />
    </Band>
  );
}
export function EntriesStrip() {
  const session = useSession();
  const router = useRouter();
  const entries = session.phone?.entries() ?? [];
  const oldest = entries[0];
  if (!oldest || !session.phone) return null;
  const states = entries.map((entry) => session.phone?.snapshot(entry.command.payload.id).state);
  const plural = entries.length > 1;
  const fact = entriesFact(states);
  return (
    <View style={{ margin: 16 }}>
      <Band
        kind="wait"
        icon="hourglass"
        title={`${String(entries.length)} ${plural ? "entries are" : "entry is"} kept on this phone.`}
        text={fact}
      >
        <Button
          small
          outline
          label="Review"
          busy={
            session.phone.snapshot(oldest.command.payload.id).state === "saved" &&
            session.phone.snapshot(oldest.command.payload.id).storageError === null
          }
          onPress={() => {
            if (session.phone?.snapshot(oldest.command.payload.id).state === "saved")
              session.phone.run(
                () => session.phone?.repair(oldest.command.payload.id) ?? Promise.resolve(),
              );
            else openWrite(router, oldest.command.operation, oldest.command.payload.id);
          }}
        />
      </Band>
    </View>
  );
}
export function WriteNotice({
  id,
  zone,
  updatedAt,
  readFailed = true,
}: {
  id?: string;
  zone?: string | undefined;
  updatedAt?: number;
  readFailed?: boolean;
}) {
  const { notice, reload } = useWriteFeedback();
  if (!notice || (id && notice.entry.command.payload.id !== id)) return null;
  const words = notice.noCallback
    ? { title: "No callback was set", text: "There was nothing to clear." }
    : successWords(notice.entry, zone);
  return (
    <>
      {notice.toast && (
        <SavedToast key={notice.entry.command.payload.key}>
          <Band kind={notice.noCallback ? "neutral" : "done"} icon="check" {...words} />
        </SavedToast>
      )}
      {id && notice.historyFailed && readFailed && (
        <Band
          kind="done"
          icon="check"
          title="Saved. History could not refresh."
          text={
            zone && updatedAt
              ? `This screen is as it was at ${clock(new Date(updatedAt), zone)}.`
              : "The last loaded history is still shown."
          }
        >
          <Button
            small
            outline
            label="Reload"
            onPress={() => {
              void reload();
            }}
          />
        </Band>
      )}
    </>
  );
}
