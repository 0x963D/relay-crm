\set ON_ERROR_STOP on
BEGIN;
SET LOCAL search_path = pg_catalog, public;
SELECT 'CREATE ROLE relay_owner' WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='relay_owner') \gexec
SELECT 'CREATE ROLE relay_app' WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='relay_app') \gexec
SELECT format('ALTER ROLE relay_owner LOGIN CREATEDB NOCREATEROLE NOINHERIT PASSWORD %L', :'owner_password') \gexec
SELECT format('ALTER ROLE relay_app LOGIN NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD %L', :'app_password') \gexec
SELECT format('ALTER ROLE %I NOSUPERUSER', rolname) FROM pg_roles WHERE rolname IN ('relay_owner','relay_app') AND rolsuper \gexec
SELECT format('ALTER ROLE %I NOREPLICATION', rolname) FROM pg_roles WHERE rolname IN ('relay_owner','relay_app') AND rolreplication \gexec
SELECT format('ALTER ROLE %I NOBYPASSRLS', rolname) FROM pg_roles WHERE rolname IN ('relay_owner','relay_app') AND rolbypassrls \gexec
SELECT 'GRANT relay_owner TO CURRENT_USER WITH INHERIT TRUE, SET TRUE' WHERE NOT (SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AND current_user <> 'relay_owner' \gexec
SELECT format('REVOKE %I FROM relay_app', r.rolname) FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.roleid WHERE m.member='relay_app'::regrole \gexec
-- The new owner needs CREATE on public before it can receive its objects.
ALTER SCHEMA public OWNER TO relay_owner;
DO $$
DECLARE item record;
BEGIN
  FOR item IN SELECT tablename FROM pg_tables WHERE schemaname='public' LOOP
    EXECUTE format('ALTER TABLE public.%I OWNER TO relay_owner', item.tablename);
  END LOOP;
  FOR item IN SELECT sequencename FROM pg_sequences WHERE schemaname='public' LOOP
    EXECUTE format('ALTER SEQUENCE public.%I OWNER TO relay_owner', item.sequencename);
  END LOOP;
  FOR item IN SELECT oid::regprocedure AS signature FROM pg_proc WHERE pronamespace='public'::regnamespace LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO relay_owner', item.signature);
  END LOOP;
  FOR item IN SELECT typname FROM pg_type WHERE typnamespace='public'::regnamespace AND typtype IN ('e','d') LOOP
    EXECUTE format('ALTER TYPE public.%I OWNER TO relay_owner', item.typname);
  END LOOP;
END $$;
SELECT format('ALTER DATABASE %I OWNER TO relay_owner', current_database()) \gexec
SELECT format('ALTER DATABASE %I OWNER TO relay_owner', datname) FROM pg_database WHERE datname=current_database() || '_template' AND datdba=current_user::regrole \gexec
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_roles
    WHERE rolname IN ('relay_owner','relay_app')
      AND (rolsuper OR rolcreaterole OR rolinherit OR rolreplication OR rolbypassrls
           OR rolcreatedb <> (rolname='relay_owner') OR NOT rolcanlogin)
  ) THEN
    RAISE EXCEPTION 'Relay roles have unexpected role attributes';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_auth_members WHERE member IN ('relay_owner'::regrole,'relay_app'::regrole)
  ) THEN
    RAISE EXCEPTION 'Relay roles must not be members of other roles';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_shdepend
    WHERE refclassid='pg_authid'::regclass AND refobjid='relay_app'::regrole AND deptype='o'
  ) THEN
    RAISE EXCEPTION 'relay_app must not own database objects';
  END IF;
  IF has_database_privilege('relay_app',current_database(),'CREATE')
     OR has_schema_privilege('relay_app','public','CREATE') THEN
    RAISE EXCEPTION 'relay_app must not have CREATE on the demo database or public schema';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_database WHERE datname=current_database() AND datdba='relay_owner'::regrole
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_namespace WHERE nspname='public' AND nspowner='relay_owner'::regrole
  ) THEN
    RAISE EXCEPTION 'relay_owner must own the database and public schema';
  END IF;
END $$;
COMMIT;
