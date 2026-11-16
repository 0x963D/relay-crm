"use client";
import { useState } from "react";
import {
  keepPreviousData,
  useQuery,
  type UseQueryOptions,
  type QueryKey,
} from "@tanstack/react-query";

export function usePagedQuery<TData, TError, TKey extends QueryKey>(
  options: UseQueryOptions<TData, TError, TData, TKey>,
  scope: string,
) {
  const [last, setLast] = useState<{ scope: string; data: TData } | null>(null);
  const query = useQuery({
    ...options,
    ...(last?.scope === scope ? { placeholderData: keepPreviousData } : {}),
  });
  if (query.data !== undefined && (last?.data !== query.data || last.scope !== scope))
    setLast({ scope, data: query.data });
  return { ...query, data: query.data ?? (last?.scope === scope ? last.data : undefined) };
}
