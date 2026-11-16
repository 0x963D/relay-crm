CREATE TABLE public.demo_seed (
    key text PRIMARY KEY CHECK (key = 'tidewell-language-school/v1'),
    company text NOT NULL CHECK (company = 'Tidewell Language School'),
    state text NOT NULL CHECK (state IN ('building', 'ready')),
    seeded_at timestamp(3) with time zone NOT NULL
);
GRANT SELECT ON public.demo_seed TO relay_app;

ALTER TABLE public.job_leases DROP CONSTRAINT job_leases_route_check;
ALTER TABLE public.job_leases ADD CONSTRAINT job_leases_route_check
    CHECK (route IN ('outbox', 'reconcile', 'demo'));

CREATE FUNCTION public.relay_ready() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
    SELECT EXISTS (
        SELECT 1 FROM public._prisma_migrations
        WHERE migration_name = '0008_demo_lifecycle' AND finished_at IS NOT NULL
    ) AND NOT EXISTS (
        SELECT 1 FROM public._prisma_migrations
        WHERE finished_at IS NULL AND rolled_back_at IS NULL
    )
$$;
REVOKE ALL ON FUNCTION public.relay_ready() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.relay_ready() TO relay_app;

ALTER TABLE public.job_leases ENABLE ROW LEVEL SECURITY;
CREATE POLICY app_job_routes ON public.job_leases TO relay_app
    USING (route IN ('outbox', 'reconcile'))
    WITH CHECK (route IN ('outbox', 'reconcile'));
