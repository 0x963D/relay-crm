import type { IntakeSubmission } from "@relay/domain";
import { intakeFake, submissionExample } from "@relay/domain/testing";
import { describe, expect, it } from "vitest";
import type { MetaLeadSource } from "../src/server/intake/meta/lead-source.ts";
import { createMetaWebhook } from "../src/server/intake/meta/webhook.ts";
import {
  APP_SECRET,
  delivery,
  leadgen,
  notification,
  sign,
  SIGNED_FIXTURE,
  signedDelivery,
  VERIFY_TOKEN,
  WEBHOOK_URL,
} from "./support/meta.ts";

const NOW = new Date("2026-11-14T08:00:05.000Z");

interface Options {
  readonly graphFails?: readonly string[];
  readonly respond?: Parameters<typeof intakeFake>[0];
  readonly submissionFor?: (leadgenId: string, receivedAt: Date) => IntakeSubmission;
}

function setup(options: Options = {}) {
  const fetched: { leadgenId: string; receivedAt: Date }[] = [];
  const logged: string[] = [];
  const leads: MetaLeadSource = {
    fetchSubmission: (leadgenId, receivedAt) => {
      fetched.push({ leadgenId, receivedAt });
      if (options.graphFails?.includes(leadgenId) === true) {
        return Promise.reject(new Error("Graph is unavailable"));
      }
      const build =
        options.submissionFor ??
        ((id, at) => submissionExample({ source: "metaLeadAds", externalId: id, receivedAt: at }));
      return Promise.resolve(build(leadgenId, receivedAt));
    },
  };
  const intake = intakeFake(options.respond);
  const webhook = createMetaWebhook({
    verifyToken: VERIFY_TOKEN,
    appSecret: APP_SECRET,
    leads,
    intake: intake.intake,
    now: () => NOW,
    log: (event) => {
      logged.push(event);
    },
  });
  return { webhook, fetched, logged, received: intake.received };
}

function handshake(query: Readonly<Record<string, string>>): Request {
  return new Request(`${WEBHOOK_URL}?${new URLSearchParams(query).toString()}`);
}

