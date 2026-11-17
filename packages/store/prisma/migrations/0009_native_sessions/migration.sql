ALTER TABLE public.auth_sessions ADD COLUMN is_native boolean NOT NULL DEFAULT false;

DROP FUNCTION public.relay_ready();
CREATE FUNCTION public.relay_ready(required_migration text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
    SELECT EXISTS (
        SELECT 1 FROM public._prisma_migrations
        WHERE migration_name = required_migration AND finished_at IS NOT NULL AND rolled_back_at IS NULL
    ) AND NOT EXISTS (
        SELECT 1 FROM public._prisma_migrations
        WHERE finished_at IS NULL AND rolled_back_at IS NULL
    )
$$;
REVOKE ALL ON FUNCTION public.relay_ready(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.relay_ready(text) TO relay_app;
