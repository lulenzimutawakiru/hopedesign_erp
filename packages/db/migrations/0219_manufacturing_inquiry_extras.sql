-- ============================================================================
-- 0219 - Manufacturing inquiry parity
--
-- Closes the "Product Spec Groups Maintenance" parity gap from the legacy
-- manufacturing module: adds an optional grouping label to production
-- standards so product specifications can be organised into named groups.
-- The remaining parity items (where-used, copy BOM, CoA, unused materials,
-- ready-to-produce, MRP reschedules) are read/compute-only and need no schema.
-- ============================================================================

ALTER TABLE production_standards ADD COLUMN IF NOT EXISTS spec_group TEXT;

CREATE INDEX IF NOT EXISTS idx_production_standards_group
  ON production_standards (tenant_id, spec_group);
