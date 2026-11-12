import pg from 'pg';
import { Ctx } from '../db.js';
import { badRequest } from '../utils.js';
import { resolveAppSettings, settingBool, upsertAppSetting } from './companyConfig.js';

/**
 * Sales app settings from app_settings category `sales`.
 * Company override beats the tenant default, same as every other setting.
 * Invoicing policy is not stored: customer invoices are created from dispatched
 * quantities only, so the policy is delivered quantities.
 */

export interface SalesSettings {
  defaultQuotationValidityDays: number;
  lockConfirmedSales: boolean;
  proformaInvoice: boolean;
  showMargins: boolean;
  discounts: boolean;
  saleWarnings: boolean;
  defaultTemplateId: number | null;
  /** Always delivered. Exposed so the settings screen can state the real rule. */
  invoicingPolicy: 'delivered';
}

const CATEGORY = 'sales';

export const SALES_SETTING_DEFAULTS: SalesSettings = {
  defaultQuotationValidityDays: 30,
  lockConfirmedSales: false,
  proformaInvoice: false,
  showMargins: false,
  discounts: true,
  saleWarnings: true,
  defaultTemplateId: null,
  invoicingPolicy: 'delivered',
};

function daysFrom(raw: unknown): number {
  if (raw === undefined || raw === null || raw === '') return SALES_SETTING_DEFAULTS.defaultQuotationValidityDays;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.trunc(n) : SALES_SETTING_DEFAULTS.defaultQuotationValidityDays;
}

function templateFrom(raw: unknown): number | null {
  if (raw === undefined || raw === null || raw === '' || raw === 0 || raw === '0') return null;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export async function getSalesSettings(client: pg.PoolClient, ctx: Ctx): Promise<SalesSettings> {
  const settings = await resolveAppSettings(client, ctx);
  return {
    defaultQuotationValidityDays: daysFrom(settings['sales.default_quotation_validity_days']),
    lockConfirmedSales: settingBool(settings, 'sales.lock_confirmed_sales'),
    proformaInvoice: settingBool(settings, 'sales.proforma_invoice'),
    showMargins: settingBool(settings, 'sales.show_margins'),
    discounts: settings['sales.discounts'] === undefined ? true : settingBool(settings, 'sales.discounts'),
    saleWarnings: settings['sales.sale_warnings'] === undefined ? true : settingBool(settings, 'sales.sale_warnings'),
    defaultTemplateId: templateFrom(settings['sales.default_template_id']),
    invoicingPolicy: 'delivered',
  };
}

function asBool(value: unknown): boolean {
  return value === true || value === 'true' || value === 1 || value === '1';
}

/** Persist only the keys present in `body`. */
export async function saveSalesSettings(client: pg.PoolClient, ctx: Ctx, body: Record<string, unknown>): Promise<SalesSettings> {
  if ('defaultQuotationValidityDays' in body) {
    const days = Number(body.defaultQuotationValidityDays);
    if (!Number.isInteger(days) || days < 0 || days > 365) {
      throw badRequest('Default quotation validity must be a whole number of days from 0 to 365');
    }
    await upsertAppSetting(client, ctx, CATEGORY, 'default_quotation_validity_days', days, { resource: 'sales.settings' });
  }
  if ('lockConfirmedSales' in body) {
    await upsertAppSetting(client, ctx, CATEGORY, 'lock_confirmed_sales', asBool(body.lockConfirmedSales), { resource: 'sales.settings' });
  }
  if ('proformaInvoice' in body) {
    await upsertAppSetting(client, ctx, CATEGORY, 'proforma_invoice', asBool(body.proformaInvoice), { resource: 'sales.settings' });
  }
  if ('showMargins' in body) {
    await upsertAppSetting(client, ctx, CATEGORY, 'show_margins', asBool(body.showMargins), { resource: 'sales.settings' });
  }
  if ('discounts' in body) {
    await upsertAppSetting(client, ctx, CATEGORY, 'discounts', asBool(body.discounts), { resource: 'sales.settings' });
  }
  if ('saleWarnings' in body) {
    await upsertAppSetting(client, ctx, CATEGORY, 'sale_warnings', asBool(body.saleWarnings), { resource: 'sales.settings' });
  }
  if ('defaultTemplateId' in body) {
    const id = templateFrom(body.defaultTemplateId);
    if (body.defaultTemplateId != null && body.defaultTemplateId !== '' && body.defaultTemplateId !== 0 && id == null) {
      throw badRequest('Default template is not a valid id');
    }
    if (id != null) {
      const found = await client.query(
        `SELECT id FROM quotation_templates WHERE id = $1 AND tenant_id = $2 AND active = true`,
        [id, ctx.tenantId]
      );
      if (found.rows.length === 0) throw badRequest('Default quotation template was not found');
    }
    await upsertAppSetting(client, ctx, CATEGORY, 'default_template_id', id, { resource: 'sales.settings' });
  }
  return getSalesSettings(client, ctx);
}
