import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { Intake } from "@relay/domain";
import { z } from "zod";
import { readBody, status } from "../../http.ts";
import type { Log } from "../../log.ts";
import type { MetaLeadSource } from "./lead-source.ts";

export interface MetaWebhookConfig {
  readonly verifyToken: string;
  readonly appSecret: string;
  readonly leads: MetaLeadSource;
  readonly intake: Intake;
  readonly now: () => Date;
  readonly log: Log;
}

export interface WebhookHandlers {
  GET(request: Request): Promise<Response>;
  POST(request: Request): Promise<Response>;
}

const MAX_BODY_BYTES = 1_000_000;
const SIGNATURE = /^sha256=([0-9a-f]{64})$/i;

const Notification = z.object({
  object: z.literal("page"),
  entry: z.array(
    z.object({
      changes: z.array(z.object({ field: z.string(), value: z.unknown() })).default([]),
    }),
  ),
});

// Digits only, because the ID becomes a path segment of the Graph request.
const LeadgenChange = z.object({
  leadgen_id: z.union([z.string().regex(/^\d+$/), z.int().positive().transform(String)]),
});

/** Hashing first gives both sides one length, which `timingSafeEqual` requires. */
function sameSecret(left: string, right: string): boolean {
  const digest = (value: string): Buffer => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(left), digest(right));
}

/**
 * Checks Meta's HMAC-SHA256 over the exact bytes received. The header must carry 64 hex digits,
 * so both sides are 32 bytes before the constant-time compare.
 */
function signatureMatches(body: Uint8Array, header: string | null, appSecret: string): boolean {
  const claimed = SIGNATURE.exec(header ?? "")?.[1];
  if (claimed === undefined) return false;
  const expected = createHmac("sha256", appSecret).update(body).digest();
  return timingSafeEqual(expected, Buffer.from(claimed, "hex"));
}

/**
 * The leadgen IDs a notification names, without repeats. An empty list means the notification
 * was for other fields. null means the body is not a page notification this code understands.
 */
function leadgenIds(body: Uint8Array): readonly string[] | null {
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
    return null;
  }
  const notification = Notification.safeParse(json);
  if (!notification.success) return null;

  const ids = new Set<string>();
  for (const change of notification.data.entry.flatMap((entry) => entry.changes)) {
    if (change.field !== "leadgen") continue;
    const leadgen = LeadgenChange.safeParse(change.value);
    if (!leadgen.success) return null;
    ids.add(leadgen.data.leadgen_id);
  }
  return [...ids];
}

/**
 * The inbound half of the Meta Lead Ads connector: the verify-token handshake, the signature
 * check, the notification shape and the status policy. A null config means Meta is not set up,
 * and both verbs answer 404.
 *
 * The status code answers one question, whether a redelivery could succeed. An unsigned request
 * gets 401. A signed body this code cannot read gets 500, because a deploy can fix that while
 * Meta still holds the notification. A failed Graph fetch or intake gets 500 too. Meta then
 * redelivers the whole batch, and the leads that already succeeded replay as no-ops.
 */
export function createMetaWebhook(config: MetaWebhookConfig | null): WebhookHandlers {
  if (config === null) {
    return { GET: () => Promise.resolve(status(404)), POST: () => Promise.resolve(status(404)) };
  }
  const { verifyToken, appSecret, leads, intake, now, log } = config;

  return {
    GET: (request) => {
      const query = new URL(request.url).searchParams;
      const challenge = query.get("hub.challenge");
      const verified =
        query.get("hub.mode") === "subscribe" &&
        challenge !== null &&
        sameSecret(query.get("hub.verify_token") ?? "", verifyToken);
      return Promise.resolve(
        verified
          ? new Response(challenge, { headers: { "content-type": "text/plain" } })
          : status(403),
      );
    },

    POST: async (request) => {
      const body = await readBody(request, MAX_BODY_BYTES);
      if (body === null) return status(413);
      if (!signatureMatches(body, request.headers.get("x-hub-signature-256"), appSecret)) {
        return status(401);
      }

      const ids = leadgenIds(body);
      if (ids === null) {
        log("meta.notification.unreadable", { bytes: body.byteLength });
        return status(500);
      }

      const receivedAt = now();
      let failed = false;
      // One at a time: leads in one batch would only contend with each other in the database.
      for (const leadgenId of ids) {
        try {
          await intake(await leads.fetchSubmission(leadgenId, receivedAt));
        } catch (error) {
          failed = true;
          log("meta.lead.failed", { leadgenId, error });
        }
      }
      return status(failed ? 500 : 200);
    },
  };
}
