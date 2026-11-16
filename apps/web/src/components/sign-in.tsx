"use client";
import { useState, type SyntheticEvent } from "react";
import { authFailure } from "@/lib/failures";
import { Brand, Refusal } from "./pieces";
import { Icon } from "./icons";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { InputOTP, InputOTPSlot } from "./ui/input-otp";
import { ThemeSwitch } from "./theme-switch";
const people = [
  { role: "manager", name: "Priya Raman" },
  { role: "agent", name: "Dele Akinwale" },
];
export function SignIn({ demo }: { demo: boolean }) {
  const [step, setStep] = useState<"email" | "code">("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function send() {
    setPending(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/email-otp/send-verification-otp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, type: "sign-in" }),
      });
      if (!res.ok) {
        setError(await authFailure(res, "send"));
        return;
      }
      setCode("");
      setStep("code");
    } catch {
      setError(await authFailure(null, "code"));
    } finally {
      setPending(false);
    }
  }
  async function submit(event: SyntheticEvent) {
    event.preventDefault();
    if (step === "email") {
      await send();
      return;
    }
    setPending(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/sign-in/email-otp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, otp: code }),
      });
      if (res.ok) {
        location.assign("/");
        return;
      }
      setCode("");
      setError(await authFailure(res, "code"));
    } catch {
      setError(await authFailure(null, "code"));
    } finally {
      setPending(false);
    }
  }
  async function demoSignIn(role: string) {
    setPending(true);
    setError(null);
    try {
      const response = await fetch("/api/auth/demo", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ role }),
      });
      if (response.ok) {
        location.assign("/");
        return;
      }
      setError(await authFailure(response, "demo"));
    } catch {
      setError(await authFailure(null, "code"));
    } finally {
      setPending(false);
    }
  }
  return (
    <div className="sign-ground h-[100dvh] grid place-items-center bg-shell relative p-pane overflow-auto max-phone:min-h-[100dvh] max-phone:h-auto max-phone:p-[112px_16px_88px]">
      <header className="sign-brand absolute [inset-block-start:28px] [inset-inline-start:32px] text-shell-foreground max-phone:[inset-inline-start:16px] max-phone:[inset-block-start:24px]">
        <Brand />
      </header>
      <main
        className="sheet bg-surface rounded-surface min-w-0 min-h-0 flex flex-col [.shell--live_&]:[grid-row:1] max-phone:m-0 max-phone:[border-radius:14px_14px_0_0] max-phone:flex-1 max-phone:overflow-visible sign-sheet w-[min(var(--sign-width),_100%)] p-[36px_36px_32px] gap-section m-0 overflow-visible [&_h1]:text-(length:--text-display) [&_h1]:leading-[32px] [&_h1]:font-[720] [&_h1]:[font-variation-settings:'wdth'_84] max-phone:p-[28px_24px]"
        id="main"
      >
        {step === "code" && (
          <Button
            variant="ghost"
            className="back-email [align-self:flex-start] p-0 justify-start h-auto text-(length:--text-small) leading-[18px] gap-tight"
            onClick={() => {
              setStep("email");
              setError(null);
            }}
          >
            {" "}
            <Icon name="back" size="small" />
            Use a different email
          </Button>
        )}
        <h1>{step === "email" ? "Sign in" : "Enter your code"}</h1>
        <p className="t2 text-secondary [.alert--refused_&]:text-refused-foreground">
          {step === "email" ? (
            "Enter your work email and we will send you a 6-digit code. There is no password to remember."
          ) : (
            <>
              We sent a 6-digit code to{" "}
              <span className="b font-[620] sign-email text-foreground">{email}</span>. It works
              once.
            </>
          )}
        </p>
        <form
          className="col flex flex-col sign-form gap-[18px]"
          action={
            step === "email"
              ? "/api/auth/email-otp/send-verification-otp"
              : "/api/auth/sign-in/email-otp"
          }
          method="post"
          onSubmit={(e) => {
            void submit(e);
          }}
        >
          {step === "email" ? (
            <div className="field flex flex-col gap-compact">
              <label className="label text-(length:--text-small) font-[600]" htmlFor="email">
                Work email
              </label>
              <div className="email-control relative [&_svg]:absolute [&_svg]:[inset-inline-start:10px] [&_svg]:[inset-block-start:14px] [&_input]:ps-[34px]">
                <Icon name="mail" />
                <Input
                  id="email"
                  name="email"
                  type="email"
                  required
                  autoComplete="email"
                  value={email}
                  onChange={(e) => {
                    setEmail(e.target.value);
                  }}
                />
              </div>
              <input type="hidden" name="type" value="sign-in" />
            </div>
          ) : (
            <>
              <input type="hidden" name="email" value={email} />
              <InputOTP
                id="otp"
                name="otp"
                aria-label="6-digit code"
                maxLength={6}
                pattern="^[0-9]+$"
                inputMode="numeric"
                autoComplete="one-time-code"
                value={code}
                onChange={setCode}
                autoFocus
              >
                {[0, 1, 2, 3, 4, 5].map((i) => (
                  <InputOTPSlot key={i} index={i} />
                ))}
              </InputOTP>
            </>
          )}
          {error && (
            <Refusal title={step === "code" ? "You could not sign in" : "Sign-in unavailable"}>
              {error}
            </Refusal>
          )}
          <Button
            className="btn--block w-full [.sign-sheet_&]:flex max-phone:[.pool-panel_&]:min-h-[44px]"
            size="lg"
            type="submit"
            disabled={pending || (step === "code" && code.length !== 6)}
          >
            {pending ? "Please wait…" : step === "email" ? "Send me a code" : "Sign in"}
          </Button>
        </form>
        {step === "code" && (
          <p className="sm text-(length:--text-small) leading-[18px] [.demo-choices_&]:font-[400] [.pool-people_&]:ms-auto [.preview-person_&]:[overflow-wrap:anywhere] [.preview-header_>_&]:text-(length:--text-caption) [.preview-header_>_&]:whitespace-nowrap t2 text-secondary [.alert--refused_&]:text-refused-foreground">
            No email yet?{" "}
            <Button
              variant="ghost"
              size="sm"
              className="resend-code p-0 h-auto text-[length:inherit] leading-[inherit] [text-decoration:underline] [text-underline-offset:3px]"
              onClick={() => {
                void send();
              }}
              disabled={pending}
            >
              Send a new code
            </Button>
          </p>
        )}
        {demo && step === "email" && (
          <section
            className="demo-choices [border-block-start:1px_solid_var(--color-rule)] pt-content flex flex-col gap-related max-phone:[.sign-sheet_&]:gap-related"
            aria-label="Try the demo"
          >
            <p className="sm text-(length:--text-small) leading-[18px] [.demo-choices_&]:font-[400] [.pool-people_&]:ms-auto [.preview-person_&]:[overflow-wrap:anywhere] [.preview-header_>_&]:text-(length:--text-caption) [.preview-header_>_&]:whitespace-nowrap t2 text-secondary [.alert--refused_&]:text-refused-foreground">
              Try the demo with invented data. It resets every night.
            </p>
            {people.map((person) => (
              <Button
                key={person.role}
                variant="outline"
                onClick={() => {
                  void demoSignIn(person.role);
                }}
                disabled={pending}
              >
                <span>{person.name}</span>
                <span className="sm text-(length:--text-small) leading-[18px] [.demo-choices_&]:font-[400] [.pool-people_&]:ms-auto [.preview-person_&]:[overflow-wrap:anywhere] [.preview-header_>_&]:text-(length:--text-caption) [.preview-header_>_&]:whitespace-nowrap">
                  {person.role[0]?.toUpperCase()}
                  {person.role.slice(1)}
                </span>
              </Button>
            ))}
          </section>
        )}
      </main>
      <aside
        className="sign-theme absolute [inset-inline-end:32px] [inset-block-start:28px] max-phone:[inset-inline-end:16px] max-phone:[inset-block-start:76px]"
        aria-label="Appearance settings"
      >
        <ThemeSwitch />
      </aside>
      <footer className="sign-footer absolute [inset-block-end:28px] [inset-inline:24px] text-center text-shell-secondary text-(length:--text-small) max-phone:[inset-block-end:24px] max-phone:text-(length:--text-caption)">
        Sales and accounts staff only. Ask your manager if you need an account.
      </footer>
    </div>
  );
}
