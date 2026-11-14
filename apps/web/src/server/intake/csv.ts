import { createHash } from "node:crypto";
import {
  normalizeAttribution,
  normalizeName,
  normalizePhone,
  parseEmail,
  parseExternalId,
  type Intake,
  type IntakeOutcome,
} from "@relay/domain";
import { parse } from "csv-parse/sync";
import { z } from "zod";

export interface CsvImportReport {
  readonly rows: number;
  /** What this import did, by outcome. A row recorded by an earlier import is not counted here. */
  readonly byOutcome: Readonly<Record<IntakeOutcome["kind"], number>>;
  readonly replayed: number;
  /** Rows that could not be recorded. Importing the file again retries only these. */
  readonly failures: readonly { readonly line: number; readonly message: string }[];
}

export class CsvHeaderError extends Error {
  override readonly name = "CsvHeaderError";
}

const Records = z.array(
  z.object({
    info: z.object({ lines: z.number() }),
    record: z.record(z.string(), z.string()),
  }),
);

function columnName(header: string): string {
  return header
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
}

function contentKey(fields: readonly (string | null)[]): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(fields)).digest("hex")}`;
}

function messageOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.trim().split("\n").at(-1) ?? message;
}

/**
 * Imports a CSV through the same intake as every other source. The file needs an `email` column.
 * `name`, `phone`, `campaign`, `ad_set`, `ad`, `form` and `external_id` are optional. Rows run
 * one at a time in file order, so an import never races itself, and a row that fails does not
 * stop the rows after it.
 */
export async function importCsv(
  deps: { readonly intake: Intake; readonly now: () => Date },
  csvText: string,
): Promise<CsvImportReport> {
  let columns: readonly string[] = [];
  const parsed: unknown = parse(csvText, {
    bom: true,
    columns: (header: string[]) => {
      columns = header.map(columnName);
      return [...columns];
    },
    info: true,
    skip_empty_lines: true,
    trim: true,
  });
  if (!columns.includes("email")) {
    throw new CsvHeaderError('The CSV needs a header row with an "email" column.');
  }
  const records = Records.parse(parsed);

  const receivedAt = deps.now();
  const byOutcome: Record<IntakeOutcome["kind"], number> = {
    leadCreated: 0,
    attachedToOpenLead: 0,
    leadReopened: 0,
    linkedToAccount: 0,
    suppressedDoNotContact: 0,
    rejectedNoEmail: 0,
  };
  let replayed = 0;
  const failures: { line: number; message: string }[] = [];

  for (const { info, record } of records) {
    const parsed = parseEmail(record.email ?? "");
    const email = parsed.ok ? parsed.value : null;
    const name = normalizeName(record.name);
    const phone = normalizePhone(record.phone);
    const attribution = normalizeAttribution({
      campaign: record.campaign,
      adSet: record.ad_set,
      ad: record.ad,
      form: record.form,
    });
    const externalId = parseExternalId(
      record.external_id === undefined || record.external_id === ""
        ? contentKey([
            email ?? record.email ?? null,
            name,
            phone,
            attribution.campaign,
            attribution.adSet,
            attribution.ad,
            attribution.form,
          ])
        : record.external_id,
    );
    if (externalId === null) {
      failures.push({ line: info.lines, message: "The external_id must be 1 to 200 characters." });
      continue;
    }

    try {
      const result = await deps.intake({
        source: "csv",
        externalId,
        email,
        name,
        phone,
        attribution,
        submittedAt: null,
        receivedAt,
        raw: record,
      });
      if (result.replayed) replayed += 1;
      else byOutcome[result.outcome.kind] += 1;
    } catch (error) {
      failures.push({ line: info.lines, message: messageOf(error) });
    }
  }

  return { rows: records.length, byOutcome, replayed, failures };
}
