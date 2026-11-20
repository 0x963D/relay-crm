import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@relay/web/api-types";

export type Outputs = inferRouterOutputs<AppRouter>;
export type Queue = Outputs["leads"]["queue"];
export type QueueRow = Queue["overdueCallbacks"][number];
export type Lead = Outputs["leads"]["get"];
export type Profile = Outputs["session"]["profile"];
