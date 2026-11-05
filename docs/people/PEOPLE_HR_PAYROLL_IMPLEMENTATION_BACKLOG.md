# Natex People — HR & Payroll Implementation Backlog

**Repository:** `lulenzimutawakiru/hopedesign_erp`  
**Planning branch:** `planning/accounting-modernisation-backlog`  
**Status:** Planning specification only. No application code, database, production data or deployment changed.

## 1. Objective

Deliver a secure, auditable Human Resources and Payroll module for Natex Cloud by HOPE DESIGN. The module will manage the employee lifecycle, organisation structure, employment records, attendance, shifts, leave, time sheets, payroll preparation, statutory deductions, payslips, payroll approvals, payment hand-off and statutory reporting.

The design must support a lean organisation today without hardcoding a five-person limit or preventing growth to multiple departments, branches, companies, currencies or payroll groups. Employee self-service and manager workflows should be permission-based. Payroll calculations must be effective-dated, reproducible and reviewable.

**Compliance boundary:** Uganda PAYE, NSSF, local service tax where applicable, withholding and other statutory obligations must be implemented from current authoritative URA, NSSF and relevant government requirements, confirmed by a qualified payroll/accounting reviewer before production use. Never hardcode an assumed tax rate or claim compliance based only on this planning document.

## 2. Mandatory repository discovery

Before implementation, inspect and record exact existing paths and contracts for:

- Employee/person records, employee numbers, employment contracts and job history.
- Departments, positions, grades, locations, cost centres and reporting lines.
- Recruitment, onboarding, document storage and employee status.
- Attendance devices and integrations, including any Hikvision import/sync code.
- Shift patterns, rosters, time sheets, overtime and absence handling.
- Leave types, balances, accruals, approvals and holiday calendars.
- Payroll periods, earnings, deductions, benefits, loans, advances and payslips.
- Existing PAYE, NSSF, tax configuration and statutory report generation.
- Payroll journals, GL accounts, cost-centre allocation and finance posting services.
- Employee payment instructions, bank files, payment approvals and reconciliation.
- User authentication, roles, permissions, audit events and notifications.
- Existing APIs, frontend routes, background jobs, migrations, tests and exports.

Map the authoritative owner of employee identity, attendance events, leave balances, payroll results, statutory liabilities, payment instructions and GL postings. Reuse existing Finance, approval, document and notification services. Do not create a second general ledger, payment engine or identity system.

## 3. Target employee lifecycle

1. Workforce plan and approved position.
2. Recruitment/selection record where in scope.
3. Employee onboarding and identity/document verification.
4. Employment contract, job, department, grade, manager and compensation setup.
5. Attendance, shift and time capture.
6. Leave and absence requests.
7. Payroll input review and cut-off.
8. Payroll calculation, exception review and reconciliation.
9. Payroll approval with maker-checker separation.
10. Payslip generation and secure distribution.
11. Payment hand-off to Finance and payment reconciliation.
12. Statutory return preparation and filing evidence.
13. Employee changes, transfers, salary revisions and disciplinary/HR records.
14. Exit, final dues, asset clearance and record retention.

## 4. Work packages

### NPE-000 — Baseline audit, data map and regression suite

**Priority:** P0

**Tasks**
- Inventory all existing HR, attendance, payroll and finance-related files, APIs, tables, migrations, permissions and tests.
- Trace an existing employee record through attendance, payroll, journal and payment, if the workflow exists.
- Identify whether employee records are duplicated across modules.
- Map Hikvision integration capabilities, device identifiers, event formats, sync method and failure handling.
- Map current statutory calculation logic and identify unverified or hardcoded assumptions.
- Record existing payroll periods, earning/deduction codes, payslip layout and GL mappings.
- Establish anonymised fixtures and baseline calculations; never copy real employee payroll data into public test fixtures.
- Document current database migration head and API contracts.

**Acceptance tests**
- Existing HR/payroll/attendance workflows pass regression.
- Current data sources and owners are documented.
- Baseline calculations can be reproduced from test fixtures.
- Sensitive production data is not used in ordinary CI.
- No existing employee or payroll records are modified during discovery.

### NPE-010 — Employee master and employment records

**Priority:** P0

**Proposed migration:** determine only after verifying the actual migration head, e.g. `<next>_people_employee_master.sql`.

