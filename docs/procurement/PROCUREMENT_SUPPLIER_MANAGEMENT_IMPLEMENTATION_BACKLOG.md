# Natex Procurement & Supplier Management Implementation Backlog

**Repository:** `lulenzimutawakiru/hopedesign_erp`  
**Planning branch:** `planning/accounting-modernisation-backlog`  
**Base branch:** `main`  
**Status:** Planning specification only. No application code, database, production data or deployment changed.

## 1. Objective

Deliver a controlled procurement lifecycle for Natex Cloud by HOPE DESIGN, from supplier onboarding and internal demand through sourcing, requisition, approval, purchase order, goods receipt, supplier invoice matching, accounts payable and payment.

Procurement must integrate with Natex Operations (inventory and manufacturing) and Accounting without duplicating their authoritative records. A purchase order is a commitment, a goods receipt is evidence of physical delivery, a supplier invoice is a financial claim, and a payment is settlement. These events must remain distinct and independently auditable.

The solution must support a lean team with configurable approval thresholds, separation of duties, supplier due diligence, competitive sourcing where appropriate, partial deliveries, price/quantity variance handling, local and foreign currency purchases, landed costs and supplier performance.

## 2. Mandatory repository discovery

Before implementation, inspect the repository and record exact existing paths for:

- Supplier/vendor master, contacts, addresses, tax identifiers and payment terms.
- Supplier categories, status, onboarding and due diligence documents.
- Purchase requisitions, requisition lines, budgets and approval workflows.
- RFQs, supplier quotations, bid comparisons and sourcing decisions.
- Purchase orders, revisions, authorisations, dispatch and cancellation.
- Goods received notes, inspection, put-away, supplier returns and debit notes.
- Supplier invoices, AP bills, credit notes, matching and payment status.
- Payments, bank accounts, payment batches and remittance advice.
- Inventory receipts, stock movements and landed-cost allocation.
- Finance budget commitments, expense approvals, GL posting and periods.
- Contracts, price lists, supplier catalogues and renewal reminders.
- User roles, permissions, audit log, notifications, APIs, services, frontend pages and tests.

Produce a source-of-truth map for supplier, requisition, PO, receipt, invoice, AP liability and payment. Identify existing workflows and API contracts before adding or changing schema. Do not build a second AP ledger, supplier master or approval engine.

## 3. Target procurement lifecycle

1. Supplier registration and controlled onboarding.
2. Internal purchase request with business justification and budget/cost centre.
3. Requisition review and approval.
4. Sourcing strategy: approved supplier/catalogue, RFQ or documented single-source exception.
5. Supplier quotation capture and comparable bid evaluation.
6. Award decision and purchase order creation.
7. PO approval, revision control and supplier communication.
8. Delivery scheduling and expected receipt.
9. Goods receipt, quantity/quality inspection and inventory hand-off.
10. Supplier invoice capture and three-way match.
11. Exception resolution and AP approval.
12. Payment proposal, authorisation, execution and remittance.
13. Supplier returns, credit notes, disputes and reconciliation.
14. Supplier performance review and contract/price renewal.

## 4. Work packages

### NC-PROC-000 — Baseline audit and regression suite

**Priority:** P0

**Files:** Discover actual supplier, purchasing, inventory, finance, workflow and frontend paths. Do not infer filenames from this plan.

**Tasks**
- Map existing procurement entities, routes, services, screens, migrations, permissions and background jobs.
- Trace current PO-to-GRN-to-invoice-to-payment lifecycle.
- Identify whether AP invoices and supplier balances are owned by the finance module.
- Map stock receipt events to Natex Operations stock movements.
- Map procurement approvals to the existing central approval engine.
- Identify existing budget controls, supplier payment terms, currencies, tax fields and audit events.
- Build fixtures for requisition, RFQ, PO, partial receipt, invoice, credit note and payment.
- Capture baseline API behaviour and migration head.

**Acceptance tests**
- Existing procurement and AP workflows pass regression.
- Existing supplier, PO, GRN and invoice records remain readable.
- Each source document has a documented authoritative owner.
- CI uses disposable databases and no production credentials.
- Existing API contracts are recorded before modification.

### NC-PROC-010 — Supplier master and onboarding

**Priority:** P0

**Proposed migration:** allocate only after verifying current migration head, e.g. `<next>_procurement_supplier_governance.sql`.

