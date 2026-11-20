import { useEffect, useRef, useState } from "react";
import type { ComponentRef } from "react";
import {
  AccessibilityInfo,
  ActivityIndicator,
  Platform,
  View,
  useWindowDimensions,
} from "react-native";
import DateTimePicker, { DateTimePickerAndroid } from "@react-native-community/datetimepicker";
import { clock, dayHeading, formatDate, zoneName } from "../core/dates.ts";
import { callbackShortcuts, wallInstant, wallTime } from "../core/write-form.ts";
import { Button, T } from "./pieces.tsx";
import { Chip, Fade } from "./write-controls.tsx";
import { useTheme } from "./theme.ts";

export function CallbackFields({
  value,
  zone,
  disabled,
  onChange,
  onError,
  closeVersion,
  error,
}: {
  value: string;
  zone: string | undefined;
  disabled: boolean;
  onChange: (at: string) => void;
  onError: (message: string | null) => void;
  closeVersion: number;
  error: string | null;
}) {
  const c = useTheme();
  const { fontScale } = useWindowDimensions();
  const [open, setOpen] = useState<"date" | "time" | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [now, setNow] = useState(new Date());
  const timeControl = useRef<ComponentRef<typeof View>>(null);
  useEffect(() => {
    if (!error) return;
    const timer = setTimeout(() => {
      if (timeControl.current)
        AccessibilityInfo.sendAccessibilityEvent(timeControl.current, "focus");
    }, 150);
    return () => {
      clearTimeout(timer);
    };
  }, [error]);
  useEffect(() => {
    setOpen(null);
  }, [closeVersion, disabled]);
  useEffect(() => {
    const timer = setInterval(() => {
      setNow(new Date());
    }, 60000);
    return () => {
      clearInterval(timer);
    };
  }, []);
  if (!zone)
    return (
      <View
        role="status"
        accessibilityLabel="Loading times"
        style={{ minHeight: 52, flexDirection: "row", gap: 8, alignItems: "center" }}
      >
        <ActivityIndicator size="small" color={c.text3} />
        <T variant="caption" color={c.text3}>
          Loading times
        </T>
      </View>
    );
  const at = new Date(value);
  const today = wallTime(now, zone);
  const minimum = wallInstant({ ...today, hour: 0, minute: 0 }, zone) ?? now;
  function commit(mode: "date" | "time", date: Date) {
    if (!zone) return;
    const chosen = wallTime(date, zone);
    const existing = wallTime(at, zone);
    const wall =
      mode === "date"
        ? { ...existing, year: chosen.year, month: chosen.month, day: chosen.day }
        : { ...existing, hour: chosen.hour, minute: chosen.minute };
    const instant = wallInstant(wall, zone);
    setSelected(null);
    onError(instant ? null : "That time does not exist on this day. The clocks go forward.");
    if (instant) onChange(instant.toISOString());
  }
  function pick(mode: "date" | "time") {
    if (disabled || !zone) return;
    if (Platform.OS === "android") {
      DateTimePickerAndroid.open({
        value: at,
        mode,
        display: mode === "date" ? "calendar" : "clock",
        timeZoneName: zone,
        is24Hour: true,
        ...(mode === "date" ? { minimumDate: minimum } : {}),
        onValueChange: (_event, date) => {
          commit(mode, date);
        },
      });
    } else setOpen((prior) => (prior === mode ? null : mode));
  }
  const phoneZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const offset = (timeZone: string) =>
    formatDate(at, timeZone, { timeZoneName: "shortOffset" }).split(" ").at(-1);
  return (
    <View style={{ gap: 12 }}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        {callbackShortcuts(now, zone).map((shortcut) => (
          <Chip
            key={shortcut.label}
            label={shortcut.label}
            disabled={disabled}
            selected={selected === shortcut.label}
            onPress={() => {
              const current = callbackShortcuts(new Date(), zone).find(
                (item) => item.label === shortcut.label,
              );
              if (current) {
                setSelected(current.label);
                onError(null);
                onChange(current.at.toISOString());
              }
            }}
          />
        ))}
      </View>
      <View style={{ flexDirection: fontScale >= 1.3 ? "column" : "row", gap: 12 }}>
        <Button
          outline
          style={{ flex: fontScale < 1.3 ? 1 : undefined }}
          icon="calendar"
          label={`Day, ${dayHeading(at, zone)}`}
          accessibilityLabel={`Day, ${dayHeading(at, zone)}`}
          disabled={disabled}
          onPress={() => {
            pick("date");
          }}
        />
        <Button
          ref={timeControl}
          outline
          style={{
            flex: fontScale < 1.3 ? 1 : undefined,
            ...(error ? { borderColor: c.refusedFg, borderWidth: 2 } : {}),
          }}
          icon="clock"
          label={`Time, ${clock(at, zone)}`}
          accessibilityLabel={`Time, ${clock(at, zone)}, ${zoneName(zone)} clock`}
          disabled={disabled}
          onPress={() => {
            pick("time");
          }}
        />
      </View>
      {Platform.OS === "ios" && open && (
        <Fade identity={open}>
          <DateTimePicker
            value={at}
            mode={open}
            display={open === "date" ? "inline" : "spinner"}
            locale="en-GB"
            timeZoneName={zone}
            minuteInterval={5}
            disabled={disabled}
            {...(open === "date" ? { minimumDate: minimum } : {})}
            onValueChange={(_event, date) => {
              commit(open, date);
            }}
          />
        </Fade>
      )}
      <T variant="caption" color={c.text3}>
        Set on the {zoneName(zone)} clock
        {offset(zone) !== offset(phoneZone) ? ", not this phone's" : ""}.
      </T>
    </View>
  );
}
