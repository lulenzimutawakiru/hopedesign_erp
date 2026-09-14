-- ============================================================================
-- 0161 - KCB notification -> customer invoice link
--
-- 0160 created `kcb_payment_notifications` without a column tying a landed
-- notification to the invoice it settles. Matching was therefore recorded as a
-- status change only, so an operator could see that a payment had been matched
-- but not what it was matched against, and an unmatch/re-match round trip lost
-- the link entirely.
--
-- This adds the missing link and the index that answers "which notifications
-- have been matched against this invoice". Both statements are idempotent
-- because 0160 also creates them on a fresh database: on an installation that
-- ran 0160 before this column existed, this migration is what repairs it; on a
-- fresh installation it is a no-op. That keeps the two paths convergent without
-- rewriting history.
--
-- Scope note: this is a link only. Matching never writes money - posting to the
-- ledger stays with kcb_ipn_post_transaction(), and the invoice remains the
-- system of record for what was owed.
-- ============================================================================

ALTER TABLE public.kcb_payment_notifications
  ADD COLUMN IF NOT EXISTS matched_invoice_id BIGINT
  REFERENCES public.customer_invoices(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_kcb_notifications_matched_invoice
  ON public.kcb_payment_notifications (company_id, matched_invoice_id)
  WHERE matched_invoice_id IS NOT NULL;
