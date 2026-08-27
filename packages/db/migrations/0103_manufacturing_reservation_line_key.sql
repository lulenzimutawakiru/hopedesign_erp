-- reserveMaterials() generates one reservation_no per production order and
-- inserts one row per material line. The original UNIQUE (company_id, reservation_no)
-- made any multi-material reservation fail. Key the document by its line.
ALTER TABLE production_material_reservations
  DROP CONSTRAINT production_material_reservations_company_id_reservation_no_key;

CREATE UNIQUE INDEX production_material_reservations_company_id_reservation_no_line_key
  ON production_material_reservations (company_id, reservation_no, work_order_id, product_id);