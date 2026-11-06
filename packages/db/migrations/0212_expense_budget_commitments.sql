-- 0212 - Reserve expense budgets at submission and release on terminal transitions
CREATE INDEX IF NOT EXISTS idx_budget_commitments_expense_ref
  ON budget_commitments(tenant_id, doc_ref_type, doc_ref_id, status)
  WHERE doc_type = 'EXPENSE';

CREATE OR REPLACE FUNCTION release_expense_budget_commitment()
RETURNS trigger AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status
     AND NEW.status IN ('POSTED','REJECTED','VOID','CANCELLED','DRAFT') THEN
    UPDATE budget_commitments
       SET status = 'RELEASED', released_at = now()
     WHERE company_id = NEW.company_id
       AND tenant_id = NEW.tenant_id
       AND doc_type = 'EXPENSE'
       AND doc_ref_type = 'ops.expenses'
       AND doc_ref_id = NEW.id
       AND status = 'COMMITTED';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_expense_budget_commitment_release ON expense_transactions;
CREATE TRIGGER trg_expense_budget_commitment_release
  AFTER UPDATE OF status ON expense_transactions
  FOR EACH ROW EXECUTE FUNCTION release_expense_budget_commitment();

-- Backfill outstanding submitted/approved expenses that already reference a
-- budget, so the new reservation logic starts from the current exposure.
INSERT INTO budget_commitments
  (company_id, tenant_id, budget_id, account_id, doc_type, doc_ref_type,
   doc_ref_id, doc_ref_code, amount, status, created_by)
SELECT et.company_id, et.tenant_id, et.budget_id,
       COALESCE(et.account_id, ec.account_id, coa.id),
       'EXPENSE', 'ops.expenses', et.id, et.exp_no, et.amount,
       'COMMITTED', et.created_by
  FROM expense_transactions et
  LEFT JOIN expense_categories ec ON ec.id = et.category_id
  LEFT JOIN chart_of_accounts coa
    ON coa.company_id = et.company_id AND coa.tenant_id = et.tenant_id
   AND coa.code = '10254500' AND coa.is_active = true AND coa.is_posting = true
  JOIN budgets b ON b.id = et.budget_id AND b.company_id = et.company_id
   AND b.tenant_id = et.tenant_id AND b.status IN ('APPROVED','ACTIVE')
  WHERE et.budget_id IS NOT NULL
    AND et.status IN ('SUBMITTED','APPROVED')
    AND COALESCE(et.account_id, ec.account_id, coa.id) IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM budget_lines bl
       WHERE bl.budget_id = et.budget_id
         AND bl.account_id = COALESCE(et.account_id, ec.account_id, coa.id)
    )
  ON CONFLICT (tenant_id, doc_type, doc_ref_type, doc_ref_id, account_id) DO NOTHING;
