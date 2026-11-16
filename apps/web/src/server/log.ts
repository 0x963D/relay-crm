export type Log = (event: string, detail: Readonly<Record<string, unknown>>) => void;

export function errorIdentity(error: unknown) {
  const code = error instanceof Error && "code" in error ? error.code : null;
  return {
    class: error instanceof Error ? error.constructor.name : "UnknownError",
    code: typeof code === "string" && /^(?:P\d{4}|[A-Z0-9]{5})$/.test(code) ? code : null,
  };
}

export const logToConsole: Log = (event, detail) => {
  const entries = Object.entries(detail).map(([key, value]) => [
    key,
    value instanceof Error ? errorIdentity(value) : value,
  ]);
  // eslint-disable-next-line no-console -- This is the application's one log sink.
  console.error(JSON.stringify({ event, ...Object.fromEntries(entries) }));
};
