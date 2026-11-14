import { describe, expect, it } from "vitest";
import { createMetaLeadSource, MetaGraphError } from "../src/server/intake/meta/lead-source.ts";
import { ACCESS_TOKEN, APP_SECRET, APPSECRET_PROOF, graphFake, graphLead } from "./support/meta.ts";

const RECEIVED = new Date("2026-11-14T08:00:05.000Z");

function sourceWith(fetch: typeof globalThis.fetch) {
  return createMetaLeadSource({
    accessToken: ACCESS_TOKEN,
    appSecret: APP_SECRET,
    graphVersion: "v24.0",
    baseUrl: "https://graph.example",
    fetch,
  });
}

describe("the Graph request", () => {
  it("asks for the lead with a bearer token, the app-secret proof and a timeout", async () => {
    const graph = graphFake({ "444": graphLead("444", { email: "ana@example.com" }) });

    await sourceWith(graph.fetch).fetchSubmission("444", RECEIVED);

    expect(graph.requests).toHaveLength(1);
    const [request] = graph.requests;
    const url = new URL(request?.url ?? "");
    expect(`${url.origin}${url.pathname}`).toBe("https://graph.example/v24.0/444");
    expect(url.searchParams.get("fields")).toBe(
      "id,created_time,field_data,ad_id,ad_name,adset_id,adset_name,campaign_id,campaign_name,form_id",
    );
    expect(url.searchParams.get("appsecret_proof")).toBe(APPSECRET_PROOF);
    expect(url.searchParams.has("access_token")).toBe(false);
    expect(request?.headers.get("authorization")).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(request?.signal.aborted).toBe(false);
  });
});

describe("a fetched lead", () => {
  it("becomes a submission keyed by the leadgen ID, with the Graph body kept as received", async () => {
    const body = graphLead(
      "444",
      { email: " Ana@Example.com ", full_name: "Ana  Silva", phone_number: "+44 20 7946 0958" },
      {
        campaign_id: "c-1",
        campaign_name: "Spring sale",
        adset_id: "s-1",
        adset_name: "Lookalikes",
        ad_id: "a-1",
        ad_name: "Video 2",
        form_id: "f-1",
      },
    );

    const submission = await sourceWith(graphFake({ "444": body }).fetch).fetchSubmission(
      "444",
      RECEIVED,
    );

    expect(submission).toEqual({
      source: "metaLeadAds",
      externalId: "444",
      email: { asTyped: "Ana@Example.com", key: "ana@example.com" },
      name: "Ana Silva",
      phone: "+44 20 7946 0958",
      attribution: { campaign: "Spring sale", adSet: "Lookalikes", ad: "Video 2", form: "f-1" },
      submittedAt: new Date("2026-11-14T08:00:00.000Z"),
      receivedAt: RECEIVED,
      raw: body,
    });
  });

  it("falls back to IDs when Graph returns no names", async () => {
    const body = graphLead(
      "444",
      { email: "ana@example.com" },
      { campaign_id: "c-1", adset_id: "s-1", ad_id: "a-1" },
    );

    const submission = await sourceWith(graphFake({ "444": body }).fetch).fetchSubmission(
      "444",
      RECEIVED,
    );

    expect(submission.attribution).toEqual({
      campaign: "c-1",
      adSet: "s-1",
      ad: "a-1",
      form: null,
    });
  });

  it("joins a first and a last name when the form has no full name", async () => {
    const body = graphLead("444", {
      email: "ana@example.com",
      first_name: "Ana",
      last_name: "Silva",
    });

    const submission = await sourceWith(graphFake({ "444": body }).fetch).fetchSubmission(
      "444",
      RECEIVED,
    );

    expect(submission.name).toBe("Ana Silva");
  });

  it.each([
    ["no email answer", { full_name: "Ana Silva" }],
    ["an email that is not an address", { email: "ana at example" }],
  ])("has a null email when the form has %s", async (_label, answers) => {
    const graph = graphFake({ "444": graphLead("444", answers) });

    const submission = await sourceWith(graph.fetch).fetchSubmission("444", RECEIVED);

    expect(submission.email).toBeNull();
  });

  it("has no submitted time when Graph sends one it cannot read", async () => {
    const body = { ...graphLead("444", { email: "ana@example.com" }), created_time: "yesterday" };

    const submission = await sourceWith(graphFake({ "444": body }).fetch).fetchSubmission(
      "444",
      RECEIVED,
    );

    expect(submission.submittedAt).toBeNull();
  });
});

describe("a Graph failure", () => {
  it("throws for a lead Graph says does not exist, because that also means no permission", async () => {
    const source = sourceWith(graphFake({}).fetch);

    await expect(source.fetchSubmission("444", RECEIVED)).rejects.toThrow(MetaGraphError);
    await expect(source.fetchSubmission("444", RECEIVED)).rejects.toThrow(/code 100, subcode 33/);
  });

  it.each([
    ["an answer for another lead", graphLead("555", { email: "ana@example.com" })],
    ["an answer with no ID", { field_data: [] }],
    ["an answer that is not an object", "ok"],
  ])("throws for %s", async (_label, body) => {
    const source = sourceWith(graphFake({ "444": body }).fetch);

    await expect(source.fetchSubmission("444", RECEIVED)).rejects.toThrow(MetaGraphError);
  });

  it("lets a network failure through", async () => {
    const source = sourceWith(() => Promise.reject(new TypeError("fetch failed")));

    await expect(source.fetchSubmission("444", RECEIVED)).rejects.toThrow("fetch failed");
  });
});
