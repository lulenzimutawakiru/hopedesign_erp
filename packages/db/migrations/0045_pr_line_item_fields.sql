-- ============================================================
-- 0045 PR line item enrichment
-- Specification, category and subcategory are captured as a
-- snapshot at requisition time (prefilled from the product
-- master so the line stays stable even if the catalog changes).
-- ============================================================

ALTER TABLE purchase_requisition_items
  ADD COLUMN IF NOT EXISTS specification TEXT,
  ADD COLUMN IF NOT EXISTS category TEXT,
  ADD COLUMN IF NOT EXISTS subcategory TEXT;

-- Backfill existing lines from the product master.
UPDATE purchase_requisition_items i
SET specification = COALESCE(p.description, i.specification),
    category      = COALESCE(pc.name, i.category),
    subcategory   = COALESCE(pcat.name, i.subcategory)
FROM products p
LEFT JOIN product_categories pc   ON pc.id = p.category_id
LEFT JOIN product_categories pcat ON pcat.id = pc.parent_id
WHERE p.id = i.product_id
  AND (i.specification IS NULL OR i.category IS NULL OR i.subcategory IS NULL);