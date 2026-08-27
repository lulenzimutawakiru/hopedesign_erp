-- PR header tax identity + user default tax code
ALTER TABLE purchase_requisitions
  ADD COLUMN tax_code text,
  ADD COLUMN tax_rate numeric(7,4) NOT NULL DEFAULT 0,
  ADD COLUMN tax_included boolean NOT NULL DEFAULT false;

ALTER TABLE users
  ADD COLUMN default_tax_code text;

-- Allow exempt treatment codes in the finance tax master
ALTER TABLE taxes DROP CONSTRAINT taxes_tax_type_check;
ALTER TABLE taxes ADD CONSTRAINT taxes_tax_type_check CHECK (tax_type = ANY (ARRAY['VAT'::text, 'WHT'::text, 'EXCISE'::text, 'WITHHOLDING_VAT'::text, 'EXEMPT'::text]));
