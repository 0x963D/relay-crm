ALTER TABLE ledger_lines ADD COLUMN side text;
ALTER TABLE ledger_lines DISABLE TRIGGER ledger_lines_append_only;
UPDATE ledger_lines SET side=CASE WHEN amount>0 THEN 'credit' ELSE 'debit' END, amount=abs(amount);
ALTER TABLE ledger_lines ENABLE TRIGGER ledger_lines_append_only;
ALTER TABLE ledger_lines ALTER COLUMN side SET NOT NULL;
ALTER TABLE ledger_lines ADD CONSTRAINT ledger_lines_side_check CHECK (side IN ('debit','credit'));
ALTER TABLE ledger_lines DROP CONSTRAINT ledger_lines_amount_check;
ALTER TABLE ledger_lines ADD CONSTRAINT ledger_lines_amount_check CHECK (amount>0);
CREATE OR REPLACE FUNCTION check_payment_posting() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE payment_uuid uuid; p payments; posting_uuid uuid; line_count bigint; total numeric; valid_lines bigint;
BEGIN
  IF TG_TABLE_NAME = 'payments' THEN payment_uuid := NEW.id;
  ELSIF TG_TABLE_NAME = 'ledger_transactions' THEN payment_uuid := NEW.payment_id;
  ELSE SELECT payment_id INTO payment_uuid FROM ledger_transactions WHERE id = NEW.transaction_id;
  END IF;
  SELECT * INTO STRICT p FROM payments WHERE id = payment_uuid;
  SELECT id INTO posting_uuid FROM ledger_transactions WHERE payment_id = payment_uuid;
  IF (p.status = 'completed') <> (posting_uuid IS NOT NULL) THEN
    RAISE EXCEPTION 'Completed payment must have exactly one posting' USING ERRCODE = '23514', CONSTRAINT = 'payment_posting_required';
  END IF;
  IF posting_uuid IS NULL THEN RETURN NULL; END IF;
  SELECT count(*), coalesce(sum(CASE l.side WHEN 'credit' THEN l.amount::numeric ELSE -l.amount::numeric END),0), count(*) FILTER (WHERE a.currency = p.currency AND
    ((a.kind = 'customer' AND a.account_id = p.account_id AND l.side='credit' AND l.amount = p.amount) OR
     (a.kind = CASE WHEN p.method='manual' THEN 'bankTransfersCash' ELSE 'cardProviderSandbox' END AND l.side='debit' AND l.amount = p.amount)))
  INTO line_count,total,valid_lines FROM ledger_lines l JOIN ledger_accounts a ON a.id = l.ledger_account_id
  WHERE l.transaction_id = posting_uuid;
  IF line_count <> 2 OR total <> 0 OR valid_lines <> 2 THEN
    RAISE EXCEPTION 'Posting must balance and match the payment' USING ERRCODE = '23514', CONSTRAINT = 'ledger_posting_balanced';
  END IF;
  RETURN NULL;
END $$;

