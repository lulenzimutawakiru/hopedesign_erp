-- URA EFRIS goods name (per product).
--
-- URA's T109 goodsDetails carries BOTH the goods code (`itemCode` = efris_goods_code)
-- and the goods name (`item`) exactly as registered on the URA portal, and rejects a
-- mismatch with 2123 "Item code and Name are not matching with URA". The ERP product
-- name / invoice line description (e.g. "NATEX A4 Premium Superior White") is the
-- business-facing name and does NOT match URA's registered name (e.g. "Bond 80 Natex
-- Paper"), so the fiscalisation worker must read URA's name from the product rather
-- than from the invoice line description.
--
-- This field stores URA's registered goods name alongside efris_goods_code. When it is
-- NULL the worker falls back to the invoice line description (the historical behaviour).

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS efris_goods_name TEXT;
