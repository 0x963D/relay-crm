import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { hostedDemoEnv } from "./support/hosted-demo.ts";
import { EnvError, parseEnv, serverOptions } from "../src/server/env.ts";

const DATABASE_URL = "postgresql://relay:relay@localhost:5432/relay";
it("sandbox delivery can reach the app independently of its published checkout address", () => {
  const env = parseEnv({
    DATABASE_URL,
    RELAY_DEMO: "1",
    RELAY_SANDBOX: "1",
    RELAY_SANDBOX_URL: "http://127.0.0.1:3197",
    RELAY_SANDBOX_DELIVERY_URL: "http://app:3107",
    RELAY_PAYMENT_WEBHOOK_SECRET: "fake-sandbox-signature-secret-for-tests",
    RELAY_RECONCILE_SECRET: "fake-reconciler-authentication-secret-for-tests",
  });
  expect(env.payments).toMatchObject({
    baseUrl: "http://127.0.0.1:3197",
    deliveryUrl: "http://app:3107",
  });
});
const META = {
  META_VERIFY_TOKEN: "verify",
  META_APP_SECRET: "secret",
  META_ACCESS_TOKEN: "token",
  META_GRAPH_VERSION: "v24.0",
};

it("serving configuration has no demo reset capability or owner credentials", () => {
  const env = parseEnv({ DATABASE_URL, RELAY_DEMO: "1" });
  expect(env).not.toHaveProperty("demoResetSecret");
  expect(env).not.toHaveProperty("demoOwnerFile");
});

describe("parseEnv", () => {
  it("configures receipt SMTP without enabling sign-in", () => {
    const env = parseEnv({
      DATABASE_URL,
      SMTP_URL: "smtp://127.0.0.1:1",
      SMTP_FROM: "fake@example.com",
    });
    expect(env.auth).toBeNull();
    expect(env.email).toEqual({
      kind: "smtp",
      url: "smtp://127.0.0.1:1",
      from: "fake@example.com",
    });
  });
  it("reads the database URL, with Meta and the dev user off when their variables are unset", () => {
    expect(parseEnv({ DATABASE_URL })).toEqual({
      email: null,
      hosted: false,
      scheduledSecret: null,
      publicForm: true,
      timeZone: "UTC",
      demo: false,
      outboxSecret: null,
      receipts: { leaseMs: 60000, sendTimeoutMs: 30000, lifetimeAttemptLimit: 12 },
      payments: null,
      trustedProxyCount: 0,
      auth: null,
      databaseUrl: DATABASE_URL,
      meta: null,
      devRole: null,
    });
  });

  it.each([
    ["missing", {}],
    ["empty", { DATABASE_URL: "" }],
    ["blank", { DATABASE_URL: "   " }],
  ])("refuses a %s database URL and names the variable", (_label, variables) => {
    expect(() => parseEnv(variables)).toThrow(EnvError);
    expect(() => parseEnv(variables)).toThrow(/DATABASE_URL/);
  });

  it("reads a complete Meta configuration and defaults the Graph base URL", () => {
    expect(parseEnv({ DATABASE_URL, ...META }).meta).toEqual({
      verifyToken: "verify",
      appSecret: "secret",
      accessToken: "token",
      graphVersion: "v24.0",
      graphBaseUrl: "https://graph.facebook.com",
    });
  });

  it("points the Graph client at another base URL when one is given", () => {
    const env = parseEnv({ DATABASE_URL, ...META, META_GRAPH_BASE_URL: "http://127.0.0.1:4010" });

    expect(env.meta?.graphBaseUrl).toBe("http://127.0.0.1:4010");
  });

  it("treats Meta variables left empty by a copied example file as unset", () => {
    const empty = { META_VERIFY_TOKEN: "", META_APP_SECRET: "", META_ACCESS_TOKEN: "" };

    expect(parseEnv({ DATABASE_URL, ...empty }).meta).toBeNull();
  });

  it("refuses a partial Meta configuration and names what is missing", () => {
    const partial = { DATABASE_URL, META_VERIFY_TOKEN: "verify", META_APP_SECRET: "secret" };

    expect(() => parseEnv(partial)).toThrow(EnvError);
    expect(() => parseEnv(partial)).toThrow(/META_ACCESS_TOKEN, META_GRAPH_VERSION/);
  });

  it("refuses a Graph version that is not a version", () => {
    expect(() => parseEnv({ DATABASE_URL, ...META, META_GRAPH_VERSION: "latest" })).toThrow(
      /META_GRAPH_VERSION/,
    );
  });

  it.each([
    ["a role the domain does not have", { RELAY_DEV_ROLE: "superuser" }],
    ["a role in the wrong case", { RELAY_DEV_ROLE: "Owner" }],
    [
      "a role while the dev user is on",
      { NODE_ENV: "development", RELAY_DEV_ACTOR: "1", RELAY_DEV_ROLE: "root" },
    ],
  ])("refuses %s and names RELAY_DEV_ROLE", (_label, variables) => {
    expect(() => parseEnv({ DATABASE_URL, ...variables })).toThrow(EnvError);
    expect(() => parseEnv({ DATABASE_URL, ...variables })).toThrow(/RELAY_DEV_ROLE/);
  });

  it("refuses a RELAY_DEV_ACTOR other than 1, so a mistyped value fails at startup", () => {
    expect(() => parseEnv({ DATABASE_URL, RELAY_DEV_ACTOR: "true" })).toThrow(/RELAY_DEV_ACTOR/);
  });
});

