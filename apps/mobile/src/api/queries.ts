import { queryOptions } from "@tanstack/react-query";
import { read, rpc } from "./client.ts";
import { server } from "./server.ts";

export const queryDefaults = {
  queries: {
    retry: false,
    networkMode: "always",
    staleTime: 30000,
    refetchOnWindowFocus: "always",
  },
  // Only the stored-entry owner retries a write, using the entry's original key.
  mutations: { retry: 0 },
} as const;

export function queryReads(origin: string, person: string | null, client = rpc, active = true) {
  const scope = ["relay", origin, person] as const;
  return {
    info: queryOptions({
      queryKey: [...scope, "server.info"],
      queryFn: ({ signal }) => read(() => client.server.info.query(undefined, { signal })),
    }),
    profile: queryOptions({
      queryKey: [...scope, "session.profile"],
      enabled: person !== null && active,
      queryFn: ({ signal }) => read(() => client.session.profile.query(undefined, { signal })),
    }),
    queue: queryOptions({
      queryKey: [...scope, "leads.queue"],
      enabled: person !== null && active,
      queryFn: ({ signal }) => read(() => client.leads.queue.query({ limit: 100 }, { signal })),
    }),
    lead: (id: string) =>
      queryOptions({
        queryKey: [...scope, "leads.get", id],
        enabled: person !== null && active,
        queryFn: ({ signal }) => read(() => client.leads.get.query({ id }, { signal })),
      }),
  };
}
export const queriesFor = (person: string | null, active = true) =>
  queryReads(server, person, rpc, active);
