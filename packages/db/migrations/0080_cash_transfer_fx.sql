-- Exchange-rate support for internal cash transfers (e.g. UGX -> USD at 3,800 UGX/USD).
-- amount stays in the source currency; to_amount is the converted target amount;
-- exchange_rate follows the system convention of base (UGX) units per 1 foreign unit.
ALTER TABLE cash_transfers
  ADD COLUMN exchange_rate NUMERIC(18,6) NOT NULL DEFAULT 1,
  ADD COLUMN to_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  ADD COLUMN from_currency TEXT,
  ADD COLUMN to_currency TEXT;

UPDATE cash_transfers ct
SET from_currency = fb.currency,
    to_currency = tb.currency,
    to_amount = ct.amount,
    exchange_rate = 1
FROM bank_accounts fb, bank_accounts tb
WHERE fb.id = ct.from_bank_id AND tb.id = ct.to_bank_id;

ALTER TABLE cash_transfers
  ALTER COLUMN from_currency SET NOT NULL,
  ALTER COLUMN to_currency SET NOT NULL;