import { useCallback, useEffect, useRef } from "react";
import type { ComponentRef, ReactNode, Ref } from "react";
import {
  AccessibilityInfo,
  ActivityIndicator,
  Animated,
  Platform,
  Pressable,
  ScrollView,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import type { TextProps, ViewStyle, StyleProp } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useFocusEffect, useRouter } from "expo-router";
import {
  Ban,
  Hourglass,
  RefreshCwOff,
  X,
  AlarmClock,
  ArrowLeft,
  CalendarClock,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleCheck,
  CircleHelp,
  CircleX,
  Clock,
  Eye,
  History,
  Inbox,
  ListTodo,
  Lock,
  LogOut,
  Mail,
  Phone,
  PhoneMissed,
  RefreshCw,
  Server,
  StickyNote,
  UserPen,
  UserPlus,
  Users,
  WifiOff,
  Globe,
  Copy,
  PhoneOff,
  MessageCircleOff,
  Ellipsis,
} from "lucide-react-native";
import type { LucideIcon } from "lucide-react-native";
import type { IconName } from "../core/icons.ts";
export type { IconName } from "../core/icons.ts";
import { useSession } from "../api/session-provider.tsx";
import { sessionPerson } from "../core/session.ts";
import Svg, { Path } from "react-native-svg";
import { families, type } from "../core/theme.ts";
import type { RowSlip, SlipKind } from "../core/queue.ts";
import { useReducedMotion, useTheme } from "./theme.ts";

const icons = {
  ban: Ban,
  hourglass: Hourglass,
  refreshOff: RefreshCwOff,
  close: X,
  alarm: AlarmClock,
  back: ArrowLeft,
  backIos: ChevronLeft,
  calendar: CalendarClock,
  check: Check,
  down: ChevronDown,
  right: ChevronRight,
  done: CircleCheck,
  help: CircleHelp,
  error: CircleX,
  clock: Clock,
  eye: Eye,
  history: History,
  inbox: Inbox,
  list: ListTodo,
  lock: Lock,
  logout: LogOut,
  mail: Mail,
  phone: Phone,
  missed: PhoneMissed,
  refresh: RefreshCw,
  server: Server,
  note: StickyNote,
  edit: UserPen,
  person: UserPlus,
  users: Users,
  offline: WifiOff,
  globe: Globe,
  copy: Copy,
  phoneOff: PhoneOff,
  messageOff: MessageCircleOff,
  more: Ellipsis,
} satisfies Record<Exclude<IconName, "whatsapp">, LucideIcon>;
export function Icon({ name, color, size = 20 }: { name: IconName; color: string; size?: number }) {
  if (name === "whatsapp")
    return (
      <Svg width={size} height={size} viewBox="0 0 24 24" accessible={false}>
        <Path
          fill={color}
          d="M20.5 3.5A11.8 11.8 0 0 0 1.9 17.7L.3 23.5l6-1.6a11.8 11.8 0 0 0 14.2-18.4ZM12.1 22a9.8 9.8 0 0 1-5-1.4l-.4-.2-3.6.9 1-3.5-.3-.4A9.8 9.8 0 1 1 12.1 22Zm5.4-7.3c-.3-.2-1.7-.9-2-.9s-.5-.1-.7.2-.8.9-1 1-.4.2-.7 0a8 8 0 0 1-3.8-3.3c-.3-.5.3-.4.9-1.6.1-.2 0-.5 0-.6l-.9-2c-.2-.5-.4-.4-.6-.4h-.5c-.2 0-.5.1-.8.4-.3.3-1 1-1 2.4s1 2.8 1.2 3 2.1 3.2 5.1 4.5c1.9.8 2.6.8 3.5.7.5-.1 1.7-.7 2-1.3.2-.6.2-1.1.1-1.3s-.3-.2-.6-.4Z"
        />
      </Svg>
    );
  const Item = icons[name];
  return <Item color={color} size={size} strokeWidth={2} accessible={false} />;
}

