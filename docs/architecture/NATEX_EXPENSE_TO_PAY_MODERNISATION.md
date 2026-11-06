# Natex Cloud Expense-to-Pay Modernisation

## Implementation baseline

This work extends the existing expenditure module. It does not replace SpendFlow,
the expense transaction register, the generic workflow engine, accounting, or
payment services.

### Existing capabilities retained

- Expense transactions, categories, lines, allocations and receipt evidence.
- Expense risk and duplicate checks.
- Existing SpendFlow workspace.
- Generic workflows, workflow instances and approval tasks.
- Finance approval inbox and accounting journal integration.
- Existing petty cash, employee claims, requisitions and payment records.

### Initial implementation slice: universal expense initiation

Migration `0208_universal_expense_initiation.sql` grants every existing role
the minimum permissions to create, submit and view its own expense records.
A role-insert trigger applies the same minimum grant to future roles.

The change intentionally does **not** grant organisation-wide expense viewing,
approval, accounting verification, posting, payment execution, reconciliation
or configuration permissions.

Employee expense reads are scoped to `created_by = authenticated user`.
Existing holders of `expenditure.expenses.view` retain organisation-wide
visibility. Draft edits and submission are restricted to the expense creator.

### Follow-on implementation work

1. Add evidence upload to the employee-owned expense lifecycle, with strict
   ownership validation for expense attachments.
2. Replace the legacy paid-on-record action with a separate payment
   authorisation, execution and reconciliation lifecycle.
3. Review expense-line/header/tax reconciliation and accrual accounting.
4. Integrate budget commitments and release/conversion semantics.
5. Add policy-driven category requirements, approval thresholds and
   department routing.
6. Add supplier invoice intake, PO matching and AP ageing.
7. Add recurring expenses, advance settlement and per diem/mileage claims.
8. Add document extraction adapters with human verification.
9. Add explainable risk scoring and exception review.
10. Expand dashboards, saved filters, audit views and mobile workflows.

## Safety rules

- Missing required approval configuration must fail closed.
- Approval is not accounting verification.
- Accounting verification is not GL posting.
- GL posting is not payment execution.
- Payment execution is not bank reconciliation.
- A creator cannot approve their own expense.
- Material changes invalidate standing approval.
- Posted journals are reversed, never silently edited or deleted.
- Existing production data and APIs must remain backward-compatible.

## Verification

Run database migrations in a disposable test database, then run:

- API tests, including `universalExpenseInitiation.test.ts`.
- API typecheck and build.
- Web build and relevant UI tests.
- Expense, approval, accounting and payment regression suites.

Production migration and deployment require a separate backup, release review
and explicit deployment authorisation.
