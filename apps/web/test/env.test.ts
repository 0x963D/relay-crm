import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { EnvError, parseEnv, serverOptions } from "../src/server/env.ts";

const DATABASE_URL = "postgresql://relay:relay@localhost:5432/relay";
const META = {
  META_VERIFY_TOKEN: "verify",
  META_APP_SECRET: "secret",
  META_ACCESS_TOKEN: "token",
  META_GRAPH_VERSION: "v24.0",
};

describe("parseEnv", () => {
  it("reads the database URL, with Meta and the dev user off when their variables are unset", () => {
    expect(parseEnv({ DATABASE_URL })).toEqual({
      demo: false,
      outboxSecret: null,
      receipts: { leaseMs: 60000, sendTimeoutMs: 30000 },
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

it.each(["RELAY_PAYMENT_WEBHOOK_SECRET", "RELAY_RECONCILE_SECRET"])(
  "%s follows the authentication secret strength rule",
  (name) => {
    for (const secret of ["a".repeat(40), "example-only-do-not-use-this-secret", "too-short"]) {
      expect(() => parseEnv({ DATABASE_URL, [name]: secret })).toThrow(EnvError);
    }
  },
);
it.each([
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
