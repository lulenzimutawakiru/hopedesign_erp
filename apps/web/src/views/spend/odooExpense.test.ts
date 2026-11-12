import { describe, expect, it } from 'vitest';
import { billableUnitPrice, canReportOnPayslip, includedTax, odooExpenseStatus, paidByLabel } from './odooExpense';

describe('odoo expense status', () => {
  it('uses the Odoo status names', () => {
    expect(odooExpenseStatus({ status: 'DRAFT' })).toBe('Draft');
    expect(odooExpenseStatus({ status: 'SUBMITTED' })).toBe('Submitted');
    expect(odooExpenseStatus({ status: 'APPROVED' })).toBe('Approved');
    expect(odooExpenseStatus({ status: 'APPROVED', accountingStatus: 'POSTED' })).toBe('Posted');
    expect(odooExpenseStatus({ status: 'POSTED', paymentStatus: 'PENDING' })).toBe('In Payment');
    expect(odooExpenseStatus({ status: 'PAID' })).toBe('Paid');
    expect(odooExpenseStatus({ status: 'REJECTED' })).toBe('Refused');
    expect(odooExpenseStatus({ status: 'VOID' })).toBe('Cancelled');
  });

  it('labels who paid', () => {
    expect(paidByLabel('employee')).toBe('Employee');
    expect(paidByLabel('company')).toBe('Company');
    expect(paidByLabel(null)).toBe('Employee');
  });

  it('pulls tax out of a tax-included total', () => {
    expect(includedTax(118, 18)).toBe(18);
    expect(includedTax(100, 0)).toBe(0);
  });

  it('prices a reinvoiced expense at cost or at sales price', () => {
    expect(billableUnitPrice({ mode: 'none', cost: 10, salesPrice: 20, amount: 10, quantity: 1 })).toBeNull();
    expect(billableUnitPrice({ mode: 'at_cost', cost: 15, salesPrice: 40, amount: 30, quantity: 2 })).toBe(15);
    expect(billableUnitPrice({ mode: 'at_cost', cost: 0, salesPrice: 40, amount: 30, quantity: 2 })).toBe(15);
    expect(billableUnitPrice({ mode: 'sales_price', cost: 15, salesPrice: 40, amount: 30, quantity: 2 })).toBe(40);
    expect(billableUnitPrice({ mode: 'sales_price', cost: 15, salesPrice: 0, amount: 30, quantity: 1 })).toBeNull();
  });

  it('reports only unpaid employee expenses that are approved or posted', () => {
    expect(canReportOnPayslip({ status: 'APPROVED', paymentMode: 'employee', paymentStatus: 'UNPAID' }, true)).toBe(true);
    expect(canReportOnPayslip({ status: 'POSTED', paymentMode: 'employee', paymentStatus: 'UNPAID' }, true)).toBe(true);
    expect(canReportOnPayslip({ status: 'APPROVED', paymentMode: 'company', paymentStatus: 'UNPAID' }, true)).toBe(false);
    expect(canReportOnPayslip({ status: 'DRAFT', paymentMode: 'employee', paymentStatus: 'UNPAID' }, true)).toBe(false);
    expect(canReportOnPayslip({ status: 'APPROVED', paymentMode: 'employee', paymentStatus: 'PAID' }, true)).toBe(false);
    expect(canReportOnPayslip({ status: 'APPROVED', paymentMode: 'employee', paymentStatus: 'UNPAID', payslipReimburse: true }, true)).toBe(false);
    expect(canReportOnPayslip({ status: 'APPROVED', paymentMode: 'employee', paymentStatus: 'UNPAID' }, false)).toBe(false);
  });
});
