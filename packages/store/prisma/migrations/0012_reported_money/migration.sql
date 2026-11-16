ALTER TABLE payments ADD CONSTRAINT payments_reported_money CHECK (
  (reported_amount IS NULL OR reported_amount > 0) AND
  (reported_currency IS NULL OR reported_currency IN ('AED','EUR','GBP','JPY','KWD','USD'))
);
