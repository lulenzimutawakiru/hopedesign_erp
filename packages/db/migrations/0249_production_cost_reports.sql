-- 0249_production_cost_reports.sql
-- Phase 6: production cost accounting report views. Each view exposes company_id
-- and tenant_id so the report engine's company scoping and tenant RLS apply.
-- Registered in apps/api/src/services/reportCore.ts.

-- Per-work-order cost sheet: standard vs actual across the six cost components.
CREATE VIEW v_production_cost_summary AS
SELECT
  wo.id AS work_order_id, wo.wo_no, wo.company_id, wo.tenant_id, wo.product_id,
  p.code AS product_code, p.name AS product_name,
  wo.quantity, wo.produced_qty,
  wo.standard_cost, wo.actual_material_cost, wo.actual_labour_cost,
  wo.actual_machine_cost, wo.actual_overhead_cost, wo.actual_waste_cost,
  wo.actual_other_cost, wo.actual_cost, wo.cost_variance,
  wo.yield_percent, wo.efficiency_percent, wo.status, wo.completed_at
FROM work_orders wo
LEFT JOIN products p ON p.id = wo.product_id;

-- BOM exploded component cost (per line standard cost).
CREATE VIEW v_bom_cost AS
SELECT
  b.id AS bom_id, b.company_id, b.tenant_id,
  b.code AS bom_code, b.name AS bom_name, b.version,
  b.product_id, p.code AS product_code, p.name AS product_name,
  bi.id AS bom_item_id, bi.product_id AS material_id,
  m.code AS material_code, m.name AS material_name,
  bi.quantity, u.code AS unit_code, bi.scrap_percent, bi.is_consumable,
  COALESCE(m.standard_cost, 0) AS unit_standard_cost,
  round(bi.quantity * COALESCE(m.standard_cost, 0), 4) AS line_standard_cost
FROM boms b
JOIN products p ON p.id = b.product_id
LEFT JOIN bom_items bi ON bi.bom_id = b.id
LEFT JOIN products m ON m.id = bi.product_id
LEFT JOIN units u ON u.id = bi.unit_id;

-- Material consumption: issued quantity * unit cost per work order line.
CREATE VIEW v_material_consumption AS
SELECT
  wom.id, wom.work_order_id, wo.wo_no, wo.company_id, wo.tenant_id,
  wom.product_id AS material_id, p.code AS material_code, p.name AS material_name,
  wom.required_qty, wom.issued_qty, wom.returned_qty, wom.unit_cost,
  round(wom.issued_qty * wom.unit_cost, 4) AS issued_cost, wom.is_consumable
FROM work_order_materials wom
JOIN work_orders wo ON wo.id = wom.work_order_id
LEFT JOIN products p ON p.id = wom.product_id;

-- Wastage: waste and scrap records unified (quantity + estimated cost).
-- waste_records carries no product_id; the product is taken from the work order.
CREATE VIEW v_wastage_report AS
SELECT
  'WASTE' AS record_type, w.id, w.company_id, w.tenant_id, w.work_order_id,
  wo.product_id, p.code AS product_code, w.waste_type, w.category,
  w.waste_qty AS quantity, w.is_abnormal, w.reason, w.recorded_at,
  round(w.waste_qty * COALESCE(p.standard_cost, 0), 4) AS estimated_cost
FROM waste_records w
LEFT JOIN work_orders wo ON wo.id = w.work_order_id
LEFT JOIN products p ON p.id = wo.product_id
UNION ALL
SELECT
  'SCRAP' AS record_type, s.id, s.company_id, s.tenant_id, s.work_order_id,
  s.product_id, p.code AS product_code, s.scrap_type, NULL::text AS category,
  s.quantity AS quantity, false AS is_abnormal, s.reason, s.recorded_at,
  round(s.quantity * s.unit_cost, 4) AS estimated_cost
FROM scrap_records s
LEFT JOIN products p ON p.id = s.product_id;

