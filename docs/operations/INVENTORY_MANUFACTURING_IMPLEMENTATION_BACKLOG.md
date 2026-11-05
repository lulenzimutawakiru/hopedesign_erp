# Natex Operations — Inventory & Manufacturing Implementation Backlog

**Repository:** `lulenzimutawakiru/hopedesign_erp`  
**Planning branch:** `planning/accounting-modernisation-backlog`  
**Base branch:** `main`  
**Status:** Planning specification only. No application code, database, production data or deployment changed.

## 1. Objective

Modernise inventory, warehouse and manufacturing operations into **Natex Operations**: an auditable, multi-location stock-control and production-management capability integrated with procurement, sales, finance, quality, maintenance and reporting.

The design must support a manufacturing and security-printing environment, including paper and other raw materials, inks, packaging, consumables, work in progress (WIP), finished goods, batch/lot tracking, production orders, job costing, wastage, quality checks and dispatch.

Do not assume the current repository has any particular module/file structure. Discover actual files and reuse existing entities and services before proposing new tables or screens.

## 2. Mandatory repository discovery

Before implementation, inspect and document the exact existing paths for:

- Item/product master, categories, variants, units of measure and product attributes.
- Warehouses, stock locations, bins, location authorisations and stock transfers.
- Stock ledger, receipts, issues, adjustments, counts, reservations and valuation.
- Purchase requisitions, purchase orders, goods received notes and supplier returns.
- Sales orders, reservations, picking, dispatch and customer returns.
- Bills of materials (BOM), routings, work centres, production orders and job cards.
- Material issue/return, WIP, production completion, scrap and rework.
- Quality inspections, non-conformance and batch/lot/serial tracking.
- Maintenance, machine downtime and production capacity, if present.
- Finance inventory mappings, COGS and manufacturing cost posting.
- API routes, services, schemas, SPA pages, navigation, permissions, tests and audit events.

Deliver a source-of-truth map and a transaction lifecycle diagram. Do not create a parallel inventory ledger or manufacturing subsystem where an equivalent exists.

## 3. Target operating model

### Inventory lifecycle
1. Item and unit-of-measure setup.
2. Warehouse/location/bin setup and user authorisation.
3. Procurement demand and expected receipts.
4. Goods receipt and inspection.
5. Put-away and stock availability.
6. Reservation for sales or production.
7. Stock issue, transfer, return and adjustment.
8. Cycle counting and full stocktake.
9. Lot/batch traceability and expiry/quality status where relevant.
10. Stock valuation and GL reconciliation.

### Manufacturing lifecycle
1. Product BOM and routing revision.
2. Production planning and capacity check.
3. Production order/job card creation.
4. Material availability and reservation.
5. Material issue to WIP.
6. Labour, machine time and overhead capture.
7. In-process quality inspection.
8. Scrap, wastage, rework and material return.
9. Production completion and finished-goods receipt.
10. Cost roll-up, variance analysis and close-out.

Stock quantity, stock valuation, production progress, quality disposition and accounting posting are separate dimensions. Do not collapse them into one status field.

## 4. Work packages

### NC-OPS-000 — Baseline audit and regression suite

**Priority:** P0

**Files:** Discover actual inventory, warehouse, procurement, manufacturing, finance and frontend paths from the repository tree.

**Tasks**
- Inventory existing tables, migrations, endpoints, pages, permissions and scheduled jobs.
- Map every stock-changing event to its authoritative stock-ledger transaction.
- Map stock transactions to their current GL posting events.
- Identify whether stock balances are stored, derived or both, and document reconciliation logic.
- Document current item types, units, warehouses, location permissions, costing methods and batch tracking.
- Create test fixtures for receipt, issue, transfer, adjustment, reservation, production, completion, sale and return.
- Capture baseline balances and existing API contracts.

**Acceptance tests**
- Existing stock and production workflows pass regression tests.
- Stock-on-hand for test fixtures reconciles to the stock ledger.
- Existing product, warehouse and transaction records remain readable.
- CI uses disposable databases and has no production credentials.
- Migration head and all current inventory tables are documented.

### NC-OPS-010 — Item master, categories and units of measure

**Priority:** P0

**Proposed migration:** next verified unused migration, e.g. `<next>_inventory_item_master_controls.sql`.

