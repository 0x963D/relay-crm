export interface VisibleRows<T> {
  limit: number;
  read: (page: { limit: number; offset: number }, signal: AbortSignal) => Promise<T>;
  merge: (previous: T, next: T) => T;
}
export async function readVisibleRows<T>(paging: VisibleRows<T>, signal: AbortSignal): Promise<T> {
  let result: T = await paging.read({ limit: Math.min(paging.limit, 100), offset: 0 }, signal);
  for (let offset = 100; offset < paging.limit; offset += 100) {
    signal.throwIfAborted();
    result = paging.merge(
      result,
      await paging.read({ limit: Math.min(paging.limit - offset, 100), offset }, signal),
    );
  }
  return result;
}
