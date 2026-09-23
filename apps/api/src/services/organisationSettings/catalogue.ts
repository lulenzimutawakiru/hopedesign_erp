/**
 * Organisation Settings catalogue.
 *
 * Organisation Settings is the ERP control plane: the organisation is described
 * once and every other module reads that description back. This file is the
 * declarative half of that promise - the categories an administrator may
 * configure, the fields inside each one, and the platform default for each
 * field. Nothing here is a fake toggle: every category with `kind: 'settings'`
 * is persisted in `app_settings` under the `organisation.<id>` category, and
 * every other `kind` names a real table (see the sibling modules of this
 * directory).
 *
 * Design rules, mirroring migration 0164:
 *   - A setting earns its own table only when it must be versioned, allocated
 *     or lifecycle-managed (tax rates, sequences, approvals, policies).
 *   - Everything else is a key in `app_settings`, which already carries
 *     per-tenant/per-company override, `configuration_history` and an audit
 *     entry on every write.
 *   - Category permissions come from the 17 `organisation.*` codes. There is no
 *     "approvals" code by design: configuring an approval workflow is a
 *     privileged-administration act, so it is guarded by
 *     `organisation.security.manage`. Administrative access still never implies
 *     business approval authority - see migration 0164 section 9.
 */

export type OrgSettingType =
  | 'text' | 'textarea' | 'number' | 'boolean' | 'select'
  | 'color' | 'url' | 'email' | 'tel' | 'date';

export interface OrgSettingDef {
  label: string;
  help?: string;
  type: OrgSettingType;
  options?: string[];
  default?: string | number | boolean;
  group?: string;
  /** Stored encrypted (AES-256-GCM) and never returned by value. */
  secret?: boolean;
  /**
   * Refuses an empty value.
   *
   * Set this where the setting is mirrored onto a NOT NULL company column, so
   * that blanking the box is answered with a field-level refusal instead of a
   * raw constraint violation. It is a declared fact about the storage, not a
   * cosmetic marker: the writer enforces it.
   */
  required?: boolean;
  min?: number;
  max?: number;
}

/**
 * How a category is loaded and saved.
 *
 *   settings        `app_settings` keys under `organisation.<id>`
 *   structure       companies/branches/departments/... rows (lifecycle managed)
 *   security_policy `security_policies` (one row per company)
 *   tax             versioned tax vocabulary (`tax_*`)
 *   approvals       `approval_workflows` / `approval_levels` / fallback rules
 *   signatures      `signature_profiles`
 *   integrations    `company_integrations` (credentials encrypted)
 *   retention       `db_retention_policies` + `backup_policies`
 *   audit           read-only view over `audit_logs` + `configuration_history`
 */
export type OrgCategoryKind =
  | 'settings' | 'structure' | 'security_policy' | 'tax'
  | 'approvals' | 'signatures' | 'integrations' | 'retention' | 'audit';

export interface OrgCategory {
  id: string;
  label: string;
  group: string;
  blurb: string;
  kind: OrgCategoryKind;
  /** Permission that gates writing this category. Reading is always
   *  `organisation.settings.view`. */
  manage: string;
  settings?: Record<string, OrgSettingDef>;
}

export const ORG_VIEW_PERMISSION = 'organisation.settings.view';
export const ORG_STRUCTURE_PERMISSION = 'organisation.structure.manage';

/** Sidebar order. Categories are listed in the order the ERP spec describes. */
export const ORG_GROUPS = [
  'Organisation', 'Finance', 'People', 'Operations', 'Documents',
  'Governance', 'Communication', 'Integrations', 'System',
] as const;

/** Compact field constructor - keeps the catalogue readable as a table. */
const f = (label: string, type: OrgSettingType, extra: Partial<OrgSettingDef> = {}): OrgSettingDef =>
  ({ label, type, ...extra });
const bool = (label: string, extra: Partial<OrgSettingDef> = {}): OrgSettingDef =>
  ({ label, type: 'boolean', ...extra });
const num = (label: string, extra: Partial<OrgSettingDef> = {}): OrgSettingDef =>
  ({ label, type: 'number', ...extra });
const sel = (label: string, options: string[], extra: Partial<OrgSettingDef> = {}): OrgSettingDef =>
  ({ label, type: 'select', options, ...extra });

const GOV = 'organisation.security.manage';
const ORG_SETTINGS_WRITE = 'organisation.settings.update';