**Database tasks**
- Reuse existing item/product schema; add only missing fields.
- Support SKU/item code, description, item type, category, brand/specification, base UOM, purchase UOM, stock UOM, sales UOM, conversion factors, barcode, status and traceability policy.
- Distinguish raw material, packaging, consumable, WIP, finished good, service and non-stock item.
- Add item-specific batch/lot/serial/expiry tracking policy.
- Add tenant/company-scoped unique SKU constraints after duplicate review.
- Preserve historical item descriptions and UOM/price snapshots on transactions.
- Add controlled item lifecycle: draft, active, blocked, obsolete.

**API/service**
- Validated item create/update/search/detail APIs.
- UOM conversion service using decimal-safe arithmetic.
- Prevent incompatible UOM conversion and invalid item type changes after transactions exist.
- Restrict item deletion when referenced; use obsolescence instead.
- Audit SKU, UOM, category, costing and traceability changes.

**Frontend**
- Item master with category/type/UOM/traceability configuration.
- Search, filters, barcode and item status.
- Display warnings for referenced items and controlled fields.
- Bulk import with preview, row-level validation and duplicate report.

**Acceptance tests**
- Duplicate SKU within tenant/company is rejected.
- UOM conversions are accurate and deterministic.
- Invalid or circular conversions are rejected.
- Historical transaction quantities and descriptions do not change when master data changes.
- Used items cannot be hard-deleted or assigned an incompatible stock UOM.
- Cross-tenant item access is denied.

### NC-OPS-020 — Warehouses, bins and access control

**Priority:** P0

**Proposed migration:** next verified unused migration, e.g. `<next>_inventory_warehouse_bin_controls.sql`.

**Database tasks**
- Reuse current warehouse/location tables.
- Support warehouse hierarchy: site, warehouse, zone, aisle, rack, shelf/bin as needed.
- Add location type, capacity, active status and allowed item/storage class where appropriate.
- Enforce unique location codes within company/warehouse.
- Preserve authorised-user/location mappings and add role-based permissions if absent.
- Add movement restrictions for quarantine, damaged, rejected and quality-hold locations.

**API/service**
- Enforce warehouse/location access on every stock read and write.
- Validate source and destination locations on transfers.
- Prevent movement into blocked or incompatible locations.
- Support warehouse configuration and location authorisation APIs.

**Frontend**
- Warehouse/location hierarchy administration.
- User-to-location permission assignment.
- Stock view filtered by authorised locations.
- Clear status labels for quarantine, damaged and available stock.

**Acceptance tests**
- Unauthorised users cannot view or move stock in restricted locations.
- Transfers to inactive/blocked locations are rejected.
- Location codes are unique in the correct scope.
- Quarantined stock is excluded from available-to-promise quantity.
- Historical movements remain accessible after a location is deactivated.

### NC-OPS-030 — Stock ledger and movement engine

**Priority:** P0

**Proposed migration:** next verified unused migration, e.g. `<next>_inventory_stock_ledger_integrity.sql`.

**Database tasks**
- Identify and preserve the existing stock ledger as the single source of truth.
- If no immutable movement ledger exists, design one with item, UOM, signed quantity, from/to location, transaction type, source document, lot/serial, effective timestamp, actor and idempotency key.
- Add indexes for tenant/company/item/location/date/source and lot lookup.
- Add movement reversal linkage and reason.
- Prevent duplicate posting of source stock events.
- Store transaction-time item/UOM snapshots needed for historical interpretation.

**API/service**
- Centralise stock receipt, issue, transfer, return, adjustment and reversal through one validated movement service.
- Use database transactions and row locking or equivalent concurrency control.
- Derive on-hand from ledger or maintain a reconciled balance projection; document which is authoritative.
- Do not permit direct arbitrary quantity edits.
- Make corrections through authorised adjustment/reversal transactions.
- Emit domain events only after successful transaction commit.

**Frontend**
- Stock movement history with source-document drill-down.
- Receipt, issue, transfer and return workflows.
- Show on-hand, reserved, quarantined, available and in-transit separately.
- Explain rejected movements with actionable validation messages.

**Acceptance tests**
- Every stock movement has a valid source, actor and audit event.
- Concurrent issues cannot drive available stock below policy limits.
- Duplicate source event is idempotent.
- Transfer decreases source and increases destination by equal quantities.
- Reversal offsets the original movement and retains both records.
- Derived/projected balances reconcile to ledger.
- Negative stock is blocked unless a documented, permissioned policy explicitly permits it.

