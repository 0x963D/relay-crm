import { queryOptions } from "@tanstack/react-query";
import { failureCode } from "./failures";
import { api, type Inputs } from "./api";
export const reads = {
  agents: () =>
    queryOptions({
      queryKey: ["agents"],
      queryFn: ({ signal }) => api.leads.agents.query({ offset: 0 }, { signal }),
    }),
  pool: (input: Inputs["leads"]["pool"] = { limit: 14, offset: 0 }) =>
    queryOptions({
      queryKey: ["pool", input],
      queryFn: ({ signal }) => api.leads.pool.query(input, { signal }),
    }),
  queue: (input: Inputs["leads"]["queue"]) =>
    queryOptions({
      queryKey: ["queue", input],
      queryFn: ({ signal }) => api.leads.queue.query(input, { signal }),
    }),
  lead: (id: string) =>
    queryOptions({
      queryKey: ["lead", id],
      queryFn: ({ signal }) => api.leads.get.query({ id }, { signal }),
    }),
};

export type Remote<T> =
  { status: "loading" } | { status: "error"; error: unknown } | { status: "ready"; value: T };
export function readState<T>({
  data,
  isError,
  error,
}: {
  data: T | undefined;
  isError: boolean;
  error: unknown;
}): Remote<T> {
  if (isError && (data === undefined || failureCode(error) === "accessDenied"))
    return { status: "error", error };
  return data === undefined ? { status: "loading" } : { status: "ready", value: data };
}