**Database tasks**
- Reuse the current supplier/vendor entity.
- Support legal/trading name, supplier code, supplier type, contacts, physical/postal address, country, currency, payment terms and preferred delivery details.
- Support Uganda TIN and other jurisdictional tax identifiers where relevant; validate format without claiming URA registration validity unless verified through an authorised source.
- Capture bank/payment details with restricted access, change history and verification status.
- Store onboarding checklist, required documents, expiry dates, review outcome and reviewer.
- Add supplier status: draft, pending review, approved, suspended, blocked and archived.
- Enforce tenant/company-scoped supplier-code uniqueness after duplicate analysis.
- Preserve transaction-time supplier name, address, tax and payment-term snapshots.

**API/service**
- Validated create/update/search/detail endpoints.
- Approval workflow for activation and sensitive master-data changes.
- Restrict bank detail visibility and changes to authorised roles.
- Prevent hard deletion where transaction history exists.
- Detect possible duplicate suppliers using configurable identifiers and matching signals.
- Record who verified supplier documents and when.

**Frontend**
- Supplier profile with contacts, compliance documents, banking verification and activity.
- Onboarding checklist and review queue.
- Duplicate warning and merge proposal workflow; never silently merge.
- Status and risk flags with reason and expiry.

**Acceptance tests**
- Supplier code uniqueness is enforced within the correct tenant/company scope.
- Unapproved suppliers cannot be selected for normal purchase orders.
- Suspended/blocked suppliers cannot receive new commitments without authorised exception.
- Bank-detail changes require approval and are fully audited.
- Historical supplier snapshots remain unchanged after master edits.
- Cross-tenant access is denied.

### NC-PROC-020 — Purchase requisitions and demand capture

**Priority:** P0

**Proposed migration:** `<next>_procurement_requisitions.sql`.

**Database tasks**
- Requisition header/lines with requester, department, cost centre, project/job, required-by date, delivery location and justification.
- Line item, description, quantity, UOM, estimated unit cost, currency, tax treatment and preferred supplier where known.
- Support catalogue and non-catalogue requests.
- Link replenishment suggestions from inventory and material requirements from manufacturing without auto-approving purchases.
- Snapshot estimated prices and source of estimate.
- Track status, version and cancellation reason.

**API/service**
- Create, amend, submit, return, reject and cancel requisitions.
- Validate item/UOM, required fields, budget and permitted delivery locations.
- Support partial line approval and quantity/price amendments if policy allows.
- Prevent requester self-approval for controlled spend.
- Preserve full revision history.

**Frontend**
- Requisition workbench with catalogue search and free-text request.
- Cost centre/project selection and justification.
- Draft/submitted/returned/approved status.
- Requester view of progress and comments.

**Acceptance tests**
- Submitted requisition has a unique reference and immutable submission snapshot.
- Budget or policy exceptions are surfaced before approval.
- Rejected/returned requisitions retain reasons and history.
- Requester cannot approve own requisition where separation of duties applies.
- Inventory replenishment creates a draft/request, not an approved PO.

### NC-PROC-030 — Sourcing, RFQ and quotation comparison

**Priority:** P1

**Proposed migration:** `<next>_procurement_sourcing_rfq.sql`.

**Database tasks**
- Sourcing event/RFQ, invited suppliers, response deadlines and line requirements.
- Supplier quotation headers/lines with price, currency, validity, lead time, delivery terms, taxes, warranty and supporting attachments.
- Record bid opening/evaluation criteria and evaluator scores.
- Store bid comparison snapshots and award recommendation.
- Record single-source/urgent purchase justification and approval.

**API/service**
- Issue RFQ to approved suppliers through configured channels.
- Capture supplier quotations and amendments.
- Compare total evaluated cost on a common basis, clearly distinguishing taxes, freight, currency conversion and delivery.
- Enforce closing deadlines and controlled late submissions.
- Record evaluation and award decisions with conflict-of-interest declarations where policy requires.
- Do not claim supplier emails were sent unless a connected delivery service confirms it.

**Frontend**
- RFQ creation and supplier invitation list.
- Quote entry/upload and clarification log.
- Side-by-side bid comparison and evaluation matrix.
- Award recommendation and single-source exception workflow.

