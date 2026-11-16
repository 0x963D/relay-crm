LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS (SELECT lower(email) FROM users GROUP BY lower(email) HAVING count(*)>1) THEN
    RAISE EXCEPTION 'Users have duplicate email addresses ignoring case. Resolve them before migrating.';
  END IF;
END $$;
CREATE UNIQUE INDEX users_email_lower_key ON users(lower(email));
