import pg from 'pg';
import { Ctx } from '../db.js';
import { badRequest } from '../utils.js';
import { resolveAppSettings, settingBool, settingNumber, settingString, upsertAppSetting } from './companyConfig.js';

/**
 * Expenditure posting configuration + policies.
 *
 * These were previously hardcoded GL account codes scattered through
 * expenses.ts. They now resolve from `app_settings` (category `expenditure`)
 * with the same precedence as every other setting: company override > tenant
 * default > built-in default. Values are validated on save but never
 * hardcoded — the defaults below are only the out-of-the-box seed and a tenant
 * can point any of them at a different, real chart-of-accounts code.
 */

export interface ExpenseSettings {
  expenseAccountCode: string;
  expensePayableAccountCode: string;
  bankClearingAccountCode: string;
  reimbursementPayableAccountCode: string;
  inputVatAccountCode: string;
  approvalLimitAmount: number;
  allowOverBudget: boolean;
}

const CATEGORY = 'expenditure';

export const EXPENSE_SETTING_DEFAULTS: ExpenseSettings = {
  expenseAccountCode: '10254500',
  expensePayableAccountCode: '10121100',
  bankClearingAccountCode: '10111300',
  reimbursementPayableAccountCode: '10111200',
  inputVatAccountCode: '10111900',
  approvalLimitAmount: 0,
  allowOverBudget: false,
};

const KEY_MAP: Array<[keyof ExpenseSettings, string]> = [
  ['expenseAccountCode', 'expense_account_code'],
  ['expensePayableAccountCode', 'expense_payable_account_code'],
  ['bankClearingAccountCode', 'bank_clearing_account_code'],
  ['reimbursementPayableAccountCode', 'reimbursement_payable_account_code'],
  ['inputVatAccountCode', 'input_vat_account_code'],
  ['approvalLimitAmount', 'approval_limit_amount'],
  ['allowOverBudget', 'allow_over_budget'],
];

export async function getExpenseSettings(client: pg.PoolClient, ctx: Ctx): Promise<ExpenseSettings> {
  const settings = await resolveAppSettings(client, ctx);
  const s = (key: string, fallback: string) => settingString(settings, key) || fallback;
  return {
    expenseAccountCode: s('expenditure.expense_account_code', EXPENSE_SETTING_DEFAULTS.expenseAccountCode),
    expensePayableAccountCode: s('expenditure.expense_payable_account_code', EXPENSE_SETTING_DEFAULTS.expensePayableAccountCode),
    bankClearingAccountCode: s('expenditure.bank_clearing_account_code', EXPENSE_SETTING_DEFAULTS.bankClearingAccountCode),
    reimbursementPayableAccountCode: s('expenditure.reimbursement_payable_account_code', EXPENSE_SETTING_DEFAULTS.reimbursementPayableAccountCode),
    inputVatAccountCode: s('expenditure.input_vat_account_code', EXPENSE_SETTING_DEFAULTS.inputVatAccountCode),
    approvalLimitAmount: settingNumber(settings, 'expenditure.approval_limit_amount'),
    allowOverBudget: settingBool(settings, 'expenditure.allow_over_budget'),
  };
}

/** Persist only the keys present in `body`; unknown keys are ignored, values validated. */
export async function saveExpenseSettings(client: pg.PoolClient, ctx: Ctx, body: Record<string, unknown>): Promise<ExpenseSettings> {
  for (const [camel, key] of KEY_MAP) {
    if (!(camel in body)) continue;
    let value = body[camel];
    if (camel === 'approvalLimitAmount') {
      const amt = Number(value);
      if (!Number.isFinite(amt) || amt < 0) throw badRequest('Approval limit must be a non-negative number');
      value = amt;
    } else if (camel === 'allowOverBudget') {
      value = value === true || value === 'true' || value === 1 || value === '1';
    } else {
      const code = String(value ?? '').trim();
      if (!code) throw badRequest(`${camel} cannot be empty`);
      value = code;
    }
    await upsertAppSetting(client, ctx, CATEGORY, key, value, { resource: `expenditure.policy.${key}` });
  }
  return getExpenseSettings(client, ctx);
}
