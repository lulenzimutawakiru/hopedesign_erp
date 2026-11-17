# Natex Cloud Modernisation Programme

**Product:** Natex Cloud by HOPE DESIGN  
**Tagline:** Streamlining Operations, Empowering Growth  
**Working branch:** `natex-cloud-modernisation`  
**Base:** `main`

## Non-negotiable preservation rules

- Preserve all existing business workflows, calculations, approval rules, segregation of duties, audit events and statutory logic.
- Preserve API routes, request/response contracts, authentication, authorization, tenant/company boundaries and integration behaviour.
- Preserve PostgreSQL schemas, migration history and data. No destructive schema changes or migration renumbering as part of visual modernisation.
- Keep existing modules available; improve navigation and presentation without silently removing capabilities.
- Prefer additive, small commits. Each change must have a clear scope and a reviewable diff.
- Do not merge to `main` or deploy production from this branch without review and explicit approval.

## Delivery phases

### Phase 0 — Baseline and safeguards
- Record the current application architecture, module inventory, build/test commands and CI checks.
- Identify existing security-sensitive paths and business-critical workflows.
- Treat current API contracts and database migrations as compatibility boundaries.
- Verify the repository's existing build and test pipeline before broad refactoring.

### Phase 1 — Brand and application foundation
- Apply the Natex Cloud identity consistently while retaining tenant-specific branding support.
- Introduce an additive design layer: typography, spacing, surfaces, focus states, responsive layout and accessible contrast.
- Refine the global shell, navigation, page headers, command palette, notifications and empty/loading/error states.
- Preserve existing routes, permissions, keyboard shortcuts and preference behaviour.

### Phase 2 — Workspace modernisation
- Executive dashboard and work inbox.
- CRM, sales, quotations and customer service.
- Procurement, supplier management and receiving.
- Inventory, warehouse, QR traceability and dispatch.
- Manufacturing, work orders, MRP, quality and security printing.
- Finance, cash/bank, receivables, payables, payment batches, reconciliation and EFRIS.
- HR, attendance, payroll, payslips and statutory reporting.
- Assets, maintenance, service desk, documents, reporting and administration.

### Phase 3 — Engineering quality
- Expand component, route, API integration and workflow regression tests.
- Add explicit checks for authorization, tenant isolation, approval segregation and financial invariants.
- Strengthen accessibility, keyboard-only operation, responsive layouts and error recovery.
- Review dependency/security automation and secret-handling practices.

### Phase 4 — Review and release readiness
- Run the complete documented build and test suite.
- Review API/database diffs and security-sensitive changes separately.
- Provide a change log, test evidence, known limitations and rollback/recovery notes.
- Open a draft pull request for review; do not merge or deploy automatically.

## Acceptance criteria

1. Existing user journeys remain reachable and permission-gated as before.
2. Existing API contracts and database migration history remain compatible.
3. No approval, payroll, payment, inventory, traceability or audit rule is weakened.
4. The UI is consistent with the Natex Cloud brand and usable on desktop, tablet and mobile.
5. Changes pass the relevant type checks, lint/token checks, unit tests and production builds.
6. The PR describes the exact files changed, tests run, results and any remaining risks.

## Current execution note

The branch was created from `main`. The first implementation slice is deliberately additive: brand presentation and a documented programme baseline. A successful GitHub commit is not evidence that tests have passed; test results will only be reported after CI or a local test run completes.
