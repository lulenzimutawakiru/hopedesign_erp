-- PR header + line discount identity
ALTER TABLE purchase_requisitions
  ADD COLUMN discount_rate numeric(7,4) NOT NULL DEFAULT 0,
  ADD COLUMN discount_amount numeric(18,2) NOT NULL DEFAULT 0;

ALTER TABLE purchase_requisition_items
  ADD COLUMN discount_percent numeric(6,3) NOT NULL DEFAULT 0,
  ADD COLUMN discount_amount numeric(18,2) NOT NULL DEFAULT 0;