**Acceptance tests**
- RFQ revisions and supplier responses are retained.
- Comparison normalises currency and cost components transparently.
- Late or incomplete bids are flagged according to configured rules.
- Award decision records evaluator, rationale and approvals.
- Single-source purchase requires reason and authorised approval.

### NC-PROC-040 — Procurement approval policies and delegation

**Priority:** P0

**Proposed migration:** reuse central approval configuration; add only missing policy data, e.g. `<next>_procurement_approval_policy.sql`.

**Database tasks**
- Configurable thresholds by company, currency, category, cost centre and purchase type.
- Approval stages, assigned role/user, delegation, effective dates and escalation rules.
- Emergency/sole-source exception types and reason requirements.
- Snapshot policy/version used for each submitted transaction.

**API/service**
- Integrate with central workflow engine rather than implementing a separate approval framework.
- Calculate approval route from committed value and configured policy.
- Re-evaluate approvals when material fields change (supplier, quantity, price, currency, tax, delivery or scope).
- Invalidate stale approvals after material amendment.
- Prevent self-approval and enforce maker-checker separation.
- Support return for correction, rejection, delegation and expiry with audit events.

**Frontend**
- Procurement approval inbox.
- Decision view with original request, quotations, budget and history.
- Approve, reject or return with mandatory reason where appropriate.
- Delegation and escalation visibility.

**Acceptance tests**
- Correct approval chain is selected for each threshold and policy.
- Material changes invalidate prior approval.
- User cannot approve own controlled transaction.
- Expired delegation cannot authorise an action.
- Emergency override records reason, approver and post-event review.

### NC-PROC-050 — Purchase orders and supplier commitments

**Priority:** P0

**Proposed migration:** `<next>_procurement_purchase_orders.sql`.

**Database tasks**
- PO header/lines, supplier, currency, exchange-rate snapshot, delivery location, payment terms, incoterms/delivery terms, tax, freight, expected date and source requisition/RFQ.
- Revision number and immutable issued version.
- Line-level ordered, received, invoiced, cancelled and outstanding quantities.
- Tolerance policy for price, quantity and delivery.
- Commitment amount and budget reservation linkage.
- Document rendering/version metadata.

**API/service**
- Convert approved requisition/award into draft PO.
- Validate supplier status, approvals, price, budget, tax and delivery data.
- Issue PO only after required approvals.
- Record supplier acknowledgement and changes.
- Handle amendments through revision and reapproval.
- Support partial closure, cancellation and expiry.
- Never rewrite an issued PO snapshot.

**Frontend**
- PO builder with requisition/RFQ source.
- Approval and issue workflow.
- Printable/downloadable PO.
- Outstanding order and delivery schedule view.
- Revision comparison and amendment reason.

**Acceptance tests**
- PO cannot be issued without required approval.
- Issued PO snapshot remains immutable; amendment creates a revision.
- Material amendment triggers reapproval.
- Outstanding quantities reconcile to ordered less received/cancelled.
- Cancelled quantities cannot be received.
- Commitment is released/adjusted correctly on cancellation, receipt and closure.

### NC-PROC-060 — Goods receipt and supplier delivery coordination

**Priority:** P0; implementation shared with Natex Operations NC-OPS-040

**Proposed migration:** prefer the Operations GRN/receiving schema; do not create a duplicate receipt model.

**Tasks**
- Link PO schedule and lines to receiving records.
- Support partial delivery, over/under delivery tolerance, damaged/short quantities and backorders.
- Capture delivery note, carrier, date/time, receiver and evidence.
- Route inspection and put-away to Natex Operations.
- Keep service/non-stock receipt confirmation separate from physical inventory receipt.
- Record receipt reversal and supplier return links.

**API/service**
- Create receipt against eligible PO line.
- Call the authoritative inventory receiving service for stock items.
- Validate quantity remaining and tolerance.
- Record accepted, rejected, quarantined and pending inspection quantities separately.
- Prevent duplicate receipt posting and preserve source links.
- Support service acceptance with authorised confirmation.

**Frontend**
- Expected deliveries dashboard.
- GRN receiving screen and PO line matching.
- Exception capture and attachment.
- Receipt status and outstanding delivery quantities.

**Acceptance tests**
- Receipt cannot exceed tolerance without authorised exception.
- Accepted goods enter inventory only through Operations stock movement service.
- Rejected/quarantined goods are not available stock.
- Partial receipt preserves outstanding PO quantity.
- Duplicate receipt cannot create duplicate stock.
- Service acceptance does not create stock quantity.