it.each(["-1", "1.5", "33", "not-a-count"])("refuses invalid proxy count %s", (count) => {
  expect(() => parseEnv({ DATABASE_URL, RELAY_TRUSTED_PROXY_COUNT: count })).toThrow(
    /RELAY_TRUSTED_PROXY_COUNT/,
  );
});
it("reads an explicit trusted proxy count", () => {
  expect(parseEnv({ DATABASE_URL, RELAY_TRUSTED_PROXY_COUNT: "2" }).trustedProxyCount).toBe(2);
});

it.each(["0", "20", "1.5", "1000001"])("refuses invalid auth circuit breaker %s", (limit) => {
  expect(() => parseEnv({ DATABASE_URL, RELAY_AUTH_GLOBAL_LIMIT: limit })).toThrow(
    /RELAY_AUTH_GLOBAL_LIMIT/,
  );
});

it.each(["a".repeat(32), "ab".repeat(32), "0123456789".repeat(4)])(
  "refuses an obviously weak auth secret",
  (secret) => {
    expect(() =>
      parseEnv({
        DATABASE_URL,
        AUTH_SECRET: secret,
        AUTH_URL: "http://localhost:3000",
        NODE_ENV: "development",
      }),
    ).toThrow(/AUTH_SECRET/);
  },
);

it("refuses the actual example file's secret", () => {
  const example = readFileSync(new URL("../../../.env.example", import.meta.url), "utf8");
  const secret = /^AUTH_SECRET=(.+)$/m.exec(example)?.[1]?.trim();
  if (!secret) throw new Error("The example file has no placeholder secret");
  expect(() => parseEnv({ DATABASE_URL, AUTH_SECRET: secret })).toThrow(/AUTH_SECRET/);
});

it("accepts a sufficiently varied fake test secret", () => {
  const env = parseEnv({
    DATABASE_URL,
    AUTH_SECRET: "fake-test-secret-with-varied-characters-12345",
    AUTH_URL: "http://localhost:3000",
    NODE_ENV: "development",
  });
  expect(env.auth).not.toBeNull();
});

