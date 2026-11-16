CREATE OR REPLACE FUNCTION bump_lead_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.version = OLD.version;
  IF NEW IS DISTINCT FROM OLD THEN
    NEW.version = OLD.version + 1;
  END IF;
  RETURN NEW;
END
$$;
