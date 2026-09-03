import { can, type MeUser } from './auth';

export type NavGroupId =
  | 'home'
  | 'business'
  | 'supply'
  | 'operations'
  | 'security'
  | 'finance'
  | 'spend'
  | 'people'
  | 'analytics'
  | 'communication'
  | 'documents'
  | 'admin';

export type BadgeKind = 'approvals' | 'exceptions' | 'inventory' | 'quality' | 'security';

export interface NavChild {
  id: string;
  label: string;
  href: string;
  perm?: string;
}

export interface NavItem {
  id: string;
  label: string;
  href: string;
  perm?: string;
  module?: string;
  accent: string;
  badge?: BadgeKind;
  keywords?: string;
  children?: NavChild[];
}

export interface NavGroup {
  id: NavGroupId;
  label: string;
  items: NavItem[];
}

export const NAV_GROUPS: NavGroup[] = [
  {
    id: 'home',
    label: 'Home',
    items: [
      { id: 'dashboard', label: 'Dashboard', href: '/dashboard', accent: 'exec', keywords: 'home today mission' },
      { id: 'work', label: 'My Work', href: '/work', accent: 'exec', keywords: 'tasks assigned queue' },
      { id: 'approvals', label: 'Approvals', href: '/approvals', accent: 'exec', badge: 'approvals', keywords: 'approve reject inbox decisions' },
    ],
  },
  {
    id: 'business',
    label: 'Business',
    items: [
      {
        id: 'crm', label: 'CRM', href: '/crm', perm: 'crm.customers.view', module: 'crm', accent: 'crm',
        keywords: 'customer account lead pipeline complaint',
        children: [
          { id: 'overview', label: 'Sales hub', href: '/crm', perm: 'crm.customers.view' },
          { id: 'mine', label: 'My work', href: '/crm/mine', perm: 'crm.activities.view' },
          { id: 'leads', label: 'Leads', href: '/crm/leads', perm: 'crm.leads.view' },
          { id: 'pipeline', label: 'Pipeline', href: '/crm/pipeline', perm: 'crm.opportunities.view' },
          { id: 'customers', label: 'Accounts', href: '/crm/customers', perm: 'crm.customers.view' },
          { id: 'contacts', label: 'Contacts', href: '/crm/contacts', perm: 'crm.contacts.view' },
          { id: 'activities', label: 'Activities', href: '/crm/activities', perm: 'crm.activities.view' },
          { id: 'complaints', label: 'Cases', href: '/crm/complaints', perm: 'crm.complaints.view' },
          { id: 'analytics', label: 'Dashboards', href: '/crm/analytics', perm: 'crm.customers.view' },
        ],
      },
      {
        id: 'sales', label: 'Sales', href: '/sales', perm: 'sales.orders.view', module: 'sales', accent: 'sales',
        keywords: 'quote order invoice cash otc',
        children: [
          { id: 'overview', label: 'Command Center', href: '/sales', perm: 'sales.orders.view' },
          { id: 'customers', label: 'Customers', href: '/sales/customers', perm: 'sales.quotations.view' },
          { id: 'quotations', label: 'Quotations', href: '/sales/quotations', perm: 'sales.quotations.view' },
          { id: 'orders', label: 'Sales Orders', href: '/sales/orders', perm: 'sales.orders.view' },
          { id: 'production', label: 'Production Orders', href: '/records/production/work_orders', perm: 'production.work_orders.view' },
          { id: 'pick', label: 'Warehouse Pick', href: '/inventory/pick', perm: 'inventory.stock.view' },
          { id: 'deliveries', label: 'Delivery Notes', href: '/sales/delivery_notes', perm: 'sales.delivery_notes.view' },
          { id: 'invoices', label: 'Invoices', href: '/sales/invoices', perm: 'sales.invoices.view' },
          { id: 'receipts', label: 'Receipts', href: '/sales/receipts', perm: 'sales.receipts.view' },
          { id: 'credits', label: 'Credit Notes', href: '/sales/credit_notes', perm: 'sales.credit_notes.view' },
          { id: 'debits', label: 'Debit Notes', href: '/sales/debit_notes', perm: 'sales.debit_notes.view' },
          { id: 'returns', label: 'Returns', href: '/sales/returns', perm: 'sales.returns.view' },
        ],
      },
    ],
  },
  {
    id: 'supply',
    label: 'Supply Chain',
    items: [
      {
        id: 'procurement', label: 'Procurement', href: '/buy', perm: 'procurement.orders.view', module: 'procurement', accent: 'proc',
        keywords: 'purchase supplier po rfq requisition grn',
        children: [
          { id: 'overview', label: 'Board', href: '/buy', perm: 'procurement.orders.view' },
          { id: 'demand', label: 'Demand', href: '/buy/demand', perm: 'procurement.requisitions.view' },
          { id: 'requisitions', label: 'Requisitions', href: '/buy/requisitions', perm: 'procurement.requisitions.view' },
          { id: 'rfqs', label: 'RFQs', href: '/buy/rfqs', perm: 'procurement.rfqs.view' },
          { id: 'orders', label: 'Purchase Orders', href: '/buy/orders', perm: 'procurement.orders.view' },
          { id: 'grn', label: 'Goods Receipts', href: '/buy/receipts', perm: 'procurement.goods_receipts.view' },
          { id: 'invoices', label: 'Supplier Invoices', href: '/buy/invoices', perm: 'procurement.supplier_invoices.view' },
          { id: 'payments', label: 'Payments', href: '/buy/payments', perm: 'procurement.payments.view' },
          { id: 'suppliers', label: 'Suppliers', href: '/records/procurement/suppliers', perm: 'procurement.suppliers.view' },
        ],
      },
      {
        id: 'inventory', label: 'Inventory', href: '/inventory/stock', perm: 'inventory.stock.view', module: 'inventory', accent: 'inv',
        keywords: 'stock warehouse product sku',
        badge: 'inventory',
        children: [
          { id: 'assets', label: 'Assets', href: '/inventory/assets', perm: 'assets.register.view' },
          { id: 'intel', label: 'Intelligence', href: '/inventory-intel/command', perm: 'inventory.stock.view' },
          { id: 'materials', label: 'Raw Materials', href: '/inventory/materials', perm: 'inventory.items.view' },
          { id: 'consumables', label: 'Consumables', href: '/inventory/consumables', perm: 'inventory.items.view' },
          { id: 'products', label: 'Products', href: '/inventory/items', perm: 'inventory.items.view' },
          { id: 'stock', label: 'Stock', href: '/inventory/stock', perm: 'inventory.stock.view' },
          { id: 'ops', label: 'Operations', href: '/inventory/ops', perm: 'inventory.stock.view' },
          { id: 'receive', label: 'Receive', href: '/inventory/receive', perm: 'inventory.stock.view' },
          { id: 'pick', label: 'Pick', href: '/inventory/pick', perm: 'inventory.stock.view' },
          { id: 'issue', label: 'Issue', href: '/inventory/issue', perm: 'inventory.stock.view' },
          { id: 'demand', label: 'Demand / ATP', href: '/inventory/demand', perm: 'inventory.stock.view' },
          { id: 'movements', label: 'Movements', href: '/inventory/movements', perm: 'inventory.movements.view' },
          { id: 'transfers', label: 'Transfers', href: '/inventory/transfers', perm: 'inventory.transfers.view' },
          { id: 'adjustments', label: 'Adjustments', href: '/inventory/adjustments', perm: 'inventory.adjustments.view' },
          { id: 'count', label: 'Counting', href: '/inventory/adjustments/new', perm: 'inventory.adjustments.create' },
          { id: 'batches', label: 'Batches', href: '/inventory/batches', perm: 'inventory.batches.view' },
          { id: 'warehouses', label: 'Warehouses', href: '/inventory/warehouses', perm: 'inventory.warehouses.view' },
          { id: 'asset-moves', label: 'Asset Movements', href: '/records/assets/movements', perm: 'assets.movements.view' },
        ],
      },
      { id: 'warehouses', label: 'Warehouses', href: '/warehouse', perm: 'inventory.stock.view', module: 'inventory', accent: 'wh', keywords: 'receive putaway pick handheld' },
      {
        id: 'logistics', label: 'Logistics', href: '/records/logistics/trips', perm: 'logistics.trips.view', module: 'logistics', accent: 'log',
        keywords: 'trip vehicle dispatch',
        children: [
          { id: 'trips', label: 'Trips', href: '/records/logistics/trips', perm: 'logistics.trips.view' },
          { id: 'vehicles', label: 'Vehicles', href: '/records/logistics/vehicles', perm: 'logistics.vehicles.view' },
          { id: 'drivers', label: 'Drivers', href: '/records/logistics/drivers', perm: 'logistics.drivers.view' },
          { id: 'routes', label: 'Routes', href: '/records/logistics/routes', perm: 'logistics.routes.view' },
        ],
      },
    ],
  },
  {
    id: 'operations',
    label: 'Operations',
    items: [
      {
        id: 'production', label: 'Manufacturing', href: '/plant', perm: 'production.work_orders.view', module: 'production', accent: 'mfg',
        keywords: 'plant machine wo manufacture mrp requisition',
        children: [
          { id: 'command', label: 'Command Center', href: '/plant/command', perm: 'production.kpis.view' },
          { id: 'live_factory', label: 'Live Factory', href: '/plant/live', perm: 'production.machines.view' },
          { id: 'alert_center', label: 'Factory Alerts', href: '/plant/alerts', perm: 'production.kpis.view' },
          { id: 'production_wizard', label: 'Quick Create', href: '/plant/wizard', perm: 'production.work_orders.create' },
          { id: 'visual_schedule', label: 'Visual Schedule', href: '/plant/gantt-ux', perm: 'production.plans.view' },
          { id: 'operator_hub', label: 'Operator Hub', href: '/plant/operator-ux', perm: 'production.work_orders.start' },
          { id: 'qc_checklist', label: 'QC Checklist', href: '/plant/inspections-ux', perm: 'quality.inspections.view' },
          { id: 'material_issue_ux', label: 'Quick Issue', href: '/plant/issue-ux', perm: 'production.work_orders.issue' },
          { id: 'waste_recorder', label: 'Quick Waste', href: '/plant/waste-ux', perm: 'production.outputs.view' },
          { id: 'overview', label: 'Board', href: '/plant', perm: 'production.work_orders.view' },
          { id: 'demand', label: 'Sales Demand', href: '/plant/demand', perm: 'production.work_orders.view' },
          { id: 'plans', label: 'Plans', href: '/plant/plans', perm: 'production.plans.view' },
          { id: 'mrp', label: 'MRP & Requisitions', href: '/plant/mrp', perm: 'production.plans.view' },
          { id: 'dashboard', label: 'Manufacturing Dashboard', href: '/plant/dashboard', perm: 'production.kpis.view' },
          { id: 'schedule', label: 'Schedule (Gantt)', href: '/plant/gantt', perm: 'production.plans.view' },
          { id: 'standards', label: 'Standards', href: '/plant/standards', perm: 'production.work_orders.view' },
          { id: 'packaging', label: 'Packaging', href: '/plant/packaging', perm: 'production.work_orders.view' },
          { id: 'inspections', label: 'QC Inspections', href: '/plant/inspections', perm: 'quality.inspections.view' },
          { id: 'wip', label: 'WIP', href: '/plant/wip', perm: 'production.work_orders.view' },
          { id: 'outputs', label: 'Outputs', href: '/plant/outputs', perm: 'production.work_orders.view' },
          { id: 'reservations', label: 'Reservations', href: '/plant/reservations', perm: 'inventory.stock.view' },
          { id: 'issues', label: 'Material Issues', href: '/plant/issues', perm: 'production.work_orders.view' },
          { id: 'waste', label: 'Waste', href: '/plant/waste', perm: 'production.work_orders.view' },
          { id: 'scrap', label: 'Scrap', href: '/plant/scrap', perm: 'production.work_orders.view' },
          { id: 'downtime', label: 'Downtime', href: '/plant/downtime', perm: 'production.kpis.view' },
          { id: 'machine_status', label: 'Machine Status', href: '/plant/machines', perm: 'production.machines.view' },
          { id: 'ncr', label: 'Manufacturing NCRs', href: '/plant/ncr', perm: 'quality.ncrs.view' },
          { id: 'work_orders', label: 'Work Orders', href: '/plant/orders', perm: 'production.work_orders.view' },
          { id: 'shifts', label: 'Shift Handover', href: '/plant/shifts', perm: 'production.work_orders.view' },
            { id: 'machines', label: 'Machines', href: '/records/production/machines', perm: 'production.machines.view' },
{ id: 'boms', label: 'BOMs', href: '/plant/boms', perm: 'production.boms.view' },
          { id: 'costing', label: 'Costing', href: '/plant/costing', perm: 'production.costing.view' },
          { id: 'operator', label: 'Operator Floor', href: '/operator', perm: 'production.work_orders.start' },
        ],
      },
      {
        id: 'assets', label: 'Asset Management', href: '/assets', perm: 'assets.register.view', module: 'assets', accent: 'ast',
        keywords: 'asset register tag qr barcode lifecycle depreciation disposal custody',
        children: [
          { id: 'overview', label: 'Dashboard', href: '/assets', perm: 'assets.dashboards.view' },
          { id: 'register', label: 'Asset Register', href: '/assets/register', perm: 'assets.register.view' },
          { id: 'scan', label: 'Asset Scanner', href: '/assets/scan', perm: 'assets.scans.perform' },
          { id: 'verify', label: 'Verification', href: '/assets/verify', perm: 'assets.register.verify' },
          { id: 'tags', label: 'Tags', href: '/assets/tags', perm: 'assets.tags.view' },
          { id: 'custody', label: 'Custodians', href: '/assets/custody', perm: 'assets.custodians.view' },
          { id: 'transfers', label: 'Transfers', href: '/assets/transfers', perm: 'assets.transfers.view' },
          { id: 'audits', label: 'Audits', href: '/assets/audits', perm: 'assets.audits.view' },
          { id: 'maintenance', label: 'Maintenance', href: '/assets/maintenance', perm: 'assets.maintenance.view' },
          { id: 'depreciation', label: 'Depreciation', href: '/assets/depreciation', perm: 'assets.depreciation.view' },
          { id: 'impairments', label: 'Impairment', href: '/assets/impairments', perm: 'assets.impairments.view' },
          { id: 'disposals', label: 'Disposal', href: '/assets/disposals', perm: 'assets.disposals.view' },
          { id: 'anomalies', label: 'Anomalies', href: '/assets/anomalies', perm: 'assets.anomalies.view' },
          { id: 'import', label: 'Import', href: '/assets/import', perm: 'assets.imports.view' },
          { id: 'export', label: 'Export', href: '/assets/export', perm: 'assets.exports.view' },
        ],
      },
      {
        id: 'maintenance', label: 'Maintenance', href: '/records/maintenance/requests', perm: 'maintenance.requests.view', module: 'maintenance', accent: 'mnt',
        keywords: 'repair downtime request',
        children: [
          { id: 'requests', label: 'Work Requests', href: '/records/maintenance/requests', perm: 'maintenance.requests.view' },
          { id: 'schedules', label: 'Schedules', href: '/records/maintenance/schedules', perm: 'maintenance.schedules.view' },
          { id: 'work_orders', label: 'Maintenance WOs', href: '/records/maintenance/work_orders', perm: 'maintenance.work_orders.view' },
        ],
      },
      {
        id: 'quality', label: 'Quality Control', href: '/records/quality/inspections', perm: 'quality.inspections.view', module: 'quality', accent: 'qc',
        keywords: 'ncr capa inspect',
        badge: 'quality',
        children: [
          { id: 'inspections', label: 'Inspections', href: '/records/quality/inspections', perm: 'quality.inspections.view' },
          { id: 'ncrs', label: 'NCRs', href: '/records/quality/ncrs', perm: 'quality.ncrs.view' },
          { id: 'capa', label: 'CAPA', href: '/records/quality/capa', perm: 'quality.capa.view' },
          { id: 'defects', label: 'Defects', href: '/records/quality/defects', perm: 'quality.defects.view' },
        ],
      },
      {
        id: 'documents', label: 'Document Management', href: '/documents', perm: 'documents.view', module: 'documents', accent: 'doc',
        keywords: 'documents dms library folders policies procedures contracts qms files',
        children: [
          { id: 'doc_dashboard', label: 'Dashboard', href: '/documents', perm: 'documents.command.view' },
          { id: 'doc_library', label: 'Library', href: '/documents/library', perm: 'documents.view' },
          { id: 'doc_folders', label: 'Folders', href: '/documents/folders', perm: 'documents.folders.manage' },
          { id: 'doc_approvals', label: 'Approvals', href: '/documents/approvals', perm: 'documents.approve' },
          { id: 'doc_audit', label: 'Activity', href: '/documents/audit', perm: 'documents.command.view' },
          { id: 'doc_settings', label: 'Settings', href: '/documents/settings', perm: 'documents.settings.manage' },
        ],
      },
    ],
  },
  {
    id: 'security',
    label: 'Security',
    items: [
      {
        id: 'security', label: 'Security Printing', href: '/security-jobs', perm: 'security_printing.jobs.view', module: 'security_printing', accent: 'sec',
        keywords: 'secure print custody job',
        badge: 'security',
        children: [
          { id: 'jobs', label: 'Secure Jobs', href: '/security-jobs', perm: 'security_printing.jobs.view' },
          { id: 'qr', label: 'QR & Traceability', href: '/qr/scan' },
          { id: 'packing', label: 'Ream Packing', href: '/packing', perm: 'qr.packing.scan' },
          { id: 'labels', label: 'Label Varieties', href: '/labels', perm: 'qr.templates.view' },
        ],
      },
    ],
  },
  {
    id: 'finance',
    label: 'Finance',
    items: [
      {
        id: 'finance', label: 'Accounting', href: '/finance', perm: 'finance.journals.view', module: 'finance', accent: 'fin',
        keywords: 'journal bank cash books',
        children: [
          { id: 'overview', label: 'Overview', href: '/finance', perm: 'finance.journals.view' },
          { id: 'journals', label: 'Journals', href: '/finance/journals', perm: 'finance.journals.view' },
          { id: 'expenses', label: 'Expenses', href: '/finance/expenses', perm: 'finance.expenses.view' },
          { id: 'budgets', label: 'Budgets', href: '/finance/budgets', perm: 'finance.budgets.view' },
          { id: 'tb', label: 'Trial Balance', href: '/finance/trial-balance', perm: 'finance.journals.view' },
          { id: 'pl', label: 'Profit & Loss', href: '/finance/profit-loss', perm: 'finance.journals.view' },
          { id: 'bs', label: 'Balance Sheet', href: '/finance/balance-sheet', perm: 'finance.journals.view' },
          { id: 'ar', label: 'Receivables', href: '/finance/ar', perm: 'finance.journals.view' },
          { id: 'ap', label: 'Payables', href: '/finance/ap', perm: 'finance.journals.view' },
          { id: 'banks', label: 'Banking', href: '/finance/banks', perm: 'finance.banks.view' },
          { id: 'transfers', label: 'Transfers', href: '/finance/transfers', perm: 'finance.banks.view' },
          { id: 'advances', label: 'Advances', href: '/finance/advances', perm: 'finance.advances.view' },
          { id: 'periods', label: 'Periods', href: '/finance/periods', perm: 'finance.periods.view' },
          { id: 'tax', label: 'VAT', href: '/finance/tax', perm: 'finance.taxes.view' },
          { id: 'coa', label: 'Chart of Accounts', href: '/finance/accounts', perm: 'finance.chart_of_accounts.view' },
          { id: 'advanced', label: 'Advanced', href: '/finance/advanced', perm: 'finance.journals.view' },
          { id: 'posting-rules', label: 'Posting Rules', href: '/finance/posting-rules', perm: 'finance.posting_rules.view' },
          { id: 'efris', label: 'EFRIS', href: '/finance/efris', perm: 'finance.efris.view' },
          { id: 'tax-compliance', label: 'Tax Compliance', href: '/finance/tax-compliance', perm: 'finance.tax_transactions.view' },
          { id: 'costing', label: 'Manufacturing Costing', href: '/finance/costing', perm: 'finance.production_costs.view' },
          { id: 'consolidation', label: 'Consolidation', href: '/finance/consolidation', perm: 'finance.consolidation.view' },
          { id: 'close', label: 'Period Close', href: '/finance/close', perm: 'finance.close_tasks.view' },
          { id: 'audit', label: 'Audit Trail', href: '/finance/audit', perm: 'finance.audit.view' },
        ],
      },
    ],
  },
  {
    id: 'spend',
    label: 'Requisitions & Spend',
    items: [
      {
        id: 'spend', label: 'Requisitions & Spend', href: '/spend', perm: 'expenditure.dashboards.view', module: 'expenditure', accent: 'fin',
        keywords: 'requisition expenditure petty cash expense claim budget approval',
        children: [
          { id: 'board', label: 'Command Center', href: '/spend', perm: 'expenditure.dashboards.view' },
          { id: 'requisitions', label: 'Requisitions', href: '/spend/requisitions', perm: 'expenditure.requisitions.view' },
          { id: 'expenses', label: 'Daily Expenditure', href: '/spend/expenses', perm: 'expenditure.expenses.view' },
          { id: 'petty-cash', label: 'Petty Cash', href: '/spend/petty-cash', perm: 'expenditure.petty_cash.view' },
          { id: 'claims', label: 'Expense Claims', href: '/spend/claims', perm: 'expenditure.claims.view' },
          { id: 'close', label: 'Daily Close', href: '/spend/close', perm: 'expenditure.daily_close.view' },
        ],
      },
    ],
  },
  {
    id: 'people',
    label: 'People',
    items: [
      {
        id: 'hr', label: 'HR', href: '/people', perm: 'hr.employees.view', module: 'hr', accent: 'hr',
        keywords: 'employee leave payroll people nssf paye',
        children: [
          { id: 'overview', label: 'Board', href: '/people', perm: 'hr.employees.view' },
          { id: 'org', label: 'Org Chart', href: '/people/org', perm: 'hr.employees.view' },
          { id: 'positions', label: 'Positions', href: '/people/positions', perm: 'hr.positions.view' },
          { id: 'workforce', label: 'Workforce Plans', href: '/people/workforce', perm: 'hr.workforce_plans.view' },
          { id: 'requisitions', label: 'Requisitions', href: '/people/requisitions', perm: 'hr.requisitions.view' },
          { id: 'recruitment', label: 'Recruitment', href: '/people/recruitment', perm: 'hr.applications.view' },
          { id: 'vacancies', label: 'Vacancies', href: '/people/vacancies', perm: 'hr.vacancies.view' },
          { id: 'candidates', label: 'Candidates', href: '/people/candidates', perm: 'hr.candidates.view' },
          { id: 'onboarding', label: 'Onboarding', href: '/people/onboarding', perm: 'hr.onboarding.view' },
          { id: 'employees', label: 'Employees', href: '/people/employees', perm: 'hr.employees.view' },
          { id: 'employee-ids', label: 'Employee IDs', href: '/people/employee-ids', perm: 'hr.employee_identity.view' },
          { id: 'contracts', label: 'Contracts', href: '/people/contracts', perm: 'hr.contracts.view' },
          { id: 'contract-templates', label: 'Contract Templates', href: '/people/contracts/templates', perm: 'hr.contracts.view' },
          { id: 'expiring-contracts', label: 'Expiring', href: '/people/contracts/expiring', perm: 'hr.contracts.view' },
          { id: 'leave', label: 'Leave', href: '/people/leave', perm: 'hr.leave.view' },
          { id: 'leave-calendar', label: 'Leave Calendar', href: '/people/leave/calendar', perm: 'hr.holidays.view' },
          { id: 'leave-balances', label: 'Leave Balances', href: '/people/leave/balances', perm: 'hr.leave_balances.view' },
          { id: 'attendance', label: 'Attendance', href: '/people/attendance', perm: 'hr.attendance.view' },
          { id: 'time', label: 'Time & Shifts', href: '/people/time', perm: 'hr.shifts.view' },
          { id: 'payroll', label: 'Payroll', href: '/people/payrolls', perm: 'hr.payrolls.view' },
          { id: 'payroll-exceptions', label: 'Exceptions', href: '/people/exceptions', perm: 'hr.payrolls.view' },
          { id: 'loans', label: 'Loans', href: '/people/loans', perm: 'hr.loans.view' },
          { id: 'advances', label: 'Salary Advances', href: '/people/advances', perm: 'hr.advances.view' },
          { id: 'payments', label: 'Pay Batches', href: '/people/payments', perm: 'hr.payrolls.view' },
          { id: 'off-cycle', label: 'Off-cycle', href: '/people/off-cycle', perm: 'hr.payrolls.create' },
          { id: 'arrears', label: 'Arrears', href: '/people/arrears', perm: 'hr.payrolls.view' },
          { id: 'final-settlements', label: 'Final Settlements', href: '/people/final-settlements', perm: 'hr.final_settlements.view' },
          { id: 'offboardings', label: 'Offboarding', href: '/people/offboardings', perm: 'hr.offboardings.view' },
          { id: 'performance', label: 'Performance', href: '/people/performance', perm: 'hr.performance_goals.view' },
          { id: 'training', label: 'Training', href: '/people/training', perm: 'hr.training_catalog.view' },
          { id: 'benefits', label: 'Benefits', href: '/people/benefits', perm: 'hr.benefit_plans.view' },
          { id: 'relations', label: 'Relations', href: '/people/relations', perm: 'hr.grievances.view' },
          { id: 'me', label: 'My HR', href: '/people/me', perm: 'hr.leave.view' },
        ],
      },
    ],
  },
  {
    id: 'analytics',
    label: 'Analytics',
    items: [
      { id: 'reports', label: 'Reports', href: '/reports', accent: 'rpt', keywords: 'report kpi export bi' },
    ],
  },
  {
    id: 'communication',
    label: 'Communication',
    items: [
      {
        id: 'communication_center', label: 'Comm Center', href: '/communication', perm: 'communication.command.view', module: 'communication', accent: 'com',
        keywords: 'inbox messages notifications email announcements templates delivery logs chat comms communication health sms test',
        children: [
          { id: 'com_center', label: 'Command Center', href: '/communication', perm: 'communication.command.view' },
          { id: 'com_health', label: 'Health', href: '/communication/admin', perm: 'communication.command.view' },
          { id: 'com_messages', label: 'Messages', href: '/communication/messages', perm: 'communication.messages.view' },
          { id: 'com_notifications', label: 'Notifications', href: '/communication/notifications', perm: 'communication.notifications.view' },
          { id: 'com_email', label: 'Email', href: '/communication/email', perm: 'communication.emails.view' },
          { id: 'com_announcements', label: 'Announcements', href: '/communication/announcements', perm: 'communication.announcements.view' },
          { id: 'com_templates', label: 'Templates', href: '/communication/templates', perm: 'communication.templates.view' },
          { id: 'com_deliveries', label: 'Delivery Logs', href: '/communication/deliveries', perm: 'communication.delivery_logs.view' },
          { id: 'com_settings', label: 'Settings', href: '/communication/settings', perm: 'communication.settings.manage' },
        ],
      },
    ],
  },
  {
    id: 'admin',
    label: 'Administration',
    items: [
      {
        id: 'adminhome', label: 'Administration', href: '/admin', perm: 'admin.users.view', module: 'admin', accent: 'adm',
        keywords: 'admin users roles permissions rbac abac policies sod security sessions audit settings features health backups identity access control database db dba schema tables indexes queries monitoring storage migration restore',
        children: [
          { id: 'admindash', label: 'Dashboard', href: '/admin', perm: 'admin.users.view' },
          { id: 'admindatabase', label: 'Database', href: '/admin/database', perm: 'database.health.view' },
          { id: 'adminusers', label: 'Users', href: '/admin/users', perm: 'admin.users.view' },
          { id: 'adminroles', label: 'Roles', href: '/admin/roles', perm: 'admin.roles.view' },
          { id: 'adminpolicies', label: 'Policies', href: '/admin/policies', perm: 'admin.policies.view' },
          { id: 'adminsod', label: 'SoD', href: '/admin/sod', perm: 'admin.sod.view' },
          { id: 'adminsecurity', label: 'Security', href: '/admin/security', perm: 'admin.security.view' },
          { id: 'adminsessions', label: 'Sessions', href: '/admin/sessions', perm: 'admin.sessions.view' },
          { id: 'adminaudit', label: 'Audit', href: '/admin/audit', perm: 'admin.audit_logs.view' },
          { id: 'adminsettings', label: 'Settings', href: '/admin/settings', perm: 'admin.settings.view' },
          { id: 'adminfeatures', label: 'Features', href: '/admin/features', perm: 'admin.feature_flags.view' },
          { id: 'adminhealth', label: 'Health', href: '/admin/health', perm: 'admin.health.view' },
          { id: 'adminbackups', label: 'Backups', href: '/admin/backups', perm: 'admin.backups.view' },
        ],
      },
      {
        id: 'admin', label: 'Workflows', href: '/records/workflows/workflows', perm: 'workflows.workflows.view', module: 'workflows', accent: 'adm',
        keywords: 'workflow policy audit settings',
        children: [
          { id: 'workflows', label: 'Workflows', href: '/records/workflows/workflows', perm: 'workflows.workflows.view' },
          { id: 'instances', label: 'Instances', href: '/records/workflows/instances', perm: 'workflows.instances.view' },
        ],
      },
      {
        id: 'exports', label: 'Data Export', href: '/exports', perm: 'admin.exports.run', accent: 'adm',
        keywords: 'export csv xlsx json data download tenant company branch audit',
      },
      {
        id: 'settings', label: 'Settings', href: '/settings', perm: 'admin.settings.view', accent: 'adm',
        keywords: 'settings preference config system company profile',
      },
    ],
  },
];