describe("the verify-token handshake", () => {
  it("echoes the challenge when the mode and the token match", async () => {
    const response = await setup().webhook.GET(
      handshake({
        "hub.mode": "subscribe",
        "hub.verify_token": VERIFY_TOKEN,
        "hub.challenge": "1158201444",
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/plain");
    expect(await response.text()).toBe("1158201444");
  });

  it.each([
    [
      "a wrong token",
      { "hub.mode": "subscribe", "hub.verify_token": "guess", "hub.challenge": "1" },
    ],
    [
      "a token that only starts like the real one",
      { "hub.mode": "subscribe", "hub.verify_token": "test-verify", "hub.challenge": "1" },
    ],
    ["no token", { "hub.mode": "subscribe", "hub.challenge": "1" }],
    [
      "another mode",
      { "hub.mode": "unsubscribe", "hub.verify_token": VERIFY_TOKEN, "hub.challenge": "1" },
    ],
    ["no challenge", { "hub.mode": "subscribe", "hub.verify_token": VERIFY_TOKEN }],
  ])("answers 403 to %s", async (_label, query) => {
    const response = await setup().webhook.GET(handshake(query));

    expect(response.status).toBe(403);
    expect(await response.text()).toBe("");
  });
});

describe("a webhook that is not configured", () => {
  it("answers 404 to both verbs", async () => {
    const webhook = createMetaWebhook(null);

    expect((await webhook.GET(handshake({ "hub.mode": "subscribe" }))).status).toBe(404);
    expect((await webhook.POST(signedDelivery(SIGNED_FIXTURE.body))).status).toBe(404);
  });
});

describe("the signature check", () => {
  it("accepts a delivery signed with the app secret", async () => {
    const { webhook, fetched, received } = setup();

    const response = await webhook.POST(delivery(SIGNED_FIXTURE.body, SIGNED_FIXTURE.signature));

    expect(response.status).toBe(200);
    expect(fetched).toEqual([{ leadgenId: SIGNED_FIXTURE.leadgenId, receivedAt: NOW }]);
    expect(received.map((submission) => submission.externalId)).toEqual([SIGNED_FIXTURE.leadgenId]);
  });

  it("accepts the same signature written in uppercase hex", async () => {
    const { webhook } = setup();
    const signature = `sha256=${SIGNED_FIXTURE.signature.slice(7).toUpperCase()}`;

    expect((await webhook.POST(delivery(SIGNED_FIXTURE.body, signature))).status).toBe(200);
  });

  it.each<[string, string, string | null]>([
    [
      "a body that changed after it was signed",
      SIGNED_FIXTURE.body.replace("444555666777", "444555666778"),
      SIGNED_FIXTURE.signature,
    ],
    ["one extra byte of whitespace", `${SIGNED_FIXTURE.body}\n`, SIGNED_FIXTURE.signature],
    [
      "a signature with one digit changed",
      SIGNED_FIXTURE.body,
      SIGNED_FIXTURE.signature.replace(/.$/, "7"),
    ],
    ["a signature made with another secret", SIGNED_FIXTURE.body, sign(SIGNED_FIXTURE.body, "x")],
    ["no signature header", SIGNED_FIXTURE.body, null],
    ["an empty signature header", SIGNED_FIXTURE.body, ""],
    ["a signature without its prefix", SIGNED_FIXTURE.body, SIGNED_FIXTURE.signature.slice(7)],
    ["a SHA-1 signature", SIGNED_FIXTURE.body, "sha1=2fd4e1c67a2d28fced849ee1bb76e7391b93eb12"],
    ["a truncated signature", SIGNED_FIXTURE.body, SIGNED_FIXTURE.signature.slice(0, 40)],
  ])("answers 401 to %s and touches nothing", async (_label, body, signature) => {
    const { webhook, fetched, received } = setup();

    const response = await webhook.POST(delivery(body, signature));

    expect(response.status).toBe(401);
    expect(fetched).toEqual([]);
    expect(received).toEqual([]);
  });

  it("answers 413 to a body over the size limit without reading a signature", async () => {
    const { webhook, fetched } = setup();
    const body = "x".repeat(1_000_001);

    expect((await webhook.POST(delivery(body, sign(body)))).status).toBe(413);
    expect(fetched).toEqual([]);
  });
});

describe("a signed notification", () => {
  it.each([
    ["is not JSON", "leadgen_id=444"],
    ["is not valid UTF-8", new Uint8Array([0x7b, 0xff, 0x7d])],
    ["is for another object", JSON.stringify({ object: "user", entry: [] })],
    ["has no entries", JSON.stringify({ object: "page" })],
    ["has a leadgen change with no ID", notification({ field: "leadgen", value: {} })],
    [
      "has a leadgen ID that is not digits",
      notification({ field: "leadgen", value: { leadgen_id: "../me" } }),
    ],
  ])("gets 500 when it %s, so Meta keeps it", async (_label, body) => {
    const { webhook, fetched, logged } = setup();

    const response = await webhook.POST(delivery(body, sign(body)));

    expect(response.status).toBe(500);
    expect(fetched).toEqual([]);
    expect(logged).toEqual(["meta.notification.unreadable"]);
  });

  it("gets 200 and is ignored when it is for other fields", async () => {
    const { webhook, fetched, received } = setup();

    const response = await webhook.POST(
      signedDelivery(notification({ field: "feed", value: { item: "post" } })),
    );

    expect(response.status).toBe(200);
    expect(fetched).toEqual([]);
    expect(received).toEqual([]);
  });

  it("accepts a leadgen ID sent as a number", async () => {
    const { webhook, fetched } = setup();

    const response = await webhook.POST(
      signedDelivery(notification({ field: "leadgen", value: { leadgen_id: 444555666777 } })),
    );

    expect(response.status).toBe(200);
    expect(fetched.map((call) => call.leadgenId)).toEqual(["444555666777"]);
  });

  it("processes each lead once, in the order the batch names them", async () => {
    const { webhook, received } = setup();

    const response = await webhook.POST(
      signedDelivery(notification(leadgen("111"), leadgen("222"), leadgen("111"), leadgen("333"))),
    );

    expect(response.status).toBe(200);
    expect(received.map((submission) => submission.externalId)).toEqual(["111", "222", "333"]);
  });

  it("records a lead with no usable email and still answers 200", async () => {
    const { webhook, received } = setup({
      submissionFor: (leadgenId, receivedAt) =>
        submissionExample({
          source: "metaLeadAds",
          externalId: leadgenId,
          email: null,
          receivedAt,
        }),
    });

    const response = await webhook.POST(signedDelivery(notification(leadgen("111"))));

    expect(response.status).toBe(200);
    expect(received.map((submission) => submission.email)).toEqual([null]);
  });
});

describe("a failure after the signature check", () => {
  it("answers 500 when Graph fails for one lead, after processing the others", async () => {
    const { webhook, received, logged } = setup({ graphFails: ["222"] });

    const response = await webhook.POST(
      signedDelivery(notification(leadgen("111"), leadgen("222"), leadgen("333"))),
    );

    expect(response.status).toBe(500);
    expect(received.map((submission) => submission.externalId)).toEqual(["111", "333"]);
    expect(logged).toEqual(["meta.lead.failed"]);
  });

  it("answers 500 when intake fails, so Meta redelivers", async () => {
    const { webhook, logged } = setup({
      respond: () => {
        throw new Error("the database is down");
      },
    });

    const response = await webhook.POST(signedDelivery(notification(leadgen("111"))));

    expect(response.status).toBe(500);
    expect(logged).toEqual(["meta.lead.failed"]);
  });
});
