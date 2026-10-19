-- URA EFRIS goods registration mapping (per product).
--
-- The T109 goodsDetails must carry the itemCode (URA goodsCode), the unit of
-- measure, and the goods category exactly as the goods is registered on the URA
-- portal. None of those are derivable from the ERP product catalogue (the ERP
-- product `code` is an internal SKU, and the URA unit/category codes are
-- URA-assigned), so they live here as operator-maintained fields on `products`
-- and the fiscalisation worker reads them off the product when it builds the
-- T109 body. `vatApplicableFlag` is NOT stored: it is derived from the line's
-- tax rate (taxable line = '1', otherwise '0') at submit time.

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS efris_goods_code TEXT,
  ADD COLUMN IF NOT EXISTS efris_unit_of_measure TEXT,
  ADD COLUMN IF NOT EXISTS efris_goods_category_id TEXT,
  ADD COLUMN IF NOT EXISTS efris_goods_category_name TEXT;

CREATE INDEX IF NOT EXISTS idx_products_efris_goods_code
  ON products (company_id, efris_goods_code)
  WHERE efris_goods_code IS NOT NULL;