export const ALL_NAV_ITEMS: NavItem[] = NAV_GROUPS.flatMap((g) => g.items);

const CORE_MODULES = new Set(['admin', 'database', 'settings', 'workflows', 'reports']);

function moduleActiveForTenant(user: MeUser | null, module?: string): boolean {
  if (!module) return true;
  if (CORE_MODULES.has(module)) return true;
  const active = user?.activate_modules;
  if (!active || active.length === 0) return true;
  return active.includes(module);
}

export function itemVisible(user: MeUser | null, item: { perm?: string; module?: string }): boolean {
  if (!moduleActiveForTenant(user, item.module)) return false;
  if (item.perm && !can(user, item.perm)) return false;
  return true;
}

export function visibleGroups(user: MeUser | null): NavGroup[] {
  return NAV_GROUPS.map((g) => ({
    ...g,
    items: g.items
      .map((item) => {
        const children = item.children?.filter((c) => itemVisible(user, { ...c, module: item.module }));
        return { ...item, children };
      })
      .filter((item) => {
        if (item.children && item.children.length > 0) return true;
        return itemVisible(user, item);
      }),
  })).filter((g) => g.items.length > 0);
}

export function findItemByHref(href: string): NavItem | undefined {
  return ALL_NAV_ITEMS.find((i) => i.href === href);
}

