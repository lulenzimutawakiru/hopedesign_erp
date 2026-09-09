-- ============================================================================
-- Inventory organisation: separate OFFICE consumables from factory supplies.
--
-- HOPE DESIGN GROUP produces a single finished good (NATEX A4 Premium
-- Superior White). Consumables must be split so factory production supplies
-- (ream labels, machine consumables, spares) and office consumables
-- (stationery, printer paper, cleaning materials) are catalogued separately.
--
-- Adds a child category CONS-OFF (Office Consumables) under CONSUMABLES.
-- Office consumable products are assigned category_id = CONS-OFF; factory
-- consumables stay under the CONSUMABLES parent. Idempotent and scoped to the
-- HDG company only.
-- ============================================================================

INSERT INTO product_categories (company_id, tenant_id, code, name, kind, parent_id, status)
SELECT c.id, c.tenant_id, 'CONS-OFF', 'Office Consumables', 'CONSUMABLE', parent.id, 'ACTIVE'
FROM tenants t
JOIN companies c ON c.tenant_id = t.id AND c.code = 'HDG'
JOIN product_categories parent
  ON parent.company_id = c.id
 AND parent.code = 'CONSUMABLES'
WHERE NOT EXISTS (
  SELECT 1
  FROM product_categories existing
  WHERE existing.company_id = c.id
    AND existing.code = 'CONS-OFF'
);
