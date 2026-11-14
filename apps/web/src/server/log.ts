export type Log = (event: string, detail: Readonly<Record<string, unknown>>) => void;

function describe(value: unknown): unknown {
  return value instanceof Error ? { name: value.name, message: value.message } : value;
}

export const logToConsole: Log = (event, detail) => {
  const entries = Object.entries(detail).map(([key, value]) => [key, describe(value)]);
  // eslint-disable-next-line no-console -- This is the application's one log sink.
  console.error(JSON.stringify({ event, ...Object.fromEntries(entries) }));
};
