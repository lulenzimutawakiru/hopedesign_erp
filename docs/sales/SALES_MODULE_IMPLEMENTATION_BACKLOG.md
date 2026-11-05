# Natex Commerce — Sales & CRM Module Review and Implementation Backlog

**Repository:** `lulenzimutawakiru/hopedesign_erp`  
**Planning branch:** `planning/accounting-modernisation-backlog`  
**Base branch:** `main`  
**Status:** Planning specification only. No sales application code, database, production data or deployment changed.

## 1. Mission

Modernise the ERP sales lifecycle into **Natex Commerce**, an integrated CRM, quotation, order management, fulfilment, receivables and customer-retention capability.

The sales module must integrate with inventory, manufacturing, finance, EFRIS, payment channels, delivery/shipping and reporting. It must preserve existing customer, order, invoice, payment and stock workflows while improving controls and usability.

## 2. Mandatory repository discovery before implementation

Do not assume the paths below exist. First inspect the current repository tree and locate the actual implementation for:

- Sales/CRM routes and page registration in the existing SPA router/navigation.
- Customer and contact API routes, services, validation schemas and database tables.
- Leads, opportunities, quotations, sales orders, dispatch/delivery, invoices, receipts and returns.
- Product catalogue, price lists, stock availability, reservations and warehouse allocation.
- Discount, tax, payment terms, payment methods, credit status, salesperson, sales area and commission configuration.
- GL and COGS mappings and finance posting integration.
- EFRIS fiscalisation, credit notes, cancellations and error/retry handling.
- Existing permissions, audit events, notifications, exports, tests and shared UI components.

Record a route-to-file inventory and source-of-truth map before changing code. Do not create duplicate models or a second sales API if an equivalent exists.

## 3. Sales lifecycle and target workflow

1. Lead capture and qualification.
2. Customer/prospect identity and contact verification.
3. Opportunity creation, ownership, value, probability and expected close date.
4. Product/service selection and availability/pricing checks.
5. Quotation preparation, margin/discount validation and approval.
6. Customer acceptance and quotation conversion to a sales order.
7. Credit, payment/deposit and fulfilment checks.
8. Inventory reservation or manufacturing demand creation.
9. Picking, packing, dispatch, delivery and proof of delivery.
10. Invoice creation and finance posting.
11. URA EFRIS submission/reconciliation where legally required.
12. Receipt capture, allocation, collection and customer statement.
13. Returns, credit notes, warranty/service resolution and approved refunds.
14. Customer feedback, retention, repeat sales and account review.

A sales order, dispatch, invoice, GL posting and EFRIS fiscalisation are distinct lifecycle events. Never collapse them into a single “completed” status.

## 4. Work packages

### NC-SAL-000 — Baseline audit and regression protection

**Priority:** P0

**Files:** Existing sales routes/services, database migrations, SPA route/navigation, sales pages, API clients/types, permissions and test suites (discover exact paths first).

**Tasks**
- Inventory all sales routes, UI screens, database entities and integrations.
- Draw the current data flow from customer → quotation/order → stock → invoice → receipt → GL/EFRIS.
- Identify duplicate or overlapping customer/order/invoice records and define authoritative records.
- Capture existing request/response contracts and permissions.
- Create deterministic test fixtures for customer, product, price, quotation, order, dispatch, invoice, receipt, return and credit note.
- Record existing production behaviours that must remain compatible.

**Acceptance tests**
- Existing sales API and UI regression tests pass.
- Existing customer, quotation, order, invoice and payment records remain readable.
- CI test environment uses disposable databases and no production credentials.
- Sales lifecycle states and transitions are documented.

### NC-SAL-010 — Customer master, contacts and account governance

**Priority:** P0  
**Proposed migration:** next verified unused migration, e.g. `<next>_sales_customer_governance.sql`.

**Database tasks**
- Review existing customer schema before adding columns/tables.
- Support customer legal/trading name, unique customer number, registration/TIN where applicable, contacts, billing/shipping addresses, preferred currency, payment terms, credit limit, credit status, sales owner, segment/type and active status.
- Support multiple contacts and addresses without duplicating customer accounts.
- Add tenant/company-scoped uniqueness and indexes for customer number and relevant tax identifiers, subject to lawful data requirements.
- Add duplicate-customer detection using configurable matching signals; do not automatically merge records.
- Maintain audit history for changes to customer identity, tax details, credit limit and payment terms.

