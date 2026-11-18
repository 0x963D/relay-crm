import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import * as Haptics from "expo-haptics";
import { useSession } from "./session-provider.tsx";
import { queriesFor } from "./queries.ts";
import type { Entry } from "../core/write-model.ts";
import { sessionPerson } from "../core/session.ts";

interface Notice {
  readonly person: string | null;
  readonly accountId: string | null;
  readonly entry: Entry;
  readonly noCallback: boolean;
  readonly toast: boolean;
  readonly historyFailed: boolean;
}
interface Feedback {
  readonly notice: Notice | null;
  readonly reload: () => Promise<void>;
}
const Context = createContext<Feedback | null>(null);
export function WriteFeedbackProvider({ children }: { children: ReactNode }) {
  const session = useSession();
  const client = useQueryClient();
  const person = sessionPerson(session.state);
  const currentPerson = useRef(person);
  currentPerson.current = person;
  const [notice, setNotice] = useState<Notice | null>(null);
  const seen = useRef(new Set<string>());
  const refresh = useCallback(
    async (entry: Entry) => {
      if (!person) return;
      const options = queriesFor(person);
      const results = await Promise.allSettled([
        client.query({ ...options.lead(entry.command.payload.id), staleTime: 0 }),
        client.query({ ...options.queue, staleTime: 0 }),
      ]);
      if (person === currentPerson.current)
        setNotice((prior) =>
          prior?.entry.command.payload.key === entry.command.payload.key
            ? { ...prior, historyFailed: results.some((item) => item.status === "rejected") }
            : prior,
        );
    },
    [person, client],
  );
  useEffect(() => {
    setNotice(null);
    seen.current.clear();
    const phone = session.phone;
    return phone?.subscribe(() => {
      for (const entry of phone.entries()) {
        const saved = phone.snapshot(entry.command.payload.id);
        if (saved.state !== "saved" || seen.current.has(entry.command.payload.key)) continue;
        seen.current.add(entry.command.payload.key);
        setNotice({
          person,
          accountId: saved.receipt?.accountId ?? null,
          entry,
          noCallback: saved.view === "noCallback",
          toast: true,
          historyFailed: false,
        });
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(
          () => undefined,
        );
        void refresh(entry);
      }
    });
  }, [session.phone, person, refresh]);
  useEffect(() => {
    if (!notice?.toast) return;
    const timer = setTimeout(() => {
      setNotice((prior) => (prior ? { ...prior, toast: false } : null));
    }, 4350);
    return () => {
      clearTimeout(timer);
    };
  }, [notice?.entry.command.payload.key, notice?.toast]);
  return (
    <Context
      value={{
        notice: notice?.person === person ? notice : null,
        reload: async () => {
          if (notice) await refresh(notice.entry);
        },
      }}
    >
      {children}
    </Context>
  );
}
export function useWriteFeedback() {
  const value = useContext(Context);
  if (!value) throw new Error("WriteFeedbackProvider is required.");
  return value;
}
