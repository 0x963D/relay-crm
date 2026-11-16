import { randomUUID } from "node:crypto";
import { logToConsole, type Log } from "./log.ts";

export function reportFailure(
  event: string,
  error: unknown,
  log: Log = logToConsole,
  requestId = randomUUID(),
) {
  log(event, { requestId, error });
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