export function T({
  variant = "body",
  color,
  style,
  maxFontSizeMultiplier = variant === "slip" ? 1.5 : 2,
  ...props
}: TextProps & {
  variant?: keyof typeof type;
  color?: string | undefined;
  ref?: Ref<ComponentRef<typeof Text>> | undefined;
}) {
  const theme = useTheme();
  return (
    <Text
      {...props}
      maxFontSizeMultiplier={maxFontSizeMultiplier}
      style={[
        {
          ...type[variant],
          color: color ?? theme.text,
          fontVariant: ["tabular-nums", "lining-nums"],
        },
        style,
      ]}
    />
  );
}
export function Heading({
  children,
  variant = "heading",
  color,
  style,
  maxFontSizeMultiplier = 2,
  numberOfLines,
}: {
  children: ReactNode;
  variant?: keyof typeof type;
  color?: string;
  style?: TextProps["style"];
  maxFontSizeMultiplier?: number;
  numberOfLines?: number;
}) {
  const ref = useRef<ComponentRef<typeof Text>>(null);
  const entered = useRef(false);
  const { state } = useSession();
  const person = sessionPerson(state);
  useEffect(() => {
    entered.current = false;
  }, [person]);
  useFocusEffect(
    useCallback(() => {
      if (entered.current || state.kind !== "signedIn") return;
      const timer = setTimeout(() => {
        if (ref.current) {
          AccessibilityInfo.sendAccessibilityEvent(ref.current, "focus");
          entered.current = true;
        }
      }, 250);
      return () => {
        clearTimeout(timer);
      };
    }, [state.kind]),
  );
  return (
    <T
      ref={ref}
      accessibilityRole="header"
      variant={variant}
      color={color}
      style={style}
      maxFontSizeMultiplier={maxFontSizeMultiplier}
      numberOfLines={numberOfLines}
    >
      {children}
    </T>
  );
}
export function Avatar({
  name,
  size = 36,
  carbon = false,
}: {
  name: string;
  size?: number;
  carbon?: boolean;
}) {
  const c = useTheme();
  return (
    <View
      accessible={false}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{
        width: size,
        height: size,
        borderRadius: 999,
        backgroundColor: carbon ? "rgba(243,244,255,0.15)" : c.mute,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <T
        color={carbon ? c.onCarbon : c.text2}
        style={{
          fontSize: size === 26 ? 11 : size === 52 ? 18 : 13,
          fontFamily: families.semibold,
        }}
      >
        {name
          .split(" ")
          .map((part) => part[0])
          .slice(0, 2)
          .join("")}
      </T>
    </View>
  );
}
export function Button({
  ref,
  label,
  accessibilityLabel,
  onPress,
  icon,
  outline = false,
  busy = false,
  disabled = false,
  small = false,
  style,
}: {
  ref?: Ref<ComponentRef<typeof View>>;
  label: string;
  accessibilityLabel?: string;
  onPress: () => void;
  icon?: IconName | undefined;
  outline?: boolean;
  busy?: boolean;
  disabled?: boolean;
  small?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const c = useTheme();
  const off = disabled || busy;
  const fg = disabled ? c.text3 : outline ? c.text : c.onInk;
  return (
    <Pressable
      ref={ref}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled: off, busy }}
      disabled={off}
      onPress={onPress}
      style={({ pressed }) => [
        {
          minHeight: small ? (Platform.OS === "android" ? 48 : 44) : 52,
          paddingHorizontal: 14,
          paddingVertical: 12,
          borderRadius: 10,
          borderWidth: outline && !disabled ? 1 : 0,
          borderColor: c.control,
          backgroundColor: disabled ? c.mute : outline ? c.sheet : c.ink,
          flexDirection: "row",
          gap: 8,
          alignItems: "center",
          justifyContent: "center",
          opacity: pressed ? 0.85 : 1,
        },
        style,
      ]}
    >
      {busy ? (
        <ActivityIndicator size="small" color={fg} />
      ) : icon ? (
        <Icon name={icon} color={fg} />
      ) : null}
      <T
        variant={small ? "secondary" : "rowTitle"}
        color={fg}
        style={{ textAlign: "center", flexShrink: 1 }}
      >
        {label}
      </T>
    </Pressable>
  );
}
export function IconButton({
  ref,
  icon,
  label,
  onPress,
  disabled = false,
  header = false,
  outline = false,
  large = false,
}: {
  ref?: Ref<ComponentRef<typeof View>>;
  icon: IconName;
  label: string;
  onPress: () => void;
  disabled?: boolean;
  header?: boolean;
  outline?: boolean;
  large?: boolean;
}) {
  const c = useTheme();
  const reduced = useReducedMotion();
  const turn = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (reduced || label !== "Refreshing") return;
    turn.setValue(0);
    const animation = Animated.loop(
      Animated.timing(turn, {
        toValue: 1,
        duration: 800,
        useNativeDriver: true,
        easing: (value) => value,
      }),
    );
    animation.start();
    return () => {
      animation.stop();
      turn.setValue(0);
    };
  }, [label, reduced, turn]);
  const side = large ? 52 : header || Platform.OS === "android" ? 48 : 44;
  return (
    <Pressable
      ref={ref}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => ({
        width: side,
        height: side,
        borderRadius: 10,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: header ? "transparent" : disabled ? c.mute : outline ? c.sheet : c.inkTint,
        borderWidth: outline ? 1 : 0,
        borderColor: c.control,
        opacity: pressed ? 0.85 : 1,
      })}
    >
      <Animated.View
        style={{
          transform: [
            { rotate: turn.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "360deg"] }) },
          ],
        }}
      >
        <Icon
          name={header && icon === "back" && Platform.OS === "ios" ? "backIos" : icon}
          color={header ? c.onCarbon : disabled ? c.text3 : outline ? c.text2 : c.ink}
          size={header ? (icon === "back" ? (Platform.OS === "ios" ? 28 : 24) : 22) : 20}
        />
      </Animated.View>
    </Pressable>
  );
}
export function Header({
  title,
  summary,
  children,
  back = false,
}: {
  title: string;
  summary?: ReactNode;
  children?: ReactNode;
  back?: boolean;
}) {
  const c = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { fontScale } = useWindowDimensions();
  return (
    <View
      style={{
        paddingTop: insets.top,
        paddingHorizontal: back ? 4 : 16,
        paddingBottom: 14,
        backgroundColor: c.carbon,
      }}
    >
      <View
        style={{
          minHeight: 52,
          flexDirection: fontScale >= 1.6 && !back ? "column-reverse" : "row",
          alignItems: fontScale >= 1.6 && !back ? "stretch" : "center",
          gap: back ? 0 : 10,
        }}
      >
        {back && (
          <IconButton
            icon="back"
            header
            label="Back"
            onPress={() => {
              router.back();
            }}
          />
        )}
        <Heading
          variant={back ? "title2" : "title"}
          color={c.onCarbon}
          style={{ flex: 1 }}
          maxFontSizeMultiplier={1.5}
          numberOfLines={2}
        >
          {title}
        </Heading>
        <View
          style={{ flexDirection: "row", alignItems: "center", gap: 10, alignSelf: "flex-end" }}
        >
          {children}
        </View>
      </View>
      {summary && fontScale < 1.6 ? (
        <View style={{ marginStart: back ? 48 : 0 }}>
          {typeof summary === "string" ? (
            <T variant="small" color={c.onCarbon2}>
              {summary}
            </T>
          ) : (
            summary
          )}
        </View>
      ) : null}
    </View>
  );
}
export function Screen({ children }: { children: ReactNode }) {
  const c = useTheme();
  return (
    <View style={{ flex: 1, backgroundColor: c.carbon }}>
      <View style={{ flex: 1, width: "100%", maxWidth: 560, alignSelf: "center" }}>{children}</View>
    </View>
  );
}
export function Sheet({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const c = useTheme();
  return (
    <View
      style={[
        {
          flex: 1,
          backgroundColor: c.sheet,
          borderTopStartRadius: 20,
          borderTopEndRadius: 20,
          overflow: "hidden",
        },
        style,
      ]}
    >
      {children}
    </View>
  );
}
export function Content({ children }: { children: ReactNode }) {
  const inset = useSafeAreaInsets();
  return (
    <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: inset.bottom + 12, gap: 24 }}>
      {children}
    </ScrollView>
  );
}
export function Slip({
  text,
  kind = "mute",
  icon,
}: {
  text: string;
  kind?: SlipKind;
  icon?: IconName;
}) {
  const c = useTheme();
  const colors = {
    refused: [c.refused, c.refusedFg, c.refusedBorder],
    wait: [c.wait, c.waitFg, c.waitBorder],
    done: [c.done, c.doneFg, c.doneBorder],
    fresh: [c.inkTint, c.ink, c.inkTint],
    outline: [c.sheet, c.text2, c.control],
    mute: [c.mute, c.text2, c.mute],
  };
  const [bg, fg, border] = colors[kind];
  return (
    <View
      style={{
        alignSelf: "flex-start",
        minHeight: 24,
        paddingVertical: 3,
        paddingHorizontal: 8,
        borderRadius: 4,
        borderWidth: 1,
        borderColor: border,
        backgroundColor: bg,
        flexDirection: "row",
        gap: 5,
        alignItems: "center",
        flexShrink: 1,
      }}
    >
      {icon && <Icon name={icon} color={fg ?? c.text2} size={14} />}
      <T variant="slip" color={fg} style={{ flexShrink: 1 }}>
        {text}
      </T>
    </View>
  );
}
export function Slips({ items }: { items: readonly RowSlip[] }) {
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
      {items.map((slip) => (
        <Slip key={slip.text} {...slip} />
      ))}
    </View>
  );
}
export function Band({
  title,
  text,
  kind = "neutral",
  icon = "help",
  children,
  titleVariant = "secondary",
  iconSize = 20,
}: {
  title: string;
  text: string;
  kind?: "neutral" | "wait" | "refused" | "info" | "done";
  icon?: IconName | undefined;
  children?: ReactNode;
  titleVariant?: "secondary" | "display";
  iconSize?: number;
}) {
  const c = useTheme();
  const fg =
    kind === "wait"
      ? c.waitFg
      : kind === "refused"
        ? c.refusedFg
        : kind === "done"
          ? c.doneFg
          : kind === "info"
            ? c.ink
            : c.text2;
  const bg =
    kind === "wait"
      ? c.wait
      : kind === "refused"
        ? c.refused
        : kind === "done"
          ? c.done
          : kind === "info"
            ? c.inkTint
            : c.mute;
  useEffect(() => {
    if (Platform.OS === "ios")
      AccessibilityInfo.announceForAccessibilityWithOptions(`${title}. ${text}`, {
        queue: kind !== "refused",
      });
  }, [title, text, kind]);
  return (
    <View
      style={{
        borderRadius: 12,
        backgroundColor: bg,
        paddingVertical: 12,
        paddingHorizontal: 14,
        gap: 12,
      }}
    >
      <View
        accessible
        role={kind === "refused" ? "alert" : "status"}
        accessibilityLiveRegion={kind === "refused" ? "assertive" : "polite"}
        accessibilityLabel={`${title}. ${text}`}
        style={{ flexDirection: "row", gap: 12 }}
      >
        <Icon name={icon} color={fg} size={iconSize} />
        <View style={{ flex: 1, gap: 4 }}>
          <T
            variant={titleVariant}
            color={kind === "neutral" ? c.text : fg}
            style={titleVariant === "secondary" ? { fontFamily: families.semibold } : undefined}
          >
            {title}
          </T>
          <T variant="small" color={fg}>
            {text}
          </T>
        </View>
      </View>
      {children}
    </View>
  );
}
export function Empty({
  title,
  titleRef,
  text,
  icon,
  action,
  onPress,
}: {
  title: string;
  titleRef?: Ref<ComponentRef<typeof Text>>;
  text: string;
  icon: IconName;
  action: string;
  onPress: () => void;
}) {
  const c = useTheme();
  return (
    <View style={{ alignItems: "center", paddingHorizontal: 24, paddingTop: 64, gap: 16 }}>
      <View
        style={{
          width: 56,
          height: 56,
          borderRadius: 28,
          backgroundColor: c.mute,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Icon name={icon} color={c.text3} size={26} />
      </View>
      <T
        ref={titleRef}
        accessibilityRole="header"
        variant="heading"
        style={{ textAlign: "center" }}
      >
        {title}
      </T>
      <T variant="secondary" color={c.text2} style={{ textAlign: "center", maxWidth: 300 }}>
        {text}
      </T>
      <Button
        small
        label={action}
        onPress={onPress}
        icon={action === "Try again" || action === "Check again" ? "refresh" : undefined}
      />
    </View>
  );
}
export function Skeleton({ lead = false, signoff = false }: { lead?: boolean; signoff?: boolean }) {
  const c = useTheme();
  const opacity = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    let animation: Animated.CompositeAnimation | undefined;
    void AccessibilityInfo.isReduceMotionEnabled().then((reduced) => {
      if (!reduced) {
        animation = Animated.loop(
          Animated.sequence([
            Animated.timing(opacity, { toValue: 0.5, duration: 700, useNativeDriver: true }),
            Animated.timing(opacity, { toValue: 1, duration: 700, useNativeDriver: true }),
          ]),
        );
        animation.start();
      }
    });
    return () => {
      animation?.stop();
    };
  }, [opacity]);
  return (
    <Animated.View
      accessible
      role="status"
      accessibilityLabel={
        signoff ? "Loading closing details" : lead ? "Loading lead" : "Loading queue"
      }
      accessibilityState={{ busy: true }}
      style={{ padding: signoff ? 0 : 16, gap: 24, opacity }}
    >
      {signoff ? (
        <View style={{ gap: 8 }}>
          <View style={{ height: 26, width: "80%", borderRadius: 6, backgroundColor: c.mute }} />
          <View style={{ height: 14, width: "65%", borderRadius: 6, backgroundColor: c.mute }} />
        </View>
      ) : (
        Array.from({ length: lead ? 5 : 7 }, (_, i) => (
          <View key={i} style={{ gap: 10 }}>
            <View
              style={{
                height: 16,
                width: i % 2 ? "40%" : "50%",
                borderRadius: 6,
                backgroundColor: c.mute,
              }}
            />
            <View
              style={{
                height: lead && i < 2 ? 56 : 22,
                width: "80%",
                borderRadius: 6,
                backgroundColor: c.mute,
              }}
            />
            <View style={{ height: 16, width: "65%", borderRadius: 6, backgroundColor: c.mute }} />
          </View>
        ))
      )}
    </Animated.View>
  );
}