**Database tasks**
- Reuse existing person/employee identity where available.
- Employee number, legal name, preferred name, contact details, emergency contact and residential/contact address.
- Employment status, hire date, contract start/end, employment type, probation and confirmation dates.
- Department, position, grade, manager, location, cost centre and legal employer.
- Compensation package references with effective dates; avoid storing salary history as an overwrite-only field.
- Bank/payment instructions in a separately permissioned and encrypted/restricted data domain.
- Employee documents with type, issue/expiry date, verification status and access policy.
- Emergency contact and dependent information with restricted access.
- Termination date, reason category, rehire eligibility and clearance status.
- Tenant/company/branch scope and employee-number uniqueness rules.

**API/service**
- Create, update, search, view, transfer and terminate employee records.
- Validate employment dates and manager/reporting relationships.
- Require approval for sensitive changes including bank details, compensation and legal employer.
- Preserve effective-dated history and transaction-time snapshots.
- Restrict employee access to own profile and managers to permitted reporting scope.
- Prevent hard deletion where payroll or audit history exists.

**Frontend**
- Employee directory and profile.
- Employment timeline and organisation placement.
- Document checklist and expiry alerts.
- Restricted bank and compensation panels.
- Employee self-service profile correction request.

**Acceptance tests**
- Employee number is unique in the intended legal-entity scope.
- Historical salary/job/department changes remain reconstructable.
- Bank changes require independent review and are audited.
- Employee cannot access another employee's restricted data.
- Terminated employees remain available for lawful historical payroll and audit.

### NPE-020 — Organisation structure, positions and workforce planning

**Priority:** P1

**Proposed migration:** `<next>_people_organisation_structure.sql`.

**Tasks**
- Departments, teams, locations, positions, grades and reporting hierarchy.
- Effective-dated position assignment and vacancy status.
- Approved headcount and budgeted positions by department/cost centre.
- Optional project, production line and shift allocation.
- Organisation chart and manager delegation.
- Map positions and employees to Finance cost centres.

**Acceptance tests**
- Circular reporting relationships are rejected.
- Historical org assignments are retained.
- Headcount reports reconcile to active employment records.
- Only authorised users can approve new positions or headcount changes.

### NPE-030 — Recruitment and onboarding

**Priority:** P2

**Proposed migration:** `<next>_people_recruitment_onboarding.sql`.

**Tasks**
- Vacancy requisition, role description, budget approval and hiring manager.
- Applicant records, application stage, interview notes and decision history.
- Conflict-of-interest declarations and restricted interview feedback.
- Offer, acceptance and onboarding checklist.
- Convert accepted candidate to employee without duplicate identity.
- Track required documents, induction, assigned assets and system access requests.

**Acceptance tests**
- Recruitment records are permission-restricted.
- Candidate conversion does not create duplicate employee/person records.
- Offer and hiring approval history is retained.
- Employee activation is gated by required onboarding checks as configured.

### NPE-040 — Attendance device integration and time capture

**Priority:** P0 where attendance is used for payroll

**Proposed migration:** reuse existing attendance/event tables; add only missing integration records, e.g. `<next>_people_attendance_sync.sql`.

**Tasks**
- Discover and document current Hikvision attendance integration and device models.
- Map device user identifiers to employee records using a controlled mapping table.
- Import raw clock events with source device, timestamp, timezone, event type and ingestion reference.
- Store raw events immutably; corrections must be separate reviewed adjustments.
- Handle duplicate events, delayed sync, device clock drift, offline devices and missing punches.
- Support manual attendance with reason, evidence and approval.
- Generate daily attendance summaries from raw events without overwriting source events.
- Define local timezone handling explicitly (Uganda is UTC+3) and preserve original device timestamp/timezone context.
- Support multiple sites/devices and employee assignments.

**API/service**
- Idempotent device event ingestion.
- Mapping and validation service.
- Reconciliation queue for unknown employee IDs and malformed events.
- Attendance calculation service with configurable grace periods and shift rules.
- Sync health and last successful event time.
- No direct mutation of raw event records.

**Frontend**
- Attendance dashboard and exceptions queue.
- Device health and sync status.
- Employee attendance timeline.
- Missing punch correction request and supervisor approval.
- Daily/period attendance reconciliation.

