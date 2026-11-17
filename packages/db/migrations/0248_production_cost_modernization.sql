-- 0248_production_cost_modernization.sql
-- Phase 3/4 data model for production cost accounting: machine utility capture,
-- employee hourly rate, labour->employee linkage, and value-tracked WIP.
--
-- Every addition is defaulted (0 / NULL) so existing rows and the prior costing
-- engine keep working unchanged until the new engine consumes the columns.

-- Machine electricity: rated power draw (kW) and the per-kWh tariff. The cost
-- of a run is hours * hourly_rate (machine time) plus kWh * utility_rate.
ALTER TABLE machines
  ADD COLUMN power_kw NUMERIC(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN utility_rate_per_kwh NUMERIC(18,4) NOT NULL DEFAULT 0;

-- Actual energy consumed per work-order operation (metered or est. from power_kw * hours).
ALTER TABLE work_order_operations
  ADD COLUMN kwh_consumed NUMERIC(14,4) NOT NULL DEFAULT 0;

-- Hourly employees (salary_type = 'HOURLY') previously had no usable rate; this
-- is the authoritative rate for labour costing. Monthly staff keep 0 here and
-- their wages reach the GL through payroll (never a duplicate labour journal).
ALTER TABLE employees
  ADD COLUMN hourly_rate NUMERIC(18,4) NOT NULL DEFAULT 0;

-- Attribute production labour to an employee (and thus their cost centre), not
-- only to a user login. `cost` continues to be computed server-side.
ALTER TABLE work_order_labour
  ADD COLUMN employee_id BIGINT REFERENCES employees(id);

-- Value-tracked WIP: the MES wip_balances table was quantity-only. `value`
-- carries the absorbed cost of the work in progress at that balance row.
ALTER TABLE wip_balances
  ADD COLUMN value NUMERIC(18,2) NOT NULL DEFAULT 0;

COMMENT ON COLUMN machines.power_kw IS 'Rated power draw in kW, used with utility_rate_per_kwh for energy costing';
COMMENT ON COLUMN machines.utility_rate_per_kwh IS 'Electricity tariff in UGX per kWh';
COMMENT ON COLUMN employees.hourly_rate IS 'Hourly labour rate for HOURLY employees; 0 for monthly staff';
COMMENT ON COLUMN work_order_labour.employee_id IS 'Employee who performed the labour (links to employees.cost_centre_id)';
COMMENT ON COLUMN wip_balances.value IS 'Absorbed cost of the WIP quantity at this balance row';
