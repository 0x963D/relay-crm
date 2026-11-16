\set ON_ERROR_STOP on
SELECT 'CREATE ROLE relay_owner' WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='relay_owner') \gexec
SELECT 'CREATE ROLE relay_app' WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='relay_app') \gexec
SELECT format('ALTER ROLE relay_owner LOGIN NOSUPERUSER CREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS PASSWORD %L', :'owner_password') \gexec
SELECT format('ALTER ROLE relay_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS PASSWORD %L', :'app_password') \gexec
SELECT format('REVOKE %I FROM relay_app', r.rolname) FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.roleid WHERE m.member='relay_app'::regrole \gexec
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
ALTER SCHEMA public OWNER TO relay_owner;
SELECT format('ALTER DATABASE %I OWNER TO relay_owner', datname) FROM pg_database WHERE datname=current_database() || '_template' AND datdba=current_user::regrole \gexec
