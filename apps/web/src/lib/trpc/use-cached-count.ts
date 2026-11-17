"use client";
import { useSyncExternalStore } from "react";
import { useQueryClient, type QueryKey, type DataTag } from "@tanstack/react-query";

export function useCachedCount<T>(
  queryKey: DataTag<QueryKey, T, unknown>,
  count: (data: T) => number,
) {
  const client = useQueryClient();
  const read = () => {
    const rows = client.getQueriesData<T>({ queryKey }).filter((row) => row[1] !== undefined);
    rows.sort(
      (a, b) =>
        (client.getQueryState(b[0])?.dataUpdatedAt ?? 0) -
        (client.getQueryState(a[0])?.dataUpdatedAt ?? 0),
    );
    const data = rows[0]?.[1];
    return data ? count(data) : undefined;
  };
  return useSyncExternalStore(
    (notify) => client.getQueryCache().subscribe(notify),
    read,
    () => undefined,
  );
}
