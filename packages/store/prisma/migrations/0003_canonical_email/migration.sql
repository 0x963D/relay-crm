-- One canonical address per lead, for identity and for delivery. The old pair of a lowercased key
-- and the address as typed could name two different mailboxes.

-- The twin of the address parseEmail produces: an ASCII dot-atom local part, then lowercase
-- letter-digit-hyphen labels, the last with a letter. ASCII only, so PostgreSQL reads it exactly as
-- JavaScript does under any collation. It comes first, so a row that does not fit stops the
-- migration before anything is dropped.
ALTER TABLE leads ADD CONSTRAINT leads_email_canonical CHECK (
  length(email_key) <= 254 AND
  length(split_part(email_key, '@', 1)) <= 64 AND
  length(split_part(email_key, '@', 2)) <= 253 AND
  email_key ~ ('^[a-z0-9_!#$%&''*+/=?^`{|}~-]+(\.[a-z0-9_!#$%&''*+/=?^`{|}~-]+)*'
    || '@([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+(?=[a-z0-9-]*[a-z])[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$')
);

ALTER TABLE leads DROP CONSTRAINT leads_email_key_normalized;
ALTER TABLE leads DROP COLUMN email;
ALTER TABLE leads RENAME COLUMN email_key TO email;
ALTER INDEX leads_email_key_key RENAME TO leads_email_key;