### NC-PROC-070 — Supplier invoice capture and three-way matching

**Priority:** P0; finance-owned AP record

**Proposed migration:** reuse finance AP invoice tables; add matching records only if absent, e.g. `<next>_procurement_invoice_matching.sql`.

**Database tasks**
- Link supplier invoice to supplier, PO, receipt/service acceptance and AP bill.
- Store supplier invoice number/date, currency, tax, freight, line values and attachment.
- Enforce duplicate invoice detection by supplier and invoice reference with controlled exception.
- Match quantities and prices at line level.
- Store match outcome, tolerance, variance type, reviewer and resolution.
- Preserve original invoice image/file reference and extracted values separately from verified values.

**API/service**
- Capture supplier invoice into finance AP through its existing authoritative service.
- Perform two-way match (PO/invoice) where no receipt is expected and three-way match (PO/receipt/invoice) for goods.
- Support configurable price/quantity/tax/freight tolerances.
- Block or route mismatches for approval; do not silently alter PO or invoice.
- Prevent duplicate AP liability.
- Ensure tax treatment and input VAT are handled by finance rules and current Uganda requirements, not hardcoded assumptions.
- EFRIS supplier invoice verification must only be implemented if URA provides a supported, authorised interface and the business is approved to use it; do not scrape or fabricate verification.

**Frontend**
- Invoice capture and attachment.
- PO/GRN/invoice matching workspace.
- Highlight unmatched lines, price/quantity differences and tax exceptions.
- Exception resolution with reason and approval.
- Drill-through to finance AP invoice.

**Acceptance tests**
- Duplicate supplier invoice is detected and blocked or escalated.
- Invoice cannot be approved for payment while mandatory match exceptions remain unresolved.
- Three-way match compares correct PO, receipt and invoice lines.
- AP liability is created exactly once through Finance.
- Supplier invoice and receipt totals reconcile with documented tolerance.
- Unverified OCR/extracted fields are not treated as authoritative without review.

### NC-PROC-080 — Supplier returns, debit/credit notes and disputes

**Priority:** P1

**Proposed migration:** reuse Operations returns and Finance AP credit-note entities; add only missing links.

**Tasks**
- Link return authorisation to original receipt, item/lot and supplier.
- Capture return reason, quantity, condition, inspection and dispatch evidence.
- Support replacement, refund, supplier credit and price adjustment outcomes.
- Link supplier credit note to AP and original invoice.
- Track disputed invoice lines and resolution.

**API/service**
- Create return request and approval.
- Move returned stock through Operations stock movement service.
- Ensure only eligible stock can be returned.
- Create AP credit note through Finance.
- Prevent duplicate stock return or credit-note posting.
- Reconcile replacement goods as a new receipt.

**Frontend**
- Supplier return workbench.
- Return authorisation and dispatch documents.
- Credit note/dispute tracking.
- Outstanding supplier claims report.

**Acceptance tests**
- Return reduces eligible stock once and preserves original receipt/lot reference.
- AP credit note is linked to the correct invoice.
- Replacement delivery creates a new receipt, not an overwrite.
- Dispute status prevents payment of the disputed portion where policy requires.
- All return and credit actions are audited.

### NC-PROC-090 — Supplier payments, remittance and reconciliation

**Priority:** P0; payment execution is finance-owned

**Proposed migration:** reuse Finance payment/bank transaction models; add procurement remittance links only if needed.

**Tasks**
- Show due AP invoices by due date, supplier, currency and payment method.
- Prepare payment proposal/batch from approved and eligible AP invoices.
- Support partial payment, withholding/retention where legally and contractually applicable, and supplier advance policy.
- Capture remittance advice and payment confirmation reference.
- Link bank reconciliation result to payment settlement.

**API/service**
- Use Finance payment service and bank-account controls.
- Enforce payment approval and segregation between preparation, approval and execution.
- Recheck invoice eligibility, holds, credits and supplier bank verification at execution.
- Prevent duplicate payment using idempotency and reference checks.
- Support failed/reversed payment states without deleting original transaction.
- Do not expose full bank details to unauthorised users.

**Frontend**
- AP due list and payment proposal.
- Payment approval queue and batch review.
- Remittance advice generation.
- Payment status and bank reconciliation drill-down.

