/** Read a value from a row that may use snake_case or camelCase keys. */
export function pick<T = unknown>(row: Record<string, unknown>, ...keys: string[]): T | undefined {
  for (const k of keys) {
    if (row[k] !== undefined && row[k] !== null) return row[k] as T;
  }
  return undefined;
}

/** Stable display of a value. */
export function displayValue(v: unknown): string {
  if (v === null || v === undefined) return '-';
  if (typeof v === 'object') {
    try {
      return JSON.stringify(v);
    } catch {
      return '[object]';
    }
  }
  return String(v);
}

export function titleCase(s: string): string {
  return s
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export function moduleLabel(module: string): string {
  const map: Record<string, string> = {
    crm: 'CRM',
    sales: 'Sales',
    procurement: 'Procurement',
    inventory: 'Inventory',
    production: 'Manufacturing',
    quality: 'Quality',
    security_printing: 'Security Printing',
    maintenance: 'Maintenance',
    logistics: 'Logistics',
    finance: 'Finance',
    hr: 'HR',
    assets: 'Assets',
    documents: 'Documents',
    healthcare: 'Healthcare',
    workflows: 'Administration',
    notifications: 'Notifications',
  };
  return map[module] ?? titleCase(module);
}

export interface NavItem {
  module: string;
  label: string;
  icon: string;
  resources: { resource: string; label: string }[];
}

export const NAV: NavItem[] = [
  {
    module: 'crm', label: 'CRM', icon: '\u{1F465}',
    resources: [
      { resource: 'customers', label: 'Customers' },
      { resource: 'contacts', label: 'Contacts' },
      { resource: 'leads', label: 'Leads' },
      { resource: 'opportunities', label: 'Opportunities' },
      { resource: 'activities', label: 'Activities' },
      { resource: 'complaints', label: 'Complaints' },
    ],
  },
  {
    module: 'sales', label: 'Sales', icon: '\u{1F4B0}',
    resources: [
      { resource: 'quotations', label: 'Quotations' },
      { resource: 'orders', label: 'Sales Orders' },
      { resource: 'delivery_notes', label: 'Delivery Notes' },
      { resource: 'invoices', label: 'Invoices' },
      { resource: 'receipts', label: 'Receipts' },
      { resource: 'credit_notes', label: 'Credit Notes' },
      { resource: 'debit_notes', label: 'Debit Notes' },
      { resource: 'returns', label: 'Returns' },
    ],
  },
  {
    module: 'procurement', label: 'Procurement', icon: '\u{1F6D2}',
    resources: [
      { resource: 'suppliers', label: 'Suppliers' },
      { resource: 'requisitions', label: 'Requisitions' },
      { resource: 'rfqs', label: 'RFQs' },
      { resource: 'quotations', label: 'Supplier Quotations' },
      { resource: 'orders', label: 'Purchase Orders' },
      { resource: 'goods_receipts', label: 'Goods Receipts' },
      { resource: 'supplier_invoices', label: 'Supplier Invoices' },
      { resource: 'payments', label: 'Supplier Payments' },
      { resource: 'returns', label: 'Purchase Returns' },
      { resource: 'contracts', label: 'Supplier Contracts' },
    ],
  },
  {
    module: 'inventory', label: 'Inventory', icon: '\u{1F4E6}',
    resources: [
      { resource: 'items', label: 'Products' },
      { resource: 'batches', label: 'Batches' },
      { resource: 'warehouses', label: 'Warehouses' },
      { resource: 'bins', label: 'Bins' },
      { resource: 'stock', label: 'Stock Levels' },
      { resource: 'movements', label: 'Stock Movements' },
      { resource: 'reservations', label: 'Reservations' },
      { resource: 'transfers', label: 'Transfers' },
      { resource: 'adjustments', label: 'Adjustments' },
    ],
  },
  {
    module: 'production', label: 'Manufacturing', icon: '\u{1F3ED}',
    resources: [
      { resource: 'plans', label: 'Production Plans' },
      { resource: 'boms', label: 'BOMs' },
      { resource: 'routings', label: 'Routings' },
      { resource: 'work_centres', label: 'Work Centres' },
      { resource: 'machines', label: 'Machines' },
      { resource: 'work_orders', label: 'Work Orders' },
      { resource: 'outputs', label: 'Production Outputs' },
      { resource: 'downtime', label: 'Downtime' },
    ],
  },
  {
    module: 'quality', label: 'Quality', icon: '\u2705',
    resources: [
      { resource: 'plans', label: 'Inspection Plans' },
      { resource: 'inspections', label: 'Inspections' },
      { resource: 'defects', label: 'Defects' },
      { resource: 'ncrs', label: 'NCRs' },
      { resource: 'capa', label: 'CAPA' },
    ],
  },
  {
    module: 'security_printing', label: 'Security Printing', icon: '\u{1F512}',
    resources: [{ resource: 'jobs', label: 'Secure Jobs' }],
  },
  {
    module: 'maintenance', label: 'Maintenance', icon: '\u{1F527}',
    resources: [
      { resource: 'requests', label: 'Work Requests' },
      { resource: 'schedules', label: 'Schedules' },
      { resource: 'work_orders', label: 'Maintenance Work Orders' },
    ],
  },
  {
    module: 'logistics', label: 'Logistics', icon: '\u{1F69A}',
    resources: [
      { resource: 'vehicles', label: 'Vehicles' },
      { resource: 'routes', label: 'Routes' },
      { resource: 'drivers', label: 'Drivers' },
      { resource: 'trips', label: 'Trips' },
      { resource: 'fuel', label: 'Fuel Logs' },
      { resource: 'fleet', label: 'Fleet Maintenance' },
    ],
  },
  {
    module: 'finance', label: 'Finance', icon: '\u{1F4CA}',
    resources: [
      { resource: 'chart_of_accounts', label: 'Chart of Accounts' },
      { resource: 'periods', label: 'Financial Periods' },
      { resource: 'banks', label: 'Bank Accounts' },
      { resource: 'journals', label: 'Journal Entries' },
      { resource: 'budgets', label: 'Budgets' },
      { resource: 'expenses', label: 'Expenses' },
      { resource: 'taxes', label: 'Taxes' },
    ],
  },
  {
    module: 'hr', label: 'HR', icon: '\u{1F4CB}',
    resources: [
      { resource: 'employees', label: 'Employees' },
      { resource: 'contracts', label: 'Contracts' },
      { resource: 'attendance', label: 'Attendance' },
      { resource: 'leave', label: 'Leave Requests' },
      { resource: 'payrolls', label: 'Payrolls' },
      { resource: 'loans', label: 'Employee Loans' },
    ],
  },
  {
    module: 'assets', label: 'Assets', icon: '\u{1F3E2}',
    resources: [
      { resource: 'register', label: 'Asset Register' },
      { resource: 'movements', label: 'Movements' },
      { resource: 'maintenance', label: 'Maintenance' },
    ],
  },
  {
    module: 'documents', label: 'Documents', icon: '\u{1F4C4}',
    resources: [{ resource: 'documents', label: 'Documents' }],
  },
  {
    module: 'healthcare', label: 'Healthcare', icon: '\u{1F3E5}',
    resources: [
      { resource: 'patients', label: 'Patients' },
      { resource: 'visits', label: 'Visits' },
      { resource: 'appointments', label: 'Appointments' },
      { resource: 'practitioners', label: 'Practitioners' },
      { resource: 'emrs', label: 'EMR' },
      { resource: 'prescriptions', label: 'Prescriptions' },
      { resource: 'dispensings', label: 'Dispensings' },
      { resource: 'lab_requests', label: 'Lab Requests' },
      { resource: 'lab_results', label: 'Lab Results' },
      { resource: 'bills', label: 'Bills' },
      { resource: 'facilities', label: 'Facilities' },
      { resource: 'wards', label: 'Wards' },
      { resource: 'beds', label: 'Beds' },
      { resource: 'insurance_claims', label: 'Insurance Claims' },
    ],
  },
  {
    module: 'workflows', label: 'Administration', icon: '\u2699',
    resources: [
      { resource: 'workflows', label: 'Workflows' },
      { resource: 'instances', label: 'Instances' },
    ],
  },
];

export function resourcesOf(module: string) {
  const item = NAV.find((n) => n.module === module);
  return item?.resources ?? [];
}