### NC-OPS-040 — Goods receiving, inspection and put-away

**Priority:** P1

**Dependencies:** NC-OPS-010, NC-OPS-020, NC-OPS-030

**Proposed migration:** next verified unused migration, e.g. `<next>_inventory_receiving_inspection.sql`.

**Database tasks**
- Reuse procurement PO, supplier, GRN and return entities.
- Add receipt line quantities: expected, received, accepted, rejected and pending inspection.
- Record supplier batch/lot, manufacturer batch, expiry, certificate/COA and delivery condition where applicable.
- Add inspection result, inspector, timestamp, reason and disposition.
- Track put-away task and final location.

**API/service**
- Receive against approved PO or authorised non-PO receipt policy.
- Enforce over-receipt tolerances and approval.
- Create stock movement only for accepted or explicitly quarantined quantities according to policy.
- Create supplier discrepancy/non-conformance record for damaged or short deliveries.
- Support partial receipt and supplier return.

**Frontend**
- Receiving workbench with PO lines and expected quantities.
- Barcode/lot capture and inspection checklist.
- Accepted, rejected, quarantine and put-away queues.
- Print GRN and supplier discrepancy report.

**Acceptance tests**
- Receipt cannot exceed approved tolerance without approval.
- Accepted and quarantined quantities are separately visible.
- Rejected goods do not become available stock.
- Partial receipts leave correct outstanding PO quantity.
- GRN and stock ledger reconcile.
- Replayed receipt event does not duplicate stock.

### NC-OPS-050 — Reservations, allocations and stock availability

**Priority:** P1

**Dependencies:** NC-OPS-030, Sales backlog NC-SAL-060

**Proposed migration:** next verified unused migration, e.g. `<next>_inventory_reservations.sql`.

**Database tasks**
- Reuse existing reservations where available.
- Support reservation source type/id, item, quantity, UOM, warehouse/location, lot allocation, expiry, status and release reason.
- Track soft allocation versus hard reservation if business policy needs both.
- Add indexes and uniqueness/idempotency for source lines.

**API/service**
- Calculate available-to-promise from on-hand less reservations, quality holds and other unavailable quantities, plus eligible incoming/planned supply where configured.
- Reserve stock atomically.
- Support sales order, production order and transfer demand.
- Revalidate reservation before pick/issue.
- Release on cancellation, expiry or approved amendment.

**Frontend**
- Availability inquiry by item and location.
- Reservation detail and source order.
- Reservation allocation/release queue.
- Backorder and shortage visibility.

**Acceptance tests**
- Two concurrent orders cannot reserve the same available stock.
- Reservation cannot exceed eligible available quantity without authorised override.
- Cancelled order releases reservation once.
- Quality-held stock is excluded from ATP.
- ATP breakdown reconciles to stock, reservations and holds.

### NC-OPS-060 — Stocktakes, cycle counts and adjustments

**Priority:** P1

**Proposed migration:** next verified unused migration, e.g. `<next>_inventory_count_controls.sql`.

**Database tasks**
- Count session, scope, freeze/snapshot, count lines, blind-count flag, recount, variance, reason and approval.
- Preserve expected quantity at count start and actual counted quantity.
- Add approval and posting status for adjustments.
- Track counters and reviewers separately.

**API/service**
- Create count plans by warehouse, category, movement velocity or risk.
- Support blind count and independent recount.
- Calculate variance against a defined snapshot and handle movements during count.
- Post approved variance through stock movement engine and inventory accounting mapping.
- Prevent count session from posting twice.

**Frontend**
- Count sheets and mobile-friendly count entry.
- Variance review and recount.
- Approval queue with value impact.
- Stocktake completion report.

**Acceptance tests**
- Count uses consistent snapshot/cut-off rules.
- Unapproved variance cannot be posted.
- Recount and variance reasons are audited.
- Approved adjustment creates one stock movement and corresponding GL event.
- Count posting is idempotent.

### NC-OPS-070 — Batch, lot, serial and traceability

**Priority:** P1 where regulated/quality-sensitive materials require it

**Proposed migration:** next verified unused migration, e.g. `<next>_inventory_lot_traceability.sql`.

**Database tasks**
- Lot/batch identity, supplier, manufacture/expiry dates, certificate reference, status and source receipt.
- Serial-number tracking for selected equipment/products.
- Lot quantity by location and movement history.
- Link production consumption and output lots to source lots for genealogy.
- Avoid collecting sensitive supplier or customer information beyond operational need.

