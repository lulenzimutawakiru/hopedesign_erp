-- Link RFQs to their originating purchase requisition so the
-- PR -> RFQ -> quotation -> PO chain stays fully traceable.
ALTER TABLE rfqs ADD COLUMN requisition_id bigint REFERENCES purchase_requisitions(id);
CREATE INDEX idx_rfqs_requisition_id ON rfqs (requisition_id);

-- Backfill: only where a single requisition matches the RFQ's full line set
-- (same product + quantity pairs), so we never guess.
UPDATE rfqs r
SET requisition_id = c.requisition_id
FROM (
  SELECT rfq_id, requisition_id, count(*) OVER (PARTITION BY rfq_id) AS full_matches
  FROM (
    SELECT ri.rfq_id, pri.requisition_id
    FROM rfq_items ri
    JOIN purchase_requisition_items pri
      ON pri.product_id = ri.product_id
     AND pri.quantity = ri.quantity
     AND pri.requisition_id IS NOT NULL
    GROUP BY ri.rfq_id, pri.requisition_id
    HAVING count(*) = (SELECT count(*) FROM rfq_items x WHERE x.rfq_id = ri.rfq_id)
  ) m
) c
WHERE c.full_matches = 1
  AND r.id = c.rfq_id
  AND r.requisition_id IS NULL;
