import { useCallback, useRef } from "react";
import { useFocusEffect } from "expo-router";
import { useSession } from "./session-provider.tsx";
import { queriesFor } from "./queries.ts";
import { sessionPerson } from "../core/session.ts";

export function useReadOptions() {
  const { state } = useSession();
  return queriesFor(sessionPerson(state), state.kind === "signedIn");
}
export function useReadOnReturn(
  refetch: (options?: { cancelRefetch?: boolean }) => Promise<unknown>,
) {
  const { state } = useSession();
  const active = useRef(false);
  active.current = state.kind === "signedIn";
  const entered = useRef(false);
  useFocusEffect(
    useCallback(() => {
      if (entered.current && active.current) void refetch({ cancelRefetch: false });
      entered.current = true;
    }, [refetch]),
  );
}
