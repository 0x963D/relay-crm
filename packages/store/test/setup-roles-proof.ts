import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import pg from "pg";

const execute = promisify(execFile);
const name = `relay-bootstrap-${randomUUID()}`;
const password = () => randomBytes(24).toString("hex");
const adminPassword = password();
const ownerPassword = password();
const appPassword = password();
const bootstrap = await readFile(new URL("../scripts/setup-roles.sql", import.meta.url), "utf8");
const prisma = createRequire(import.meta.url).resolve("prisma/build/index.js");
const store = fileURLToPath(new URL("..", import.meta.url));

async function docker(...args: string[]) {
  return (await execute("docker", args)).stdout.trim();
}

function script(user: string, database: string, sql: string, variables: string[] = []) {
  const result = spawnSync(
    "docker",
    [
      "exec",
      "-i",
      name,
      "psql",
      "-X",
      "-v",
      "ON_ERROR_STOP=1",
      "-U",
      user,
      "-d",
      database,
      ...variables,
    ],
    { input: sql, encoding: "utf8" },
  );
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr.trim());
}

await docker(
  "run",
  "--detach",
  "--rm",
  "--name",
  name,
  "--env",
  "POSTGRES_HOST_AUTH_METHOD=scram-sha-256",
  "--env",
  `POSTGRES_PASSWORD=${password()}`,
  "--publish",
  "127.0.0.1::5432",
  "postgres:17",
);
try {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await docker("exec", name, "pg_isready", "-h", "127.0.0.1", "-U", "postgres");
      break;
    } catch (error) {
      if (attempt >= 60) throw error;
      await sleep(500);
    }
  }
  const port = (await docker("port", name, "5432/tcp")).split(":").at(-1);
  assert(port, "Expected a loopback port for the disposable PostgreSQL server.");
  const url = (user: string, secret: string) =>
    `postgresql://${user}:${secret}@127.0.0.1:${port}/relay`;
  const connect = async <T>(
    user: string,
    secret: string,
    run: (client: pg.Client) => Promise<T>,
  ) => {
    const client = new pg.Client({ connectionString: url(user, secret) });
    await client.connect();
    try {
      return await run(client);
    } finally {
      await client.end();
    }
  };
  script(
    "postgres",
    "postgres",
    `
    CREATE ROLE bootstrap_admin LOGIN CREATEROLE CREATEDB PASSWORD ${pg.escapeLiteral(adminPassword)};
  `,
  );
  script("bootstrap_admin", "postgres", "CREATE DATABASE relay;");
  await connect("bootstrap_admin", adminPassword, async (client) => {
    const version = await client.query<{ server_version_num: string }>("SHOW server_version_num");
    const versionNumber = version.rows[0]?.server_version_num ?? "";
    assert.match(versionNumber, /^17\d{4}$/);
    const attributes = await client.query(
      "SELECT rolsuper, rolcreaterole, rolcreatedb, rolbypassrls FROM pg_roles WHERE rolname=current_user",
    );
    assert.deepEqual(attributes.rows, [
      { rolsuper: false, rolcreaterole: true, rolcreatedb: true, rolbypassrls: false },
    ]);
    await client.query(
      "CREATE TABLE public.bootstrap_existing (id integer GENERATED ALWAYS AS IDENTITY)",
    );
    process.stdout.write(
      `PostgreSQL ${versionNumber}: bootstrap_admin is a non-superuser with CREATEROLE and CREATEDB.\n`,
    );
  });
  const setup = () => {
    script("bootstrap_admin", "relay", bootstrap, [
      "-v",
      `owner_password=${ownerPassword}`,
      "-v",
      `app_password=${appPassword}`,
    ]);
  };
  setup();
  process.stdout.write("Role bootstrap and ownership transfer succeeded as bootstrap_admin.\n");
  await connect("relay_owner", ownerPassword, async (client) => {
    const table = await client.query(
      "SELECT tableowner FROM pg_tables WHERE tablename='bootstrap_existing' AND schemaname='public'",
    );
    assert.deepEqual(table.rows, [{ tableowner: "relay_owner" }]);
    await client.query("DROP TABLE public.bootstrap_existing");
  });
  const migration = await execute(process.execPath, [prisma, "migrate", "deploy"], {
    cwd: store,
    env: { MIGRATION_DATABASE_URL: url("relay_owner", ownerPassword) },
  });
  process.stdout.write(migration.stdout);

  await connect("relay_owner", ownerPassword, async (client) => {
    const owners = await client.query(`
      SELECT datdba::regrole::text AS database_owner,
             (SELECT nspowner::regrole::text FROM pg_namespace WHERE nspname='public') AS schema_owner,
             ARRAY(SELECT DISTINCT relowner::regrole::text FROM pg_class WHERE relnamespace='public'::regnamespace) AS relation_owners,
             ARRAY(SELECT DISTINCT proowner::regrole::text FROM pg_proc WHERE pronamespace='public'::regnamespace) AS routine_owners,
             ARRAY(SELECT DISTINCT typowner::regrole::text FROM pg_type WHERE typnamespace='public'::regnamespace) AS type_owners
      FROM pg_database WHERE datname=current_database()
    `);
    assert.deepEqual(owners.rows, [
      {
        database_owner: "relay_owner",
        schema_owner: "relay_owner",
        relation_owners: ["relay_owner"],
        routine_owners: ["relay_owner"],
        type_owners: ["relay_owner"],
      },
    ]);
    await client.query("INSERT INTO job_leases VALUES ('demo', gen_random_uuid(), now())");
    process.stdout.write("relay_owner owns the database, schema and migrated objects.\n");
  });

  setup();
  process.stdout.write("Role bootstrap can be rerun as bootstrap_admin after the migrations.\n");
  await connect("relay_app", appPassword, async (client) => {
    const roles = await client.query(`
      SELECT rolname, rolcanlogin, rolcreatedb, rolinherit, rolsuper, rolcreaterole, rolreplication, rolbypassrls,
             EXISTS (SELECT 1 FROM pg_auth_members WHERE member=oid) AS membership
      FROM pg_roles WHERE rolname IN ('relay_app', 'relay_owner') ORDER BY rolname
    `);
    const restricted = {
      rolcanlogin: true,
      rolinherit: false,
      rolsuper: false,
      rolcreaterole: false,
      rolreplication: false,
      rolbypassrls: false,
      membership: false,
    };
    assert.deepEqual(roles.rows, [
      { ...restricted, rolname: "relay_app", rolcreatedb: false },
      { ...restricted, rolname: "relay_owner", rolcreatedb: true },
    ]);
    const owned = await client.query(
      "SELECT 1 FROM pg_shdepend WHERE refclassid='pg_authid'::regclass AND refobjid=current_user::regrole AND deptype='o'",
    );
    assert.deepEqual(owned.rows, []);
    for (const sql of [
      "ALTER TABLE job_leases ADD COLUMN unauthorized boolean",
      "SET ROLE relay_owner",
    ]) {
      await assert.rejects(client.query(sql), { code: "42501" });
      process.stdout.write(`relay_app refused ${sql} (42501).\n`);
    }
    assert.deepEqual((await client.query("SELECT route FROM job_leases")).rows, []);
    await client.query("SET row_security = off");
    await assert.rejects(client.query("SELECT route FROM job_leases"), { code: "42501" });
    process.stdout.write(
      "relay_app owns nothing, has no memberships or privileged attributes, and cannot bypass row-level security.\n",
    );
  });
  await connect("relay_owner", ownerPassword, async (client) => {
    await client.query("GRANT CREATE ON SCHEMA public TO relay_app");
    try {
      assert.throws(setup, /relay_app must not have CREATE on the demo database or public schema/);
      process.stdout.write("Bootstrap rejects unexpected CREATE access for relay_app.\n");
    } finally {
      await client.query("REVOKE CREATE ON SCHEMA public FROM relay_app");
    }
  });
} finally {
  await docker("stop", name);
  process.stdout.write("Removed the isolated proof container and its database and roles.\n");
}
