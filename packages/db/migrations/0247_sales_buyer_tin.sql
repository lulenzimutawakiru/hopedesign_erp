-- 0247 - Sales documents carry an optional buyer TIN override
--
-- A B2B / B2G buyer's fiscal TIN is normally the customer's stored TIN, but the
-- taxpayer actually billed can differ (a department, branch or distinct legal
-- entity). This lets a sales document record the buyer TIN used for the EFRIS
-- fiscal document. It is nullable: fiscalisation falls back to the customer's
-- TIN when the document carries no override (see efris/processor.ts).
--
-- Additive and idempotent. migrate.js owns transaction + schema_migrations.

ALTER TABLE sales_quotations
  ADD COLUMN IF NOT EXISTS buyer_tin TEXT;

ALTER TABLE sales_orders
  ADD COLUMN IF NOT EXISTS buyer_tin TEXT;

ALTER TABLE customer_invoices
  ADD COLUMN IF NOT EXISTS buyer_tin TEXT;