export function RefreshStrip({
  offline,
  updated,
  onPress,
}: {
  offline: boolean;
  updated: string;
  onPress: () => void;
}) {
  const c = useTheme();
  const label = `${offline ? "Offline." : "Could not refresh."} Last updated ${updated}.`;
  useEffect(() => {
    if (Platform.OS === "ios")
      AccessibilityInfo.announceForAccessibilityWithOptions(label, { queue: true });
  }, [label]);
  return (
    <View
      style={{
        margin: 16,
        borderRadius: 10,
        backgroundColor: c.wait,
        borderWidth: 1,
        borderColor: c.waitBorder,
        flexDirection: "row",
        alignItems: "center",
        gap: 8,
        paddingStart: 12,
        paddingEnd: 4,
      }}
    >
      <Icon name={offline ? "offline" : "refreshOff"} color={c.waitFg} />
      <View
        accessible
        role="status"
        accessibilityLiveRegion="polite"
        accessibilityLabel={label}
        style={{ flex: 1, paddingVertical: 12 }}
      >
        <T variant="small" color={c.waitFg}>
          <T variant="small" color={c.waitFg} style={{ fontFamily: families.semibold }}>
            {offline ? "Offline." : "Could not refresh."}
          </T>{" "}
          Last updated {updated}.
        </T>
      </View>
      <Pressable
        accessibilityRole="button"
        onPress={onPress}
        style={{
          minWidth: 44,
          minHeight: Platform.OS === "android" ? 48 : 44,
          paddingHorizontal: 10,
          justifyContent: "center",
        }}
      >
        <T
          variant="small"
          color={c.waitFg}
          style={{ fontFamily: families.semibold, textDecorationLine: "underline" }}
        >
          Try again
        </T>
      </Pressable>
    </View>
  );
}