export const ORG_CATEGORIES: OrgCategory[] = [
  // -------------------------------------------------------------------------
  // Organisation
  // -------------------------------------------------------------------------
  {
    id: 'profile',
    label: 'Organisation Profile',
    group: 'Organisation',
    kind: 'settings',
    manage: ORG_SETTINGS_WRITE,
    blurb: 'The identity every document, receipt, payslip and report carries. Changing the legal name here changes it everywhere.',
    settings: {
      legal_name: f('Legal Name', 'text', { group: 'Identity', default: 'HOPE DESIGN GROUP LTD' }),
      trading_name: f('Trading Name', 'text', {
        group: 'Identity', default: 'HOPE DESIGN GROUP LTD', required: true,
      }),
      trading_as: f('Trading As', 'text', { group: 'Identity' }),
      registration_number: f('Registration Number', 'text', { group: 'Registration' }),
      tin: f('TIN', 'text', { group: 'Registration', help: 'Uganda Revenue Authority taxpayer identification number.' }),
      vrn: f('VAT Registration Number', 'text', { group: 'Registration' }),
      nssf_employer_number: f('NSSF Employer Number', 'text', { group: 'Registration' }),
      industry: sel('Industry', [
        'Paper Manufacturing', 'Security Printing', 'Printing & Packaging', 'Manufacturing', 'Other',
      ], { group: 'Classification', default: 'Paper Manufacturing' }),
      org_type: sel('Organisation Type', [
        'LIMITED_COMPANY', 'SOLE_PROPRIETORSHIP', 'PARTNERSHIP', 'GOVERNMENT', 'NGO', 'OTHER',
      ], { group: 'Classification', default: 'LIMITED_COMPANY' }),
      specialty: f('Specialty', 'text', { group: 'Classification', default: 'Paper Manufacturing & Security Printing' }),
      country: f('Country', 'text', { group: 'Localisation', default: 'Uganda' }),
      currency: f('Currency', 'text', { group: 'Localisation', default: 'UGX', required: true }),
      timezone: f('Timezone', 'text', { group: 'Localisation', default: 'Africa/Kampala' }),
      language: sel('Language', ['en', 'sw', 'fr'], { group: 'Localisation', default: 'en' }),
      date_format: sel('Date Format', ['YYYY-MM-DD', 'DD/MM/YYYY', 'MM/DD/YYYY'], {
        group: 'Localisation', default: 'DD/MM/YYYY',
      }),
      phone: f('Phone', 'tel', { group: 'Contact' }),
      email: f('Email', 'email', { group: 'Contact', default: 'info@hopedesigngroup.com' }),
      website: f('Website', 'url', { group: 'Contact' }),
      physical_address: f('Physical Address', 'textarea', { group: 'Address', default: 'Plot 59 Kyambogo Drive, Kyambogo' }),
      postal_address: f('Postal Address', 'textarea', { group: 'Address' }),
      city: f('City', 'text', { group: 'Address', default: 'Kampala' }),
      district: f('District', 'text', { group: 'Address', default: 'Kampala' }),
      region: f('Region', 'text', { group: 'Address', default: 'Central' }),
      description: f('Organisation Description', 'textarea', { group: 'Description' }),
    },
  },

  // The seven Organisation structure categories are deliberately NOT listed
  // here. They are defined once, in structure.ts, because each carries entity
  // metadata (required fields, company/branch scoping, root-ness) that has
  // nowhere to live in OrgSettingDef. catalogueIndex() splices them into the
  // Organisation group and getCategory() falls back to structureCatalogue().
  // Declaring them in both places is how a duplicate id gets in.

  // -------------------------------------------------------------------------
  // Finance
  // -------------------------------------------------------------------------
  {
    id: 'fiscal',
    label: 'Fiscal Settings',
    group: 'Finance',
    kind: 'settings',
    manage: 'organisation.finance.manage',
    blurb: 'Financial year, accounting periods and their locking. Every open, close, reopen, lock and unlock writes an audit record.',
    settings: {
      fiscal_year_start: f('Financial Year Start', 'text', { group: 'Year', default: '07-01', help: 'MM-DD. 1 July matches the Ugandan government financial year.' }),
      fiscal_year_end: f('Financial Year End', 'text', { group: 'Year', default: '06-30' }),
      fiscal_year_label: sel('Financial Year Label', ['FY2026', '2025-2026', '2026'], { group: 'Year', default: '2025-2026' }),
      accounting_period_granularity: sel('Accounting Period', ['MONTHLY', 'QUARTERLY', 'YEARLY'], { group: 'Periods', default: 'MONTHLY' }),
      periods_auto_create: bool('Create Periods Automatically', { group: 'Periods', default: true }),
      period_lock_on_close: bool('Lock Period On Close', { group: 'Periods', default: true }),
      period_reopen_requires_approval: bool('Reopening Requires Approval', { group: 'Periods', default: true }),
      period_reopen_max_days: num('Reopen Window (days)', { group: 'Periods', default: 30, min: 0, max: 365 }),
      period_closing_requires_reason: bool('Closing Requires A Reason', { group: 'Periods', default: true }),
      currency: f('Default Currency', 'text', { group: 'Currency', default: 'UGX' }),
      multi_currency_enabled: bool('Multi Currency', { group: 'Currency', default: true }),
      exchange_rate_source: sel('Exchange Rate Source', [
        'MANUAL', 'BANK_OF_UGANDA', 'CENTRAL_BANK', 'PROVIDER_API',
      ], { group: 'Currency', default: 'BANK_OF_UGANDA' }),
      exchange_rate_variance_limit: num('Exchange Rate Variance Limit (%)', { group: 'Currency', default: 5, min: 0, max: 100 }),
      decimal_precision: num('Decimal Precision', { group: 'Rounding', default: 2, min: 0, max: 6 }),
      rounding_rule: sel('Rounding Rule', ['ROUND', 'ROUND_UP', 'ROUND_DOWN', 'BANKERS'], { group: 'Rounding', default: 'ROUND' }),
      rounding_tolerance: num('Rounding Tolerance', { group: 'Rounding', default: 1, min: 0, max: 10000 }),
    },
  },
  {
    id: 'tax',
    label: 'Tax Settings',
    group: 'Finance',
    kind: 'tax',
    manage: 'organisation.tax.manage',
    blurb: 'Tax policy plus the versioned tax vocabulary. No rate is hard-coded anywhere in the application: rates live in tax_rates with effective dates and a closed revision is frozen.',
    settings: {
      default_vat_code: f('Default VAT Code', 'text', { group: 'VAT', default: 'VAT_STANDARD' }),
      vat_registered: bool('VAT Registered', { group: 'VAT', default: true }),
      vat_return_frequency: sel('VAT Return Frequency', ['MONTHLY', 'QUARTERLY', 'ANNUALLY'], { group: 'VAT', default: 'MONTHLY' }),
      vat_filing_day: num('VAT Filing Day', { group: 'VAT', default: 15, min: 1, max: 28 }),
      prices_tax_inclusive: bool('Prices Are Tax Inclusive', { group: 'VAT', default: false }),
      withhold_tax_enabled: bool('Withholding Tax', { group: 'Withholding', default: true }),
      wht_default_rate: num('Default WHT Rate (%)', { group: 'Withholding', default: 6, min: 0, max: 100 }),
      wht_remit_day: num('WHT Remittance Day', { group: 'Withholding', default: 15, min: 1, max: 28 }),
      corporate_tax_rate: num('Corporate Tax Rate (%)', { group: 'Corporate', default: 30, min: 0, max: 100 }),
      efris_enabled: bool('EFRIS Enabled', { group: 'EFRIS', default: false, help: 'Fiscalisation cannot be switched on until the integration self-test has passed against the URA sandbox.' }),
      efris_tax_code_source: sel('EFRIS Tax Code Source', ['LOCAL', 'EFRIS_LOOKUP'], { group: 'EFRIS', default: 'LOCAL' }),
      tax_exemption_requires_approval: bool('Exemptions Require Approval', { group: 'Controls', default: true }),
    },
  },
  {
    id: 'finance',
    label: 'Finance Settings',
    group: 'Finance',
    kind: 'settings',
    manage: 'organisation.finance.manage',
    blurb: 'Credit control, journal controls and cash limits. These thresholds are read by the finance module at transaction time.',
    settings: {
      default_payment_terms_days: num('Default Payment Terms (days)', { group: 'Credit', default: 30, min: 0, max: 365 }),
      credit_limit_default: num('Default Credit Limit', { group: 'Credit', default: 0, min: 0 }),
      credit_limit_enforced: bool('Enforce Credit Limits', { group: 'Credit', default: true }),
      credit_limit_warn_percent: num('Credit Limit Warning (%)', { group: 'Credit', default: 80, min: 0, max: 100 }),
      overdue_block_days: num('Block New Sales After (days overdue)', { group: 'Credit', default: 60, min: 0, max: 3650 }),
      journal_requires_approval: bool('Journals Require Approval', { group: 'Journals', default: true }),
      journal_approval_threshold: num('Journal Approval Threshold', { group: 'Journals', default: 1000000, min: 0 }),
      backdated_journal_days: num('Backdated Journal Window (days)', { group: 'Journals', default: 7, min: 0, max: 365 }),
      bank_reconciliation_required: bool('Bank Reconciliation Required', { group: 'Cash', default: true }),
      petty_cash_limit: num('Petty Cash Limit', { group: 'Cash', default: 500000, min: 0 }),
      default_bank_account: f('Default Bank Account', 'text', { group: 'Cash' }),
    },
  },

  // -------------------------------------------------------------------------
  // People
  // -------------------------------------------------------------------------
  {
    id: 'payroll',
    label: 'Payroll Settings',
    group: 'People',
    kind: 'settings',
    manage: 'organisation.payroll.manage',
    blurb: 'Pay frequency, statutory rules and payroll approvals. PAYE bands and NSSF rates are versioned in tax_thresholds / tax_rates, so a rule change never rewrites a historical payslip.',
    settings: {
      payroll_frequency: sel('Payroll Frequency', ['MONTHLY', 'WEEKLY', 'BIWEEKLY'], { group: 'Schedule', default: 'MONTHLY' }),
      pay_day: num('Pay Day', { group: 'Schedule', default: 28, min: 1, max: 31 }),
      payroll_cutoff_day: num('Payroll Cut-off Day', { group: 'Schedule', default: 25, min: 1, max: 31 }),
      payroll_currency: f('Currency', 'text', { group: 'Schedule', default: 'UGX' }),
      payroll_group_default: f('Default Payroll Group', 'text', { group: 'Schedule', default: 'MONTHLY_STAFF' }),
      payslip_numbering_rule: f('Payslip Numbering Rule', 'text', { group: 'Schedule', default: 'PAY' }),
      overtime_enabled: bool('Overtime', { group: 'Overtime', default: true }),
      overtime_rate_weekday: num('Weekday Rate', { group: 'Overtime', default: 1.5, min: 1, max: 10 }),
      overtime_rate_weekend: num('Weekend Rate', { group: 'Overtime', default: 2, min: 1, max: 10 }),
      overtime_rate_holiday: num('Public Holiday Rate', { group: 'Overtime', default: 2.5, min: 1, max: 10 }),
      overtime_requires_approval: bool('Overtime Requires Approval', { group: 'Overtime', default: true }),
      overtime_monthly_cap_hours: num('Monthly Overtime Cap (hours)', { group: 'Overtime', default: 50, min: 0, max: 400 }),
      paye_enabled: bool('PAYE', { group: 'Statutory', default: true }),
      paye_basis: sel('PAYE Basis', ['MONTHLY', 'ANNUAL'], { group: 'Statutory', default: 'MONTHLY' }),
      nssf_enabled: bool('NSSF', { group: 'Statutory', default: true }),
      nssf_employee_rate: num('NSSF Employee Rate (%)', { group: 'Statutory', default: 5, min: 0, max: 100 }),
      nssf_employer_rate: num('NSSF Employer Rate (%)', { group: 'Statutory', default: 10, min: 0, max: 100 }),
      local_service_tax_enabled: bool('Local Service Tax', { group: 'Statutory', default: true }),
      payroll_requires_approval: bool('Payroll Requires Approval', { group: 'Controls', default: true }),
      payroll_approval_threshold: num('Payroll Approval Threshold', { group: 'Controls', default: 0, min: 0 }),
      payroll_lock_after_payment: bool('Lock After Payment', { group: 'Controls', default: true }),
      payroll_allow_negative_net: bool('Allow Negative Net Pay', { group: 'Controls', default: false }),
      payslip_email_enabled: bool('Email Payslips', { group: 'Controls', default: true }),
    },
  },
  {
    id: 'hr',
    label: 'HR Settings',
    group: 'People',
    kind: 'settings',
    manage: 'organisation.hr.manage',
    blurb: 'Employment vocabulary, leave policy and the payroll boundary. A system user and a payroll enrolment are deliberately different things.',
    settings: {
      employee_number_prefix: f('Employee Number Prefix', 'text', { group: 'Numbering', default: 'EMP' }),
      employee_number_format: f('Employee Number Format', 'text', { group: 'Numbering', default: '{PREFIX}-{YEAR}-{SEQ}' }),
      probation_months: num('Probation (months)', { group: 'Employment', default: 3, min: 0, max: 24 }),
      notice_period_days: num('Notice Period (days)', { group: 'Employment', default: 30, min: 0, max: 365 }),
      contract_renewal_warning_days: num('Contract Renewal Warning (days)', { group: 'Employment', default: 60, min: 0, max: 365 }),
      retirement_age: num('Retirement Age', { group: 'Employment', default: 60, min: 40, max: 80 }),
      employment_types: f('Employment Types', 'text', { group: 'Employment', default: 'PERMANENT,CONTRACT,PROBATION,CASUAL,INTERN,CONSULTANT' }),
      employment_statuses: f('Employment Statuses', 'text', { group: 'Employment', default: 'ACTIVE,SUSPENDED,ON_LEAVE,TERMINATED,RETIRED,RESIGNED' }),
      leave_types: f('Leave Types', 'text', { group: 'Leave', default: 'ANNUAL,SICK,MATERNITY,PATERNITY,COMPASSIONATE,STUDY,UNPAID' }),
      leave_year_start: f('Leave Year Start', 'text', { group: 'Leave', default: '01-01', help: 'MM-DD.' }),
      leave_requires_approval: bool('Leave Requires Approval', { group: 'Leave', default: true }),
      leave_carryover_enabled: bool('Leave Carry-over', { group: 'Leave', default: true }),
      leave_carryover_max_days: num('Maximum Carry-over (days)', { group: 'Leave', default: 10, min: 0, max: 365 }),
      leave_min_notice_days: num('Minimum Notice (days)', { group: 'Leave', default: 7, min: 0, max: 365 }),
      disciplinary_requires_hr: bool('Disciplinary Requires HR', { group: 'Performance', default: true }),
      performance_cycle: sel('Performance Cycle', ['QUARTERLY', 'HALF_YEARLY', 'ANNUAL'], { group: 'Performance', default: 'ANNUAL' }),
      training_records_required: bool('Training Records Required', { group: 'Performance', default: true }),
      payroll_enrolment_default: bool('Enrol New Employees In Payroll', {
        group: 'Payroll boundary',
        default: false,
        help: 'Off by design. A Managing Director, Operations Manager or System Administrator can hold a system account and organisational authority without being on payroll.',
      }),
    },
  },
  {
    id: 'attendance',
    label: 'Attendance Settings',
    group: 'People',
    kind: 'settings',
    manage: 'organisation.attendance.manage',
    blurb: 'Shifts, grace periods and the Hikvision feed. Raw device events are never overwritten - a correction creates a linked adjustment.',
    settings: {
      hikvision_enabled: bool('Hikvision Integration', { group: 'Devices', default: true }),
      attendance_source: sel('Attendance Source', ['DEVICE', 'MANUAL', 'BOTH'], { group: 'Devices', default: 'BOTH' }),
      default_shift: f('Default Shift', 'text', { group: 'Shifts', default: 'DAY' }),
      shift_start: f('Shift Start', 'text', { group: 'Shifts', default: '08:00' }),
      shift_end: f('Shift End', 'text', { group: 'Shifts', default: '17:00' }),
      break_minutes: num('Break (minutes)', { group: 'Shifts', default: 60, min: 0, max: 480 }),
      working_days: f('Working Days', 'text', { group: 'Shifts', default: 'MON-SAT' }),
      late_grace_minutes: num('Late Grace (minutes)', { group: 'Rules', default: 10, min: 0, max: 240 }),
      early_departure_grace_minutes: num('Early Departure Grace (minutes)', { group: 'Rules', default: 10, min: 0, max: 240 }),
      absent_after_minutes: num('Absent After (minutes)', { group: 'Rules', default: 240, min: 0, max: 1440 }),
      auto_overtime_from_attendance: bool('Derive Overtime From Attendance', { group: 'Rules', default: false }),
      correction_requires_approval: bool('Corrections Require Approval', { group: 'Corrections', default: true }),
      correction_window_days: num('Correction Window (days)', { group: 'Corrections', default: 14, min: 1, max: 365 }),
      raw_events_immutable: bool('Raw Device Events Are Immutable', {
        group: 'Corrections',
        default: true,
        help: 'Read-only by design: corrections create a linked adjustment and never rewrite the device event.',
      }),
      clock_in_location_code: f('Clock-in Location', 'text', {
        group: 'Premises',
        help: 'Location code from Organisation structure. Device clock-in is recorded only at that location, using the premises latitude, longitude and radius saved on it.',
      }),
      gps_required: bool('Require GPS On Mobile Clock-in', { group: 'Corrections', default: false }),
    },
  },

  // -------------------------------------------------------------------------
  // Operations
  // -------------------------------------------------------------------------
  {
    id: 'manufacturing',
    label: 'Manufacturing Settings',
    group: 'Operations',
    kind: 'settings',
    manage: 'organisation.manufacturing.manage',
    blurb: 'Plants, machines, shifts, quality gates and waste vocabulary for the factory floor.',
    settings: {
      default_plant: f('Default Plant', 'text', { group: 'Plant', default: 'FACTORY' }),
      machines: f('Machines', 'text', { group: 'Plant', default: 'FSS104,FSS300' }),
      shifts: f('Shifts', 'text', { group: 'Shifts', default: 'DAY,NIGHT' }),
      shift_pattern: sel('Shift Pattern', ['SINGLE', 'TWO_SHIFT', 'THREE_SHIFT', 'CONTINUOUS'], { group: 'Shifts', default: 'TWO_SHIFT' }),
      production_calendar_days: num('Production Days Per Week', { group: 'Shifts', default: 6, min: 1, max: 7 }),
      bom_required: bool('BOM Required', { group: 'Production', default: true }),
      bom_versioning: bool('Version BOMs', { group: 'Production', default: true }),
      routing_required: bool('Routing Required', { group: 'Production', default: false }),
      production_order_approval: bool('Production Orders Require Approval', { group: 'Production', default: true }),
      production_order_prefix: f('Production Order Prefix', 'text', { group: 'Production', default: 'PRD' }),
      scrap_tolerance_percent: num('Scrap Tolerance (%)', { group: 'Quality', default: 3, min: 0, max: 100 }),
      waste_categories: f('Waste Categories', 'text', { group: 'Quality', default: 'TRIM,SPOILAGE,REJECT,DESTROYED,OFFCUT' }),
      downtime_reasons: f('Downtime Reasons', 'text', { group: 'Quality', default: 'BREAKDOWN,SETUP,MATERIAL,NO_OPERATOR,MAINTENANCE,POWER' }),
      qc_gates: f('Quality Gates', 'text', { group: 'Quality', default: 'RAW_MATERIAL,IN_PROCESS,FINAL,RELEASE' }),
      qc_block_on_fail: bool('Block On Quality Failure', { group: 'Quality', default: true }),
      maintenance_due_warning_days: num('Maintenance Warning (days)', { group: 'Maintenance', default: 7, min: 0, max: 365 }),
      require_operator_certification: bool('Require Operator Certification', { group: 'Maintenance', default: true }),
    },
  },
  {
    id: 'inventory',
    label: 'Inventory Settings',
    group: 'Operations',
    kind: 'settings',
    manage: 'organisation.inventory.manage',
    blurb: 'Valuation, tracking and replenishment - plus the custody controls the security-printing line depends on.',
    settings: {
      valuation_method: sel('Valuation Method', ['FIFO', 'WEIGHTED_AVERAGE', 'STANDARD_COST', 'SPECIFIC'], { group: 'Valuation', default: 'WEIGHTED_AVERAGE' }),
      default_uom: f('Default Unit Of Measure', 'text', { group: 'Valuation', default: 'PCS' }),
      batch_tracking: bool('Batch Tracking', { group: 'Tracking', default: true }),
      serial_tracking: bool('Serial Tracking', { group: 'Tracking', default: false }),
      expiry_tracking: bool('Expiry Tracking', { group: 'Tracking', default: true }),
      negative_stock_allowed: bool('Allow Negative Stock', { group: 'Tracking', default: false }),
      reservation_enabled: bool('Stock Reservations', { group: 'Tracking', default: true }),
      reorder_point_enabled: bool('Reorder Points', { group: 'Replenishment', default: true }),
      reorder_review_period_days: num('Reorder Review Period (days)', { group: 'Replenishment', default: 7, min: 1, max: 365 }),
      adjustment_requires_approval: bool('Adjustments Require Approval', { group: 'Controls', default: true }),
      adjustment_approval_threshold: num('Adjustment Approval Threshold', { group: 'Controls', default: 500000, min: 0 }),
      transfer_requires_approval: bool('Transfers Require Approval', { group: 'Controls', default: false }),
      cycle_count_frequency: sel('Cycle Count Frequency', ['MONTHLY', 'QUARTERLY', 'ANNUALLY'], { group: 'Controls', default: 'QUARTERLY' }),
      controlled_materials_enabled: bool('Controlled Materials', { group: 'Security printing', default: true }),
      controlled_material_custody: bool('Custody Tracking', { group: 'Security printing', default: true }),
      controlled_material_reconciliation_days: num('Reconciliation Period (days)', { group: 'Security printing', default: 30, min: 1, max: 365 }),
      spoil_reject_segregation: bool('Segregate Spoilage And Rejects', { group: 'Security printing', default: true }),
      destruction_requires_witness: bool('Destruction Requires A Witness', { group: 'Security printing', default: true }),
    },
  },
  {
    id: 'procurement',
    label: 'Procurement Settings',
    group: 'Operations',
    kind: 'settings',
    manage: ORG_SETTINGS_WRITE,
    blurb: 'Purchase approval thresholds, supplier vetting and the three-way match tolerance.',
    settings: {
      purchase_order_prefix: f('Purchase Order Prefix', 'text', { group: 'Documents', default: 'PO' }),
      po_requires_approval: bool('Purchase Orders Require Approval', { group: 'Approval', default: true }),
      po_approval_threshold: num('PO Approval Threshold', { group: 'Approval', default: 1000000, min: 0 }),
      three_way_match_required: bool('Three-way Match Required', { group: 'Controls', default: true }),
      match_tolerance_percent: num('Match Tolerance (%)', { group: 'Controls', default: 2, min: 0, max: 100 }),
      supplier_approval_required: bool('Suppliers Require Approval', { group: 'Suppliers', default: true }),
      supplier_require_tin: bool('Suppliers Require TIN', { group: 'Suppliers', default: true }),
      supplier_require_wht: bool('Suppliers Require WHT Classification', { group: 'Suppliers', default: true }),
      grn_required_for_payment: bool('Goods Received Note Required For Payment', { group: 'Suppliers', default: true }),
      partial_receipt_allowed: bool('Allow Partial Receipt', { group: 'Suppliers', default: true }),
      rfq_min_suppliers: num('Minimum Suppliers Per RFQ', { group: 'Sourcing', default: 3, min: 1, max: 20 }),
      blanket_po_enabled: bool('Blanket Purchase Orders', { group: 'Sourcing', default: false }),
      local_purchase_preferred: bool('Prefer Local Purchase', { group: 'Sourcing', default: true }),
    },
  },
  {
    id: 'sales',
    label: 'Sales Settings',
    group: 'Operations',
    kind: 'settings',
    manage: ORG_SETTINGS_WRITE,
    blurb: 'Document prefixes, discount authority and the sales order approval band.',
    settings: {
      invoice_prefix: f('Invoice Prefix', 'text', { group: 'Documents', default: 'INV' }),
      quotation_prefix: f('Quotation Prefix', 'text', { group: 'Documents', default: 'QUO' }),
      delivery_note_prefix: f('Delivery Note Prefix', 'text', { group: 'Documents', default: 'DN' }),
      quotation_validity_days: num('Quotation Validity (days)', { group: 'Documents', default: 30, min: 1, max: 365 }),
      max_discount_percent: num('Maximum Discount (%)', { group: 'Pricing', default: 10, min: 0, max: 100 }),
      discount_requires_approval: bool('Discounts Require Approval', { group: 'Pricing', default: true }),
      price_list_required: bool('Price List Required', { group: 'Pricing', default: true }),
      allow_price_override: bool('Allow Price Override', { group: 'Pricing', default: false }),
      credit_note_requires_approval: bool('Credit Notes Require Approval', { group: 'Controls', default: true }),
      invoice_requires_delivery_note: bool('Invoice Requires Delivery Note', { group: 'Controls', default: false }),
      sales_order_requires_approval: bool('Sales Orders Require Approval', { group: 'Controls', default: true }),
      sales_order_approval_threshold: num('Sales Order Approval Threshold', { group: 'Controls', default: 5000000, min: 0 }),
      commission_enabled: bool('Sales Commission', { group: 'Controls', default: false }),
    },
  },
  {
    id: 'crm',
    label: 'CRM Settings',
    group: 'Operations',
    kind: 'settings',
    manage: ORG_SETTINGS_WRITE,
    blurb: 'Pipeline stages, customer segments and follow-up discipline.',
    settings: {
      lead_prefix: f('Lead Prefix', 'text', { group: 'Pipeline', default: 'LEAD' }),
      opportunity_stages: f('Opportunity Stages', 'text', { group: 'Pipeline', default: 'NEW,QUALIFIED,PROPOSAL,NEGOTIATION,WON,LOST' }),
      default_lead_owner_required: bool('Every Lead Needs An Owner', { group: 'Pipeline', default: true }),
      follow_up_sla_days: num('Follow-up SLA (days)', { group: 'Pipeline', default: 2, min: 1, max: 90 }),
      customer_segments: f('Customer Segments', 'text', { group: 'Customers', default: 'CORPORATE,GOVERNMENT,SME,RETAIL,EXPORT' }),
      customer_credit_check: bool('Credit Check New Customers', { group: 'Customers', default: true }),
      customer_requires_tin: bool('Customers Require TIN', { group: 'Customers', default: true }),
      activity_reminders: bool('Activity Reminders', { group: 'Customers', default: true }),
      contract_renewal_warning_days: num('Contract Renewal Warning (days)', { group: 'Customers', default: 60, min: 0, max: 365 }),
      customer_satisfaction_survey: bool('Satisfaction Surveys', { group: 'Customers', default: false }),
    },
  },
  {
    id: 'service_desk',
    label: 'Service Desk Settings',
    group: 'Operations',
    kind: 'settings',
    manage: ORG_SETTINGS_WRITE,
    blurb: 'Ticket numbering, queues, business hours and the SLA clock.',
    settings: {
      ticket_prefix: f('Ticket Prefix', 'text', { group: 'Numbering', default: 'HDG-SD' }),
      ticket_number_format: f('Ticket Number Format', 'text', { group: 'Numbering', default: '{PREFIX}-{YEAR}-{SEQ}' }),
      default_priority: sel('Default Priority', ['LOW', 'MEDIUM', 'HIGH', 'URGENT', 'CRITICAL'], { group: 'Queues', default: 'MEDIUM' }),
      default_queue: f('Default Queue', 'text', { group: 'Queues', default: 'IT_SUPPORT' }),
      first_response_sla_minutes: num('First Response SLA (minutes)', { group: 'SLA', default: 60, min: 1, max: 10080 }),
      resolution_sla_hours: num('Resolution SLA (hours)', { group: 'SLA', default: 24, min: 1, max: 8760 }),
      business_hours: f('Business Hours', 'text', { group: 'SLA', default: '08:00-17:00' }),
      business_days: f('Business Days', 'text', { group: 'SLA', default: 'MON-FRI' }),
      sla_pauses_outside_hours: bool('Pause SLA Outside Business Hours', { group: 'SLA', default: true }),
      escalation_enabled: bool('Escalation', { group: 'Escalation', default: true }),
      escalation_after_percent: num('Escalate After (% of SLA)', { group: 'Escalation', default: 80, min: 1, max: 100 }),
      auto_assign_enabled: bool('Automatic Assignment', { group: 'Escalation', default: true }),
      reopen_window_days: num('Reopen Window (days)', { group: 'Escalation', default: 14, min: 0, max: 365 }),
      satisfaction_survey: bool('Satisfaction Survey On Close', { group: 'Escalation', default: true }),
    },
  },

  // -------------------------------------------------------------------------
  // Documents
  // -------------------------------------------------------------------------
  {
    id: 'numbering',
    label: 'Numbering & Sequences',
    group: 'Documents',
    kind: 'settings',
    manage: 'organisation.documents.manage',
    blurb: 'Central sequence policy. Actual counters live in number_sequences and are allocated inside the writing transaction, so concurrent requests cannot collide.',
    settings: {
      default_format: f('Default Format', 'text', { group: 'Format', default: '{PREFIX}-{YEAR}-{SEQ}' }),
      default_pad: num('Sequence Length', { group: 'Format', default: 6, min: 1, max: 12 }),
      include_branch_code: bool('Include Branch Code', { group: 'Format', default: false }),
      include_department_code: bool('Include Department Code', { group: 'Format', default: false }),
      default_reset_frequency: sel('Reset Frequency', ['YEAR', 'FISCAL_YEAR', 'MONTH', 'QUARTER', 'NONE'], { group: 'Reset', default: 'YEAR' }),
      reset_year_start: f('Year Start', 'text', { group: 'Reset', default: '01-01', help: 'MM-DD. Ignored when the reset frequency is FISCAL_YEAR.' }),
      gap_detection_enabled: bool('Detect Gaps', { group: 'Controls', default: true }),
      allow_manual_number: bool('Allow Manual Numbers', {
        group: 'Controls',
        default: false,
        help: 'Off by default: a manual number breaks the audit chain. Turning it on is a dangerous change and is confirmed separately.',
      }),
      preview_next_number: bool('Preview Next Number', { group: 'Controls', default: true }),
    },
  },
  {
    id: 'documents',
    label: 'Document Settings',
    group: 'Documents',
    kind: 'settings',
    manage: 'organisation.documents.manage',
    blurb: 'Page geometry and the blocks every generated document carries.',
    settings: {
      page_size: sel('Page Size', ['A4', 'A5', 'A3', 'LETTER'], { group: 'Page', default: 'A4' }),
      orientation: sel('Orientation', ['PORTRAIT', 'LANDSCAPE'], { group: 'Page', default: 'PORTRAIT' }),
      margin_top_mm: num('Top Margin (mm)', { group: 'Margins', default: 15, min: 0, max: 100 }),
      margin_bottom_mm: num('Bottom Margin (mm)', { group: 'Margins', default: 15, min: 0, max: 100 }),
      margin_left_mm: num('Left Margin (mm)', { group: 'Margins', default: 15, min: 0, max: 100 }),
      margin_right_mm: num('Right Margin (mm)', { group: 'Margins', default: 15, min: 0, max: 100 }),
      show_logo: bool('Show Logo', { group: 'Header & Footer', default: true }),
      show_secondary_logo: bool('Show Secondary Logo', { group: 'Header & Footer', default: true }),
      header_text: f('Document Header', 'textarea', { group: 'Header & Footer' }),
      footer_text: f('Document Footer', 'textarea', { group: 'Header & Footer' }),
      show_watermark: bool('Show Watermark', { group: 'Watermark', default: false }),
      watermark_text: f('Watermark Text', 'text', { group: 'Watermark' }),
      show_signature_block: bool('Show Signature Block', { group: 'Blocks', default: true }),
      show_qr_code: bool('Show QR Code', { group: 'Blocks', default: true }),
      show_barcode: bool('Show Barcode', { group: 'Blocks', default: false }),
      show_document_number: bool('Show Document Number', { group: 'Blocks', default: true }),
      show_approval_history: bool('Show Approval History', { group: 'Blocks', default: true }),
      confidentiality_classification: sel('Confidentiality Classification', ['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED'], { group: 'Blocks', default: 'INTERNAL' }),
      copy_labels: f('Copy Labels', 'text', { group: 'Blocks', default: 'ORIGINAL,DUPLICATE,TRIPLICATE' }),
      document_retention_days: num('Document Retention (days)', { group: 'Retention', default: 2555, min: 1, help: 'Seven years by default, matching the statutory minimum.' }),
    },
  },
  {
    id: 'signatures',
    label: 'Electronic Signatures',
    group: 'Documents',
    kind: 'signatures',
    manage: 'organisation.documents.manage',
    blurb: 'Which documents must be signed and how a signature is applied. A signature is only ever applied by the workflow, never inserted by hand.',
    settings: {
      signature_required_for: f('Signature Required For', 'text', { group: 'Scope', default: 'INVOICE,PURCHASE_ORDER,PAYSLIP,CONTRACT,OFFICIAL_LETTER' }),
      signature_authority_required: bool('Verify Signature Authority', { group: 'Controls', default: true }),
      allow_manual_signature_insert: bool('Allow Manual Signature Insert', {
        group: 'Controls',
        default: false,
        help: 'Structurally refused: the apply endpoint always records the acting user and the signature profile owner separately, so one person cannot affix another person signature.',
      }),
      signature_hash_algorithm: sel('Hash Algorithm', ['SHA-256', 'SHA-384', 'SHA-512'], { group: 'Integrity', default: 'SHA-256' }),
      signature_requires_approval: bool('Signatures Require Approval', { group: 'Integrity', default: true }),
      signature_expiry_days: num('Signature Validity (days)', { group: 'Integrity', default: 365, min: 0 }),
      verify_url_base: f('Verification URL', 'url', { group: 'Verification', default: 'https://hopedesign.jorlentech.com/verify' }),
      stamp_applied_time: bool('Stamp Applied Time', { group: 'Verification', default: true }),
      stamp_applied_ip: bool('Stamp Applied IP', { group: 'Verification', default: true }),
    },
  },

  // -------------------------------------------------------------------------
  // Governance
  // -------------------------------------------------------------------------
  {
    id: 'approvals',
    label: 'Approval Settings',
    group: 'Governance',
    kind: 'approvals',
    manage: GOV,
    blurb: 'Levels, limits, fallbacks and expiry. A fallback approver gains the approval act only - never a role and never its privileges.',
    settings: {
      approval_expiry_hours: num('Approval Expiry (hours)', { group: 'Controls', default: 72, min: 1, max: 8760 }),
      escalation_hours: num('Escalation After (hours)', { group: 'Controls', default: 24, min: 1, max: 8760 }),
      allow_delegation: bool('Allow Delegation', { group: 'Controls', default: true }),
      fallback_expiry_days: num('Fallback Validity (days)', { group: 'Controls', default: 90, min: 1, max: 1095 }),
      fallback_never_grants_admin: bool('Fallback Never Grants Admin', {
        group: 'Controls',
        default: true,
        help: 'Read-only invariant. It is recorded here so the guarantee is visible and auditable, and the database refuses the alternative structurally.',
      }),
      escalate_on_no_fallback: sel('When No Fallback Exists', ['BLOCK', 'ESCALATE_TO_APPROVER', 'ESCALATE_TO_SECURITY'], { group: 'Controls', default: 'BLOCK' }),
      require_approved_by_different_user: bool('Approver Must Differ From Submitter', { group: 'Segregation', default: true }),
      require_distinct_level_approvers: bool('Distinct Approver Per Level', { group: 'Segregation', default: true }),
      reject_returns_to_previous_level: bool('Rejection Returns To Previous Level', { group: 'Segregation', default: false }),
      require_reason_on_reject: bool('Reason Required On Rejection', { group: 'Segregation', default: true }),
      require_reason_on_override: bool('Reason Required On Override', { group: 'Segregation', default: true }),
      notify_on_submit: bool('Notify On Submit', { group: 'Notifications', default: true }),
      notify_on_decision: bool('Notify On Decision', { group: 'Notifications', default: true }),
    },
  },
  {
    id: 'workflow',
    label: 'Workflow Settings',
    group: 'Governance',
    kind: 'settings',
    manage: GOV,
    blurb: 'Document lifecycle and what may change once a document has moved on.',
    settings: {
      default_document_lifecycle: f('Default Lifecycle', 'text', { group: 'Lifecycle', default: 'DRAFT,SUBMITTED,APPROVED,POSTED,CLOSED' }),
      allow_edit_after_submit: bool('Allow Edit After Submit', { group: 'Lifecycle', default: false }),
      allow_edit_after_approve: bool('Allow Edit After Approval', { group: 'Lifecycle', default: false }),
      allow_cancel_after_post: bool('Allow Cancel After Posting', { group: 'Lifecycle', default: true }),
      cancellation_requires_approval: bool('Cancellation Requires Approval', { group: 'Cancellation', default: true }),
      cancellation_requires_reason: bool('Cancellation Requires A Reason', { group: 'Cancellation', default: true }),
      reversal_creates_new_document: bool('Reversal Creates A New Document', {
        group: 'Cancellation',
        default: true,
        help: 'On by design: a posted document is reversed, never rewritten.',
      }),
      auto_close_after_days: num('Auto Close After (days)', { group: 'SLA', default: 0, min: 0, help: 'Zero disables automatic closing.' }),
      require_attachment_on_submit: bool('Require Attachment On Submit', { group: 'SLA', default: false }),
      sla_warning_hours: num('Warning Before SLA (hours)', { group: 'SLA', default: 48, min: 0 }),
      delegation_honoured_in_workflow: bool('Honour Delegated Authority', { group: 'Delegation', default: true }),
    },
  },
  {
    id: 'security',
    label: 'Security Settings',
    group: 'Governance',
    kind: 'security_policy',
    manage: 'organisation.security.manage',
    blurb: 'Deny-by-default security policy for the organisation. Field names map one-to-one onto the security_policies row.',
    settings: {
      mfa_required: bool('Require MFA For Everyone', { group: 'MFA', default: false }),
      mfa_required_for_admins: bool('Require MFA For Administrators', { group: 'MFA', default: true }),
      password_min_length: num('Password Minimum Length', { group: 'Password', default: 12, min: 8, max: 128 }),
      password_require_upper: bool('Require Uppercase', { group: 'Password', default: true }),
      password_require_lower: bool('Require Lowercase', { group: 'Password', default: true }),
      password_require_digit: bool('Require Digit', { group: 'Password', default: true }),
      password_require_symbol: bool('Require Symbol', { group: 'Password', default: true }),
      password_expiry_days: num('Password Expiry (days)', { group: 'Password', default: 0, min: 0, max: 730, help: 'Zero means no forced rotation.' }),
      password_history_count: num('Password History', { group: 'Password', default: 5, min: 0, max: 24 }),
      max_failed_attempts: num('Maximum Failed Attempts', { group: 'Lockout', default: 5, min: 1, max: 50 }),
      lockout_minutes: num('Lockout Duration (minutes)', { group: 'Lockout', default: 30, min: 1, max: 1440 }),
      session_timeout_minutes: num('Session Timeout (minutes)', { group: 'Sessions', default: 30, min: 1, max: 1440 }),
      idle_timeout_minutes: num('Idle Timeout (minutes)', { group: 'Sessions', default: 0, min: 0, max: 1440, help: 'Zero means the session timeout above is the only limit.' }),
      max_concurrent_sessions: num('Maximum Concurrent Sessions', { group: 'Sessions', default: 5, min: 1, max: 100 }),
      ip_allowlist: f('IP Allowlist', 'text', { group: 'Network', help: 'Comma-separated CIDR ranges. Empty means no IP restriction.' }),
      ip_denylist: f('IP Denylist', 'text', { group: 'Network', help: 'Comma-separated CIDR ranges.' }),
      api_require_https: bool('Require HTTPS For API', { group: 'API', default: true }),
      api_rate_limit_per_minute: num('API Rate Limit (per minute)', { group: 'API', default: 600, min: 1, max: 100000 }),
      api_token_ttl_minutes: num('API Token Lifetime (minutes)', { group: 'API', default: 60, min: 1, max: 43200 }),
      audit_level: sel('Audit Level', ['MINIMAL', 'STANDARD', 'VERBOSE'], { group: 'Auditing', default: 'STANDARD' }),
      privileged_access_requires_approval: bool('Privileged Access Requires Approval', { group: 'Privileged access', default: true }),
      privileged_session_recording: bool('Record Privileged Sessions', { group: 'Privileged access', default: false }),
      sod_enforced: bool('Enforce Segregation Of Duties', { group: 'Privileged access', default: true }),
    },
  },

  // -------------------------------------------------------------------------
  // Communication
  // -------------------------------------------------------------------------
  {
    id: 'notifications',
    label: 'Notification Settings',
    group: 'Communication',
    kind: 'settings',
    manage: ORG_SETTINGS_WRITE,
    blurb: 'Which channels are live, which events notify, and how a failed notification is retried and escalated.',
    settings: {
      email_enabled: bool('Email', { group: 'Channels', default: true }),
      sms_enabled: bool('SMS', { group: 'Channels', default: false }),
      whatsapp_enabled: bool('WhatsApp', { group: 'Channels', default: false }),
      push_enabled: bool('Push', { group: 'Channels', default: true }),
      in_app_enabled: bool('In-App', { group: 'Channels', default: true }),
      quiet_hours_start: f('Quiet Hours Start', 'text', { group: 'Delivery', default: '20:00' }),
      quiet_hours_end: f('Quiet Hours End', 'text', { group: 'Delivery', default: '07:00' }),
      digest_frequency: sel('Digest Frequency', ['NONE', 'DAILY', 'WEEKLY'], { group: 'Delivery', default: 'DAILY' }),
      max_retries: num('Maximum Retries', { group: 'Delivery', default: 3, min: 0, max: 10 }),
      retry_backoff_minutes: num('Retry Backoff (minutes)', { group: 'Delivery', default: 5, min: 1, max: 1440 }),
      escalate_failed_after_minutes: num('Escalate Failed After (minutes)', { group: 'Delivery', default: 60, min: 1, max: 10080 }),
      notify_approval_required: bool('Approval Required', { group: 'Events', default: true }),
      notify_approval_completed: bool('Approval Completed', { group: 'Events', default: true }),
      notify_approval_rejected: bool('Approval Rejected', { group: 'Events', default: true }),
      notify_payroll_completed: bool('Payroll Completed', { group: 'Events', default: true }),
      notify_leave_submitted: bool('Leave Submitted', { group: 'Events', default: true }),
      notify_leave_approved: bool('Leave Approved', { group: 'Events', default: true }),
      notify_ticket_assigned: bool('Ticket Assigned', { group: 'Events', default: true }),
      notify_sla_breach: bool('SLA Breach', { group: 'Events', default: true }),
      notify_po_approved: bool('Purchase Order Approved', { group: 'Events', default: true }),
      notify_invoice_issued: bool('Invoice Issued', { group: 'Events', default: true }),
      notify_payment_received: bool('Payment Received', { group: 'Events', default: true }),
      notify_production_completed: bool('Production Completed', { group: 'Events', default: true }),
      notify_stock_shortage: bool('Stock Shortage', { group: 'Events', default: true }),
      notify_security_event: bool('Security Event', { group: 'Events', default: true }),
      notify_system_alert: bool('System Alert', { group: 'Events', default: true }),
    },
  },
  {
    id: 'communication',
    label: 'Communication Settings',
    group: 'Communication',
    kind: 'settings',
    manage: ORG_SETTINGS_WRITE,
    blurb: 'Outbound mail, SMS and WhatsApp transport. Credentials are encrypted at rest and reported only as present or absent.',
    settings: {
      smtp_host: f('SMTP Host', 'text', { group: 'Email', default: 'smtp.jorlentech.com' }),
      smtp_port: num('SMTP Port', { group: 'Email', default: 587, min: 1, max: 65535 }),
      smtp_username: f('SMTP Username', 'text', { group: 'Email' }),
      smtp_password: f('SMTP Password', 'text', { group: 'Email', secret: true }),
      smtp_secure: sel('SMTP Security', ['NONE', 'STARTTLS', 'TLS'], { group: 'Email', default: 'STARTTLS' }),
      mail_from_name: f('From Name', 'text', { group: 'Email', default: 'HOPE DESIGN GROUP LTD' }),
      mail_from_address: f('From Address', 'email', { group: 'Email', default: 'info@hopedesigngroup.com' }),
      mail_reply_to: f('Reply To', 'email', { group: 'Email', default: 'info@hopedesigngroup.com' }),
      sms_provider: sel('SMS Provider', ['NONE', 'AFRICASTALKING', 'TWILIO', 'LOCAL_GATEWAY'], { group: 'SMS', default: 'NONE' }),
      sms_sender_id: f('SMS Sender ID', 'text', { group: 'SMS' }),
      sms_api_key: f('SMS API Key', 'text', { group: 'SMS', secret: true }),
      whatsapp_provider: sel('WhatsApp Provider', ['NONE', 'META_CLOUD', 'TWILIO'], { group: 'WhatsApp', default: 'NONE' }),
      whatsapp_phone_number_id: f('WhatsApp Phone Number ID', 'text', { group: 'WhatsApp' }),
      whatsapp_access_token: f('WhatsApp Access Token', 'text', { group: 'WhatsApp', secret: true }),
      inbound_email_enabled: bool('Inbound Email', { group: 'Advanced', default: false }),
      signature_footer: f('Email Signature Footer', 'textarea', { group: 'Advanced' }),
    },
  },

  // -------------------------------------------------------------------------
  // Integrations
  // -------------------------------------------------------------------------
  {
    id: 'integrations',
    label: 'Integration Settings',
    group: 'Integrations',
    kind: 'integrations',
    manage: 'organisation.integrations.manage',
    blurb: 'The registry of every external system the ERP talks to - URA/EFRIS, NSSF, banks, SMS, WhatsApp, Hikvision - with per-provider health and encrypted credentials.',
    settings: {
      default_timeout_seconds: num('Default Timeout (seconds)', { group: 'Transport', default: 30, min: 1, max: 600 }),
      default_retry_attempts: num('Default Retry Attempts', { group: 'Transport', default: 3, min: 0, max: 10 }),
      circuit_breaker_enabled: bool('Circuit Breaker', { group: 'Resilience', default: true }),
      circuit_breaker_failures: num('Open After Consecutive Failures', { group: 'Resilience', default: 5, min: 1, max: 100 }),
      health_check_interval_minutes: num('Health Check Interval (minutes)', { group: 'Resilience', default: 15, min: 1, max: 1440 }),
      log_requests: bool('Log Requests', { group: 'Logging', default: true }),
      log_responses: bool('Log Responses', { group: 'Logging', default: true }),
      mask_secrets_in_logs: bool('Mask Secrets In Logs', {
        group: 'Logging',
        default: true,
        help: 'Read-only invariant: credentials are stored encrypted and redacted from logs and audit records.',
      }),
      alert_on_failure: bool('Alert On Failure', { group: 'Logging', default: true }),
      failure_alert_threshold: num('Alert After Consecutive Failures', { group: 'Logging', default: 3, min: 1, max: 100 }),
    },
  },

  // -------------------------------------------------------------------------
  // System
  // -------------------------------------------------------------------------
  {
    id: 'qr',
    label: 'QR & Traceability',
    group: 'System',
    kind: 'settings',
    manage: 'organisation.qr.manage',
    blurb: 'QR prefixes, formats, encrypted payloads and the scan actions a traceability label supports.',
    settings: {
      default_prefix: f('Default Prefix', 'text', { group: 'Format', default: 'HDG' }),
      default_format: sel('Default Format', ['PREFIX-YEAR-SEQ', 'PREFIX-SEQ', 'GS1', 'CUSTOM'], { group: 'Format', default: 'PREFIX-YEAR-SEQ' }),
      default_pad_length: num('Sequence Length', { group: 'Format', default: 6, min: 1, max: 12 }),
      verify_url_base: f('Verification URL', 'url', { group: 'Format', default: 'https://hopedesign.jorlentech.com/verify' }),
      encryption_enabled: bool('Encrypt QR Payload', { group: 'Security', default: true }),
      signing_enabled: bool('Sign QR Payload', { group: 'Security', default: true }),
      qr_expiry_days: num('QR Expiry (days)', { group: 'Security', default: 0, min: 0, help: 'Zero means the code does not expire; its lifecycle is controlled by scan status instead.' }),
      statuses: f('Statuses', 'text', { group: 'Lifecycle', default: 'ACTIVE,SUSPENDED,DAMAGED,REPLACED,VOID,LOST,ARCHIVED' }),
      scan_actions: f('Scan Actions', 'text', { group: 'Lifecycle', default: 'RECEIVE,PUT_AWAY,MOVE,TRANSFER,PICK,ISSUE,COUNT,ADJUST,RETURN,DISPATCH,VERIFY,TRACK' }),
      scan_requires_permission: bool('Scans Require Permission', { group: 'Lifecycle', default: true }),
      block_scan_on_suspended: bool('Block Scanning A Suspended Code', { group: 'Lifecycle', default: true }),
      public_verification_enabled: bool('Public Verification Page', { group: 'Lifecycle', default: true }),
      label_template: f('Label Template', 'text', { group: 'Lifecycle', default: 'STANDARD_50x25' }),
    },
  },
  {
    id: 'backup',
    label: 'Backup & Retention',
    group: 'System',
    kind: 'retention',
    manage: ORG_SETTINGS_WRITE,
    blurb: 'Backup cadence, recovery targets and retention policy. Nothing under legal hold is ever purged.',
    settings: {
      backup_frequency: sel('Backup Frequency', ['HOURLY', 'DAILY', 'WEEKLY'], { group: 'Backup', default: 'DAILY' }),
      backup_run_at: f('Backup Time', 'text', { group: 'Backup', default: '02:00' }),
      backup_retention_count: num('Backups Retained', { group: 'Backup', default: 30, min: 1, max: 3650 }),
      backup_encryption_required: bool('Encrypt Backups', { group: 'Backup', default: true }),
      backup_offsite_required: bool('Offsite Copy Required', { group: 'Backup', default: true }),
      verify_restore: bool('Verify Restore', { group: 'Backup', default: true }),
      rpo_minutes: num('Recovery Point Objective (minutes)', { group: 'Recovery', default: 1440, min: 1 }),
      rto_minutes: num('Recovery Time Objective (minutes)', { group: 'Recovery', default: 240, min: 1 }),
      disaster_recovery_plan_review_days: num('DR Plan Review (days)', { group: 'Recovery', default: 180, min: 1, max: 3650 }),
      destructive_purge_requires_approval: bool('Destructive Purge Requires Approval', {
        group: 'Retention',
        default: true,
        help: 'Read-only invariant: records under legal hold are never purged, and statutory records are never deleted destructively.',
      }),
      retention_authorisation: f('Retention Authorisation', 'text', { group: 'Retention', default: 'data_protection_officer' }),
    },
  },
  {
    id: 'audit',
    label: 'Audit & Compliance',
    group: 'System',
    kind: 'audit',
    manage: 'organisation.audit.view',
    blurb: 'What the audit trail captures, how long it is kept, and who may export it. Every configuration change on this screen is itself audited.',
    settings: {
      audit_retention_days: num('Audit Retention (days)', { group: 'Retention', default: 3650, min: 30 }),
      config_history_retention_days: num('Configuration History Retention (days)', { group: 'Retention', default: 3650, min: 30 }),
      audit_include_reads: bool('Include Reads', { group: 'Capture', default: false }),
      audit_include_config: bool('Include Configuration Changes', { group: 'Capture', default: true }),
      audit_include_auth: bool('Include Authentication Events', { group: 'Capture', default: true }),
      audit_require_reason: bool('Require A Reason For Changes', { group: 'Capture', default: true }),
      audit_export_enabled: bool('Allow Audit Export', { group: 'Export', default: true }),
      audit_export_requires_approval: bool('Audit Export Requires Approval', { group: 'Export', default: true }),
      compliance_report_frequency: sel('Compliance Report Frequency', ['MONTHLY', 'QUARTERLY', 'ANNUALLY'], { group: 'Export', default: 'QUARTERLY' }),
    },
  },
];

