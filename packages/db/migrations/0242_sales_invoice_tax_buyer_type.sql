-- 0242 - Sales document tax category + buyer type
--
-- Sales documents (quotation -> order -> invoice) gain an explicit buyer-type
-- classification (B2C / B2B / B2G) and a per-line tax-category code so exempt,
-- zero-rated, standard and other configured rates are distinguishable — the
-- numeric `tax_percent` alone cannot tell an exempt supply (0%) from a
-- zero-rated one (0%). Invoice lines also gain a unit-of-measure reference so
-- the document can render Item / Qty / UoM / Price / Total / Tax / Category.
--
-- `tax_category` holds a `tax_categories.code` (seeded in 0164 as STANDARD /
-- EXEMPT / ZERO / OUT_OF_SCOPE), not a URA code. The URA tax-category and
-- buyer-type codes continue to resolve from `efris_configurations.security_flags`
-- at fiscalisation time, so this migration introduces no hard-coded tax data.
--
-- Additive and idempotent. migrate.js owns transaction + schema_migrations.

ALTER TABLE customer_invoices
  ADD COLUMN IF NOT EXISTS buyer_type TEXT
  CHECK (buyer_type IN ('B2B','B2C','B2G'));

ALTER TABLE invoice_items
  ADD COLUMN IF NOT EXISTS tax_category TEXT;
ALTER TABLE invoice_items
  ADD COLUMN IF NOT EXISTS unit_id BIGINT REFERENCES units(id);

ALTER TABLE sales_orders
  ADD COLUMN IF NOT EXISTS buyer_type TEXT
  CHECK (buyer_type IN ('B2B','B2C','B2G'));
ALTER TABLE sales_order_items
  ADD COLUMN IF NOT EXISTS tax_category TEXT;

ALTER TABLE sales_quotations
  ADD COLUMN IF NOT EXISTS buyer_type TEXT
  CHECK (buyer_type IN ('B2B','B2C','B2G'));
ALTER TABLE sales_quotation_items
  ADD COLUMN IF NOT EXISTS tax_category TEXT;
