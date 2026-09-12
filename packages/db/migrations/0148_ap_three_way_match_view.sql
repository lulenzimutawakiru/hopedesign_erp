-- ---------------------------------------------------------------------------
-- Finance: expose three-way match provenance on the AP aging view
--
-- Accounts Payable needs to answer "can this invoice be paid?" before it
-- reaches the payment run. That answer depends on the PO/GRN/invoice chain,
-- which lives in procurement tables. Rather than have the finance subledger
-- re-implement the match, the aging view simply carries the provenance
-- (po_id / grn_id / po_no / grn_no) plus the recorded match flag, so the AP
-- workspace can show MATCHED / UNMATCHED / NO PO per invoice and drill into
-- the procurement match desk for the line-level detail.
--
-- Columns are appended, so CREATE OR REPLACE VIEW stays compatible with any
-- existing consumer that selects an explicit column list.
-- ---------------------------------------------------------------------------

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
        AND CURRENT_DATE > COALESCE(si.due_date, si.invoice_date)) AS is_overdue,
       -- Three-way match provenance (appended columns)
       si.po_id,
       si.grn_id,
       si.status AS document_status,
       si.three_way_matched,
       si.supplier_document_no,
       po.po_no,
       grn.grn_no
FROM supplier_invoices si
JOIN suppliers s ON s.id = si.supplier_id
LEFT JOIN purchase_orders po ON po.id = si.po_id
LEFT JOIN goods_receipts grn ON grn.id = si.grn_id
WHERE si.status <> 'VOID';