export function findItemById(id: string): NavItem | undefined {
  return ALL_NAV_ITEMS.find((i) => i.id === id);
}

export function moduleActive(href: string, path: string): boolean {
  if (path === href || path.startsWith(`${href}/`)) return true;
  if (href.startsWith('/sales') && (path.startsWith('/sales') || path.startsWith('/records/sales'))) return true;
  if (href.startsWith('/inventory') && (path.startsWith('/inventory') || path.startsWith('/records/inventory'))) return true;
  if (href === '/inventory/stock' && path.includes('/assets/')) return true;
  if (href === '/assets' && (path === '/assets' || path.startsWith('/assets/'))) return true;
  if (href === '/warehouse' && (path.startsWith('/warehouse') || path === '/inventory/warehouses')) return true;
  if (href === '/plant' && (path.startsWith('/plant') || path.includes('/production/') || path.startsWith('/operator') || path.startsWith('/manufacturing'))) return true;
  if (href === '/finance' && (path.startsWith('/finance') || path.includes('/finance/'))) return true;
  if (href === '/spend' && path.startsWith('/spend')) return true;
  if (href === '/buy' && (path.startsWith('/buy') || path.includes('/procurement/'))) return true;
  if (href === '/crm' && (path.startsWith('/crm') || path.includes('/crm/'))) return true;
  if (href === '/people' && (path.startsWith('/people') || path.includes('/hr/'))) return true;
  if (href === '/security-jobs' && (path.startsWith('/security') || path.includes('/security_printing/'))) return true;
  if (href === '/communication' && path.startsWith('/communication')) return true;
  if (href === '/documents' && path.startsWith('/documents')) return true;
  if (href.includes('/crm/') && path.includes('/crm/')) return true;
  if (href.includes('/procurement/') && path.includes('/procurement/')) return true;
  if (href.includes('/quality/') && path.includes('/quality/')) return true;
  if (href.includes('/hr/') && path.includes('/hr/')) return true;
  if (href.includes('/assets/') && path.includes('/assets/')) return true;
  if (href.includes('/logistics/') && path.includes('/logistics/')) return true;
  if (href.includes('/maintenance/') && path.includes('/maintenance/')) return true;
  if (href.includes('/workflows/') && path.includes('/workflows/')) return true;
  return false;
}