**API/service**
- Add validated customer create/update/search/detail endpoints using existing route conventions.
- Enforce tenant/company/branch scope on every query.
- Add duplicate suggestions and controlled merge workflow only if existing data model supports safe referential migration.
- Prevent hard deletion where sales documents or ledger history exist.

**Frontend**
- Customer 360 page with contacts, addresses, quotations, orders, invoices, receipts, returns, cases and account notes.
- Customer search with filters and duplicate warnings.
- Clear credit status and overdue exposure indicators.

**Acceptance tests**
- Cross-tenant customer access is denied.
- Duplicate identifiers are detected within configured scope.
- Multiple delivery addresses and contacts link to one customer.
- Customer identity changes are audited.
- Referenced customer cannot be hard-deleted.

### NC-SAL-020 — Leads, opportunities and sales pipeline

**Priority:** P1  
**Proposed migration:** next verified unused migration, e.g. `<next>_sales_pipeline.sql`.

**Database tasks**
- Lead source, status, owner, contact details, consent/communication preferences, qualification score and conversion reference.
- Opportunity stage, expected value, probability, expected close date, product/service interest, owner, competitor/loss reason and next action.
- Activity log for calls, meetings, emails, tasks and notes.
- Stage history and ownership-change audit.

**API/service**
- Lead capture, assignment, qualification, conversion and duplicate-check services.
- Opportunity pipeline and forecasting queries.
- Activity/task APIs with permission-aware ownership.
- Lead conversion must link to the resulting customer/contact and opportunity; avoid duplicate customer creation.

**Frontend**
- Pipeline board and list views.
- Lead inbox and assignment.
- Opportunity detail with timeline, tasks, value, stage and next action.
- Lost/won reasons and conversion action.

**Acceptance tests**
- Lead conversion preserves source and activity history.
- A lead cannot be converted twice into duplicate customers.
- Stage transitions are validated and audited.
- Forecast totals respect user/company/branch access.
- Lost opportunities require a reason.

### NC-SAL-030 — Product catalogue, price lists and quotation engine

**Priority:** P0  
**Dependencies:** NC-SAL-010

**Proposed migration:** next verified unused migration, e.g. `<next>_sales_pricing_quotations.sql`.

**Database tasks**
- Review existing product/service, unit-of-measure, tax and pricing schemas.
- Support customer/segment-specific price lists, currency, validity dates, quantity breaks and unit prices.
- Store quotation header/lines, revision/version, validity date, terms, customer acceptance, source opportunity and approval status.
- Store immutable price/tax/description snapshots on quotation lines so later catalogue changes do not rewrite historical quotes.
- Store discount type/value/reason and margin snapshot where the existing costing data supports reliable margin calculation.
- Add quotation sequence uniqueness scoped by tenant/company/financial year or approved numbering policy.

**API/service**
- Quotation calculation service for line totals, discounts, tax, freight and grand total using decimal arithmetic.
- Validate product status, unit of measure, price-list validity and tax configuration.
- Quotation versioning and PDF generation through existing document infrastructure.
- Conversion to order must preserve accepted quote terms and link both records.
- Recalculate and reapprove when material terms change.

**Frontend**
- Professional quotation builder with product search, quantity, unit, price, discount, tax, freight, notes and totals.
- Price-list selection and margin/discount warnings.
- Revision comparison and customer acceptance status.
- Download/print/share using existing secure document flow.

**Acceptance tests**
- Quote totals reconcile line-by-line using documented rounding rules.
- Expired price lists cannot be used without authorised override.
- Historical quotation values do not change when product prices or tax rates change.
- Quote revision invalidates previous approval where material fields changed.
- Converted order retains quote reference, accepted prices and terms.
- Negative quantities/prices and invalid tax configurations are rejected.

### NC-SAL-040 — Discount matrix, pricing authority and approval

**Priority:** P0  
**Dependencies:** NC-SAL-030

**Proposed migration:** next verified unused migration, e.g. `<next>_sales_discount_approvals.sql`.

**Database tasks**
- Discount policy by product/category, customer segment, quantity, campaign, salesperson and date range.
- Approval thresholds by discount percentage, value and margin floor.
- Approval request, decision, reason, approver, timestamp and approved quote/order version.
- Effective dating and policy versioning.

**API/service**
- Central discount evaluation service; client-provided totals are never trusted.
- Enforce floor price/margin and approval limits server-side.
- No self-approval for controlled discounts.
- Material changes after approval require reapproval.
- Log override and exception reason.