**Acceptance tests**
- Replaying a device batch does not duplicate events.
- Unknown device identifiers are quarantined for mapping.
- Device clock offset is visible and corrected only by documented rule.
- Manual corrections preserve raw event and approval evidence.
- Employee attendance totals can be traced to source events.
- A device outage does not silently create false attendance.

### NPE-050 — Shifts, rosters, timesheets and overtime

**Priority:** P1

**Proposed migration:** `<next>_people_shifts_timesheets.sql`.

**Tasks**
- Shift templates, rotations, rest days, public holidays and effective-dated rosters.
- Employee/role/production-line shift assignments.
- Timesheets for hourly, project or contract work.
- Overtime, night work, weekend/holiday work and on-call rules as configured by approved policy.
- Breaks, lateness, early departure and absence classifications.
- Manager review and approval with exception reasons.
- Prevent overlapping shifts and duplicate time entries.

**Acceptance tests**
- Roster rules handle overnight shifts and daylight/timezone boundaries robustly.
- Overtime is calculated only from approved policy and approved time.
- Manager cannot approve own timesheet where separation of duties applies.
- Changes after payroll cut-off create a controlled adjustment, not a silent rewrite.

### NPE-060 — Leave and absence management

**Priority:** P0

**Proposed migration:** `<next>_people_leave_management.sql`.

**Tasks**
- Configurable leave types, eligibility, accrual, carry-forward, limits and approval rules.
- Annual, sick, maternity/paternity and other leave categories as defined by current law and company policy.
- Public holiday calendar and work schedule.
- Leave opening balance and adjustment with source and approval.
- Leave request, manager approval, cancellation, recall and handover.
- Unpaid leave and payroll impact.
- Attachments for categories where evidence is required, with privacy controls.
- Effective-dated policy versions.

**Acceptance tests**
- Leave balance is calculated from opening balance, accrual, approved usage and adjustments.
- Overlapping leave requests are prevented or explicitly reviewed.
- Rejected/cancelled leave does not reduce balance.
- Approved leave feeds attendance and payroll exactly once.
- Policy changes do not silently rewrite historic balances.

### NPE-070 — Compensation, earnings and deductions configuration

**Priority:** P0

**Proposed migration:** `<next>_people_payroll_components.sql`.

**Tasks**
- Effective-dated salary structures and pay grades.
- Earnings: basic salary, allowances, overtime, commissions, bonuses and approved one-off payments.
- Deductions: statutory deductions, loans, advances, pension/benefits and authorised deductions.
- Employer contributions and non-cash benefits where applicable.
- Recurrence, taxable treatment, pensionable treatment, proration and GL mapping.
- Currency and exchange-rate rules for multi-currency employment where supported.
- Configurable caps, floors and eligibility rules with effective dates.
- Secure salary change request and approval history.

**Acceptance tests**
- Component configuration is versioned and effective-dated.
- Historical payroll runs use the component rules effective for that period.
- Unapproved salary changes cannot enter a payroll run.
- Taxable/non-taxable classification is explicit and reviewable.
- Component totals reconcile to payroll results and accounting mapping.

### NPE-080 — Uganda statutory rules and tax configuration

**Priority:** P0; compliance sign-off required

**Proposed migration:** `<next>_people_statutory_rules.sql`.

**Tasks**
- Separate statutory rules from application code and store effective-dated rule versions.
- Configure PAYE bands, reliefs and treatment using the current URA-approved basis.
- Configure NSSF employee/employer contribution treatment using current NSSF requirements and applicable employee categories.
- Model other statutory or local obligations only where applicable and verified.
- Maintain taxable benefit and allowable deduction treatment with documented source and approval.
- Record rule source, publication/effective date, reviewer and approval.
- Support payroll-period-specific statutory rule snapshot.
- Provide test vectors reviewed by a qualified Uganda payroll practitioner.

**API/service**
- Deterministic statutory calculation service with decimal-safe arithmetic.
- Return calculation breakdown, rule version and effective date.
- Reject payroll run if required rule configuration is missing or expired.
- Do not silently use a prior rate where a new period requires an updated rule.
- Generate statutory summaries and export data for review.
- Do not represent an internal calculation as a URA/NSSF filing confirmation.

**Frontend**
- Restricted statutory configuration panel.
- Effective-date and version history.
- Calculation breakdown and statutory review screen.
- Compliance report preview and exception list.

