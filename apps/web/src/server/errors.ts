import { ClientAddressError } from "./client-address.ts";
import { randomUUID } from "node:crypto";
import { errorIdentity, logToConsole, type Log } from "./log.ts";

declare global {
  var relayMissingAddressLogged: boolean | undefined;
}

export function reportFailure(
  event: string,
  error: unknown,
  log: Log = logToConsole,
  requestId: string = randomUUID(),
) {
  if (error instanceof ClientAddressError) {
    if (!globalThis.relayMissingAddressLogged) {
      globalThis.relayMissingAddressLogged = true;
      log("server.clientAddressUnavailable", { requestId, error: errorIdentity(error) });
    }
  } else log(event, { requestId, error: errorIdentity(error) });
  return { message: "Something went wrong.", requestId };
}

export function failureResponse(
  event: string,
  error: unknown,
  init: ResponseInit = { status: 500 },
  log?: Log,
): Response {
  return Response.json(reportFailure(event, error, log), init);
}

export async function protectHttp(
  event: string,
  run: () => Promise<Response> | Response,
): Promise<Response> {
  try {
    return await run();
  } catch (error) {
    return failureResponse(event, error);
  }
}
