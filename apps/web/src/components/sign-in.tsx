"use client";
import { useState, type SyntheticEvent } from "react";
import { authFailure } from "@/lib/failures";
import { Brand, Refusal } from "./pieces";
import { Icon } from "./icons";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Field } from "./ui/field";
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
    <div className="h-dvh overflow-y-auto bg-sidebar px-4 py-28 sm:grid sm:place-items-center sm:p-8">
      <header className="absolute start-4 top-6 max-w-64 text-sidebar-foreground sm:start-8 sm:top-7">
        <Brand />
      </header>
      <main
        className="mx-auto flex w-full max-w-108 flex-col gap-4 rounded-xl bg-card p-6 text-card-foreground sm:p-9"
        id="main"
      >
        {step === "code" && (
          <Button
            variant="ghost"
            className="self-start justify-start px-0 text-caption"
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
        <h1 className="text-3xl font-bold">{step === "email" ? "Sign in" : "Enter your code"}</h1>
        <p className="text-secondary-foreground">
          {step === "email" ? (
            "Enter your work email and we will send you a 6-digit code. There is no password to remember."
          ) : (
            <>
              We sent a 6-digit code to{" "}
              <span className="font-semibold text-foreground">{email}</span>. It works once.
            </>
          )}
        </p>
        <form
          className="flex flex-col gap-4"
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
            <Field label="Work email">
              {(control) => (
                <>
                  <div className="relative">
                    <span className="pointer-events-none absolute start-3 top-3.5">
                      <Icon name="mail" />
                    </span>
                    <Input
                      {...control}
                      className="h-11 ps-9"
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
                </>
              )}
            </Field>
          ) : (
            <>
              <input type="hidden" name="email" value={email} />
              <InputOTP
                id="otp"
                containerClassName="grid grid-cols-6 gap-2"
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
                  <InputOTPSlot
                    key={i}
                    index={i}
                    className="h-14 w-full rounded-md border text-2xl"
                  />
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
            className="w-full"
            size="lg"
            type="submit"
            busy={pending}
            disabled={step === "code" && code.length !== 6}
          >
            {pending ? "Please wait…" : step === "email" ? "Send me a code" : "Sign in"}
          </Button>
        </form>
        {step === "code" && (
          <p className="text-caption text-secondary-foreground">
            No email yet?{" "}
            <Button
              variant="ghost"
              size="sm"
              className="h-auto p-0 text-caption underline underline-offset-4"
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
          <section className="flex flex-col gap-2 border-t pt-4" aria-label="Try the demo">
            <p className="text-caption text-secondary-foreground">
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
                <span className="text-caption font-normal">
                  {person.role[0]?.toUpperCase()}
                  {person.role.slice(1)}
                </span>
              </Button>
            ))}
          </section>
        )}
      </main>
      <aside className="absolute end-4 top-20 sm:end-8 sm:top-7" aria-label="Appearance settings">
        <ThemeSwitch />
      </aside>
      <footer className="absolute inset-x-6 bottom-6 text-center text-xs text-sidebar-muted">
        Sales and accounts staff only. Ask your manager if you need an account.
      </footer>
    </div>
  );
}
