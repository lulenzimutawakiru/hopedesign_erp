/**
 * Maps workflow entity types to their backing table + status column
 * so the generic workflow engine can drive any entity.
 */
export const ENTITIES: Record<
  string,
  {
    table: string;
    statusColumn: string;
    approvedStatus: string;
    rejectedStatus: string;
    onApprove?: 'none' | 'post' | 'authorize' | 'release';
    /** Column holding the creator/requester id, used to enforce segregation of duties on decisions. */
    ownerColumn?: string;
  }
> = {
  'sales.orders': { table: 'sales_orders', statusColumn: 'status', approvedStatus: 'APPROVED', rejectedStatus: 'REJECTED' },
  'sales.quotations': { table: 'sales_quotations', statusColumn: 'status', approvedStatus: 'APPROVED', rejectedStatus: 'REJECTED' },
  'sales.invoices': { table: 'customer_invoices', statusColumn: 'status', approvedStatus: 'APPROVED', rejectedStatus: 'REJECTED', onApprove: 'post' },
  'sales.credit_notes': { table: 'credit_notes', statusColumn: 'status', approvedStatus: 'APPROVED', rejectedStatus: 'REJECTED', onApprove: 'post' },
  'sales.debit_notes': { table: 'debit_notes', statusColumn: 'status', approvedStatus: 'APPROVED', rejectedStatus: 'REJECTED', onApprove: 'post' },
  'procurement.orders': { table: 'purchase_orders', statusColumn: 'status', approvedStatus: 'APPROVED', rejectedStatus: 'REJECTED', ownerColumn: 'created_by' },
  'procurement.po_amendments': { table: 'po_amendments', statusColumn: 'status', approvedStatus: 'APPROVED', rejectedStatus: 'REJECTED', ownerColumn: 'created_by' },
  'procurement.suppliers': { table: 'suppliers', statusColumn: 'status', approvedStatus: 'APPROVED', rejectedStatus: 'REJECTED' },
  'procurement.requisitions': { table: 'purchase_requisitions', statusColumn: 'status', approvedStatus: 'APPROVED', rejectedStatus: 'REJECTED', ownerColumn: 'requested_by' },
  'procurement.supplier_invoices': { table: 'supplier_invoices', statusColumn: 'status', approvedStatus: 'APPROVED', rejectedStatus: 'REJECTED', onApprove: 'post' },
  'procurement.payments': { table: 'supplier_payments', statusColumn: 'status', approvedStatus: 'APPROVED', rejectedStatus: 'REJECTED', onApprove: 'release' },
  'inventory.adjustments': { table: 'inventory_adjustments', statusColumn: 'status', approvedStatus: 'APPROVED', rejectedStatus: 'REJECTED', onApprove: 'post' },
  'inventory.transfers': { table: 'inventory_transfers', statusColumn: 'status', approvedStatus: 'APPROVED', rejectedStatus: 'REJECTED', onApprove: 'post' },
  'production.plans': { table: 'production_plans', statusColumn: 'status', approvedStatus: 'APPROVED', rejectedStatus: 'REJECTED' },
  'production.work_orders': { table: 'work_orders', statusColumn: 'status', approvedStatus: 'APPROVED', rejectedStatus: 'REJECTED' },
  'production.boms': { table: 'boms', statusColumn: 'status', approvedStatus: 'APPROVED', rejectedStatus: 'REJECTED' },
  'hr.payrolls': { table: 'payrolls', statusColumn: 'status', approvedStatus: 'APPROVED', rejectedStatus: 'REJECTED' },
  'hr.final_settlements': { table: 'final_settlements', statusColumn: 'status', approvedStatus: 'APPROVED', rejectedStatus: 'DRAFT', ownerColumn: 'prepared_by' },
  'hr.requisitions': { table: 'job_requisitions', statusColumn: 'status', approvedStatus: 'APPROVED', rejectedStatus: 'REJECTED', ownerColumn: 'submitted_by' },
  'hr.workforce_plans': { table: 'workforce_plans', statusColumn: 'status', approvedStatus: 'APPROVED', rejectedStatus: 'REJECTED', ownerColumn: 'submitted_by' },
  'hr.contracts': { table: 'employment_contracts', statusColumn: 'status', approvedStatus: 'SENT_FOR_SIGNATURE', rejectedStatus: 'REJECTED', ownerColumn: 'created_by' },
  'security_printing.jobs': { table: 'security_jobs', statusColumn: 'status', approvedStatus: 'APPROVED', rejectedStatus: 'REJECTED' },
  'assets.register': { table: 'asset_register', statusColumn: 'status', approvedStatus: 'REGISTERED', rejectedStatus: 'DRAFT', ownerColumn: 'created_by' },
  'assets.transfers': { table: 'asset_transfers', statusColumn: 'status', approvedStatus: 'APPROVED', rejectedStatus: 'REJECTED', ownerColumn: 'created_by', onApprove: 'post' },
  'assets.disposals': { table: 'asset_disposals', statusColumn: 'status', approvedStatus: 'APPROVED', rejectedStatus: 'REJECTED', ownerColumn: 'created_by', onApprove: 'post' },
  'assets.impairments': { table: 'asset_impairments', statusColumn: 'status', approvedStatus: 'APPROVED', rejectedStatus: 'REJECTED', ownerColumn: 'created_by', onApprove: 'post' },
  'ops.requisitions': { table: 'requisitions', statusColumn: 'status', approvedStatus: 'APPROVED', rejectedStatus: 'REJECTED', ownerColumn: 'requested_by' },
  'ops.expenses': { table: 'expense_transactions', statusColumn: 'status', approvedStatus: 'APPROVED', rejectedStatus: 'REJECTED', ownerColumn: 'created_by' },
  'ops.claims': { table: 'employee_expense_claims', statusColumn: 'status', approvedStatus: 'APPROVED', rejectedStatus: 'REJECTED', ownerColumn: 'created_by' },
  'ops.replenishments': { table: 'petty_cash_replenishments', statusColumn: 'status', approvedStatus: 'APPROVED', rejectedStatus: 'REJECTED', ownerColumn: 'requested_by' },
  'ops.daily_closings': { table: 'daily_cash_closings', statusColumn: 'status', approvedStatus: 'APPROVED', rejectedStatus: 'REJECTED', ownerColumn: 'submitted_by' },
};