it("keeps payments off until enabled and checks the reconciliation timing defaults", () => {
  expect(parseEnv({ DATABASE_URL }).payments).toBeNull();
  expect(() => parseEnv({ DATABASE_URL, RELAY_SANDBOX: "1" })).toThrow(EnvError);
  const values = {
    DATABASE_URL,
    RELAY_SANDBOX: "1",
    RELAY_DEMO: "1",
    RELAY_SANDBOX_URL: "http://127.0.0.1:3000",
    RELAY_PAYMENT_WEBHOOK_SECRET: "fake-sandbox-signature-secret-for-tests",
    RELAY_RECONCILE_SECRET: "fake-reconciler-authentication-secret-for-tests",
  };
  expect(parseEnv(values).payments).toMatchObject({
    firstCheckMs: 900000,
    intervalMs: 300000,
    checkoutTtlMs: 86400000,
    lateMs: 30000,
  });
  expect(
    parseEnv({
      ...values,
      RELAY_RECONCILE_FIRST_MS: "0",
      RELAY_RECONCILE_INTERVAL_MS: "1000",
      RELAY_SANDBOX_LATE_MS: "2500",
    }).payments,
  ).toMatchObject({ firstCheckMs: 0, intervalMs: 1000, lateMs: 2500 });
  expect(() => parseEnv({ ...values, RELAY_RECONCILE_INTERVAL_MS: "0" })).toThrow(EnvError);
  expect(() => parseEnv({ ...values, RELAY_SANDBOX_URL: "https://example.com/untrusted" })).toThrow(
    EnvError,
  );
});

it("a production build requires an explicit demo deployment for sandbox payments", () => {
  const values = {
    DATABASE_URL,
    RELAY_SANDBOX: "1",
    RELAY_SANDBOX_URL: "http://127.0.0.1:3000",
    RELAY_PAYMENT_WEBHOOK_SECRET: "fake-sandbox-signature-secret-for-tests",
    RELAY_RECONCILE_SECRET: "fake-reconciler-authentication-secret-for-tests",
  };
  expect(() => parseEnv({ ...values, NODE_ENV: "production" }, false)).toThrow(/RELAY_DEMO/);
  expect(() => parseEnv({ ...values, NODE_ENV: "development" }, false)).toThrow(/RELAY_DEMO/);
  expect(parseEnv({ ...values, RELAY_DEMO: "1" }, false)).toMatchObject({ demo: true });
  expect(parseEnv(values, true)).toMatchObject({ demo: false });
});

it.each(["RELAY_PAYMENT_WEBHOOK_SECRET", "RELAY_RECONCILE_SECRET", "RELAY_OUTBOX_SECRET"])(
  "%s follows the authentication secret strength rule",
  (name) => {
    for (const secret of ["a".repeat(40), "example-only-do-not-use-this-secret", "too-short"]) {
      expect(() => parseEnv({ DATABASE_URL, [name]: secret })).toThrow(EnvError);
    }
  },
);
it.each([
  ["AUTH_SECRET", "RELAY_OUTBOX_SECRET"],
  ["RELAY_PAYMENT_WEBHOOK_SECRET", "RELAY_OUTBOX_SECRET"],
  ["RELAY_RECONCILE_SECRET", "RELAY_OUTBOX_SECRET"],
  ["AUTH_SECRET", "RELAY_PAYMENT_WEBHOOK_SECRET"],
  ["AUTH_SECRET", "RELAY_RECONCILE_SECRET"],
  ["RELAY_PAYMENT_WEBHOOK_SECRET", "RELAY_RECONCILE_SECRET"],
])("refuses equal secrets for %s and %s", (first, second) => {
  expect(() =>
    parseEnv(
      {
        DATABASE_URL,
        NODE_ENV: "development",
        AUTH_URL: "http://127.0.0.1:3000",
        AUTH_SECRET: "fake-authentication-secret-for-tests-only",
        [first]: "fake-shared-authentication-secret-for-tests-only",
        [second]: "fake-shared-authentication-secret-for-tests-only",
      },
      true,
    ),
  ).toThrow(/distinct/);
});