export const ORG_CATEGORY_BY_ID: Map<string, OrgCategory> = new Map(
  ORG_CATEGORIES.map((c) => [c.id, c])
);

/** Every distinct write permission the module can ask for. */
export const ORG_MANAGE_PERMISSIONS: string[] = Array.from(
  new Set([
    ...ORG_CATEGORIES.map((c) => c.manage),
    // The structure categories live in structure.ts, so their write permission
    // is not in the array above and has to be named here by hand.
    ORG_STRUCTURE_PERMISSION,
  ])
);

/** Platform default for one field, or undefined when the field has none. */
export function defaultFor(categoryId: string, key: string): unknown {
  const def = ORG_CATEGORY_BY_ID.get(categoryId)?.settings?.[key];
  return def ? def.default : undefined;
}

/** `app_settings.category` value for a settings-kind category. */
export function storageCategory(categoryId: string): string {
  return 'organisation.' + categoryId;
}

export function categoryFields(categoryId: string): Record<string, OrgSettingDef> {
  return ORG_CATEGORY_BY_ID.get(categoryId)?.settings ?? {};
}

export function secretFieldKeys(categoryId: string): string[] {
  return Object.entries(categoryFields(categoryId))
    .filter(([, def]) => def.secret === true)
    .map(([key]) => key);
}