**API/service**
- Enforce traceability policy by item.
- Prevent issue of expired, blocked or quarantined lots.
- Support FEFO/FIFO allocation policy where configured.
- Provide forward trace (supplier lot to finished goods/customers) and backward trace (finished batch to inputs).
- Provide recall/hold workflow with reason and affected-document list.

**Frontend**
- Lot/serial capture at receipt, issue and production.
- Traceability search and genealogy graph/table.
- Expiry alerts and blocked-lot management.
- Recall/quality hold workbench.

**Acceptance tests**
- Traceable item cannot be received/issued without required lot/serial data.
- Expired or blocked lot cannot be allocated.
- Genealogy traces finished batch to consumed lots and source receipts.
- Recall query finds affected stock, production orders and deliveries.
- Lot transfer preserves total lot quantity and history.

### NC-OPS-080 — BOM, routing and production master data

**Priority:** P0 for manufacturing

**Proposed migration:** next verified unused migration, e.g. `<next>_manufacturing_bom_routing.sql`.

**Database tasks**
- BOM header and revision, component lines, quantity per output, scrap allowance, UOM and effective dates.
- Routing steps, work centres, sequence, standard run/setup time and required skills/resources.
- Support alternate components only with controlled substitution policy.
- Freeze BOM/routing revision on production order creation.
- Preserve historic revision usage.

**API/service**
- BOM validation for cycles, invalid items, UOM and effective dates.
- BOM explosion for planned output quantity.
- Revision approval and effective-date activation.
- Routing capacity estimate and material requirement planning inputs.

**Frontend**
- BOM editor with revision comparison and approval.
- Routing/work-centre editor.
- Where-used inquiry and BOM explosion preview.
- Effective dates and status visibility.

**Acceptance tests**
- BOM cannot contain circular dependencies.
- Invalid UOM/component references are rejected.
- Approved revision cannot be silently edited; new revision is created.
- Production order retains exact BOM/routing revision used.
- BOM explosion calculates correct material requirements and scrap allowance.

### NC-OPS-090 — Production planning and work orders

**Priority:** P1

**Dependencies:** NC-OPS-050, NC-OPS-080

**Proposed migration:** next verified unused migration, e.g. `<next>_manufacturing_work_orders.sql`.

**Database tasks**
- Production order, product, quantity, due date, priority, BOM/routing revision, planned/actual dates, status and source sales order.
- Operation/job-card records and work-centre assignment.
- Planned versus actual material/labour/machine consumption.
- Shortage and capacity exception records.

**API/service**
- Create production orders from approved demand or manual planning.
- Calculate component demand and material availability.
- Prevent release if critical materials, approvals or capacity conditions fail unless authorised exception.
- Support split, partial completion, cancellation and rescheduling.
- Track status transitions with actor and reason.

**Frontend**
- Production planning board/calendar.
- Work-order detail and job cards.
- Material shortage and capacity view.
- Progress tracking by operation.

**Acceptance tests**
- Work order uses approved BOM/routing revision.
- Required quantities calculate correctly.
- Work order cannot be released without required controls.
- Partial completion updates remaining quantity correctly.
- Cancellation releases unused reservations and preserves consumption history.

### NC-OPS-100 — Material issue, WIP and returns

**Priority:** P1

**Dependencies:** NC-OPS-030, NC-OPS-090, Accounting backlog NC-ACC-040

**Proposed migration:** next verified unused migration, e.g. `<next>_manufacturing_material_wip.sql`.

**Database tasks**
- Link material issue/return movements to work order and operation.
- Record planned, issued, consumed, returned and scrapped quantities.
- Record lot genealogy and material substitution approval.
- Track WIP quantity/value and production status by work order.

**API/service**
- Issue reserved materials to WIP using central stock movement service.
- Enforce authorised substitutions and over-consumption tolerances.
- Return unused material from WIP to an eligible stock location.
- Post inventory value transfers through central accounting posting engine.
- Prevent duplicate issue/return postings.

**Frontend**
- Material pick/issue screen.
- Work-order material consumption and return screen.
- WIP balance and variance visibility.
- Lot scan and substitution approval.

