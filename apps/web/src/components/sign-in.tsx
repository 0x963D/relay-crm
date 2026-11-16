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
  { role: "accountant", name: "Esther Okafor" },
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
    <div className="sign-ground">
      <header className="sign-brand">
        <Brand />
      </header>
      <aside className="sign-theme" aria-label="Appearance settings">
        <ThemeSwitch />
      </aside>
      <main className="sheet sign-sheet" id="main">
        {step === "code" && (
          <Button
            variant="ghost"
            className="back-email"
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
        <p className="t2">
          {step === "email" ? (
            "Enter your work email and we will send you a 6-digit code. There is no password to remember."
          ) : (
            <>
              We sent a 6-digit code to <strong>{email}</strong>. It works once.
            </>
          )}
        </p>
        <form
          className="col sign-form"
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
            <div className="field">
              <label className="label" htmlFor="email">
                Work email
              </label>
              <div className="email-control">
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
            className="btn--block"
            size="lg"
            type="submit"
            disabled={pending || (step === "code" && code.length !== 6)}
          >
            {pending ? "Please wait…" : step === "email" ? "Send me a code" : "Sign in"}
          </Button>
        </form>
        {step === "code" && (
          <p className="sm t2">
            No email yet?{" "}
            <Button
              variant="ghost"
              size="sm"
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
          <section className="demo-choices" aria-label="Try the demo">
            <p className="sm t2">Try the demo with invented data. It resets every night.</p>
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
                <span className="sm">
                  {person.role[0]?.toUpperCase()}
                  {person.role.slice(1)}
                </span>
              </Button>
            ))}
          </section>
        )}
      </main>
      <footer className="sign-footer">
        Sales and accounts staff only. Ask your manager if you need an account.
      </footer>
    </div>
  );
}
