import type { IntakeResult } from "@relay/domain";
import { intakeFake, intakeResultExample } from "@relay/domain/testing";
import { describe, expect, it } from "vitest";
import { createWebFormEndpoint } from "../src/server/intake/web-form.ts";

const NOW = new Date("2026-11-14T09:30:00.000Z");
const FORM_URL = "https://crm.example/api/intake/form";
const SUBMISSION_ID = "3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b";
const A_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function setup(respond?: Parameters<typeof intakeFake>[0]) {
  const logged: string[] = [];
  const intake = intakeFake(respond);
  const form = createWebFormEndpoint({
    intake: intake.intake,
    now: () => NOW,
    log: (event) => {
      logged.push(event);
    },
  });
  return { form, received: intake.received, logged };
}

function json(body: unknown): Request {
  return new Request(FORM_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function urlencoded(fields: Readonly<Record<string, string>>): Request {
  return new Request(FORM_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8" },
    body: new URLSearchParams(fields).toString(),
  });
}

function post(contentType: string, body: string): Request {
  return new Request(FORM_URL, { method: "POST", headers: { "content-type": contentType }, body });
}

const FIELDS = {
  submissionId: SUBMISSION_ID,
  email: " Ana@Example.com ",
  name: "  Ana   Silva ",
  phone: "+44 20 7946 0958",
  form: "contact",
  campaign: "spring",
};

describe("a valid submission", () => {
  it.each([
    ["JSON", json(FIELDS)],
    ["a URL-encoded form", urlencoded(FIELDS)],
  ])("sent as %s is recorded and answered with 202", async (_label, request) => {
    const { form, received } = setup();

    const response = await form.POST(request);

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ received: true });
    expect(received).toEqual([
      {
        source: "webForm",
        externalId: SUBMISSION_ID,
        email: { asTyped: "Ana@Example.com", key: "ana@example.com" },
        name: "Ana Silva",
        phone: "+44 20 7946 0958",
        attribution: { campaign: "spring", adSet: null, ad: null, form: "contact" },
        submittedAt: null,
        receivedAt: NOW,
        raw: FIELDS,
      },
    ]);
  });

  it("keeps fields it does not know in the stored record", async () => {
    const { form, received } = setup();
    const body = { email: "ana@example.com", consent: true, answers: { budget: "10k" } };

    await form.POST(json(body));

    expect(received[0]?.raw).toEqual(body);
  });

  it.each<[string, IntakeResult]>([
    ["a new lead", intakeResultExample()],
    ["a rejection", { ...intakeResultExample(), outcome: { kind: "rejectedNoEmail" } }],
    ["a replay", { ...intakeResultExample(), replayed: true }],
  ])("answers the same for %s, so it never reveals who is known", async (_label, result) => {
    const { form } = setup(() => result);

    const response = await form.POST(json(FIELDS));

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ received: true });
  });
});

describe("the idempotency key", () => {
  it("is the submission ID in lowercase, so a retry sends the same key", async () => {
    const { form, received } = setup();
    const uppercase = { ...FIELDS, submissionId: SUBMISSION_ID.toUpperCase() };

    await form.POST(json(FIELDS));
    await form.POST(json(uppercase));

    expect(received.map((submission) => submission.externalId)).toEqual([
      SUBMISSION_ID,
      SUBMISSION_ID,
    ]);
  });

  it.each([
    ["no submission ID", { email: "ana@example.com" }],
    ["a submission ID that is not a UUID", { email: "ana@example.com", submissionId: "form-1" }],
  ])("is minted on the server for %s, new for each request", async (_label, fields) => {
    const { form, received } = setup();

    await form.POST(urlencoded(fields));
    await form.POST(urlencoded(fields));

    const [first, second] = received.map((submission) => submission.externalId);
    expect(first).toMatch(A_UUID);
    expect(second).toMatch(A_UUID);
    expect(second).not.toBe(first);
  });
});

describe("a submission a person can fix", () => {
  it.each([
    [
      "an email that is not an address",
      { email: "ana at example" },
      "Enter a valid email address.",
    ],
    ["an empty email", { email: "  " }, "Enter a valid email address."],
    ["no email", { name: "Ana" }, "Enter an email address."],
  ])("gets 422 that names the field for %s", async (_label, fields, message) => {
    const { form, received } = setup();

    const response = await form.POST(json(fields));

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ errors: { email: message } });
    expect(received).toEqual([]);
  });

  it("gets 422 when the JSON body is not an object", async () => {
    const { form, received } = setup();

    const response = await form.POST(json(["ana@example.com"]));

    expect(response.status).toBe(422);
    expect(received).toEqual([]);
  });
});

describe("a request the endpoint cannot read", () => {
  it.each([
    ["malformed JSON", post("application/json", "{email:"), 400],
    ["an unsupported content type", post("text/plain", "email=ana@example.com"), 415],
    [
      "a body over the size limit",
      post(
        "application/json",
        JSON.stringify({ email: "a@example.com", pad: "x".repeat(100_000) }),
      ),
      413,
    ],
  ])("gets a client error for %s", async (_label, request, expected) => {
    const { form, received } = setup();

    expect((await form.POST(request)).status).toBe(expected);
    expect(received).toEqual([]);
  });
});

describe("a failed intake", () => {
  it("gets 503 with Retry-After, and the retry carries the same key", async () => {
    let calls = 0;
    const { form, received, logged } = setup(() => {
      calls += 1;
      if (calls === 1) throw new Error("the database is down");
      return intakeResultExample();
    });

    const first = await form.POST(json(FIELDS));
    const retry = await form.POST(json(FIELDS));

    expect(first.status).toBe(503);
    expect(first.headers.get("retry-after")).toBe("1");
    expect(logged).toEqual(["webForm.intake.failed"]);
    expect(retry.status).toBe(202);
    expect(received.map((submission) => submission.externalId)).toEqual([
      SUBMISSION_ID,
      SUBMISSION_ID,
    ]);
  });
});