**Acceptance tests**
- Material issue reduces raw material and increases WIP according to accounting mapping.
- Return reverses appropriate WIP/raw material quantities and values.
- Unapproved substitutions are blocked.
- WIP quantity/value reconciles to work-order transactions and GL.
- Duplicate issue event is idempotent.

### NC-OPS-110 — Labour, machine time and overhead capture

**Priority:** P2

**Dependencies:** NC-OPS-090, Accounting backlog NC-ACC-040

**Proposed migration:** next verified unused migration, e.g. `<next>_manufacturing_labor_overhead.sql`.

**Database tasks**
- Labour time entries, employee/work centre, operation, start/end or duration, approved rate snapshot.
- Machine time, downtime reason, work centre and rate snapshot.
- Overhead pool, allocation basis, effective rate and version.
- Approval and correction history.

**API/service**
- Validate time entries and approval.
- Calculate direct labour and machine cost.
- Allocate overhead by approved basis (machine hours, labour hours or other configured driver).
- Prevent duplicate time capture and unauthorised rate edits.
- Link payroll/labour cost imports without duplicating payroll liabilities.

**Frontend**
- Operator time capture and supervisor review.
- Machine time/downtime capture.
- Overhead-rate configuration and cost preview.
- Work-order cost breakdown.

**Acceptance tests**
- Invalid or overlapping time entries are detected according to policy.
- Approved rate snapshot is retained for historic production.
- Labour/machine/overhead cost allocation is reproducible.
- Payroll cost import is reconciled and not double-counted.
- Corrections are audited and approved.

### NC-OPS-120 — Quality control, non-conformance and rework

**Priority:** P1 for quality-sensitive manufacturing

**Proposed migration:** next verified unused migration, e.g. `<next>_manufacturing_quality_controls.sql`.

**Database tasks**
- Inspection plan, characteristic/specification, sample size, acceptance criteria and revision.
- Incoming, in-process and final inspection records.
- Non-conformance, defect code, severity, disposition, corrective action and closure evidence.
- Quarantine/hold references and rework order links.

**API/service**
- Enforce required inspection gates before stock release or production completion.
- Record measured values and pass/fail decisions with inspector and timestamp.
- Control concession, rework, scrap and supplier return disposition.
- Prevent inspectors from approving their own controlled exceptions where policy requires independence.

**Frontend**
- Inspection checklist and measurement entry.
- Non-conformance queue and corrective-action workflow.
- Quality hold and release screen.
- Inspection history by item, supplier, lot and production order.

**Acceptance tests**
- Mandatory failed inspection blocks stock release/completion.
- Quality hold removes stock from ATP.
- Rework creates linked traceable transactions.
- Quality release requires authorised decision and evidence.
- Audit history preserves original inspection results.

### NC-OPS-130 — Production completion, finished goods and variance

**Priority:** P1

**Dependencies:** NC-OPS-100, NC-OPS-110, NC-OPS-120, Accounting backlog NC-ACC-040

**Proposed migration:** next verified unused migration, e.g. `<next>_manufacturing_completion_variance.sql`.

**Database tasks**
- Production output receipts, accepted/rejected output, by-product, scrap and rework quantities.
- Actual cost roll-up snapshots and variance classification.
- Finished-goods batch genealogy and final inspection disposition.
- Work-order close status and approval.

**API/service**
- Complete full or partial production order.
- Validate output quantities against order and approved tolerances.
- Transfer approved WIP value to finished goods using configured cost method.
- Post scrap, yield, usage, labour and overhead variances to approved GL accounts.
- Close work order only when required materials, time, quality and financial controls are satisfied.

**Frontend**
- Production completion screen.
- Finished-goods receipt and lot labels.
- Actual versus standard/planned cost analysis.
- Variance approval and work-order closeout.

**Acceptance tests**
- Finished-goods receipt is supported by approved completion and quality status.
- WIP decreases and finished-goods inventory increases by the correctly valued amount.
- Scrap and variances post to designated accounts.
- Partial completion leaves accurate WIP and remaining order quantity.
- Work order cannot close with unresolved mandatory exceptions.

### NC-OPS-140 — Inventory costing and valuation

**Priority:** P0 for financial integrity

**Dependencies:** NC-OPS-030, NC-OPS-040, NC-OPS-100, NC-OPS-130, Accounting backlog NC-ACC-010 and NC-ACC-040

**Proposed migration:** next verified unused migration, e.g. `<next>_inventory_costing_valuation.sql`.