-- Direct labour by work order / employee.
CREATE VIEW v_labour_cost_report AS
SELECT
  wl.id, wl.work_order_id, wo.wo_no, wo.company_id, wo.tenant_id,
  wl.employee_id, e.employee_no, e.first_name, e.last_name,
  wl.operator_user_id, wl.hours, wl.hourly_rate, wl.cost, wl.worked_at
FROM work_order_labour wl
JOIN work_orders wo ON wo.id = wl.work_order_id
LEFT JOIN employees e ON e.id = wl.employee_id;

-- Machine cost: run hours * hourly rate plus energy (kWh * tariff) per operation.
CREATE VIEW v_machine_cost_report AS
SELECT
  o.id AS operation_id, o.work_order_id, wo.wo_no, wo.company_id, wo.tenant_id,
  o.seq, o.name AS operation_name, o.work_centre_id, wc.code AS work_centre_code,
  o.machine_id, m.code AS machine_code, m.name AS machine_name,
  CASE WHEN o.actual_started_at IS NOT NULL AND o.actual_ended_at IS NOT NULL
       THEN GREATEST(0, EXTRACT(EPOCH FROM (o.actual_ended_at - o.actual_started_at)))/3600.0
       ELSE (COALESCE(o.planned_setup_min,0)+COALESCE(o.planned_run_min,0))/60.0 END AS hours,
  o.kwh_consumed, m.hourly_rate, m.utility_rate_per_kwh,
  round(CASE WHEN o.actual_started_at IS NOT NULL AND o.actual_ended_at IS NOT NULL
       THEN GREATEST(0, EXTRACT(EPOCH FROM (o.actual_ended_at - o.actual_started_at)))/3600.0
       ELSE (COALESCE(o.planned_setup_min,0)+COALESCE(o.planned_run_min,0))/60.0 END
       * COALESCE(m.hourly_rate, 0)
       + COALESCE(o.kwh_consumed, 0) * COALESCE(m.utility_rate_per_kwh, 0), 4) AS machine_cost
FROM work_order_operations o
JOIN work_orders wo ON wo.id = o.work_order_id
LEFT JOIN work_centres wc ON wc.id = o.work_centre_id
LEFT JOIN machines m ON m.id = o.machine_id;

-- Overhead absorbed per work order plus the driver quantities used.
CREATE VIEW v_overhead_cost_report AS
SELECT
  wo.id AS work_order_id, wo.wo_no, wo.company_id, wo.tenant_id,
  wo.actual_overhead_cost,
  (SELECT COALESCE(SUM(CASE WHEN o.actual_started_at IS NOT NULL AND o.actual_ended_at IS NOT NULL
       THEN GREATEST(0, EXTRACT(EPOCH FROM (o.actual_ended_at - o.actual_started_at)))/3600.0
       ELSE (COALESCE(o.planned_setup_min,0)+COALESCE(o.planned_run_min,0))/60.0 END),0)
     FROM work_order_operations o WHERE o.work_order_id = wo.id) AS machine_hours,
  (SELECT COALESCE(SUM(hours),0) FROM work_order_labour WHERE work_order_id = wo.id) AS labour_hours,
  wo.produced_qty, wo.actual_material_cost
FROM work_orders wo
WHERE wo.status IN ('COMPLETED','CLOSED');

-- Value-tracked WIP balances.
CREATE VIEW v_wip_valuation AS
SELECT
  wb.id, wb.company_id, wb.tenant_id, wb.work_order_id, wb.product_id,
  p.code AS product_code, p.name AS product_name,
  wb.quantity, wb.value, u.code AS unit_code,
  wb.work_centre_id, wb.machine_id, wb.last_posting_at
FROM wip_balances wb
LEFT JOIN products p ON p.id = wb.product_id
LEFT JOIN units u ON u.id = wb.unit_id;

