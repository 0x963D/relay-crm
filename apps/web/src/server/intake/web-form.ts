import { randomUUID } from "node:crypto";
import {
  isExternalId,
  normalizeAttribution,
  normalizeName,
  normalizePhone,
  parseEmail,
  type EmailProblem,
  type ExternalId,
  type Intake,
  type JsonValue,
} from "@relay/domain";
import { z } from "zod";
import type { Store } from "@relay/store";
import { clientAddress } from "../client-address.ts";
import { allowRequest, limitKey, rateLimited } from "../rate-limit.ts";
import { failureResponse, protectHttp } from "../errors.ts";
import { readBody, status } from "../http.ts";
import type { Log } from "../log.ts";

export interface WebFormDeps {
  readonly intake: Intake;
  readonly limits: Pick<Store, "takeRequestLimit">;
  readonly trustedProxyCount: number;
  readonly now: () => Date;
  readonly log: Log;
}

export interface WebFormEndpoint {
  POST(request: Request): Promise<Response>;
}

const MAX_BODY_BYTES = 100_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const Fields = z.object({
  email: z.string({ error: "Enter an email address." }),
  submissionId: z.string().optional(),
  name: z.string().optional(),
  phone: z.string().optional(),
  form: z.string().optional(),
  campaign: z.string().optional(),
});

const EMAIL_PROBLEMS: Readonly<Record<EmailProblem, string>> = {
  malformed: "Enter an email address in the form name@example.com.",
  tooLong:
    "Use a shorter email address, with at most 64 characters before the @ sign and 254 in all.",
  nonAsciiLocalPart: "Use only ASCII letters, digits and symbols before the @ sign.",
  invalidDomain: "Check the part after the @ sign. It must be a domain name, such as example.com.",
};

type Body =
  | { readonly kind: "parsed"; readonly value: JsonValue }
  | { readonly kind: "refused"; readonly status: 400 | 415 };

function parseBody(contentType: string, bytes: Uint8Array): Body {
  const text = new TextDecoder().decode(bytes);
  if (contentType.startsWith("application/json")) {
    try {
      return { kind: "parsed", value: z.json().parse(JSON.parse(text)) };
    } catch {
      return { kind: "refused", status: 400 };
    }
  }
  if (contentType.startsWith("application/x-www-form-urlencoded")) {
    return { kind: "parsed", value: Object.fromEntries(new URLSearchParams(text)) };
  }
  return { kind: "refused", status: 415 };
}

function externalIdFor(submissionId: string | undefined): ExternalId {
  const id =
    submissionId !== undefined && UUID.test(submissionId)
      ? submissionId.toLowerCase()
      : randomUUID();
  if (!isExternalId(id)) throw new Error("A UUID did not pass as an external ID");
  return id;
}

function invalid(errors: Readonly<Record<string, string>>): Response {
  return Response.json({ errors }, { status: 422 });
}

/**
 * The public form endpoint. It takes JSON or a URL-encoded form. A field a person can fix gets a
 * 422 that names it. Every recorded submission gets the same 202, so the answer never reveals
 * whether the email was already known. A failed intake gets 503, and sending the same
 * `submissionId` again is safe.
 */
export function createWebFormEndpoint({
  intake,
  limits,
  trustedProxyCount,
  now,
  log,
}: WebFormDeps): WebFormEndpoint {
  return {
    POST: (request) =>
      protectHttp("webForm.failed", async () => {
        if (
          !(await allowRequest(limits, [
            { key: limitKey("form:client", clientAddress(request, trustedProxyCount)), max: 10 },
            { key: "form:global", max: 1000 },
          ]))
        )
          return rateLimited();
        const bytes = await readBody(request, MAX_BODY_BYTES);
        if (bytes === null) return status(413);
        const body = parseBody(request.headers.get("content-type") ?? "", bytes);
        if (body.kind === "refused") return status(body.status);

        const fields = Fields.safeParse(body.value);
        if (!fields.success) {
          return invalid(
            Object.fromEntries(
              fields.error.issues.map((issue) => [String(issue.path[0] ?? "body"), issue.message]),
            ),
          );
        }
        const email = parseEmail(fields.data.email);
        if (!email.ok) return invalid({ email: EMAIL_PROBLEMS[email.error] });
        const externalId = externalIdFor(fields.data.submissionId);

        try {
          await intake({
            source: "webForm",
            externalId,
            email: email.value,
            name: normalizeName(fields.data.name),
            phone: normalizePhone(fields.data.phone),
            attribution: normalizeAttribution({
              campaign: fields.data.campaign,
              form: fields.data.form,
            }),
            submittedAt: null,
            receivedAt: now(),
            raw: body.value,
          });
        } catch (error) {
          return failureResponse(
            "webForm.intake.failed",
            error,
            { status: 503, headers: { "retry-after": "1" } },
            log,
          );
        }
        return Response.json({ received: true }, { status: 202 });
      }),
  };
}