it("development always binds loopback and production honors its configured host", () => {
  expect(
    serverOptions(["node", "serve", "--dev"], { HOST: "0.0.0.0", PORT: "3001" }),
  ).toMatchObject({ host: "127.0.0.1", port: 3001, dev: true });
  expect(serverOptions(["node", "serve"], { HOST: "192.0.2.7", PORT: "3002" })).toMatchObject({
    host: "192.0.2.7",
    port: 3002,
    dev: false,
  });
});

it.each(["60000", "60001"])("refuses receipt send timeout %s at or beyond its lease", (timeout) => {
  expect(() =>
    parseEnv({
      DATABASE_URL,
      RELAY_RECEIPT_LEASE_MS: "60000",
      RELAY_RECEIPT_SEND_TIMEOUT_MS: timeout,
    }),
  ).toThrow("shorter than");
});

it.each(["0", "-1", "1.5", "1001"])("refuses invalid lifetime receipt limit %s", (limit) => {
  expect(() => parseEnv({ DATABASE_URL, RELAY_RECEIPT_LIFETIME_ATTEMPTS: limit })).toThrow(
    "RELAY_RECEIPT_LIFETIME_ATTEMPTS",
  );
});

it("accepts an organisation time zone and refuses an unknown one", () => {
  expect(parseEnv({ DATABASE_URL, RELAY_TIME_ZONE: "Pacific/Auckland" }).timeZone).toBe(
    "Pacific/Auckland",
  );
  expect(() => parseEnv({ DATABASE_URL, RELAY_TIME_ZONE: "not-a-zone" })).toThrow(
    /RELAY_TIME_ZONE/,
  );
});

it("unbundled commands allow the local sandbox but keep the production guard", () => {
  const values = {
    DATABASE_URL,
    RELAY_SANDBOX: "1",
    RELAY_SANDBOX_URL: "http://127.0.0.1:3000",
    RELAY_PAYMENT_WEBHOOK_SECRET: "fake-sandbox-signature-secret-for-tests",
    RELAY_RECONCILE_SECRET: "fake-reconciler-authentication-secret-for-tests",
  };
  expect(parseEnv(values).payments).not.toBeNull();
  expect(parseEnv({ ...values, NODE_ENV: "development" }).payments).not.toBeNull();
  expect(() => parseEnv({ ...values, NODE_ENV: "production" })).toThrow(/RELAY_DEMO/);
  expect(() => parseEnv({ ...values, NODE_ENV: "development" }, false)).toThrow(/RELAY_DEMO/);
});