**Acceptance tests**
- Test vectors match approved external calculations for each effective period.
- Boundary values at each tax band and contribution limit are tested.
- Historical payroll can be recalculated using the original rule snapshot.
- Changes require authorised review and audit.
- No unverified rates are deployed as production defaults.

### NPE-090 — Payroll period, inputs and calculation engine

**Priority:** P0

**Proposed migration:** `<next>_people_payroll_runs.sql`.

**Tasks**
- Payroll groups, pay frequency, period calendar, cut-off and processing dates.
- Payroll input collection from attendance, approved overtime, leave, commissions, loans, advances and one-off adjustments.
- Input validation, missing data checks and exception queue.
- Gross-to-net calculation with earnings, deductions, employer costs and statutory components.
- Proration for joiners, leavers, unpaid leave and salary changes.
- Support payroll reruns through controlled versioning, not overwriting a finalised run.
- Record calculation engine version, component versions, statutory rules and input snapshots.
- Support simulation/draft runs before approval.

**API/service**
- Deterministic payroll calculation service.
- Idempotent run creation and input import.
- Explicit draft, calculated, under review, approved, posted, paid, reversed and closed states.
- Lock inputs after cut-off; late changes go through adjustment workflow.
- Produce employee-level and company-level reconciliation.
- Ensure one employee cannot be included twice in the same payroll group/period unless explicitly supported and controlled.

**Frontend**
- Payroll calendar and run dashboard.
- Input validation and exception resolution.
- Draft payroll calculation and variance comparison.
- Employee-level gross-to-net breakdown.
- Payroll reconciliation and approval summary.

**Acceptance tests**
- Re-running identical inputs/rules produces identical results.
- Duplicate inputs are detected.
- Joiner/leaver proration and unpaid leave are tested.
- Payroll totals equal sum of employee results.
- Draft recalculation does not alter approved/posted payroll.
- Missing statutory configuration blocks finalisation.

### NPE-100 — Payroll approval, posting and accounting integration

**Priority:** P0

**Proposed migration:** reuse central approvals and Finance journal services; add only missing payroll posting links.

**Tasks**
- Payroll preparation and independent review.
- Configurable approval levels and thresholds.
- Prevent payroll preparer from approving own run.
- Snapshot approved payroll result and prevent silent changes.
- Post payroll journal via central Finance posting service.
- Map gross earnings, employer contributions, statutory liabilities, employee net pay and cost-centre allocations to approved GL accounts.
- Support reversal and corrected payroll with linked original transaction.
- Distinguish payroll approved, journal posted, payment initiated and payment reconciled.

**Acceptance tests**
- Payroll cannot be posted before required approval.
- Payroll journal posts exactly once.
- Journal debits and credits balance.
- Payroll journal agrees with payroll register and statutory liability summary.
- Cost-centre allocations reconcile.
- Reversal preserves original posted journal and audit history.

### NPE-110 — Payslips and employee self-service

**Priority:** P0

**Tasks**
- Generate payslips from approved payroll results only.
- Include pay period, earnings, deductions, statutory breakdown, employer contributions where appropriate, net pay and year-to-date totals.
- Secure employee self-service access.
- Employee can view/download only their own payslips.
- Optional controlled notification via configured email/SMS channel; avoid exposing salary details in message previews.
- Track delivery attempt/status without claiming delivery when provider has not confirmed it.

**Acceptance tests**
- Payslip totals match payroll register.
- Employee cannot access another employee's payslip by changing URL/API identifier.
- Payslip is not regenerated from mutable draft inputs after payroll finalisation.
- Delivery retry is idempotent and delivery status reflects provider response.

### NPE-120 — Payroll payment hand-off and reconciliation

**Priority:** P0; Finance owns payment execution

**Tasks**
- Prepare payroll payment proposal from approved net-pay results.
- Validate employee bank instructions and bank verification status.
- Generate supported bank payment file/export only after format and bank approval are confirmed.
- Use Finance payment service for authorisation, execution, bank transaction and reconciliation.
- Handle failed, rejected, returned and reversed payments.
- Provide employee-level payment status with restricted access.
- Support controlled cash/manual payment evidence only if company policy permits.

