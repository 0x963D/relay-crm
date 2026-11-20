import { useEffect, useState } from "react";
import { AccessibilityInfo, useColorScheme } from "react-native";
import type { ViewStyle } from "react-native";
import { themeFor } from "../core/theme.ts";
export const useTheme = () => themeFor(useColorScheme());
export function useElevation(level: 1 | 2): ViewStyle {
  const dark = useColorScheme() === "dark";
  return {
    shadowColor: level === 2 && dark ? "#000000" : "#161A52",
    shadowOpacity: level === 1 ? 0.14 : dark ? 0.5 : 0.16,
    shadowRadius: level === 1 ? 2 : 28,
    shadowOffset: { width: 0, height: level === 1 ? 1 : -10 },
    elevation: level === 1 ? 1 : 16,
  };
}
export function useReducedMotion() {
  const [reduced, setReduced] = useState(true);
  useEffect(() => {
    let active = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((value) => {
      if (active) setReduced(value);
    });
    const subscription = AccessibilityInfo.addEventListener("reduceMotionChanged", setReduced);
    return () => {
      active = false;
      subscription.remove();
    };
  }, []);
  return reduced;
}
