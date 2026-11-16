"use client";
import { NativeSelect } from "./ui/native-select";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
const Theme = createContext<{ preference: string; setPreference: (value: string) => void } | null>(
  null,
);
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreference] = useState("system");
  useEffect(() => {
    setPreference(localStorage.getItem("relay-theme") ?? "system");
  }, []);
  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      document.documentElement.dataset.theme =
        preference === "system" ? (media.matches ? "dark" : "light") : preference;
    };
    apply();
    media.addEventListener("change", apply);
    return () => {
      media.removeEventListener("change", apply);
    };
  }, [preference]);
  function choose(value: string) {
    localStorage.setItem("relay-theme", value);
    setPreference(value);
  }
  return <Theme.Provider value={{ preference, setPreference: choose }}>{children}</Theme.Provider>;
}
export function ThemeSwitch() {
  const theme = useContext(Theme);
  if (!theme) throw new Error("ThemeSwitch needs ThemeProvider");
  const { preference, setPreference } = theme;
  return (
    <NativeSelect
      className="h-9 w-auto rounded-md border-sidebar-border bg-sidebar-accent text-xs text-sidebar-foreground"
      aria-label="Appearance"
      value={preference}
      onChange={(e) => {
        setPreference(e.target.value);
      }}
    >
      <option value="system">System</option>
      <option value="light">Light</option>
      <option value="dark">Dark</option>
    </NativeSelect>
  );
}