export function activeItem(path: string, user: MeUser | null): NavItem | undefined {
  const visible = ALL_NAV_ITEMS.filter((i) => itemVisible(user, i));
  return visible.find((i) => moduleActive(i.href, path) && i.id !== 'warehouses') ?? visible.find((i) => moduleActive(i.href, path));
}

export function moduleChildrenFor(path: string, user: MeUser | null): NavChild[] {
  const item = activeItem(path, user);
  return (item?.children ?? []).filter((c) => itemVisible(user, { ...c, module: item?.module }));
}

export function childActive(href: string, path: string): boolean {
  if (path === href || path.startsWith(`${href}/`)) return true;
  return false;
}

export interface RecordTab {
  id: string;
  label: string;
  href?: string;
}

export function recordTabs(module: string, resource: string): RecordTab[] {
  if (module === 'inventory' && resource === 'items') {
    return [
      { id: 'overview', label: 'Overview' },
      { id: 'stock', label: 'Stock', href: '/inventory/stock' },
      { id: 'batches', label: 'Batches', href: '/inventory/batches' },
      { id: 'qr', label: 'QR' },
      { id: 'timeline', label: 'Timeline' },
      { id: 'audit', label: 'Audit' },
    ];
  }
  if (module === 'production' && resource === 'machines') {
    return [
      { id: 'overview', label: 'Overview' },
      { id: 'production', label: 'Production', href: '/records/production/work_orders' },
      { id: 'downtime', label: 'Downtime', href: '/records/production/downtime' },
      { id: 'maintenance', label: 'Maintenance', href: '/records/maintenance/requests' },
      { id: 'qr', label: 'QR' },
      { id: 'audit', label: 'History' },
    ];
  }
  if ((module === 'security_printing' && resource === 'jobs') || (module === 'security' && resource === 'jobs')) {
    return [
      { id: 'overview', label: 'Overview' },
      { id: 'qr', label: 'QR' },
      { id: 'timeline', label: 'Custody' },
      { id: 'audit', label: 'Audit' },
    ];
  }
  return [
    { id: 'overview', label: 'Overview' },
    { id: 'timeline', label: 'Timeline' },
    { id: 'qr', label: 'QR' },
    { id: 'audit', label: 'Audit' },
  ];
}