**Frontend**
- Show applied pricing rules and discount authority.
- Approval inbox with quote context, margin impact and customer history.
- Block unauthorised discounts at save/submit/post time, not merely hide buttons.

**Acceptance tests**
- Discount above user's authority requires approval.
- Margin below configured floor is blocked or escalated according to policy.
- Approver cannot approve own request.
- Changed quantity, price or discount invalidates approval.
- Every override is auditable.

### NC-SAL-050 — Sales order, credit control and deposits

**Priority:** P0  
**Dependencies:** NC-SAL-030, NC-SAL-040, Finance AR work package

**Proposed migration:** next verified unused migration, e.g. `<next>_sales_order_credit_controls.sql`.

**Database tasks**
- Sales order header/lines, accepted quotation reference, order status, requested delivery date, fulfilment priority, deposit/payment requirements and cancellation reason.
- Credit review snapshot: limit, outstanding exposure, overdue amount and decision at order approval time.
- Deposit and payment allocation references; do not duplicate AR receipt records.
- Order revision history and cancellation audit.

**API/service**
- Quote-to-order conversion with idempotency.
- Credit exposure check including unpaid invoices, open orders and configured exposure rules.
- Configurable block/warn/approval policy for over-limit or overdue accounts.
- Validate deposits and payment terms before release.
- Prevent order release when required approvals, stock or credit checks are incomplete.

**Frontend**
- Order workbench with quote link, payment terms, credit exposure and fulfilment status.
- Credit-hold queue with approval/release reason.
- Order amendment and cancellation workflow.

**Acceptance tests**
- Repeated quote conversion does not create duplicate orders.
- Credit exposure is calculated from authoritative AR data.
- Over-limit order follows configured block/approval policy.
- Order amendment after approval triggers required reapproval.
- Cancellation preserves history and releases eligible reservations.

### NC-SAL-060 — Inventory availability, reservation and manufacturing demand

**Priority:** P1  
**Dependencies:** NC-SAL-050; inventory/manufacturing module review

**Database tasks**
- Reuse existing stock reservation and production demand tables where present.
- Link order lines to reservations, allocation records, production demand and fulfilment quantities.
- Track partial fulfilment and backorders without corrupting ordered quantities.
- Record reservation expiry/release and reason.

**API/service**
- Availability check must distinguish on-hand, reserved, available, incoming and planned production quantities.
- Reserve stock atomically to avoid overselling under concurrent orders.
- Create manufacturing demand for make-to-order items where configured.
- Revalidate availability at pick/dispatch time.
- Do not post inventory/COGS twice; integrate with the inventory posting engine.

**Frontend**
- Availability by warehouse/location.
- Reserve/release stock and backorder visibility.
- Make-to-stock/make-to-order fulfilment path.
- Order fulfilment progress and expected date.

**Acceptance tests**
- Concurrent orders cannot reserve the same available stock.
- Partial fulfilment leaves accurate remaining quantity.
- Cancelled orders release eligible reservations.
- Make-to-order order creates one linked production demand.
- Sales fulfilment agrees with inventory movement and accounting events.

### NC-SAL-070 — Picking, packing, dispatch and proof of delivery

**Priority:** P1  
**Dependencies:** NC-SAL-060

**Proposed migration:** next verified unused migration, e.g. `<next>_sales_dispatch_delivery.sql`.

**Database tasks**
- Dispatch/delivery header and lines, picked/packed quantities, carrier/shipper, freight charge, tracking reference, dispatch timestamps and delivery confirmation.
- Proof-of-delivery attachment metadata, receiver name/signature reference and exception/damage reason.
- Partial dispatch and backorder references.

**API/service**
- Pick/pack/dispatch state transitions with permissions.
- Validate warehouse/location authorisation and available quantities.
- Link dispatch to inventory movement; ensure idempotent stock issue.
- Support delivery exception, failed delivery and return-to-stock workflows.
- Store attachments through approved file storage, not arbitrary public URLs.

**Frontend**
- Pick list, packing checklist and dispatch note.
- Delivery tracking and proof-of-delivery capture.
- Partial delivery and exception handling.

**Acceptance tests**
- Dispatch cannot exceed approved order quantity or available stock.
- Dispatch creates exactly one inventory issue.
- Partial dispatch retains remaining balance.
- Delivery confirmation records actor/time and evidence.
- Failed delivery does not falsely mark order fulfilled.

