-- 0237 - Work centres: routing-operation alternatives (Odoo Manufacturing parity)
--
-- The `work_centres` and `routing_operations` tables have existed since 0002 with
-- the core Odoo fields (cost per hour, capacity, efficiency target, setup/run/
-- teardown times). Odoo's one remaining routing-operation concept — a list of
-- alternative work centres that can also perform an operation — is added here as
-- a JSONB array of work-centre ids on `routing_operations`, so the new routing
-- operations editor can record fallbacks without a second normalised table.
--
-- Additive and idempotent. migrate.js owns transaction + schema_migrations.

ALTER TABLE routing_operations
  ADD COLUMN IF NOT EXISTS alternative_work_centres JSONB NOT NULL DEFAULT '[]'::jsonb;
