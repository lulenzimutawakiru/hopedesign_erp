-- ============================================================
-- 0018 Label varieties
-- Extends label_templates with physical size + printer model so
-- ream/carton QR labels can be printed in multiple selectable
-- sizes (label varieties) on Niimbot printers.
-- ============================================================

-- Allow REAM kind on label templates.
ALTER TABLE label_templates DROP CONSTRAINT label_templates_kind_check;
ALTER TABLE label_templates ADD CONSTRAINT label_templates_kind_check CHECK (kind IN (
  'PRODUCT','BATCH','REAM','CARTON','PALLET','ASSET','MACHINE','BIN','DELIVERY','WORK_ORDER'));

-- Physical label size (mm) + target printer model + default flag.
ALTER TABLE label_templates ADD COLUMN mm_width NUMERIC(6,2);
ALTER TABLE label_templates ADD COLUMN mm_height NUMERIC(6,2);
ALTER TABLE label_templates ADD COLUMN printer_model TEXT;
ALTER TABLE label_templates ADD COLUMN is_default BOOLEAN NOT NULL DEFAULT false;

-- One default variety per tenant + kind.
CREATE UNIQUE INDEX uq_label_templates_default
  ON label_templates (tenant_id, kind) WHERE is_default;

-- The legacy ream seed was created before REAM was a valid kind; fix it.
UPDATE label_templates SET kind = 'REAM'
  WHERE code = 'LT-FG-REAM' AND kind = 'PRODUCT' AND company_id = 2;

-- Seed stock label varieties for the Hope Design tenant (company/tenant 2).
-- Idempotent: clear existing defaults for these kinds first, then upsert.
UPDATE label_templates SET is_default = false
  WHERE tenant_id = 2 AND kind IN ('REAM','CARTON');

INSERT INTO label_templates
  (company_id, tenant_id, code, name, kind, content, is_active, mm_width, mm_height, printer_model, is_default)
VALUES
  (2, 2, 'LT-REAM-40x25',   'Ream label 40x25mm',  'REAM',   '{"format":"QR","label_type":1}'::jsonb, true, 40, 25, 'b1pro', true),
  (2, 2, 'LT-REAM-30x20',   'Ream label 30x20mm',  'REAM',   '{"format":"QR","label_type":1}'::jsonb, true, 30, 20, 'b1',    false),
  (2, 2, 'LT-REAM-50x30',   'Ream label 50x30mm',  'REAM',   '{"format":"QR","label_type":1}'::jsonb, true, 50, 30, 'b1pro', false),
  (2, 2, 'LT-CARTON-60x40', 'Carton label 60x40mm','CARTON', '{"format":"QR","label_type":1}'::jsonb, true, 60, 40, 'b1pro', true),
  (2, 2, 'LT-CARTON-80x50', 'Carton label 80x50mm','CARTON', '{"format":"QR","label_type":1}'::jsonb, true, 80, 50, 'b1pro', false)
ON CONFLICT (company_id, code) DO UPDATE SET
  kind         = EXCLUDED.kind,
  name         = EXCLUDED.name,
  content      = EXCLUDED.content,
  is_active    = EXCLUDED.is_active,
  mm_width     = EXCLUDED.mm_width,
  mm_height    = EXCLUDED.mm_height,
  printer_model = EXCLUDED.printer_model,
  is_default   = EXCLUDED.is_default;
