-- ============================================================
-- 0093 Finance control: AR/AP aging buckets, duplicate AP,
-- bank statement vs cashbook matching (not a tick-box).
-- Does not replace the GL, journals, or posting engine.
-- ============================================================

-- ---------- Aging: CURRENT / 1-30 / 31-60 / 61-90 / 91-120 / 120+ ----------
CREATE OR REPLACE VIEW v_ar_aging AS
SELECT ci.id, ci.company_id, ci.tenant_id, ci.invoice_no, ci.customer_id, c.name AS customer_name,
       ci.invoice_date, ci.due_date, ci.total, ci.amount_paid, (ci.total - ci.amount_paid) AS balance,
       CASE
         WHEN ci.status = 'VOID' THEN 'VOID'
         WHEN ci.total - ci.amount_paid <= 0 THEN 'PAID'
         WHEN CURRENT_DATE <= COALESCE(ci.due_date, ci.invoice_date) THEN 'CURRENT'
         WHEN CURRENT_DATE - COALESCE(ci.due_date, ci.invoice_date) BETWEEN 1 AND 30 THEN 'AGING_1_30'
         WHEN CURRENT_DATE - COALESCE(ci.due_date, ci.invoice_date) BETWEEN 31 AND 60 THEN 'AGING_31_60'
         WHEN CURRENT_DATE - COALESCE(ci.due_date, ci.invoice_date) BETWEEN 61 AND 90 THEN 'AGING_61_90'
         WHEN CURRENT_DATE - COALESCE(ci.due_date, ci.invoice_date) BETWEEN 91 AND 120 THEN 'AGING_91_120'
         ELSE 'AGING_120_PLUS'
       END AS bucket,
       GREATEST((CURRENT_DATE - COALESCE(ci.due_date, ci.invoice_date)), 0)::int AS days_overdue,
       (ci.status <> 'VOID' AND (ci.total - ci.amount_paid) > 0
        AND CURRENT_DATE > COALESCE(ci.due_date, ci.invoice_date)) AS is_overdue
FROM customer_invoices ci
JOIN customers c ON c.id = ci.customer_id
WHERE ci.status <> 'VOID';

CREATE OR REPLACE VIEW v_ap_aging AS
SELECT si.id, si.company_id, si.tenant_id, si.supplier_invoice_no, si.supplier_id, s.name AS supplier_name,
       si.invoice_date, si.due_date, si.total, si.amount_paid, (si.total - si.amount_paid) AS balance,
       CASE
         WHEN si.status = 'VOID' THEN 'VOID'
         WHEN si.total - si.amount_paid <= 0 THEN 'PAID'
         WHEN CURRENT_DATE <= COALESCE(si.due_date, si.invoice_date) THEN 'CURRENT'
         WHEN CURRENT_DATE - COALESCE(si.due_date, si.invoice_date) BETWEEN 1 AND 30 THEN 'AGING_1_30'
         WHEN CURRENT_DATE - COALESCE(si.due_date, si.invoice_date) BETWEEN 31 AND 60 THEN 'AGING_31_60'
         WHEN CURRENT_DATE - COALESCE(si.due_date, si.invoice_date) BETWEEN 61 AND 90 THEN 'AGING_61_90'
         WHEN CURRENT_DATE - COALESCE(si.due_date, si.invoice_date) BETWEEN 91 AND 120 THEN 'AGING_91_120'
         ELSE 'AGING_120_PLUS'
       END AS bucket,
       GREATEST((CURRENT_DATE - COALESCE(si.due_date, si.invoice_date)), 0)::int AS days_overdue,
       (si.status <> 'VOID' AND (si.total - si.amount_paid) > 0
        AND CURRENT_DATE > COALESCE(si.due_date, si.invoice_date)) AS is_overdue
FROM supplier_invoices si
JOIN suppliers s ON s.id = si.supplier_id
WHERE si.status <> 'VOID';

-- ---------- Duplicate AP: the supplier's own invoice number ----------
ALTER TABLE supplier_invoices
  ADD COLUMN IF NOT EXISTS supplier_document_no TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_supplier_invoices_document_no
  ON supplier_invoices (company_id, supplier_id, lower(btrim(supplier_document_no)))
  WHERE supplier_document_no IS NOT NULL
    AND btrim(supplier_document_no) <> ''
    AND status <> 'VOID';

CREATE INDEX IF NOT EXISTS idx_supplier_payments_dup
  ON supplier_payments (company_id, supplier_id, payment_date, amount)
  WHERE status <> 'VOID';

-- ---------- Bank reconciliation: statement vs cashbook ----------
CREATE TABLE IF NOT EXISTS bank_reconciliations (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  bank_account_id BIGINT NOT NULL REFERENCES bank_accounts(id),
  recon_no TEXT NOT NULL,
  statement_date DATE NOT NULL DEFAULT CURRENT_DATE,
  statement_balance NUMERIC(18,2),
  book_balance NUMERIC(18,2),
  status TEXT NOT NULL DEFAULT 'OPEN'
    CHECK (status IN ('OPEN','SUBMITTED','APPROVED','VOID')),
  notes TEXT,
  created_by BIGINT REFERENCES users(id),
  submitted_by BIGINT REFERENCES users(id),
  submitted_at TIMESTAMPTZ,
  approved_by BIGINT REFERENCES users(id),
  approved_at TIMESTAMPTZ,
  UNIQUE (company_id, recon_no),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_bank_recon_open
  ON bank_reconciliations (bank_account_id)
  WHERE status IN ('OPEN','SUBMITTED');

CREATE TABLE IF NOT EXISTS bank_reconciliation_matches (
  id BIGSERIAL PRIMARY KEY,
  reconciliation_id BIGINT NOT NULL REFERENCES bank_reconciliations(id) ON DELETE CASCADE,
  bank_transaction_id BIGINT NOT NULL REFERENCES bank_transactions(id),
  journal_line_id BIGINT REFERENCES journal_lines(id),
  match_method TEXT NOT NULL DEFAULT 'MANUAL'
    CHECK (match_method IN ('EXACT','REFERENCE','DATE','MANUAL')),
  amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (reconciliation_id, bank_transaction_id)
);

CREATE INDEX IF NOT EXISTS idx_bank_recon_matches_line
  ON bank_reconciliation_matches(journal_line_id);

ALTER TABLE bank_reconciliations ENABLE ROW LEVEL SECURITY;
ALTER TABLE bank_reconciliation_matches ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON bank_reconciliations;
CREATE POLICY tenant_isolation ON bank_reconciliations USING (tenant_id = app_tenant_id());
DROP POLICY IF EXISTS tenant_isolation ON bank_reconciliation_matches;
CREATE POLICY tenant_isolation ON bank_reconciliation_matches
  USING (reconciliation_id IN (SELECT id FROM bank_reconciliations));
