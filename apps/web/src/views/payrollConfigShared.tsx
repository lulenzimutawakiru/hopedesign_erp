/**
 * Shared vocabulary for the payroll configuration screens.
 *
 * The statutory editor and the settings editor are two halves of one job: telling
 * payroll what the law and the business want. They share the shapes the API returns
 * and the small form primitives below, so a field looks and validates the same on
 * either tab.
 */

export type Rec = Record<string, unknown>;

export const today = () => new Date().toISOString().slice(0, 10);

// --- what the API returns ---------------------------------------------------

export interface SettingDefinition {
  key: string;
  label: string;
  group: string;
  type: 'text' | 'code' | 'currency' | 'enum';
  options: string[] | null;
  description: string;
  consumedBy: string;
  defaultValue: string;
  settingId: number | null;
  value: string;
  isDefault: boolean;
  status: string | null;
  storedDescription: string | null;
  updatedAt: string | null;
}

export interface ExtraSetting {
  settingId: number;
  key: string;
  value: string;
  rawValue: unknown;
  status: string | null;
  description: string | null;
  updatedAt: string | null;
}

export interface SettingsPayload {
  companyId: number | null;
  definitions: SettingDefinition[];
  extras: ExtraSetting[];
  groups: string[];
}

export type StatutoryState =
  | 'IN_EFFECT'
  | 'SCHEDULED'
  | 'OUTRANKED'
  | 'SHADOWED_BY_COMPANY'
  | 'EXPIRED'
  | 'SUPERSEDED';

export interface StatutoryConfig {
  id: number;
  companyId: number | null;
  country: string;
  category: string;
  code: string;
  name: string;
  description: string | null;
  effectiveFrom: string;
  effectiveTo: string | null;
  rates: unknown;
  thresholds: unknown;
  limits: unknown;
  formula: unknown;
  version: number;
  status: string;
  createdAt?: string;
  updatedAt?: string;
  scope: 'COMPANY' | 'TENANT';
  resolved: boolean;
  state: StatutoryState;
  winnerConfigId: number | null;
  winnerCode: string | null;
  companyName: string | null;
}

export interface ResolutionRow {
  category: string;
  configId: number | null;
  code: string | null;
  name: string | null;
  version: number | null;
  scope: 'COMPANY' | 'TENANT' | null;
  companyId: number | null;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  missing: boolean;
}

export interface StatutoryPayload {
  asOf: string;
  country: string;
  companyId: number | null;
  categories: string[];
  configs: StatutoryConfig[];
  resolution: ResolutionRow[];
  companies: Array<{ id: number; name: string }>;
}

export interface PreviewStep {
  label: string;
  amount: number;
  kind: string;
}

export interface PreviewPayload {
  asOf: string;
  country: string;
  companyId: number | null;
  gross: number;
  chargeableIncome: number;
  taxableIncome: number;
  nssf: { employee: number; employer: number; base: number; ceiling: number | null };
  paye: number;
  payeError: string | null;
  lst: number;
  totalDeductions: number;
  net: number;
  employerCost: number;
  configs: { paye: Rec | null; nssf: Rec | null; lst: Rec | null };
  steps: PreviewStep[];
}

// --- readable labels --------------------------------------------------------

export const CATEGORY_LABELS: Record<string, string> = {
  PAYE: 'PAYE',
  NSSF: 'NSSF',
  LST: 'Local service tax',
  SDI: 'SDI',
  WHT: 'Withholding tax',
  SEVERANCE: 'Severance',
  MINIMUM_WAGE: 'Minimum wage',
  OTHER: 'Other',
};

export const CATEGORY_BLURB: Record<string, string> = {
  PAYE: 'Income tax withheld from taxable pay, band by band.',
  NSSF: 'Social security contributed as a share of gross pay.',
  LST: 'Local service tax: graduated, flat, or a share of gross.',
  SDI: 'Skills development levy.',
  WHT: 'Withholding tax on payments to suppliers.',
  SEVERANCE: 'Statutory severance on termination.',
  MINIMUM_WAGE: 'Floor pay used to flag underpayment.',
  OTHER: 'Anything the catalogue above does not name.',
};

export const categoryLabel = (category: string) =>
  CATEGORY_LABELS[category] ?? category.replace(/_/g, ' ');