**Database tasks**
- Confirm supported cost method and scope (company/item/category).
- Preserve cost layers or valuation snapshots required by chosen method.
- Store landed cost components and allocation basis where supported.
- Store valuation runs, cut-off, method version and approval.
- Keep historic valuation results reproducible.

**API/service**
- Implement weighted-average costing first if compatible with current architecture and approved accounting policy.
- Add standard costing only with controlled standard revisions and variance treatment.
- Support landed cost allocation to eligible receipts.
- Revalue according to approved policy without rewriting historical source movements.
- Produce inventory valuation by item, warehouse, lot and as-of date.
- Reconcile inventory valuation to GL control accounts.

**Frontend**
- Cost method configuration with warnings and effective dates.
- Inventory valuation report and drill-down.
- Landed-cost allocation preview.
- Valuation exception and reconciliation workspace.

**Acceptance tests**
- Cost calculation is deterministic and uses decimal-safe arithmetic.
- Backdated receipts/returns follow documented recalculation policy.
- Inventory valuation reconciles to inventory GL control accounts.
- Valuation run is reproducible and idempotent.
- Changing cost method does not rewrite historic posted values.
- Negative-stock or zero-cost edge cases are handled explicitly and audited.

### NC-OPS-150 — Maintenance and production capacity

**Priority:** P2

**Proposed migration:** next verified unused migration, e.g. `<next>_manufacturing_maintenance_capacity.sql`.

**Database tasks**
- Equipment/machine register, work-centre link, maintenance plan, service schedule, downtime event and maintenance work order.
- Capacity calendar, shifts, planned downtime and work-centre availability.
- Spare-parts consumption linked to inventory movement.

**API/service**
- Prevent planning beyond available capacity unless an authorised override exists.
- Generate preventive maintenance due alerts.
- Record breakdowns and actual downtime.
- Issue spare parts through stock movement engine.
- Keep maintenance expenses and capital improvements distinct for finance treatment.

**Frontend**
- Equipment register and maintenance calendar.
- Downtime and breakdown log.
- Work-centre capacity board.
- Spare-parts issue and maintenance cost report.

**Acceptance tests**
- Over-capacity planning raises a visible exception.
- Maintenance schedule produces due work orders without duplicates.
- Spare-parts issue reduces stock once and links to maintenance order.
- Downtime is included in capacity reporting.
- Maintenance history is immutable/audited.

### NC-OPS-160 — Operations dashboards and traceable reports

**Priority:** P2

**Dependencies:** NC-OPS-010 through NC-OPS-150

**Reports**
- Stock on hand, available, reserved, quarantined and in transit.
- Stock ageing, slow-moving, obsolete and expiry risk.
- Reorder and shortage report.
- Stock valuation and inventory-to-GL reconciliation.
- Material usage and wastage by product/order/period.
- WIP ageing and value.
- Production plan versus actual, output, yield, scrap and downtime.
- BOM variance, labour/machine/overhead cost and production margin.
- Lot genealogy and recall exposure.

**Frontend**
- Operations dashboard with drill-down to source records.
- Warehouse dashboard with authorised-location filtering.
- Production dashboard by work centre/order/shift.
- Saved reports and bounded exports.

**Acceptance tests**
- Dashboard figures reconcile to underlying ledgers and production records.
- WIP, stock and finished-goods values reconcile to finance reports.
- Filters respect tenant/company/branch/location permissions.
- Forecast/planned quantities are clearly distinguished from actual posted movements.
- Reports are performant with representative data volumes.

## 5. Cross-module integration contracts

| Integration | Required behaviour |
|---|---|
| Procurement → Inventory | Approved PO/GRN drives receipt; supplier invoice remains a finance/AP document |
| Inventory → Procurement | Reorder/shortage suggestions can create requisitions but never auto-approve purchases |
| Sales → Inventory | ATP, reservations, picking, dispatch, returns and backorders |
| Sales → Manufacturing | Make-to-order demand links to production order |
| Manufacturing → Inventory | BOM, material issue/return, WIP, finished goods, scrap and lot genealogy |
| Inventory/Manufacturing → Finance | Stock value and production cost post through central accounting engine |
| Quality → Inventory/Manufacturing | Quarantine, inspection gates, release, rework and scrap disposition |
| Maintenance → Inventory | Spare parts issued against maintenance work orders |
| HR/Payroll → Manufacturing | Approved labour cost feed; no duplicate payroll posting |
| Operations → Reporting | Operational quantities and valuation reconcile to authoritative source ledgers |