**Acceptance tests**
- Procurement cannot execute a payment outside Finance controls.
- Blocked supplier or unverified bank change triggers hold.
- Duplicate payment attempt is rejected or safely idempotent.
- Partial payments update remaining payable correctly.
- Reversed/failed payments preserve audit trail and reopen payable appropriately.
- AP balance reconciles to supplier statement and GL control account.

### NC-PROC-100 — Contracts, catalogues and supplier pricing

**Priority:** P2

**Proposed migration:** `<next>_procurement_contract_catalogues.sql`.

**Database tasks**
- Contract header, supplier, scope, value, currency, start/end date, renewal terms, owner, attachments and status.
- Contract line pricing, discount, minimum order, lead time, validity and UOM.
- Supplier catalogue and preferred item references.
- Price history with effective dates and source.
- Renewal and expiry reminders.

**API/service**
- Validate contract dates and approval.
- Resolve applicable price using supplier/item/UOM/currency/effective date.
- Warn when PO deviates from contract price.
- Prevent expired contract pricing from applying without exception.
- Preserve price snapshot on requisition/PO.

**Frontend**
- Contract register and expiry dashboard.
- Supplier catalogue maintenance.
- Price comparison and deviation approvals.
- Contract document history.

**Acceptance tests**
- Price resolution selects correct active contract revision.
- Expired contracts are not silently applied.
- PO preserves the price and terms used at issue.
- Contract amendments are versioned and approved.
- Renewal reminders are not duplicated.

### NC-PROC-110 — Supplier performance, risk and analytics

**Priority:** P2

**Tasks**
- Define measurable supplier KPIs: on-time delivery, quantity accuracy, rejection rate, invoice match rate, price variance, response time and dispute resolution.
- Calculate metrics from completed transactions, not manually asserted scores.
- Distinguish verified data from buyer-entered qualitative evaluation.
- Support periodic review, corrective action and supplier suspension recommendation.
- Provide spend analysis by category, supplier, cost centre, currency and period.
- Identify concentration risk and single-source dependency.

**Frontend**
- Supplier scorecard with drill-down to source documents.
- Procurement spend and savings analysis.
- Late delivery and quality trend reports.
- Supplier review and corrective action workflow.

**Acceptance tests**
- KPI values are reproducible from source records.
- Cancelled/test transactions are excluded according to documented rules.
- Users only see supplier data within authorised scope.
- Manual score adjustments require reason and audit.
- Reports reconcile to PO and AP transaction totals.

### NC-PROC-120 — Procurement reporting, alerts and operational dashboards

**Priority:** P2

**Reports**
- Requisition ageing and approval bottlenecks.
- RFQ response and bid comparison.
- PO commitments, outstanding quantities and overdue deliveries.
- GRN versus PO and invoice matching exceptions.
- AP due/overdue and supplier statement reconciliation.
- Spend by supplier/category/cost centre/project/currency.
- Contract expiry and price deviation.
- Supplier performance, risk and concentration.
- Purchase price variance and landed cost.

**Alerts**
- Requisition awaiting approval.
- PO approaching delivery date or overdue.
- Supplier compliance document nearing expiry.
- Invoice mismatch or duplicate warning.
- Contract nearing expiry.
- Supplier suspended/blocked with open commitments.

**Acceptance tests**
- Dashboard totals reconcile to authoritative procurement and finance records.
- Forecast/commitment figures are distinguished from posted actuals.
- Alerts are permission-aware and deduplicated.
- Reports respect tenant/company/cost-centre access.
- Exported data is bounded, audited and permission-checked.

## 5. Cross-module integration contracts

| Integration | Required behaviour |
|---|---|
| Inventory → Procurement | Reorder and material demand generate suggested requisitions; never auto-approve |
| Manufacturing → Procurement | BOM/production shortages feed planned demand and required-by dates |
| Procurement → Inventory | Approved PO and GRN drive expected and actual receipt through Operations |
| Procurement → Finance | Approved supplier invoice creates AP liability through Finance |
| Finance → Procurement | AP eligibility, credit notes, payment state and supplier balances are visible by permission |
| Procurement → Finance | Approved commitments and cost-centre consumption update budget control |
| Quality → Procurement | Supplier non-conformance and inspection results inform returns and scorecards |
| Procurement → Supplier | RFQ, PO, amendment and remittance communication via approved channels |
| Procurement → Audit | Approval, sourcing, master-data, match and exception events are traceable |

