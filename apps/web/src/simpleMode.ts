import { can, type MeUser } from './auth';
import { personaOf, type Persona } from './work';
import type { Prefs } from './prefs';

/**
 * Simple Mode — a human-centred, app-launcher experience modelled on the
 * familiar organisation of modern ERP suites (Sales, Manufacturing,
 * Accounting, Inventory, Payroll, Employees, Time Off, Purchase, Dashboards)
 * but mapped onto Natex's existing modules, routes and permissions.
 *
 * It reuses the exact same routes, permissions and business logic as the
 * full (Advanced) experience; the only difference is the surface — a grid of
 * big, everyday-named app tiles plus a short "do quickly" row. Every entry is
 * gated by the same `can(user, permission)` check used everywhere else, so
 * Simple Mode can never grant access the user does not already have.
 */

/** Personas that land in Simple Mode by default (shop-floor / self-service). */
const SIMPLE_PERSONAS: ReadonlySet<Persona> = new Set<Persona>([
  'warehouse', // storekeepers, receiving, dispatch, stock counters
  'plant', // machine operators, production workers, maintenance
  'quality', // inspectors, QC/NCR officers
  'security', // secure print machine operators
]);

/** Role-code hints that steer a user toward Simple Mode even outside those personas. */
const SIMPLE_ROLE_HINTS = /storekeeper|machine_operator|production_worker|receiving_officer|dispatch_officer|quality_inspector|maintenance_technician|driver|stock_counter|secure_machine_operator/;

export function defaultsToSimpleMode(user: MeUser | null): boolean {
  if (!user) return false;
  if (SIMPLE_PERSONAS.has(personaOf(user))) return true;
  return SIMPLE_ROLE_HINTS.test((user.roles ?? []).map((r) => r.role_code).join(' '));
}

/** Explicit preference wins; otherwise fall back to the role-based default. */
export function effectiveSimpleMode(user: MeUser | null, prefs: Pick<Prefs, 'simpleMode'>): boolean {
  return prefs.simpleMode ?? defaultsToSimpleMode(user);
}

export interface SimpleApp {
  id: string;
  /** Familiar module name (mirrors the modern ERP app organisation). */
  name: string;
  /** One short plain-sentence hint. */
  hint: string;
  /** Emoji glyph (the app has no icon library — this is the house convention). */
  icon: string;
  /** Real route the app opens (must resolve in routeMatches()). */
  href: string;
  /** Permission gate — hidden unless the user can open it. */
  perm?: string;
}

/**
 * The app launcher. Names follow the conventional module vocabulary users
 * already recognise; each maps to a real Natex module. Payroll / Employees /
 * Time Off all open the HR hub (`/people`) because Natex keeps those together
 * in one module today — the tiles stay distinct so the familiar app list reads
 * correctly, and each is permission-gated to only the people who can use it.
 */
export const SIMPLE_APPS: SimpleApp[] = [
  { id: 'sales', name: 'Sales', hint: 'Quotes, orders and invoices', icon: '💼', href: '/sales', perm: 'sales.orders.view' },
  { id: 'manufacturing', name: 'Manufacturing', hint: 'Make and finish products', icon: '🏭', href: '/plant', perm: 'production.work_orders.view' },
  { id: 'accounting', name: 'Accounting', hint: 'Money in and out, the books', icon: '🧮', href: '/finance', perm: 'finance.journals.view' },
  { id: 'inventory', name: 'Inventory', hint: 'Stock on hand and stock moves', icon: '📦', href: '/inventory', perm: 'inventory.stock.view' },
  { id: 'payroll', name: 'Payroll', hint: 'Run pay and see payslips', icon: '👛', href: '/people', perm: 'hr.payrolls.view' },
  { id: 'employees', name: 'Employees', hint: 'People and their records', icon: '👥', href: '/people', perm: 'hr.employees.view' },
  { id: 'time-off', name: 'Time Off', hint: 'Request and approve leave', icon: '🏖️', href: '/people', perm: 'hr.leave.view' },
  { id: 'purchase', name: 'Purchase', hint: 'Order from suppliers', icon: '🛒', href: '/buy', perm: 'procurement.orders.view' },
  { id: 'dashboards', name: 'Dashboards', hint: 'Reports and key numbers', icon: '📈', href: '/reports', perm: 'reports.executive.view' },
];

export function visibleSimpleApps(user: MeUser | null): SimpleApp[] {
  return SIMPLE_APPS.filter((a) => !a.perm || can(user, a.perm));
}

export interface SimpleTask {
  id: string;
  label: string;
  hint: string;
  icon: string;
  href: string;
  perm?: string;
}

/** A short "do quickly" row of the most common everyday actions. */
export const SIMPLE_TASKS: SimpleTask[] = [
  { id: 'record-expense', label: 'Record Expense', hint: 'What you spent', icon: '💵', href: '/spend/expenses/new', perm: 'expenditure.expenses.create' },
  { id: 'receive-stock', label: 'Receive Stock', hint: 'Goods arriving', icon: '📥', href: '/inventory', perm: 'inventory.movements.create' },
  { id: 'give-out-stock', label: 'Give Out Stock', hint: 'Issue materials', icon: '📤', href: '/inventory', perm: 'inventory.movements.create' },
  { id: 'ask-materials', label: 'Ask for Materials', hint: 'Request a purchase', icon: '📝', href: '/spend/requisitions/new', perm: 'expenditure.requisitions.create' },
  { id: 'record-output', label: 'Record Finished Products', hint: 'Report what you made', icon: '✅', href: '/plant', perm: 'production.outputs.create' },
  { id: 'report-problem', label: 'Report a Problem', hint: 'Something is broken', icon: '🛠️', href: '/service-desk', perm: 'service_desk.tickets.create' },
];

export function visibleSimpleTasks(user: MeUser | null): SimpleTask[] {
  return SIMPLE_TASKS.filter((t) => !t.perm || can(user, t.perm));
}