describe("hosted demo environment", () => {
  const hosted = {
    ...hostedDemoEnv("https://relay.example"),
    NODE_ENV: "production",
    DATABASE_URL: "postgresql://relay_app@localhost/relay",
  };

  it("enables shared sign-in and scheduled jobs with SMTP disabled", () => {
    expect(parseEnv(hosted)).toMatchObject({
      email: { kind: "disabled" },
      hosted: true,
      scheduledSecret: hosted.CRON_SECRET,
      auth: { delivery: { kind: "disabled" } },
    });
  });

  it.each([
    "AUTH_SECRET",
    "RELAY_PAYMENT_WEBHOOK_SECRET",
    "RELAY_RECONCILE_SECRET",
    "RELAY_OUTBOX_SECRET",
  ] as const)("rejects a schedule secret shared with %s", (variable) => {
    expect(() => parseEnv({ ...hosted, CRON_SECRET: hosted[variable] })).toThrow(/distinct/);
  });

  it("fails closed without a scheduled secret or with an owner connection", () => {
    expect(() => parseEnv({ ...hosted, CRON_SECRET: undefined })).toThrow(/CRON_SECRET/);
    expect(() => parseEnv({ ...hosted, CRON_SECRET: "short" })).toThrow(/CRON_SECRET/);
    expect(() => parseEnv({ ...hosted, MIGRATION_DATABASE_URL: DATABASE_URL })).toThrow(
      /maintenance environment/,
    );
    expect(() => parseEnv({ ...hosted, DATABASE_URL })).toThrow(/must use relay_app/);
  });

  it.each(["preview", "development", undefined])(
    "refuses the no-email demo on Vercel with deployment environment %s",
    (target) => {
      expect(() => parseEnv({ ...hosted, VERCEL: "1", VERCEL_ENV: target })).toThrow(
        /requires a Production deployment/,
      );
    },
  );

  it("accepts the no-email demo on Vercel Production", () => {
    expect(parseEnv({ ...hosted, VERCEL: "1", VERCEL_ENV: "production" }).hosted).toBe(true);
  });

  it("accepts ordinary SMTP on Vercel and ignores an unrelated CRON_SECRET", () => {
    const env = parseEnv({
      DATABASE_URL,
      VERCEL: "1",
      VERCEL_ENV: "preview",
      NODE_ENV: "production",
      AUTH_URL: hosted.AUTH_URL,
      AUTH_SECRET: hosted.AUTH_SECRET,
      SMTP_URL: "smtp://localhost",
      SMTP_FROM: "relay@example.com",
      CRON_SECRET: "unrelated",
    });
    expect(env).toMatchObject({
      hosted: false,
      scheduledSecret: null,
      auth: { delivery: { kind: "smtp" } },
    });
  });

  it.each([undefined, "0"])(
    "requires a positive proxy count without a socket peer, given %s",
    (count) => {
      expect(() => parseEnv({ ...hosted, RELAY_TRUSTED_PROXY_COUNT: count })).toThrow(
        /Set RELAY_TRUSTED_PROXY_COUNT to the number of trusted proxy hops/,
      );
    },
  );

  it("allows an explicit zero only with the socket peer available", () => {
    vi.stubGlobal("relayCapturesSocketPeer", true);
    try {
      expect(parseEnv({ ...hosted, RELAY_TRUSTED_PROXY_COUNT: "0" }).trustedProxyCount).toBe(0);
      expect(() => parseEnv({ ...hosted, RELAY_TRUSTED_PROXY_COUNT: undefined })).toThrow(
        /Set RELAY_TRUSTED_PROXY_COUNT/,
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each([
    [
      "a query user overrides the URI user",
      "postgresql://relay_app@localhost/relay?user=relay_owner",
    ],
    [
      "startup options are refused",
      "postgresql://relay_app@localhost/relay?options=-c%20role%3Drelay_owner",
    ],
    ["no user", "postgresql://localhost/relay"],
  ])("refuses a runtime connection when %s", (_case, url) => {
    vi.stubEnv("PGUSER", "relay_owner");
    try {
      expect(() => parseEnv({ ...hosted, DATABASE_URL: url })).toThrow(/relay_app|startup options/);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.each([
    "postgresql://relay%5Fapp@localhost/relay",
    "postgresql://relay_owner@localhost/relay?user=relay_app",
    "postgresql://relay_app@localhost/relay?user=",
  ])("accepts a connection whose driver user is relay_app (%s)", (url) => {
    expect(parseEnv({ ...hosted, DATABASE_URL: url }).scheduledSecret).toBe(hosted.CRON_SECRET);
  });

  it("allows disabled email only in a demo without any SMTP settings", () => {
    const demo = hosted;
    expect(() => parseEnv({ ...demo, RELAY_DEMO: undefined })).toThrow(/RELAY_DEMO=1/);
    expect(() => parseEnv({ ...demo, SMTP_URL: "smtp://localhost" })).toThrow(/cannot use SMTP/);
    expect(() => parseEnv({ ...demo, SMTP_FROM: "relay@example.com" })).toThrow(/cannot use SMTP/);
    expect(() => parseEnv({ ...demo, RELAY_EMAIL_MODE: "off" })).toThrow(/RELAY_EMAIL_MODE/);
  });
});