export interface Crumb {
  label: string;
  href?: string;
}

export function crumbsFor(path: string, extra?: Crumb[]): Crumb[] {
  const parts = path.split('/').filter(Boolean);
  const crumbs: Crumb[] = [{ label: 'Home', href: '/dashboard' }];
  const item = ALL_NAV_ITEMS.find((i) => moduleActive(i.href, path));
  if (item) crumbs.push({ label: item.label, href: item.href });
  const child = item?.children?.find((c) => childActive(c.href, path) && c.href !== item.href);
  if (child) crumbs.push({ label: child.label, href: child.href });
  if (parts[0] === 'records' && parts[3] && !Number.isNaN(Number(parts[3]))) {
    crumbs.push({ label: `#${parts[3]}` });
  } else if (parts[0] === 'sales' && parts[2] && Number(parts[2]) > 0) {
    crumbs.push({ label: `#${parts[2]}` });
  } else if (parts[0] === 'inventory' && parts[2] && Number(parts[2]) > 0) {
    crumbs.push({ label: `#${parts[2]}` });
  } else if (parts[0] === 'qr' && parts[1] && parts[1] !== 'scan') {
    crumbs.push({ label: decodeURIComponent(parts[1]) });
  } else if (parts[0] === 'operator' && parts[1]) {
    crumbs.push({ label: `WO #${parts[1]}` });
  } else if (parts[0] === 'buy' && parts[2] && Number(parts[2]) > 0) {
    crumbs.push({ label: `#${parts[2]}` });
  } else if (parts[0] === 'crm' && parts[2] && Number(parts[2]) > 0) {
    crumbs.push({ label: `#${parts[2]}` });
  } else if (parts[0] === 'assets' && parts[2] && Number(parts[2]) > 0) {
    crumbs.push({ label: `#${parts[2]}` });
  } else if (parts[0] === 'people' && parts[2] && Number(parts[2]) > 0) {
    crumbs.push({ label: `#${parts[2]}` });
  }
  if (extra) crumbs.push(...extra);
  const seen = new Set<string>();
  return crumbs.filter((c) => {
    const k = `${c.label}|${c.href ?? ''}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export function requiredPermForPath(path: string): string | undefined {
  const parts = path.split('/').filter(Boolean);
  if (path === '/exports') return 'admin.exports.run';
  if (path === '/settings') return 'admin.settings.view';
  if (parts[0] === 'admin') {
    const map: Record<string, string> = {
      users: 'admin.users.view',
      roles: 'admin.roles.view',
      policies: 'admin.policies.view',
      database: 'database.health.view',
      sod: 'admin.sod.view',
      security: 'admin.security.view',
      sessions: 'admin.sessions.view',
      audit: 'admin.audit_logs.view',
      settings: 'admin.settings.view',
      features: 'admin.feature_flags.view',
      health: 'admin.health.view',
      backups: 'admin.backups.view',
    };
    return map[parts[1] ?? ''] ?? 'admin.users.view';
  }
  if (parts[0] === 'records' && parts[1] && parts[2]) {
    return `${parts[1]}.${parts[2]}.view`;
  }
  if (parts[0] === 'people') {
    const map: Record<string, string> = {
      employees: 'hr.employees.view',
      'employee-ids': 'hr.employee_identity.view',
      org: 'hr.employees.view',
      positions: 'hr.positions.view',
      workforce: 'hr.workforce_plans.view',
      'workforce-plans': 'hr.workforce_plans.view',
      scenarios: 'hr.workforce_plans.view',
      leave: 'hr.leave.view',
      attendance: 'hr.attendance.view',
      payrolls: 'hr.payrolls.view',
      requisitions: 'hr.requisitions.view',
      recruitment: 'hr.applications.view',
      vacancies: 'hr.vacancies.view',
      candidates: 'hr.candidates.view',
      onboarding: 'hr.onboarding.view',
      contracts: 'hr.contracts.view',
      arrears: 'hr.payrolls.view',
      exceptions: 'hr.payrolls.view',
      loans: 'hr.loans.view',
      advances: 'hr.advances.view',
      payments: 'hr.payrolls.view',
      'off-cycle': 'hr.payrolls.view',
      'final-settlements': 'hr.final_settlements.view',
      offboardings: 'hr.offboardings.view',
      performance: 'hr.performance_goals.view',
      training: 'hr.training_catalog.view',
      benefits: 'hr.benefit_plans.view',
      relations: 'hr.grievances.view',
      time: 'hr.shifts.view',
      me: 'hr.leave.view',
      hcm: 'hr.employees.view',
    };
    if (parts[1] === 'leave') {
      if (parts[2] === 'balances') return 'hr.leave_balances.view';
      if (parts[2] === 'calendar') return 'hr.holidays.view';
    }
    return map[parts[1] ?? ''] ?? 'hr.employees.view';
  }
  if (parts[0] === 'crm') {
    const map: Record<string, string> = {
      leads: 'crm.leads.view',
      pipeline: 'crm.opportunities.view',
      opportunities: 'crm.opportunities.view',
      customers: 'crm.customers.view',
      contacts: 'crm.contacts.view',
      activities: 'crm.activities.view',
      complaints: 'crm.complaints.view',
      analytics: 'crm.customers.view',
      mine: 'crm.activities.view',
    };
    return map[parts[1] ?? ''] ?? 'crm.customers.view';
  }
  if (parts[0] === 'plant' && parts[1] === 'command') return 'production.kpis.view';
  if (parts[0] === 'plant' && parts[1] === 'mrp') return 'production.plans.view';
  if (parts[0] === 'plant') return 'production.work_orders.view';
  if (parts[0] === 'finance') return 'finance.journals.view';
  if (parts[0] === 'spend') return 'expenditure.dashboards.view';
  if (path === '/packing') return 'qr.packing.scan';
  if (path === '/labels') return 'qr.templates.view';
  if (parts[0] === 'buy') {
    const map: Record<string, string> = {
      demand: 'procurement.requisitions.view',
      requisitions: 'procurement.requisitions.view',
      rfqs: 'procurement.rfqs.view',
      orders: 'procurement.orders.view',
      receipts: 'procurement.goods_receipts.view',
      invoices: 'procurement.supplier_invoices.view',
      payments: 'procurement.payments.view',
    };
    return map[parts[1] ?? ''] ?? 'procurement.orders.view';
  }
  if (parts[0] === 'sales' && parts[1] === 'customers') return 'sales.quotations.view';
  if (parts[0] === 'sales' && parts[1]) return `sales.${parts[1]}.view`;
  if (parts[0] === 'inventory-intel') return 'inventory.stock.view';
  if (parts[0] === 'inventory' && parts[1]) {
    const map: Record<string, string> = {
      stock: 'inventory.stock.view',
      ops: 'inventory.stock.view',
      receive: 'inventory.stock.view',
      pick: 'inventory.stock.view',
      issue: 'inventory.stock.view',
      demand: 'inventory.stock.view',
      putaway: 'inventory.movements.create',
      assets: 'assets.register.view',
      materials: 'inventory.items.view',
      items: 'inventory.items.view',
      warehouses: 'inventory.warehouses.view',
      movements: 'inventory.movements.view',
      transfers: 'inventory.transfers.view',
      adjustments: 'inventory.adjustments.view',
      batches: 'inventory.batches.view',
      reservations: 'inventory.reservations.view',
    };
    return map[parts[1]];
  }
  if (parts[0] === 'communication') {
    const map: Record<string, string> = {
      messages: 'communication.messages.view',
      notifications: 'communication.notifications.view',
      email: 'communication.emails.view',
      announcements: 'communication.announcements.view',
      templates: 'communication.templates.view',
      deliveries: 'communication.delivery_logs.view',
      settings: 'communication.settings.manage',
    };
    return map[parts[1] ?? ''] ?? 'communication.command.view';
  if (parts[0] === 'documents') {
    const map: Record<string, string> = {
      library: 'documents.view', folders: 'documents.view', approvals: 'documents.approve',
      audit: 'documents.command.view', settings: 'documents.settings.manage',
    };
    return map[parts[1] ?? ''] ?? 'documents.command.view';
  }
  }
  if (parts[0] === 'assets') {
    const map: Record<string, string> = {
      register: 'assets.register.view',
      tags: 'assets.tags.view',
      transfers: 'assets.transfers.view',
      audits: 'assets.audits.view',
      maintenance: 'assets.maintenance.view',
      depreciation: 'assets.depreciation.view',
      impairments: 'assets.impairments.view',
      disposals: 'assets.disposals.view',
      anomalies: 'assets.anomalies.view',
      import: 'assets.imports.view',
      export: 'assets.exports.view',
      verify: 'assets.register.verify',
      scan: 'assets.scans.perform',
      custody: 'assets.custodians.view',
    };
    return map[parts[1] ?? ''] ?? 'assets.register.view';
  }
  const item = ALL_NAV_ITEMS.find((i) => moduleActive(i.href, path));
  return item?.perm;
}

export function isFocusPath(path: string): boolean {
  return path.startsWith('/operator') || path === '/warehouse/floor';
}

export function normalizePath(path: string): string {
  if (path.startsWith('/manufacturing/work-orders')) return path.replace('/manufacturing/work-orders', '/records/production/work_orders');
  if (path.startsWith('/machines/')) return path.replace('/machines/', '/records/production/machines/');
  if (path === '/machines') return '/records/production/machines';
  if (path === '/security/jobs') return '/security-jobs';
  if (path.startsWith('/security/jobs/')) return path.replace('/security/jobs/', '/records/security_printing/jobs/');
  if (path.startsWith('/finance/invoices/')) return path.replace('/finance/invoices/', '/sales/invoices/');
  if (path === '/procurement' || path === '/records/procurement') return '/buy';
  if (path.startsWith('/records/procurement/orders')) return path.replace('/records/procurement/orders', '/buy/orders');
  if (path.startsWith('/records/procurement/requisitions')) return path.replace('/records/procurement/requisitions', '/buy/requisitions');
  if (path.startsWith('/records/procurement/goods_receipts')) return path.replace('/records/procurement/goods_receipts', '/buy/receipts');
  if (path.startsWith('/records/procurement/supplier_invoices')) return path.replace('/records/procurement/supplier_invoices', '/buy/invoices');
  if (path.startsWith('/records/procurement/payments')) return path.replace('/records/procurement/payments', '/buy/payments');
  if (path.startsWith('/records/procurement/rfqs')) return path.replace('/records/procurement/rfqs', '/buy/rfqs');
  if (path === '/records/crm' || path === '/records/crm/customers') return path === '/records/crm' ? '/crm' : '/crm/customers';
  if (path.startsWith('/records/crm/customers')) return path.replace('/records/crm/customers', '/crm/customers');
  if (path.startsWith('/records/crm/leads')) return path.replace('/records/crm/leads', '/crm/leads');
  if (path.startsWith('/records/crm/opportunities')) return path.replace('/records/crm/opportunities', '/crm/opportunities');
  if (path.startsWith('/records/crm/activities')) return path.replace('/records/crm/activities', '/crm/activities');
  if (path.startsWith('/records/crm/complaints')) return path.replace('/records/crm/complaints', '/crm/complaints');
  if (path.startsWith('/records/crm/contacts')) return path.replace('/records/crm/contacts', '/crm/contacts');
  if (path === '/hr' || path === '/records/hr') return '/people';
  if (path.startsWith('/records/hr/employees')) return path.replace('/records/hr/employees', '/people/employees');
  if (path.startsWith('/records/hr/leave')) return path.replace('/records/hr/leave', '/people/leave');
  if (path.startsWith('/records/hr/attendance')) return path.replace('/records/hr/attendance', '/people/attendance');
  if (path.startsWith('/records/hr/payrolls')) return path.replace('/records/hr/payrolls', '/people/payrolls');
  if (path.startsWith('/records/hr/requisitions')) return path.replace('/records/hr/requisitions', '/people/requisitions');
  if (path.startsWith('/records/hr/vacancies')) return path.replace('/records/hr/vacancies', '/people/vacancies');
  if (path.startsWith('/records/hr/candidates')) return path.replace('/records/hr/candidates', '/people/candidates');
  if (path.startsWith('/records/hr/applications')) return path.replace('/records/hr/applications', '/people/recruitment');
  if (path.startsWith('/records/hr/interviews')) return path.replace('/records/hr/interviews', '/people/recruitment');
  if (path.startsWith('/records/hr/offers')) return path.replace('/records/hr/offers', '/people/candidates');
  if (path.startsWith('/records/hr/onboarding')) return path.replace('/records/hr/onboarding', '/people/onboarding');
  if (path.startsWith('/records/hr/divisions') || path.startsWith('/records/hr/locations') || path.startsWith('/records/hr/org_units') || path.startsWith('/records/hr/teams') || path.startsWith('/records/hr/job_families') || path.startsWith('/records/hr/job_grades')) return '/people/org';
  if (path.startsWith('/records/hr/positions')) return path.replace('/records/hr/positions', '/people/positions');
  if (path.startsWith('/records/hr/position_assignments')) return path.replace('/records/hr/position_assignments', '/people/positions');
  if (path.startsWith('/records/hr/workforce_plans')) return path.replace('/records/hr/workforce_plans', '/people/workforce');
  if (path.startsWith('/records/hr/loans')) return path.replace('/records/hr/loans', '/people/loans');
  if (path.startsWith('/records/hr/performance_goals') || path.startsWith('/records/hr/performance_reviews') || path.startsWith('/records/hr/pips')) return '/people/performance';
  if (path.startsWith('/records/hr/training')) return '/people/training';
  if (path.startsWith('/records/hr/benefit')) return '/people/benefits';
  if (path.startsWith('/records/hr/grievances') || path.startsWith('/records/hr/disciplinary') || path.startsWith('/records/hr/warnings')) return '/people/relations';
  if (path.startsWith('/records/hr/shifts') || path.startsWith('/records/hr/timesheets') || path.startsWith('/records/hr/overtime')) return '/people/time';
  if (path.startsWith('/records/hr/offboardings')) return path.replace('/records/hr/offboardings', '/people/offboardings');
  return path;
}

export function hrefForSearchHit(table: string, match: Record<string, unknown>): string {
  const id = match.id;
  const code = match.code;
  switch (table) {
    case 'sales_orders': return `/sales/orders/${id}`;
    case 'sales_quotations': return `/sales/quotations/${id}`;
    case 'sales_invoices': return `/sales/invoices/${id}`;
    case 'products': return `/inventory/items/${id}`;
    case 'assets': return `/records/assets/register/${id}`;
    case 'warehouses': return `/inventory/warehouses/${id}`;
    case 'machines': return `/records/production/machines/${id}`;
    case 'work_orders': return `/records/production/work_orders/${id}`;
    case 'qr_codes': return `/qr/${code ?? id}`;
    case 'customers': return `/crm/customers/${id}`;
    case 'leads': return `/crm/leads/${id}`;
    case 'opportunities': return `/crm/opportunities/${id}`;
    case 'complaints': return `/crm/complaints/${id}`;
    case 'employees': return `/people/employees/${id}`;
    case 'payrolls': return `/people/payrolls/${id}`;
    case 'suppliers': return `/records/procurement/suppliers/${id}`;
    case 'purchase_orders': return `/buy/orders/${id}`;
    case 'purchase_requisitions': return `/buy/requisitions/${id}`;
    case 'goods_receipts': return `/buy/receipts/${id}`;
    case 'supplier_invoices': return `/buy/invoices/${id}`;
    default: {
      if (typeof table === 'string' && table.includes('_')) {
        const [mod, ...rest] = table.split('_');
        return `/records/${mod}/${rest.join('_')}/${id}`;
      }
      return `/dashboard`;
    }
  }
}

export function looksLikeQr(q: string): boolean {
  return /^(HDG[-_]|QR[-_])/i.test(q.trim()) || /FG-\d{4}-\d+/i.test(q.trim());
}

export type Breakpoint = 'mobile' | 'phablet' | 'tablet' | 'laptop' | 'desktop' | 'wide';

export function breakpointOf(width: number): Breakpoint {
  if (width < 640) return 'mobile';
  if (width < 768) return 'phablet';
  if (width < 1024) return 'tablet';
  if (width < 1280) return 'laptop';
  if (width < 1536) return 'desktop';
  return 'wide';
}

export function track(event: string, props: Record<string, string | number | boolean> = {}) {
  try {
    const row = { t: Date.now(), e: event, ...props };
    const raw = sessionStorage.getItem('hope.os.telemetry');
    const buf = raw ? JSON.parse(raw) as unknown[] : [];
    buf.push(row);
    sessionStorage.setItem('hope.os.telemetry', JSON.stringify(buf.slice(-200)));
  } catch { /* ignore */ }
}