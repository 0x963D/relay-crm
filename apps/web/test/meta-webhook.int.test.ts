import type { Actor } from "@relay/domain";
import { test, type TestDatabase } from "@relay/store/testing";
import { describe, expect } from "vitest";
import { createMetaLeadSource } from "../src/server/intake/meta/lead-source.ts";
import { createMetaWebhook } from "../src/server/intake/meta/webhook.ts";
import {
  ACCESS_TOKEN,
  APP_SECRET,
  delivery,
  graphFake,
  graphLead,
  SIGNED_FIXTURE,
  VERIFY_TOKEN,
} from "./support/meta.ts";

const NOW = new Date("2026-11-14T08:00:05.000Z");

const GRAPH_LEAD = graphLead(
  SIGNED_FIXTURE.leadgenId,
  { email: "Ana@Example.com", full_name: "Ana Silva" },
  { campaign_name: "Spring sale" },
);

/** The real webhook, the real Graph client and the real store. Only Graph's HTTP is canned. */
function webhookOver(db: TestDatabase, leads: Readonly<Record<string, unknown>>) {
  const graph = graphFake(leads);
  const webhook = createMetaWebhook({
    verifyToken: VERIFY_TOKEN,
    appSecret: APP_SECRET,
    leads: createMetaLeadSource({
      accessToken: ACCESS_TOKEN,
      appSecret: APP_SECRET,
      graphVersion: "v24.0",
      baseUrl: "https://graph.example",
      fetch: graph.fetch,
    }),
    intake: db.store.intake,
    now: () => NOW,
    log: () => undefined,
  });
  return { webhook, graph };
}

async function ownerOf(db: TestDatabase): Promise<Actor> {
  return { userId: await db.seedUser("owner"), role: "owner", team: null };
}

const signed = (): Request => delivery(SIGNED_FIXTURE.body, SIGNED_FIXTURE.signature);

describe("the Meta webhook over a real database", () => {
  test("a signed delivery creates one lead with its attribution", async ({ db }) => {
    const { webhook } = webhookOver(db, { [SIGNED_FIXTURE.leadgenId]: GRAPH_LEAD });

    const response = await webhook.POST(signed());

    expect(response.status).toBe(200);
    expect(await db.store.listLeads(await ownerOf(db), { limit: 10 })).toMatchObject([
      {
        email: "ana@example.com",
        name: "Ana Silva",
        lifecycle: { state: { status: "new" } },
        createdAt: NOW,
        origin: { source: "metaLeadAds", campaign: "Spring sale" },
      },
    ]);
    expect(
      await db.rows("SELECT source, external_id, outcome, submitted_at, raw FROM intake_events"),
    ).toEqual([
      {
        source: "metaLeadAds",
        external_id: SIGNED_FIXTURE.leadgenId,
        outcome: "leadCreated",
        submitted_at: new Date("2026-11-14T08:00:00.000Z"),
        raw: GRAPH_LEAD,
      },
    ]);
    expect(await db.counts()).toEqual({ leads: 1, intakeEvents: 1, activities: 1 });
  });

  test("a redelivery answers 200 and writes nothing new", async ({ db }) => {
    const { webhook } = webhookOver(db, { [SIGNED_FIXTURE.leadgenId]: GRAPH_LEAD });

    const first = await webhook.POST(signed());
    const second = await webhook.POST(signed());

    expect([first.status, second.status]).toEqual([200, 200]);
    expect(await db.counts()).toEqual({ leads: 1, intakeEvents: 1, activities: 1 });
  });

  test("a tampered delivery answers 401, calls nothing and writes nothing", async ({ db }) => {
    const { webhook, graph } = webhookOver(db, { [SIGNED_FIXTURE.leadgenId]: GRAPH_LEAD });
    const tampered = SIGNED_FIXTURE.body.replace("444555666777", "444555666778");

    const response = await webhook.POST(delivery(tampered, SIGNED_FIXTURE.signature));

    expect(response.status).toBe(401);
    expect(graph.requests).toEqual([]);
    expect(await db.counts()).toEqual({ leads: 0, intakeEvents: 0, activities: 0 });
  });

  test("a delivery Graph cannot serve answers 500, and its redelivery records the lead", async ({
    db,
  }) => {
    const failing = webhookOver(db, {});
    const failed = await failing.webhook.POST(signed());

    expect(failed.status).toBe(500);
    expect(await db.counts()).toEqual({ leads: 0, intakeEvents: 0, activities: 0 });

    const working = webhookOver(db, { [SIGNED_FIXTURE.leadgenId]: GRAPH_LEAD });
    const redelivered = await working.webhook.POST(signed());

    expect(redelivered.status).toBe(200);
    expect(await db.counts()).toEqual({ leads: 1, intakeEvents: 1, activities: 1 });
  });
});
