import { MeUser } from './auth';

export type Persona =
  | 'executive'
  | 'commercial'
  | 'warehouse'
  | 'plant'
  | 'security'
  | 'finance'
  | 'quality'
  | 'people';

export interface Workspace {
  id: string;
  label: string;
  hint: string;
  href: string;
  personas: Persona[];
  perm?: string;
}

export const WORKSPACES: Workspace[] = [
  { id: 'commercial', label: 'Commercial', hint: 'Quote to cash', href: '/sales/orders', personas: ['executive', 'commercial'], perm: 'sales.orders.view' },
  { id: 'warehouse', label: 'Warehouse', hint: 'Stock and moves', href: '/inventory/stock', personas: ['executive', 'warehouse', 'plant'], perm: 'inventory.stock.view' },
  { id: 'plant', label: 'Plant', hint: 'Work orders', href: '/records/production/work_orders', personas: ['executive', 'plant'], perm: 'production.work_orders.view' },
  { id: 'security', label: 'Secure print', hint: 'Custody jobs', href: '/security-jobs', personas: ['executive', 'security'], perm: 'security_printing.jobs.view' },
  { id: 'quality', label: 'Quality', hint: 'NCR and CAPA', href: '/records/quality/ncrs', personas: ['executive', 'quality', 'plant'], perm: 'quality.ncrs.view' },
  { id: 'money', label: 'Money', hint: 'AR, AP, books', href: '/records/finance/journals', personas: ['executive', 'finance'], perm: 'finance.journals.view' },
  { id: 'people', label: 'People', hint: 'HR and payroll', href: '/people', personas: ['executive', 'people'], perm: 'hr.employees.view' },
];

export function roleCodes(user: MeUser | null): string[] {
  return (user?.roles ?? []).map((r) => r.role_code);
}

export function personaOf(user: MeUser | null): Persona {
  const codes = roleCodes(user).join(' ');
  if (/security_printing|secure_|security_admin/.test(codes)) return 'security';
  if (/warehouse|storekeeper|dispatch|inventory|receiving|stock_/.test(codes)) return 'warehouse';
  if (/production|machine_operator|maintenance|work_order/.test(codes)) return 'plant';
  if (/quality|qc_|ncr_|qa_/.test(codes)) return 'quality';
  if (/cfo|finance|accountant|ar_|ap_|cashier|treasury|payroll_accountant/.test(codes)) return 'finance';
  if (/sales|crm|commercial|account_manager/.test(codes)) return 'commercial';
  if (/hr_|recruitment|training|employee_self/.test(codes)) return 'people';
  return 'executive';
}

export function personaLabel(p: Persona): string {
  return {
    executive: 'Enterprise',
    commercial: 'Commercial desk',
    warehouse: 'Warehouse floor',
    plant: 'Plant operations',
    security: 'Secure print',
    finance: 'Finance desk',
    quality: 'Quality desk',
    people: 'People operations',
  }[p];
}