### NC-SAL-080 — Invoice, finance and EFRIS hand-off

**Priority:** P0  
**Dependencies:** Finance AR and tax/EFRIS work packages

**Database tasks**
- Reuse existing invoice, invoice-line, credit-note, tax and EFRIS records.
- Preserve order/dispatch references and invoice source snapshots.
- Distinguish invoice draft/approved/posted from EFRIS queued/submitted/accepted/rejected/cancelled states.
- Add unique source links/idempotency for order-to-invoice and invoice-to-GL posting.

**API/service**
- Invoice from order or dispatch according to configured policy.
- Validate quantity, pricing, tax, customer tax details and posting period.
- Call central finance posting engine; do not implement separate sales GL posting logic.
- Queue EFRIS separately and reconcile explicit URA responses.
- Support partial invoicing only where configured and prevent over-invoicing.
- Credit notes/refunds require linked source invoice, reason and correct URA workflow.

**Frontend**
- Invoice review and posting preview.
- Show separate ERP posting and EFRIS statuses.
- EFRIS exception queue and retry history.
- Credit note and cancellation workflow with audit evidence.

**Acceptance tests**
- Invoice totals reconcile to order/dispatch and tax calculation.
- GL posting is balanced and idempotent.
- EFRIS rejection does not mark invoice fiscalised.
- Retrying submission does not create duplicate fiscal documents.
- Credit note references original invoice and preserves original history.
- Invoice cannot be posted into a closed accounting period.

### NC-SAL-090 — Receipts, payment methods and collections

**Priority:** P1  
**Dependencies:** Finance AR work package

**Database tasks**
- Reuse existing receipt/payment tables and add allocation references only where missing.
- Support bank transfer, cash, card, mobile money and other enabled methods as configuration—not hard-coded assumptions.
- Store provider transaction reference, payment account, receipt date, currency, fees and reconciliation status.
- Support partial allocation, overpayment and unapplied cash.

**API/service**
- Receipt capture and allocation through finance AR services.
- Validate provider reference uniqueness and payment-account ownership.
- Support payment callback/webhook verification for enabled providers.
- Collections tasks and reminders with contact preference/consent checks.
- Refunds use approved reversal/payment flows.

**Frontend**
- Customer receipt screen and allocation interface.
- Outstanding invoice ageing and collection work queue.
- Payment channel reference and reconciliation status.

**Acceptance tests**
- Partial receipt allocates accurately.
- Duplicate payment provider reference is rejected or safely idempotent.
- Unapplied cash remains visible.
- Receipt GL and AR allocations reconcile.
- Refund is approved, linked and audited.

### NC-SAL-100 — Salespeople, territories, commission and freight

**Priority:** P2  
**Dependencies:** NC-SAL-010, NC-SAL-050, Finance GL mappings

**Proposed migration:** next verified unused migration, e.g. `<next>_sales_territory_commission_freight.sql`.

**Database tasks**
- Salesperson/team, sales area/territory, customer assignment and effective dates.
- Commission plan/type, eligible basis, rate, thresholds, caps, clawback and approval status.
- Shipper/carrier and freight charge rules.
- Commission accrual and settlement references; prevent duplicate commission generation.

**API/service**
- Assign salesperson/territory with history.
- Calculate commission from approved policy and eligible paid/posted sales basis.
- Handle returns, credit notes and cancellations with commission adjustment/clawback.
- Freight calculation and posting through configured GL mapping.
- Require approval before commission payout.

**Frontend**
- Sales team and territory administration.
- Commission statement and approval queue.
- Freight/shipper configuration and delivery cost visibility.

**Acceptance tests**
- Commission calculation follows effective-dated policy.
- Unpaid, cancelled or credited sales are treated according to configured policy.
- Return/credit note produces correct commission adjustment.
- Commission batch is idempotent.
- Freight is visible on quotation/order/invoice and posts to the approved account.

### NC-SAL-110 — Sales analytics, forecasting and customer retention

**Priority:** P2  
**Dependencies:** NC-SAL-020 through NC-SAL-100

**Tasks**
- Pipeline conversion, win/loss, quote turnaround, order fulfilment, average order value, gross margin, customer retention, repeat purchase and overdue customer metrics.
- Forecast by salesperson, team, territory, product/category and period.
- Drill-down from every KPI to source records.
- Customer inactivity and reorder prompts based on configurable rules.
- Sales reports must reconcile to posted finance and fulfilment records; pipeline forecast must remain clearly distinguished from recognised revenue.