**Acceptance tests**
- Payment proposal matches approved payroll net pay.
- Unverified bank changes place affected employee payment on hold.
- Duplicate payment execution is prevented.
- Finance payment status reconciles to employee payroll payable.
- Failed/reversed payments retain full audit and liability state.

### NPE-130 — Loans, advances, benefits and employee claims

**Priority:** P1

**Proposed migration:** `<next>_people_employee_loans_benefits.sql`.

**Tasks**
- Employee loan/advance request, terms, approval, disbursement link and repayment schedule.
- Payroll deduction schedule with effective dates and outstanding balance.
- Benefit enrolment, employer contributions and eligibility.
- Expense/claim hand-off to Finance expense workflow; do not duplicate expense accounting.
- Enforce deduction consent and legal/policy limits reviewed by HR/Finance.

**Acceptance tests**
- Loan balance reconciles to disbursements, repayments and adjustments.
- Repayment schedule cannot exceed approved terms.
- Payroll deductions do not exceed configured lawful/policy limits.
- Reversal and early settlement recalculate future instalments transparently.

### NPE-140 — Employee lifecycle changes, exit and final dues

**Priority:** P1

**Tasks**
- Transfers, promotions, salary changes, manager changes and contract renewals.
- Probation and contract expiry alerts.
- Resignation, termination, retirement and end-of-contract workflows.
- Exit checklist, asset return, access revocation request and knowledge handover.
- Final payroll, accrued leave, outstanding loans/advances and other approved dues.
- Preserve statutory and payroll history according to retention policy.
- Restrict sensitive disciplinary and grievance records.

**Acceptance tests**
- Effective-dated changes apply from the correct payroll period.
- Termination does not erase historical employee/payroll records.
- Final dues reconcile to approved payroll and Finance balances.
- Access revocation is tracked and confirmed by the relevant system owner.

### NPE-150 — HR documents, notifications and compliance reporting

**Priority:** P1

**Tasks**
- Controlled document storage for contracts, identity/employment evidence, certificates and policy acknowledgements.
- Document access by role and employee relationship.
- Expiry reminders for contracts, permits, licences and required documents.
- HR letters and employment confirmation templates with approval and versioning.
- Payroll register, PAYE/NSSF summaries, leave reports, attendance summaries, headcount, staff cost and turnover reporting.
- Statutory export formats based on current authority requirements.
- Audit of report generation and export.

**Acceptance tests**
- Restricted documents cannot be accessed through guessed URLs.
- Expiry notifications are deduplicated.
- Reports reconcile to employee/payroll source records.
- Statutory exports are labelled as drafts until reviewed/accepted through the official channel.

### NPE-160 — Data migration, integration and operational safeguards

**Priority:** P0

**Tasks**
- Profile existing employee, attendance, leave, payroll and bank data before migration.
- Detect duplicate employees, invalid employee numbers, missing statutory identifiers and inconsistent balances.
- Define mapping and reconciliation reports before import.
- Use staged, repeatable, idempotent migration with dry-run and rollback plan.
- Keep source records and migration provenance.
- Integrate with Natex Operations attendance, Finance GL/AP/payment, approval engine, document management and notification service.
- Establish backup, restore and access review procedures for sensitive HR/payroll data.

**Acceptance tests**
- Migration dry-run reports every rejected, transformed and accepted row.
- Employee count, leave balances, payroll opening balances and statutory opening liabilities reconcile.
- Re-running migration does not duplicate employees or transactions.
- Rollback is tested in staging.
- No production migration occurs without written approval and verified backup.

## 5. Cross-module integration contracts

| Module | Integration contract |
|---|---|
| Natex Operations / Hikvision | Raw attendance events flow into attendance processing; payroll consumes approved time summaries |
| Natex Operations / Manufacturing | Shift and production time allocations can map to production cost centres without duplicating employee identity |
| Finance | Payroll journal, statutory liabilities, employee advances and payment execution use central Finance services |
| Procurement | Employee onboarding may request assets; asset issue/return remains with asset/inventory owner |
| Sales / CRM | Approved commissions may enter payroll as validated inputs, not direct payroll edits |
| Approval engine | HR changes, leave, overtime, payroll and bank changes use central maker-checker workflow |
| Identity and access | Employee lifecycle can request access changes; identity provider remains authoritative for authentication |
| Documents | Contracts and sensitive HR records use central document storage with HR-specific permissions |
| Notifications | Secure reminders and payslip availability notices use configured channels with delivery tracking |

