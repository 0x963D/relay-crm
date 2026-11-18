import type { Session } from "./session.ts";

export type SessionSurface = "content" | "form" | "review" | "result";
export function signInOptions(state: Session, modal: boolean) {
  return {
    allowed: state.kind === "ended" || state.kind === "signedOut",
    email: !modal && state.kind === "ended" ? "" : "email" in state ? state.email : "",
    remove: state.kind === "ended" && !modal,
  };
}
export function sessionDisplay(state: Session, surface: SessionSurface) {
  if (state.kind === "signedIn") return "content";
  if (state.kind === "ended" && surface !== "content") return "modal";
  return "replacement";
}
export function sessionSurface(pathname: string): SessionSurface {
  if (pathname.includes("/write/")) return "form";
  if (/\/(attempt|note|callback|close)(\/|$)/.test(pathname)) return "form";
  if (/\/review(\/|$)/.test(pathname)) return "review";
  if (/\/won(\/|$)/.test(pathname)) return "result";
  return "content";
}
