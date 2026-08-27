-- PR header delivery cost (logistics charge, additive to discount)
ALTER TABLE purchase_requisitions
  ADD COLUMN delivery_cost numeric(18,2) NOT NULL DEFAULT 0;