## 6. Mandatory security, privacy and payroll controls

- Enforce tenant, legal employer, branch and role scope server-side.
- Apply least-privilege access to salary, bank, identity, medical/leave evidence and disciplinary records.
- Do not expose sensitive employee information in logs, URLs, exports or notification previews.
- Separate HR administrator, payroll preparer, payroll reviewer, payroll approver and payment executor roles.
- No self-approval for sensitive HR changes or payroll approval.
- Bank detail changes require independent verification and full audit.
- Payroll calculation uses immutable input/rule snapshots after final approval.
- Corrections use adjustment/reversal workflows; never overwrite posted payroll.
- Raw attendance events remain immutable; manual corrections require reason and approval.
- Encrypt sensitive data in transit and at rest according to platform capabilities; restrict backups and exports.
- Audit views, changes, exports, approvals, payroll runs and payment actions.
- Retention and deletion follow applicable law and approved company policy; do not retain sensitive records indefinitely without a documented basis.
- Do not expose payroll to ordinary line managers beyond their authorised scope.
- Do not hardcode statutory rates, assume every employee has identical tax treatment or claim statutory filing has occurred without authoritative confirmation.

## 7. Test strategy and definition of done

Each package must include:
- Fresh-install and upgrade migration tests on disposable databases.
- Unit tests for effective dating, payroll arithmetic, statutory rules, leave accrual, proration and overtime.
- API tests for validation, authentication, permissions and tenant/company isolation.
- Service tests for idempotency, concurrency, transaction boundaries and reversals.
- Frontend tests for employee self-service, approval inbox, attendance exceptions and payroll review.
- Security tests for IDOR, role escalation, sensitive exports, bank data and payslip access.
- End-to-end scenario: employee setup → attendance import → leave/overtime approval → payroll draft → statutory calculation → payroll approval → GL posting → payment hand-off → payslip.
- Reconciliation tests for payroll register, GL journal, statutory liabilities and payment totals.
- Test vectors reviewed by a qualified Uganda payroll practitioner before statutory production use.

## 8. Recommended delivery order

1. NPE-000 baseline audit.
2. NPE-010 employee master and NPE-020 organisation structure.
3. NPE-040 attendance integration and NPE-050 shifts/timesheets.
4. NPE-060 leave management.
5. NPE-070 compensation configuration and NPE-080 statutory rules.
6. NPE-090 payroll calculation engine.
7. NPE-100 approval and Finance posting.
8. NPE-110 payslips and employee self-service.
9. NPE-120 Finance payment hand-off.
10. NPE-130 loans/benefits and NPE-140 employee lifecycle.
11. NPE-150 reporting and NPE-160 migration/operational hardening.

Adjust sequencing after repository discovery and current system constraints.

## 9. Suggested implementation branches

Create implementation branches from the approved base branch, not from this planning branch unless explicitly agreed:

- `feature/people-employee-master`
- `feature/people-attendance-hikvision`
- `feature/people-leave-timesheets`
- `feature/people-payroll-rules-engine`
- `feature/people-payroll-posting-payslips`
- `feature/people-payroll-payment-integration`

Each pull request should contain one coherent vertical slice with tests, migration, API, UI and documentation. Use feature flags where existing workflows are replaced.

## 10. First sprint deliverables

- Exact repository file map for employee, attendance, leave, payroll, statutory calculation, payslip and payment.
- Data ownership map across HR, Hikvision, Finance and identity/access.
- Attendance source audit: device models, event identifiers, sync mechanism, timezone, duplicate handling and outage behaviour.
- Payroll calculation audit with current rules and all hardcoded statutory assumptions identified.
- Employee and payroll data quality report using appropriately protected data.
- Regression tests for current attendance and payroll flows.
- Approved Uganda statutory rule source register and reviewer sign-off plan.
- Select one vertical slice after discovery; recommended first slice is employee master + permission controls, followed by attendance-to-timesheet.

**Release gate:** no production payroll run until employee identity, attendance cut-off, statutory rule versions, calculation reproducibility, approval separation, Finance journal mapping, payment reconciliation and payslip privacy have passed documented UAT and independent payroll review.

**Non-goals for this planning document:** no automatic statutory filing, no direct bank payments, no production data migration, no live device configuration changes and no deployment.