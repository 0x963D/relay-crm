ALTER TABLE sandbox_checkouts ADD COLUMN expires_at timestamptz(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP + interval '24 hours');
ALTER TABLE payment_events DROP CONSTRAINT payment_events_kind_check;
ALTER TABLE payment_events ADD CONSTRAINT payment_events_kind_check CHECK (kind IN ('checkoutCreated','webhookDelivery','reconcilerCheck','settlement','reviewClosed','checkoutClosed','manualRecorded','approved','rejected','cancelled','edited','receiptRequeued'));
