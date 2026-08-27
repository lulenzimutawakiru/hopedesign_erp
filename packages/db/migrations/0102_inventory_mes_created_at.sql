-- MES: issueMaterialMes orders FIFO by created_at; inventory table lacked the column.
ALTER TABLE inventory ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now();
CREATE INDEX IF NOT EXISTS idx_inventory_fifo ON inventory(product_id, tenant_id, batch_id, created_at);