## 6. Mandatory controls and invariants

- The stock ledger is the source of truth for stock movement; balances are derived or a reconciled projection.
- No arbitrary direct quantity editing.
- Every movement has tenant/company, item, UOM, location, source, actor, timestamp and audit trail.
- All stock-changing operations are transactional, idempotent and concurrency-safe.
- No negative stock unless an explicit policy permits it with role and audit controls.
- Quarantined, damaged, expired or blocked stock is not available for sale or production issue.
- No self-approval for controlled stock adjustments, substitutions, scrap/write-off or production exceptions.
- Posted stock/GL events are corrected through linked reversals, not destructive edits.
- BOM/routing revisions are effective-dated and snapshotted onto work orders.
- Material, labour, machine and overhead costs are traceable to production orders.
- WIP, raw material and finished-goods values reconcile to their separate GL control accounts.
- Lot genealogy supports backward and forward traceability.
- Tenant/company/branch/warehouse access is enforced server-side.
- Historical records and source snapshots remain intact.

## 7. Test strategy and definition of done

Each work package must include:
- Fresh-install and upgrade migration tests using disposable databases.
- Migration rollback/recovery rehearsal and existing-data preservation.
- Unit tests for UOM conversion, ATP, costing, BOM explosion, scrap and variance.
- Service tests for transactional movement, concurrency, idempotency and reversal.
- API tests for authentication, authorisation, tenant/company/location scope and validation.
- Frontend tests for workflows, permission states, scanning, errors and partial processing.
- End-to-end tests from purchase receipt through production to finished-goods sale/dispatch.
- Stock ledger-to-balance and inventory valuation-to-GL reconciliations.
- Audit-event verification for approvals, adjustments, quality release and work-order close.
- Performance tests for representative stock ledger, BOM and movement volumes.

## 8. Recommended delivery order

1. NC-OPS-000 baseline audit.
2. NC-OPS-010 item master, NC-OPS-020 warehouses/locations and NC-OPS-030 stock ledger integrity.
3. NC-OPS-040 receiving and NC-OPS-060 stocktakes.
4. NC-OPS-050 reservations and NC-OPS-070 lot traceability.
5. NC-OPS-080 BOM/routing and NC-OPS-090 production planning.
6. NC-OPS-100 material issue/WIP, NC-OPS-110 labour/overhead and NC-OPS-120 quality.
7. NC-OPS-130 production completion and NC-OPS-140 costing/valuation.
8. NC-OPS-150 maintenance/capacity and NC-OPS-160 dashboards.

The precise order must be adjusted after discovery of existing functionality and dependencies. Inventory valuation and GL controls must be designed before enabling new production-cost posting in production.

## 9. Branch and production safety

- Keep this document on `planning/accounting-modernisation-backlog`.
- Create implementation branches from approved `main`, for example:
  - `feature/ops-inventory-ledger-integrity`
  - `feature/ops-receiving-and-stocktakes`
  - `feature/ops-bom-production-orders`
  - `feature/ops-manufacturing-costing`
- Deliver small vertical-slice PRs: migration + service + API + UI + tests + documentation.
- Use feature flags for new stock and manufacturing paths where required.
- Use isolated staging and sanitised data. No production credentials in CI.
- Reconcile opening quantities, lots, reservations, WIP, finished goods and GL inventory accounts before activation.
- Do not run migrations or data conversion against production as part of development.
- Merge/deploy only after code review, operations/accounting approval, CI, backup/restore rehearsal and rollback review.

## 10. First sprint deliverables

- Exact repository file map for inventory, warehouses, procurement, manufacturing and finance.
- Current stock movement lifecycle and stock-to-GL mapping.
- Data quality report: duplicate SKUs, invalid UOMs, negative balances, orphan movements and location permission gaps.
- Regression tests for receipt, issue, transfer, adjustment, reservation and production completion.
- Inventory ledger and stock balance reconciliation test.
- Prioritised findings with exact paths and severity.
- One reviewed vertical slice (recommended: stock movement integrity and audit) ready for a draft PR.

**Release gate:** do not enable new manufacturing cost posting until stock quantities, stock valuation, WIP and finished-goods control accounts reconcile and production event posting is idempotent.
