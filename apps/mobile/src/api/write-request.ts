import { failureFrom } from "./client.ts";
import type { createClient } from "./client.ts";
import type { Answer, Command } from "../core/write-model.ts";

export function writeRequest(client: ReturnType<typeof createClient>["rpc"]) {
  return async (command: Command, signal?: AbortSignal): Promise<Answer> => {
    try {
      const receipt = await (() => {
        switch (command.operation) {
          case "attempt":
            return client.leads.logAttempt.mutate(
              {
                ...command.payload,
                callback: command.payload.callback
                  ? command.payload.callback.kind === "set"
                    ? { kind: "set", at: new Date(command.payload.callback.at) }
                    : { kind: "clear" }
                  : undefined,
              },
              signal ? { signal } : undefined,
            );
          case "note":
            return client.leads.addNote.mutate(command.payload, signal ? { signal } : undefined);
          case "callback":
            return client.leads.setCallback.mutate(
              {
                ...command.payload,
                change:
                  command.payload.change.kind === "set"
                    ? { kind: "set", at: new Date(command.payload.change.at) }
                    : { kind: "clear" },
              },
              signal ? { signal } : undefined,
            );
          case "close":
            return client.leads.close.mutate(command.payload, signal ? { signal } : undefined);
        }
      })();
      return { kind: "receipt", receipt: { id: receipt.id, accountId: receipt.accountId } };
    } catch (error) {
      const failure = failureFrom(error);
      switch (failure.kind) {
        case "refused":
          return { kind: "refused", reason: failure.reason };
        case "sessionEnded":
          return { kind: "401" };
        case "network":
          return { kind: "unknown", cause: "network" };
        case "noAnswer":
          return { kind: "unknown", cause: "timeout" };
        case "unreadable":
          return { kind: "unknown", cause: "unreadable" };
        case "http":
          return { kind: "unknown", cause: failure.status >= 500 ? "server" : "unreadable" };
      }
    }
  };
}