/**
 * Changes that warrant a separate confirmation in the UI and a reason in the
 * audit record, because getting them wrong is expensive or hard to undo.
 */
export const ORG_DANGEROUS_KEYS: ReadonlySet<string> = new Set([
  'allow_manual_number',
  'period_reopen_requires_approval',
  'period_lock_on_close',
  'allow_edit_after_posted',
  'allow_edit_after_approve',
  'allow_edit_after_submit',
  'sod_enforced',
  'mfa_required_for_admins',
  'privileged_access_requires_approval',
  'audit_level',
  'mask_secrets_in_logs',
  'raw_events_immutable',
  'destructive_purge_requires_approval',
  'negative_stock_allowed',
  'allow_price_override',
  'efris_enabled',
  'multi_currency_enabled',
]);

/**
 * Settings the ERP treats as fixed invariants.
 *
 * A screen round-trips its whole form, so these may be sent back unchanged -
 * but they may never be flipped. The list is exported rather than inlined so
 * the API can publish it and the settings screen can render those fields
 * read-only, instead of letting an administrator discover the rule by having a
 * save rejected.
 */
export const ORG_IMMUTABLE_KEYS: ReadonlySet<string> = new Set([
  'fallback_never_grants_admin',
  'mask_secrets_in_logs',
  'raw_events_immutable',
  'destructive_purge_requires_approval',
]);

/** True when the given key may not be written for the given category/kind. */
export function isImmutableKey(key: string): boolean {
  return ORG_IMMUTABLE_KEYS.has(key);
}