-- Cost variance per completed work order (standard - actual, positive = favourable).
CREATE VIEW v_cost_variance_report AS
SELECT
  wo.id AS work_order_id, wo.wo_no, wo.company_id, wo.tenant_id, wo.product_id,
  p.code AS product_code, p.name AS product_name,
  wo.standard_cost, wo.actual_material_cost, wo.actual_labour_cost,
  wo.actual_machine_cost, wo.actual_overhead_cost, wo.actual_waste_cost,
  wo.actual_other_cost, wo.actual_cost, wo.cost_variance,
  CASE WHEN COALESCE(wo.standard_cost, 0) <> 0
       THEN round((wo.cost_variance / wo.standard_cost) * 100, 4)
       ELSE NULL END AS variance_percent,
  wo.completed_at
FROM work_orders wo
LEFT JOIN products p ON p.id = wo.product_id
WHERE wo.status IN ('COMPLETED','CLOSED');

-- Scrap records with extended cost.
CREATE VIEW v_scrap_report AS
SELECT
  s.id, s.company_id, s.tenant_id, s.work_order_id, s.product_id,
  p.code AS product_code, p.name AS product_name,
  s.scrap_type, s.quantity, s.unit_cost,
  round(s.quantity * s.unit_cost, 4) AS scrap_cost, s.reason, s.recorded_at
FROM scrap_records s
LEFT JOIN products p ON p.id = s.product_id;

-- Rework orders and their cost.
CREATE VIEW v_rework_cost_report AS
SELECT
  r.id, r.rework_no, r.company_id, r.tenant_id, r.source_work_order_id,
  wo.wo_no AS source_wo_no, r.product_id,
  p.code AS product_code, p.name AS product_name,
  r.quantity, r.rework_cost, r.status, r.notes, r.created_at
FROM rework_orders r
LEFT JOIN work_orders wo ON wo.id = r.source_work_order_id
LEFT JOIN products p ON p.id = r.product_id;

-- Labour cost aggregated by cost centre (via employees.cost_centre_id).
CREATE VIEW v_cost_centre_production AS
SELECT
  cc.id AS cost_centre_id, cc.code AS cost_centre_code, cc.name AS cost_centre_name,
  cc.company_id, cc.tenant_id,
  COALESCE(SUM(wl.cost), 0) AS labour_cost,
  COALESCE(SUM(wl.hours), 0) AS labour_hours,
  count(DISTINCT wl.employee_id) AS employee_count
FROM cost_centres cc
LEFT JOIN employees e ON e.cost_centre_id = cc.id
LEFT JOIN work_order_labour wl ON wl.employee_id = e.id
GROUP BY cc.id, cc.code, cc.name, cc.company_id, cc.tenant_id;

-- Monthly production cost trend (standard vs actual vs variance).
CREATE VIEW v_production_cost_trend AS
SELECT
  date_trunc('month', COALESCE(wo.completed_at, wo.created_at))::date AS month,
  wo.company_id, wo.tenant_id,
  count(*) AS work_orders,
  COALESCE(SUM(wo.standard_cost), 0) AS standard_cost,
  COALESCE(SUM(wo.actual_cost), 0) AS actual_cost,
  COALESCE(SUM(wo.cost_variance), 0) AS cost_variance,
  COALESCE(SUM(wo.produced_qty), 0) AS produced_qty
FROM work_orders wo
WHERE wo.status IN ('COMPLETED','CLOSED')
GROUP BY 1, 2, 3;

-- Production output records with extended cost (GOOD / SCRAP / REWORK / WASTE).
CREATE VIEW v_production_output_cost AS
SELECT
  po.id, po.work_order_id, wo.wo_no, wo.company_id, wo.tenant_id,
  po.output_type, po.quantity, po.unit_cost,
  round(po.quantity * po.unit_cost, 4) AS extended_cost, po.reason, po.recorded_at
FROM production_outputs po
LEFT JOIN work_orders wo ON wo.id = po.work_order_id;
