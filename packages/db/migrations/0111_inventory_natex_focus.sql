-- ============================================================================
-- Inventory focus: NATEX A4 is the factory's ONLY manufactured finished good.
-- Raw materials (jumbo rolls, bobbins), packaging (cartons, labels) and
-- consumables remain separate inventory types and are NOT finished goods.
-- Idempotent: safe on a fresh DB (no products yet) and on an existing DB.
-- ============================================================================

-- 1) Promote the canonical A4 ream to the NATEX A4 finished good.
UPDATE products
SET code = 'NATEX-A4',
    name = 'NATEX A4 Premium Superior White',
    sku = 'FG-NATEX-A4',
    description = 'NATEX A4 80gsm premium superior white - 500 sheets per ream - SCA4-1100 production line',
    attributes = attributes || '{"brand":"NATEX","product_type":"REAM","line":"SCA4-1100"}'::jsonb,
    updated_at = now()
WHERE code = 'A4-80'
  AND status <> 'INACTIVE';

-- 2) Retire every other manufactured finished good (A3, security paper,
--    ad-hoc test products). They stay in history but are no longer produced,
--    sold or planned. Raw/packaging/consumable items are untouched.
UPDATE products
SET status = 'DISCONTINUED',
    updated_at = now()
WHERE status IN ('ACTIVE', 'INACTIVE')
  AND type IN ('REAM', 'FINISHED_GOODS', 'SHEET', 'SECURITY_ITEM')
  AND code <> 'NATEX-A4';

-- 3) Flag the NATEX A4 finished good as the sole active manufacturing product
--    for factory planning screens.
UPDATE products
SET attributes = attributes || '{"only_manufactured_fg":true}'::jsonb,
    updated_at = now()
WHERE code = 'NATEX-A4';
