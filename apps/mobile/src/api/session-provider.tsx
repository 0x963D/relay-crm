import { createContext, useContext, useEffect, useMemo, useReducer, useState } from "react";
import type { ReactNode } from "react";
import { AppState } from "react-native";
import { QueryClient, QueryClientProvider, focusManager } from "@tanstack/react-query";
import { auth, failureFrom, rpc, setSessionEnded } from "./client.ts";
import { PhoneEntries } from "../core/phone-entries.ts";
import { phoneStorage } from "./phone-storage.ts";
import { writeRequest } from "./write-request.ts";
import { server } from "./server.ts";
import { bearer, bearerPerson, tokenStore } from "./token.ts";
import { queryDefaults } from "./queries.ts";
import { signOutFromPhone } from "../core/sign-out.ts";
import { sessionPerson, sessionTransition } from "../core/session.ts";
import type { Credential, Session } from "../core/session.ts";

interface SessionActions {
  readonly state: Session;
  readonly accept: (credential: Credential, email: string) => Promise<void>;
  readonly signOut: () => Promise<void>;
  readonly removeSignIn: () => Promise<void>;
  readonly verify: () => Promise<void>;
  readonly rememberEmail: (email: string) => Promise<void>;
  readonly phone: PhoneEntries | null;
  readonly phoneReady: boolean;
  readonly phoneError: boolean;
  readonly reloadPhone: () => Promise<void>;
}
const Context = createContext<SessionActions | null>(null);
export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(sessionTransition, { kind: "restoring" });
  const person = sessionPerson(state);
  const phone = useMemo(
    () =>
      person
        ? new PhoneEntries({
            scope: { server, person },
            storage: phoneStorage,
            identity: () => {
              const current = bearerPerson();
              return current ? { server, person: current } : null;
            },
            dispatch: writeRequest(rpc),
            now: () => new Date(),
          })
        : null,
    [person],
  );
  const [phoneReady, setPhoneReady] = useState(false);
  const [phoneError, setPhoneError] = useState(false);
  const [, changed] = useReducer((version: number) => version + 1, 0);
  async function reloadPhone() {
    setPhoneReady(false);
    setPhoneError(false);
    try {
      await phone?.restore();
      setPhoneReady(true);
    } catch {
      setPhoneError(true);
    }
  }
  useEffect(() => {
    let current = true;
    setPhoneReady(false);
    setPhoneError(false);
    const unsubscribe = phone?.subscribe(changed);
    void phone
      ?.restore()
      .then(() => {
        if (current) setPhoneReady(true);
      })
      .catch(() => {
        if (current) setPhoneError(true);
      });
    return () => {
      current = false;
      unsubscribe?.();
    };
  }, [phone]);
  const [queries] = useState(
    () =>
      new QueryClient({
        defaultOptions: queryDefaults,
      }),
  );
  async function verify() {
    const token = bearer();
    try {
      await auth.verify();
      if (token === bearer()) dispatch({ type: "verified" });
    } catch (error) {
      const failure = failureFrom(error);
      if (token === bearer())
        dispatch(
          failure.kind === "sessionEnded" ? { type: "ended" } : { type: "unavailable", failure },
        );
    }
  }
  useEffect(() => {
    setSessionEnded(() => {
      dispatch({ type: "ended" });
    });
    void tokenStore
      .restore()
      .then(async ({ credential, email }) => {
        dispatch({ type: "restored", credential, email, now: Date.now() });
        if (credential && new Date(credential.expiresAt).getTime() > Date.now()) await verify();
      })
      .catch(() => {
        dispatch({ type: "restored", credential: null, email: "", now: Date.now() });
      });
    const sub = AppState.addEventListener("change", (status) => {
      focusManager.setFocused(status === "active");
    });
    return () => {
      setSessionEnded(null);
      sub.remove();
    };
  }, []);
  useEffect(() => {
    if (state.kind !== "signedIn") return;
    const ends = () => {
      if (new Date(state.credential.expiresAt).getTime() <= Date.now()) dispatch({ type: "ended" });
    };
    const timer = setTimeout(
      ends,
      Math.max(1, new Date(state.credential.expiresAt).getTime() - Date.now()),
    );
    const subscription = AppState.addEventListener("change", (status) => {
      if (status === "active") ends();
    });
    return () => {
      clearTimeout(timer);
      subscription.remove();
    };
  }, [state]);
  function forget() {
    queries.clear();
    dispatch({ type: "signedOut" });
  }
  function endSignIn(local = false) {
    const token = bearer();
    return signOutFromPhone(
      {
        revoke: () => auth.signOut(),
        remove: () => tokenStore.clear(token),
        erase: async () => {
          await phone?.removeAll();
        },
        forget,
      },
      local,
    );
  }
  return (
    <Context
      value={{
        state,
        phone,
        phoneReady,
        phoneError,
        reloadPhone,
        verify,
        rememberEmail: async (email) => {
          const token = bearer();
          await tokenStore.rememberEmail(email, token);
          if (token !== null && token === bearer()) dispatch({ type: "email", email });
        },
        accept: async (credential, email) => {
          await tokenStore.save(credential, email);
          const prior = state.kind === "ended" ? state.personId : null;
          if (prior !== credential.user.id) queries.clear();
          else void queries.invalidateQueries();
          dispatch({ type: "authenticated", credential, email });
        },
        signOut: () => endSignIn(),
        removeSignIn: () => endSignIn(true),
      }}
    >
      <QueryClientProvider client={queries}>{children}</QueryClientProvider>
    </Context>
  );
}
export function useSession() {
  const value = useContext(Context);
  if (!value) throw new Error("SessionProvider is required.");
  return value;
}
