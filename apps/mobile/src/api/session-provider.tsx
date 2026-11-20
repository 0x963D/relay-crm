import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";
import { Alert, AppState } from "react-native";
import { QueryClient, QueryClientProvider, focusManager } from "@tanstack/react-query";
import { auth, failureFrom, rpc, setSessionEnded } from "./client.ts";
import { PhoneEntries } from "../core/phone-entries.ts";
import { phoneStorage } from "./phone-storage.ts";
import { writeRequest } from "./write-request.ts";
import { server } from "./server.ts";
import { bearer, bearerPerson, tokenStore } from "./token.ts";
import { queryDefaults } from "./queries.ts";
import { erasePhone, keptPhoneWarning, signOutFromPhone } from "../core/sign-out.ts";
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
interface PhoneSession {
  readonly person: string;
  readonly ended: boolean;
  readonly owner: PhoneEntries;
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(sessionTransition, { kind: "restoring" });
  const person = sessionPerson(state);
  const ended = state.kind === "ended";
  const live = useRef<PhoneSession | null>(null);
  const [phoneSession, setPhoneSession] = useState<PhoneSession | null>(null);
  const phone =
    phoneSession?.person === person && phoneSession.ended === ended ? phoneSession.owner : null;
  const endSession = useCallback(() => {
    if (!live.current?.ended) live.current?.owner.retire();
    dispatch({ type: "ended" });
  }, []);
  const [phoneReady, setPhoneReady] = useState(false);
  const [phoneError, setPhoneError] = useState(false);
  const [, changed] = useReducer((version: number) => version + 1, 0);
  async function reloadPhone() {
    if (!phone) return;
    setPhoneReady(false);
    setPhoneError(false);
    try {
      await phone.restore();
      if (live.current?.owner === phone) setPhoneReady(true);
    } catch {
      if (live.current?.owner === phone) setPhoneError(true);
    }
  }
  useLayoutEffect(() => {
    const prior = live.current;
    setPhoneReady(false);
    setPhoneError(false);
    if (!person) {
      live.current = null;
      setPhoneSession(null);
      return;
    }
    const owner = new PhoneEntries({
      reportError: () => {
        Alert.alert(
          "This action could not finish",
          "Reopen this lead to review its current state before trying again.",
        );
      },
      scope: { server, person },
      storage: phoneStorage,
      identity: () => {
        const current = bearerPerson();
        return !ended && current ? { server, person: current } : null;
      },
      dispatch: writeRequest(rpc),
      now: () => new Date(),
      sessionEnded: endSession,
    });
    const next = { person, ended, owner };
    live.current = next;
    setPhoneSession(next);
    const unsubscribe = owner.subscribe(changed);
    let current = true;
    void owner
      .restore(prior?.owner)
      .then(() => {
        if (current) setPhoneReady(true);
      })
      .catch(() => {
        if (current) setPhoneError(true);
      });
    const background = AppState.addEventListener("change", (status) => {
      if (status !== "active") owner.run(() => owner.background());
    });
    return () => {
      background.remove();
      current = false;
      unsubscribe();
      owner.retire();
    };
  }, [person, ended, endSession]);
  const [queries] = useState(
    () =>
      new QueryClient({
        defaultOptions: queryDefaults,
      }),
  );
  const verify = useCallback(async () => {
    const token = bearer();
    try {
      await auth.verify();
      if (token === bearer()) dispatch({ type: "verified" });
    } catch (error) {
      const failure = failureFrom(error);
      if (token !== bearer()) return;
      if (failure.kind === "sessionEnded") endSession();
      else dispatch({ type: "unavailable", failure });
    }
  }, [endSession]);
  useEffect(() => {
    setSessionEnded(endSession);
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
  }, [endSession, verify]);
  useEffect(() => {
    if (state.kind !== "signedIn") return;
    const ends = () => {
      if (
        state.credential.token === bearer() &&
        new Date(state.credential.expiresAt).getTime() <= Date.now()
      )
        endSession();
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
  }, [state, endSession]);
  function forget() {
    queries.clear();
    dispatch({ type: "signedOut" });
  }
  async function endSignIn(local = false) {
    const token = bearer();
    const removal = await signOutFromPhone(
      {
        revoke: () => auth.signOut(),
        remove: () => tokenStore.clear(token),
        erase: async () => {
          if (!person) return;
          const owner = live.current?.person === person ? live.current.owner : null;
          await erasePhone(owner, phoneStorage, { server, person });
        },
        forget,
      },
      local,
    );
    if (removal === "kept") Alert.alert("Phone items could not be deleted", keptPhoneWarning);
  }
  return (
    <Context
      value={{
        state,
        phone,
        phoneReady: phone !== null && phoneReady,
        phoneError: phone !== null && phoneError,
        reloadPhone,
        verify,
        rememberEmail: async (email) => {
          const token = bearer();
          await tokenStore.rememberEmail(email, token);
          if (token !== null && token === bearer()) dispatch({ type: "email", email });
        },
        accept: async (credential, email) => {
          await tokenStore.save(credential, email);
          const previous = live.current;
          if (previous && (previous.ended || previous.person !== credential.user.id))
            previous.owner.retire();
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