export function greetingFor(hour = new Date().getHours()): string {
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

export interface CommandAction {
  id: string;
  label: string;
  hint: string;
  href: string;
  keywords: string;
  perm?: string;
}

export const COMMANDS: CommandAction[] = [
  { id: 'home', label: 'My day', hint: 'Role home', href: '/dashboard', keywords: 'home today mission' },
  { id: 'inbox', label: 'Inbox', hint: 'Approvals and exceptions', href: '/inbox', keywords: 'approve reject queue' },
  { id: 'quote', label: 'New quotation', hint: 'Commercial', href: '/sales/quotations/new', keywords: 'quote sell customer', perm: 'sales.quotations.create' },
  { id: 'order', label: 'Sales orders', hint: 'Order to cash', href: '/sales/orders', keywords: 'so dispatch invoice', perm: 'sales.orders.view' },
  { id: 'sales-board', label: 'Sales board', hint: 'Quote to cash', href: '/sales', keywords: 'sales otc quote invoice collect', perm: 'sales.orders.view' },
  { id: 'stock', label: 'Warehouse stock', hint: 'On hand', href: '/inventory/stock', keywords: 'inventory warehouse bin', perm: 'inventory.stock.view' },
  { id: 'xfer', label: 'New transfer', hint: 'Move stock', href: '/inventory/transfers/new', keywords: 'transfer move warehouse', perm: 'inventory.transfers.create' },
  { id: 'adj', label: 'New adjustment', hint: 'Count / correct', href: '/inventory/adjustments/new', keywords: 'adjust count stocktake', perm: 'inventory.adjustments.create' },
  { id: 'scan', label: 'Scan QR', hint: 'Trace or verify', href: '/qr/scan', keywords: 'qr barcode scan verify' },
  { id: 'secure', label: 'Secure jobs', hint: 'Dual control', href: '/security-jobs', keywords: 'security print custody', perm: 'security_printing.jobs.view' },
  { id: 'wo', label: 'Work orders', hint: 'Plant', href: '/records/production/work_orders', keywords: 'manufacture wo machine', perm: 'production.work_orders.view' },
  { id: 'customers', label: 'Customers', hint: 'CRM', href: '/crm/customers', keywords: 'customer account', perm: 'crm.customers.view' },
  { id: 'crm-board', label: 'CRM board', hint: 'Leads and pipeline', href: '/crm', keywords: 'crm lead pipeline account complaint', perm: 'crm.customers.view' },
  { id: 'crm-mine', label: 'My CRM desk', hint: 'Assigned work', href: '/crm/mine', keywords: 'my leads follow up assigned', perm: 'crm.activities.view' },
  { id: 'crm-analytics', label: 'CRM analytics', hint: 'Forecast and win rate', href: '/crm/analytics', keywords: 'forecast conversion win rate aging', perm: 'crm.customers.view' },
  { id: 'pipeline', label: 'Sales pipeline', hint: 'Opportunities', href: '/crm/pipeline', keywords: 'opportunity stage win lose', perm: 'crm.opportunities.view' },
  { id: 'reports', label: 'Reports', hint: 'Analytics', href: '/reports', keywords: 'report kpi export' },
  { id: 'work', label: 'My work', hint: 'Assigned queue', href: '/work', keywords: 'tasks assigned jobs' },
  { id: 'plant', label: 'Plant board', hint: 'Production today', href: '/plant', keywords: 'production machine efficiency mill', perm: 'production.work_orders.view' },
  { id: 'demand-make', label: 'Sales demand', hint: 'Make to order', href: '/plant/demand', keywords: 'make to order so demand', perm: 'production.work_orders.view' },
  { id: 'plans', label: 'Production plans', hint: 'Explode to WOs', href: '/plant/plans', keywords: 'plan explode mrp', perm: 'production.plans.view' },
  { id: 'whroom', label: 'Warehouse control', hint: 'Receive pick dispatch', href: '/inventory/ops', keywords: 'receive putaway pick count', perm: 'inventory.stock.view' },
  { id: 'receive', label: 'Receive PO', hint: 'Goods receipt', href: '/inventory/receive', keywords: 'grn receive inbound supplier', perm: 'inventory.movements.create' },
  { id: 'pick', label: 'Pick / dispatch', hint: 'Sales fulfilment', href: '/inventory/pick', keywords: 'pick dispatch so outbound', perm: 'inventory.movements.create' },
  { id: 'issue', label: 'Issue to plant', hint: 'Work order materials', href: '/inventory/issue', keywords: 'issue material wo production', perm: 'inventory.movements.create' },
  { id: 'demand', label: 'Demand / ATP', hint: 'Available to promise', href: '/inventory/demand', keywords: 'atp demand mrp planning', perm: 'inventory.stock.view' },
  { id: 'buy', label: 'Buy board', hint: 'PR PO GRN match', href: '/buy', keywords: 'purchase procurement supplier po pr rfq grn', perm: 'procurement.orders.view' },
  { id: 'buy-demand', label: 'Buy demand', hint: 'Plant shortages', href: '/buy/demand', keywords: 'mrp shortage requisition buy', perm: 'procurement.requisitions.view' },
  { id: 'fin', label: 'Finance cockpit', hint: 'Cash AR AP', href: '/finance', keywords: 'cash profit receivable ledger', perm: 'finance.journals.view' },
  { id: 'gl', label: 'Journals', hint: 'General ledger', href: '/finance/journals', keywords: 'journal gl double entry', perm: 'finance.journals.view' },
  { id: 'tb', label: 'Trial balance', hint: 'Debit = credit', href: '/finance/trial-balance', keywords: 'trial balance books', perm: 'finance.journals.view' },
  { id: 'je', label: 'New journal', hint: 'Manual entry', href: '/finance/journals/new', keywords: 'journal post ledger', perm: 'finance.journals.create' },
  { id: 'op', label: 'Operator floor', hint: 'Start job', href: '/operator', keywords: 'start pause output waste', perm: 'production.work_orders.start' },
  { id: 'people-board', label: 'People board', hint: 'HR and payroll', href: '/people', keywords: 'hr employee leave payroll nssf paye', perm: 'hr.employees.view' },
  { id: 'payroll', label: 'Payroll runs', hint: 'Calculate and post', href: '/people/payrolls', keywords: 'payroll paye nssf payslip', perm: 'hr.payrolls.view' },
];

export function pathForEntity(entityType: string, id: number): string {
  const [module, resource] = entityType.split('.');
  if (module === 'sales') return `/sales/${resource}/${id}`;
  if (module === 'crm' || !resource) {
    const kind = resource || module;
    if (kind === 'customers') return `/crm/customers/${id}`;
    if (kind === 'leads') return `/crm/leads/${id}`;
    if (kind === 'opportunities') return `/crm/opportunities/${id}`;
    if (kind === 'complaints') return `/crm/complaints/${id}`;
    if (kind === 'activities') return '/crm/activities';
  }
  if (module === 'hr') {
    if (resource === 'employees') return `/people/employees/${id}`;
    if (resource === 'payrolls') return `/people/payrolls/${id}`;
    if (resource === 'leave') return '/people/leave';
  }
  if (module === 'inventory') return `/inventory/${resource}/${id}`;
  if (module === 'procurement') {
    if (resource === 'orders') return `/buy/orders/${id}`;
    if (resource === 'requisitions') return `/buy/requisitions/${id}`;
    if (resource === 'goods_receipts') return `/buy/receipts/${id}`;
    if (resource === 'supplier_invoices') return `/buy/invoices/${id}`;
    if (resource === 'rfqs') return `/buy/rfqs/${id}`;
  }
  return `/records/${module}/${resource}/${id}`;
}

export interface NavModule {
  id: string;
  label: string;
  href: string;
  perm?: string;
  badge?: 'approvals' | 'exceptions';
}

export const MODULES: NavModule[] = [
  { id: 'dashboard', label: 'Dashboard', href: '/dashboard' },
  { id: 'work', label: 'My Work', href: '/work' },
  { id: 'approvals', label: 'Approvals', href: '/inbox', badge: 'approvals' },
  { id: 'crm', label: 'CRM', href: '/crm', perm: 'crm.customers.view' },
  { id: 'sales', label: 'Sales', href: '/sales', perm: 'sales.orders.view' },
  { id: 'procurement', label: 'Procurement', href: '/buy', perm: 'procurement.orders.view' },
  { id: 'inventory', label: 'Inventory', href: '/inventory/stock', perm: 'inventory.stock.view' },
  { id: 'production', label: 'Production', href: '/plant', perm: 'production.work_orders.view' },
  { id: 'quality', label: 'Quality', href: '/records/quality/inspections', perm: 'quality.inspections.view' },
  { id: 'security', label: 'Security', href: '/security-jobs', perm: 'security_printing.jobs.view' },
  { id: 'maintenance', label: 'Maintenance', href: '/records/maintenance/requests', perm: 'maintenance.requests.view' },
  { id: 'logistics', label: 'Logistics', href: '/records/logistics/trips', perm: 'logistics.trips.view' },
  { id: 'finance', label: 'Finance', href: '/finance', perm: 'finance.journals.view' },
  { id: 'hr', label: 'HR', href: '/people', perm: 'hr.employees.view' },
  { id: 'assets', label: 'Assets', href: '/records/assets/register', perm: 'assets.register.view' },
  { id: 'reports', label: 'Reports', href: '/reports' },
  { id: 'admin', label: 'Admin', href: '/admin/users', perm: 'admin.users.view' },
];

export interface CreateItem {
  id: string;
  label: string;
  href: string;
  perm: string;
}

export const CREATE_ITEMS: CreateItem[] = [
  { id: 'grn', label: 'Goods receipt', href: '/inventory/receive', perm: 'inventory.movements.create' },
  { id: 'customer', label: 'Customer', href: '/crm/customers/new', perm: 'crm.customers.create' },
  { id: 'lead', label: 'Lead', href: '/crm/leads/new', perm: 'crm.leads.create' },
  { id: 'quote', label: 'Quotation', href: '/sales/quotations/new', perm: 'sales.quotations.create' },
  { id: 'so', label: 'Sales order', href: '/sales/orders/new', perm: 'sales.orders.create' },
  { id: 'pr', label: 'Purchase requisition', href: '/buy/requisitions/new', perm: 'procurement.requisitions.create' },
  { id: 'po', label: 'Purchase order', href: '/buy/orders/new', perm: 'procurement.orders.create' },
  { id: 'grn', label: 'Goods receipt', href: '/inventory/receive', perm: 'procurement.goods_receipts.create' },
  { id: 'product', label: 'Product', href: '/inventory/items', perm: 'inventory.items.create' },
  { id: 'xfer', label: 'Stock transfer', href: '/inventory/transfers/new', perm: 'inventory.transfers.create' },
  { id: 'adj', label: 'Stock adjustment', href: '/inventory/adjustments/new', perm: 'inventory.adjustments.create' },
  { id: 'wo', label: 'Work order', href: '/plant/new', perm: 'production.work_orders.create' },
  { id: 'ncr', label: 'NCR', href: '/records/quality/ncrs', perm: 'quality.ncrs.create' },
  { id: 'invoice', label: 'Invoice', href: '/sales/invoices', perm: 'sales.invoices.create' },
  { id: 'task', label: 'Task', href: '/work', perm: 'notifications.tasks.create' },
  { id: 'employee', label: 'Employee', href: '/people/employees/new', perm: 'hr.employees.create' },
  { id: 'payroll', label: 'Payroll', href: '/people/payrolls/new', perm: 'hr.payrolls.create' },
];

export function interpretCommand(raw: string): string | null {
  const q = raw.trim().toLowerCase();
  if (!q) return null;
  if (/overdue invoice|overdue ar|receivable/.test(q)) return '/sales/invoices';
  if (/pending approval|approvals?$/.test(q)) return '/inbox';
  if (/low stock|below reorder|stock alert/.test(q)) return '/inventory/stock';
  if (/today.?s? production|plant|work order/.test(q)) return '/plant';
  if (/fss104|fss300|machine/.test(q)) return '/plant';
  if (/scan|verify qr/.test(q)) return '/qr/scan';
  if (/receive po|goods receipt|inbound/.test(q)) return '/inventory/receive';
  if (/pick|dispatch/.test(q)) return '/inventory/pick';
  if (/issue material|issue to plant/.test(q)) return '/inventory/issue';
  if (/available to promise|atp|demand board/.test(q)) return '/inventory/demand';
  if (/warehouse|put away/.test(q)) return '/inventory/ops';
  if (/cash|profit|budget|cfo/.test(q)) return '/finance';
  if (/secure|custody|spoilage/.test(q)) return '/security-jobs';
  if (/new quote|create quotation/.test(q)) return '/sales/quotations/new';
  if (/new po|purchase order/.test(q)) return '/buy/orders/new';
  if (/requisition|new pr|rfq|supplier invoice|three.?way/.test(q)) return '/buy';
  if (/buy board|procurement/.test(q)) return '/buy';
  if (/crm|pipeline|new lead|customer account/.test(q)) return '/crm';
  if (/payroll|leave request|employee|nssf|paye|hr desk/.test(q)) return '/people';
  if (/new work order|create wo|create work order/.test(q)) return '/plant/new';
  return null;
}

export { moduleActive } from './nav';

export function allowedActions(status: string | null | undefined, module: string, resource: string, canDo: (p: string) => boolean): { id: string; label: string; tone?: 'primary' | 'danger' | 'success' }[] {
  const s = String(status ?? '').toUpperCase();
  const p = (a: string) => canDo(`${module}.${resource}.${a}`);
  const out: { id: string; label: string; tone?: 'primary' | 'danger' | 'success' }[] = [];
  if (s === 'DRAFT' && p('submit')) out.push({ id: 'submit', label: 'Submit', tone: 'primary' });
  if (s === 'SUBMITTED' && p('approve')) out.push({ id: 'approve', label: 'Approve', tone: 'success' });
  if (s === 'SUBMITTED' && p('reject')) out.push({ id: 'reject', label: 'Reject', tone: 'danger' });
  if (['DRAFT', 'SUBMITTED', 'APPROVED'].includes(s) && p('cancel')) out.push({ id: 'cancel', label: 'Cancel', tone: 'danger' });
  if (['APPROVED', 'POSTED'].includes(s) && p('void')) out.push({ id: 'void', label: 'Void', tone: 'danger' });
  if (p('print')) out.push({ id: 'print', label: 'Print' });
  if (p('update')) out.push({ id: 'edit', label: 'Edit' });
  return out;
}

