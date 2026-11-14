import { createHmac } from "node:crypto";
import {
  normalizeAttribution,
  normalizeName,
  normalizePhone,
  parseEmail,
  parseExternalId,
  type IntakeSubmission,
} from "@relay/domain";
import { z } from "zod";

/** The outbound half of the Meta connector. Graph JSON never crosses this interface. */
export interface MetaLeadSource {
  /**
   * Fetches the lead a notification named. It throws on every failure, "does not exist"
   * included. Graph reports missing permissions with the same error, so treating it as permanent
   * would drop real leads while a token is misconfigured.
   */
  fetchSubmission(leadgenId: string, receivedAt: Date): Promise<IntakeSubmission>;
}

export interface MetaGraphConfig {
  readonly accessToken: string;
  readonly appSecret: string;
  /** For example "v24.0". */
  readonly graphVersion: string;
  readonly baseUrl: string;
  readonly fetch: typeof fetch;
}

export class MetaGraphError extends Error {
  override readonly name = "MetaGraphError";
}

const FIELDS =
  "id,created_time,field_data,ad_id,ad_name,adset_id,adset_name,campaign_id,campaign_name,form_id";
const TIMEOUT_MS = 10_000;

const GraphLead = z.object({
  id: z.string(),
  created_time: z.string().optional(),
  field_data: z.array(z.object({ name: z.string(), values: z.array(z.string()) })).default([]),
  ad_id: z.string().optional(),
  ad_name: z.string().optional(),
  adset_id: z.string().optional(),
  adset_name: z.string().optional(),
  campaign_id: z.string().optional(),
  campaign_name: z.string().optional(),
  form_id: z.string().optional(),
});

const GraphFailure = z.object({
  error: z.object({
    message: z.string().optional(),
    code: z.number().optional(),
    error_subcode: z.number().optional(),
  }),
});

function describeFailure(status: number, body: unknown): string {
  const failure = GraphFailure.safeParse(body);
  if (!failure.success) return `Graph answered ${String(status)}`;
  const { code, error_subcode: subcode, message } = failure.data.error;
  return `Graph answered ${String(status)}: code ${String(code)}, subcode ${String(subcode)}, ${String(message)}`;
}

function timestamp(value: string | undefined): Date | null {
  if (value === undefined) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function createMetaLeadSource(config: MetaGraphConfig): MetaLeadSource {
  // Meta checks this proof so a stolen token is useless without the app secret.
  const proof = createHmac("sha256", config.appSecret).update(config.accessToken).digest("hex");

  return {
    fetchSubmission: async (leadgenId, receivedAt) => {
      const externalId = parseExternalId(leadgenId);
      if (externalId === null) throw new MetaGraphError("The leadgen ID is not usable as a key");

      const url = new URL(
        `/${config.graphVersion}/${encodeURIComponent(leadgenId)}`,
        config.baseUrl,
      );
      url.searchParams.set("fields", FIELDS);
      url.searchParams.set("appsecret_proof", proof);
      const response = await config.fetch(url, {
        headers: { authorization: `Bearer ${config.accessToken}` },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });

      const body = z.json().safeParse(await response.json());
      if (!response.ok) throw new MetaGraphError(describeFailure(response.status, body.data));
      const lead = GraphLead.safeParse(body.data);
      if (!body.success || !lead.success || lead.data.id !== leadgenId) {
        throw new MetaGraphError(`Graph returned an unexpected body for lead ${leadgenId}`);
      }

      const answers = new Map(lead.data.field_data.map((field) => [field.name, field.values[0]]));
      const email = parseEmail(answers.get("email") ?? "");
      const fullName =
        answers.get("full_name") ??
        [answers.get("first_name"), answers.get("last_name")].filter(Boolean).join(" ");

      return {
        source: "metaLeadAds",
        externalId,
        email: email.ok ? email.value : null,
        name: normalizeName(fullName),
        phone: normalizePhone(answers.get("phone_number")),
        attribution: normalizeAttribution({
          campaign: lead.data.campaign_name ?? lead.data.campaign_id,
          adSet: lead.data.adset_name ?? lead.data.adset_id,
          ad: lead.data.ad_name ?? lead.data.ad_id,
          form: lead.data.form_id,
        }),
        submittedAt: timestamp(lead.data.created_time),
        receivedAt,
        raw: body.data,
      };
    },
  };
}
