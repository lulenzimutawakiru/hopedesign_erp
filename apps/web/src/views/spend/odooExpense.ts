import type { Rec } from './kit';
import { s } from './kit';

export type OdooExpenseStatus =
  | 'Draft'
  | 'Submitted'
  | 'Approved'
  | 'Posted'
  | 'In Payment'
  | 'Paid'
  | 'Refused'
  | 'Cancelled';

/** Map the register status onto the Odoo Expenses status names. */
export function odooExpenseStatus(row: Rec): OdooExpenseStatus {
  const status = s(row.status);
  const payment = s(row.paymentStatus);
  const accounting = s(row.accountingStatus);
  if (status === 'VOID') return 'Cancelled';
  if (status === 'REJECTED') return 'Refused';
  if (status === 'PAID' || payment === 'PAID') return 'Paid';
  if (payment === 'PENDING' || payment === 'PARTIALLY_PAID') return 'In Payment';
  if (status === 'POSTED' || accounting === 'POSTED') return 'Posted';
  if (status === 'APPROVED') return 'Approved';
  if (status === 'SUBMITTED') return 'Submitted';
  return 'Draft';
}

export function paidByLabel(mode: unknown): 'Employee' | 'Company' {
  return s(mode) === 'company' ? 'Company' : 'Employee';
}

export function expenseEmployeeName(row: Rec): string {
  const named = `${s(row.firstName)} ${s(row.lastName)}`.trim();
  return named || s(row.employeeName) || s(row.createdByName) || '—';
}

export function analyticLabel(row: Rec): string {
  const parts = [s(row.departmentName), s(row.projectName), s(row.costCentreName)].filter(Boolean);
  return parts.length ? parts.join(', ') : '—';
}

export function includedTax(total: number, ratePercent: number): number {
  if (!(total > 0) || !(ratePercent > 0)) return 0;
  return Math.round((total * ratePercent) / (100 + ratePercent) * 100) / 100;
}

export type ReinvoiceMode = 'none' | 'at_cost' | 'sales_price';

export function reinvoiceModeOf(row: Rec): ReinvoiceMode {
  const mode = s(row.reinvoiceMode ?? row.categoryReinvoiceMode);
  if (mode === 'at_cost' || mode === 'sales_price' || mode === 'none') return mode;
  return row.reinvoice === true || row.categoryReinvoice === true ? 'at_cost' : 'none';
}

/** Unit price charged back to the customer. Null when the category is not reinvoiced or the sales price is missing. */
export function billableUnitPrice(input: {
  mode: ReinvoiceMode;
  cost: number;
  salesPrice: number;
  amount: number;
  quantity: number;
}): number | null {
  if (input.mode === 'none') return null;
  const qty = input.quantity > 0 ? input.quantity : 1;
  if (input.mode === 'sales_price') return input.salesPrice > 0 ? input.salesPrice : null;
  if (input.cost > 0) return input.cost;
  return Math.round((input.amount / qty) * 100) / 100;
}

export function canReportOnPayslip(row: Rec, enabled: boolean): boolean {
  if (!enabled || row.payslipReimburse === true) return false;
  if (s(row.paymentMode) === 'company') return false;
  const status = s(row.status);
  if (status !== 'APPROVED' && status !== 'POSTED') return false;
  if (s(row.paymentStatus) === 'PAID') return false;
  return true;
}

const staged: File[] = [];

export function stageReceipts(files: File[]) {
  staged.splice(0, staged.length, ...files);
}

export function takePendingReceipts(): File[] {
  return staged.splice(0, staged.length);
}