## 6. Mandatory controls and invariants

- Supplier, PO, GRN, AP invoice and payment have distinct lifecycle records and owners.
- No PO is issued without required approval and budget/policy checks.
- No self-approval for controlled purchasing, supplier bank changes or payment actions.
- Material amendments invalidate previous approvals.
- Supplier master and bank changes are audited and access-restricted.
- Supplier invoice duplicates are detected before AP liability creation.
- Goods receipt creates stock only through Natex Operations.
- Supplier invoice creates AP liability only through Finance.
- Payment execution occurs only through Finance payment controls.
- Three-way match exceptions are visible and cannot be silently bypassed.
- Every exception has reason, actor, timestamp and approval where required.
- Reversals and corrections retain original records.
- All reads/writes enforce tenant, company and role scope server-side.
- Currency conversion, tax and landed-cost calculations use documented, effective-dated rules and decimal-safe arithmetic.
- Uganda tax fields and reporting follow current authoritative requirements; do not hardcode unverified tax rates or claim statutory compliance without validation.

## 7. Test strategy and definition of done

Every work package must include:
- Fresh-install and upgrade migration tests on disposable databases.
- Existing supplier/PO/GRN/AP data preservation tests.
- Unit tests for approval thresholds, duplicate detection, matching tolerances, currency conversion and price resolution.
- Service tests for idempotency, concurrency, reversals and transactional boundaries.
- API tests for authentication, authorisation, tenant/company scope and validation.
- Frontend tests for approval inbox, sourcing, receiving, matching and payment visibility.
- End-to-end scenario: requisition → approval → RFQ/award → PO → partial GRN → supplier invoice → AP approval → payment.
- Integration tests confirming GRN is posted once to Operations and AP liability/payment once to Finance.
- Audit-event verification for supplier changes, award, PO issue, receipt, match exception and payment approval.
- Performance tests with representative supplier, PO and invoice volumes.

## 8. Recommended delivery order

1. NC-PROC-000 baseline audit.
2. NC-PROC-010 supplier master and NC-PROC-040 approval integration.
3. NC-PROC-020 requisitions and NC-PROC-050 purchase orders.
4. NC-PROC-030 RFQ/sourcing and award evaluation.
5. NC-PROC-060 receiving integration with Natex Operations.
6. NC-PROC-070 invoice capture and three-way match with Finance.
7. NC-PROC-080 supplier returns and credit notes.
8. NC-PROC-090 payment visibility/remittance integration.
9. NC-PROC-100 contracts/pricing.
10. NC-PROC-110 supplier scorecards and NC-PROC-120 dashboards.

Adjust order after repository discovery. Build vertical slices that preserve current workflows and avoid simultaneous replacement of procurement, inventory and AP.

## 9. Branch and production safety

Keep this planning document on `planning/accounting-modernisation-backlog`.

Suggested implementation branches from approved `main`:
- `feature/procurement-supplier-master`
- `feature/procurement-requisitions-purchase-orders`
- `feature/procurement-sourcing-rfq`
- `feature/procurement-three-way-match`
- `feature/procurement-supplier-performance`

Each PR should include migration, service, API, UI, tests and documentation for one coherent vertical slice. Use feature flags where workflows are being replaced. Test on isolated staging with sanitised data. Do not run development migrations or conversion scripts against production. Require code review, procurement/finance approval, CI, backup/restore rehearsal, reconciliation and rollback review before release.

## 10. First sprint deliverables

- Exact repository file map for supplier, requisition, PO, GRN, AP invoice and payment.
- Source-of-truth and lifecycle diagram for PO → GRN → AP → payment.
- Data quality report: duplicate suppliers, missing tax/payment data, orphan POs/receipts/invoices and unapproved master records.
- Regression tests for requisition, PO approval, partial receipt, invoice matching and payment status.
- Approval-policy matrix mapped to existing workflow engine.
- Draft vertical slice: supplier master governance or requisition-to-PO approval, selected after discovery.
- Prioritised findings with exact file paths, severity, user impact, fix and acceptance criteria.

**Release gate:** do not enable automated invoice matching or payment proposals until supplier identity, PO revision, receipt quantities, AP liability ownership, approval routing and duplicate controls are verified end to end.
