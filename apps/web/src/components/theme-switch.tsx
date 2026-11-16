"use client";
import { useEffect, useState } from "react";
export function ThemeSwitch() {
  const [preference, setPreference] = useState("system");
  useEffect(() => {
    const stored = localStorage.getItem("relay-theme");
    if (stored) setPreference(stored);
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
  return (
    <select
      className="theme"
      aria-label="Appearance"
      value={preference}
      onChange={(e) => {
        setPreference(e.target.value);
        localStorage.setItem("relay-theme", e.target.value);
      }}
    >
      <option value="system">System</option>
      <option value="light">Light</option>
      <option value="dark">Dark</option>
    </select>
  );
}