**Frontend**
- Sales dashboard and pipeline board.
- Customer 360 and account activity timeline.
- Forecast and performance reports.
- Saved filters and exports using existing report infrastructure.

**Acceptance tests**
- Forecast does not appear as recognised revenue.
- Sales revenue reconciles to posted GL revenue for identical filters.
- Dashboard respects company/branch/role access.
- Metrics handle cancelled, returned, credited and partially fulfilled orders consistently.

## 5. Cross-module integration contracts

| Source/destination | Contract |
|---|---|
| CRM → Customer master | Lead conversion links records; no duplicate customer creation |
| Sales → Pricing | Server-calculated price, tax, discounts and margin |
| Sales → Inventory | Availability, reservations, pick/issue and backorder |
| Sales → Manufacturing | Demand for configured make-to-order items |
| Sales → Finance | Invoice, AR, receipt, credit note, revenue, VAT and COGS posting through central finance services |
| Sales → EFRIS | Fiscalisation submission and explicit URA outcome reconciliation |
| Sales → Delivery | Dispatch, freight, tracking and proof of delivery |
| Sales → Notifications | Approval, quote expiry, credit hold, delivery and collection events |
| Sales → Analytics | Pipeline separated from posted revenue and collected cash |

## 6. Required business controls

- No self-approval for controlled discounts, credit overrides, order release exceptions, refunds or commission payouts.
- Material changes to an approved quote/order invalidate approval.
- Customer credit limit and overdue exposure are checked server-side.
- Price, discount, tax and totals are recalculated server-side; never trust browser totals.
- All lifecycle transitions are permission-controlled and audited.
- All retryable operations use idempotency keys.
- Posted financial records are immutable; corrections use reversals/credit notes.
- Tenant/company/branch isolation is mandatory.
- Sales invoice, GL posting and EFRIS acceptance remain distinct statuses.
- Preserve all historic document snapshots and numbering.

## 7. Test strategy and definition of done

Every work package must include:
- Migration tests on fresh schema and upgrade from current schema, using disposable databases.
- Existing-data preservation and rollback/recovery evidence.
- Unit tests for price, discount, tax, credit, commission and rounding calculations.
- Service tests for transaction atomicity, idempotency and state transitions.
- API tests for authentication, permissions, tenant/company isolation and stable error responses.
- Frontend tests for validation, workflow states, access controls and failed requests.
- End-to-end lifecycle test from lead/customer through quote, order, fulfilment, invoice, EFRIS state and receipt.
- Regression tests for all current sales workflows.
- Audit-event verification for approval, override, posting, cancellation, refund and ownership changes.

## 8. Recommended delivery order

1. NC-SAL-000 baseline audit.
2. NC-SAL-010 customer master and NC-SAL-030 quotation/pricing foundations.
3. NC-SAL-040 discount approval and NC-SAL-050 sales order/credit controls.
4. NC-SAL-060 stock reservation/manufacturing demand and NC-SAL-070 fulfilment.
5. NC-SAL-080 invoicing/finance/EFRIS hand-off and NC-SAL-090 receipts/collections.
6. NC-SAL-020 pipeline/CRM enhancements, then NC-SAL-100 commissions/freight.
7. NC-SAL-110 analytics and retention.

The exact order can be adjusted after repository discovery reveals existing capabilities and dependencies. Avoid building a second customer, invoice, receipt or inventory subsystem.

## 9. Branch and release safeguards

- Keep this file as a planning artefact on `planning/accounting-modernisation-backlog`.
- Create implementation branches from approved `main`, e.g. `feature/sales-customer-quotations`, `feature/sales-order-fulfilment`, `feature/sales-efris-integration`.
- Each PR must be a complete vertical slice: schema + service + API + UI + tests + documentation.
- Use feature flags for new workflow activation where necessary.
- Test on isolated staging with sanitised data. No production database credentials in CI.
- Reconcile customer balances, open orders, stock reservations, invoice totals and tax before enabling new paths.
- Merge and deploy only after code review, accounting/operations sign-off, CI and rollback review.

## 10. First sprint deliverables

- Exact sales route/file inventory and current lifecycle diagram.
- Customer/order/invoice/payment source-of-truth map.
- Sales regression test fixtures.
- Prioritised findings with severity, user impact and exact file references.
- One selected vertical slice (recommended: customer master + quotation calculation) ready for a draft PR.
- No production deployment and no destructive migration.
