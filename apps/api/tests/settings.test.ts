import { describe, it, expect } from 'vitest';
import { api, auth, loginAs, db } from './helpers.js';

interface SettingPayload {
  category: string;
  label: string;
  blurb: string;
  meta: { updated_at: string | null; updated_by: string | null };
  settings: Record<string, { value: unknown; default: unknown; label: string; saved: boolean; type?: string; group?: string | null }>;
}

interface AuditRow {
  id: number;
  resource: string;
  action: string;
  actor: string | null;
  new_values: Record<string, unknown> | null;
  old_values: Record<string, unknown> | null;
}

describe('app settings: catalogue, upsert, audit, reset and RBAC', () => {
  it('lists the settings catalogue with defaults for an administrator', async () => {
    const { token } = await loginAs('admin');
    const res = await api.get('/api/settings').set(auth(token));
    expect(res.status).toBe(200);
    const data = res.body.data as SettingPayload[];
    expect(data.length).toBe(6);
    const general = data.find((c) => c.category === 'general');
    expect(general).toBeTruthy();
    expect(general!.label).toBe('General');
    expect(general!.blurb).toBeTruthy();
    expect('updated_at' in general!.meta).toBe(true);
    expect(general!.settings.company_name.label).toBe('Company name');
    expect(['UGX', 'USD', 'EUR', 'GBP', 'KES', 'TZS']).toContain(general!.settings.currency.value);
    expect(typeof general!.settings.low_stock_threshold.value).toBe('number');
    expect(general!.settings.currency.default).toBe('UGX');
    expect(general!.settings.company_tagline.default).toBeNull();
    expect(typeof general!.settings.company_tagline.saved).toBe('boolean');
  });

  it('exposes grouped general settings with modern field types', async () => {
    const { token } = await loginAs('admin');
    const res = await api.get('/api/settings').set(auth(token));
    expect(res.status).toBe(200);
    const general = (res.body.data as SettingPayload[]).find((c) => c.category === 'general');
    expect(general!.settings.brand_color).toMatchObject({
      type: 'color',
      default: '#1261A0',
      group: 'Company identity',
    });
    expect(general!.settings.brand_color_secondary.type).toBe('color');
    expect(general!.settings.website.type).toBe('url');
    expect(general!.settings.contact_phone.type).toBe('tel');
    expect(general!.settings.physical_address.type).toBe('textarea');
    expect(general!.settings.physical_address.group).toBe('Contact & location');
    expect(general!.settings.company_tagline.group).toBe('Company identity');
  });

  it('persists color, url, tel and textarea settings and audits them', async () => {
    const { token } = await loginAs('admin');
    const res = await api.patch('/api/settings').set(auth(token)).send({
      category: 'general',
      values: {
        brand_color: '#0B5ED7',
        website: 'https://hopedesign.co.ug',
        contact_phone: '+256 700 000 000',
        physical_address: 'Plot 7, Kampala Road\nKampala',
      },
    });
    expect(res.status).toBe(200);
    const s = res.body.data.settings;
    expect(s.brand_color.value).toBe('#0B5ED7');
    expect(s.brand_color.saved).toBe(true);
    expect(s.brand_color.group).toBe('Company identity');
    expect(s.website.value).toBe('https://hopedesign.co.ug');
    expect(s.contact_phone.value).toBe('+256 700 000 000');
    expect(s.physical_address.value).toBe('Plot 7, Kampala Road\nKampala');

    const audit = await db(
      `SELECT new_values FROM audit_logs WHERE resource = $1 AND action = 'update' ORDER BY id DESC LIMIT 1`,
      ['settings.general']
    );
    expect(audit.rows.length).toBeGreaterThan(0);
    expect(audit.rows[0].new_values.brand_color).toBe('#0B5ED7');
    expect(audit.rows[0].new_values.physical_address).toBe('Plot 7, Kampala Road\nKampala');
  });

  it('rejects unknown categories, unknown keys and invalid types', async () => {
    const { token } = await loginAs('admin');
    const badCat = await api.patch('/api/settings').set(auth(token)).send({ category: 'nope', values: { a: 1 } });
    expect(badCat.status).toBe(400);
    const badKey = await api.patch('/api/settings').set(auth(token)).send({ category: 'general', values: { nope: 1 } });
    expect(badKey.status).toBe(400);
    const badType = await api.patch('/api/settings').set(auth(token)).send({ category: 'general', values: { low_stock_threshold: 'abc' } });
    expect(badType.status).toBe(400);
  });

  it('upserts settings, returns the refreshed category and audits the change', async () => {
    const { token } = await loginAs('admin');
    const res = await api.patch('/api/settings').set(auth(token)).send({
      category: 'general',
      values: { low_stock_threshold: 7, currency: 'USD' },
    });
    expect(res.status).toBe(200);
    expect(res.body.data.category).toBe('general');
    expect(res.body.data.settings.low_stock_threshold.value).toBe(7);
    expect(res.body.data.settings.currency.value).toBe('USD');
    expect(res.body.data.meta.updated_by).toBeTruthy();

    const audit = await db(
      `SELECT resource, new_values, user_id FROM audit_logs WHERE resource = $1 AND action = 'update' ORDER BY id DESC LIMIT 1`,
      ['settings.general']
    );
    expect(audit.rows.length).toBeGreaterThan(0);
    expect(audit.rows[0].new_values.low_stock_threshold).toBe(7);
    expect(audit.rows[0].new_values.currency).toBe('USD');
  });

  it('exposes the settings audit trail over the API', async () => {
    const { token } = await loginAs('admin');
    await api.patch('/api/settings').set(auth(token)).send({ category: 'quality', values: { inspection_default: 'full' } });
    const res = await api.get('/api/settings/audit?page=1&pageSize=50').set(auth(token));
    expect(res.status).toBe(200);
    expect(res.body.pagination.total).toBeGreaterThan(0);
    const rows = res.body.data as AuditRow[];
    const found = rows.find(
      (r) => r.resource === 'settings.quality' && r.new_values?.inspection_default === 'full'
    );
    expect(found).toBeTruthy();
    expect(found!.actor).toBeTruthy();
  });

  it('resets a category to defaults and audits the reset', async () => {
    const { token } = await loginAs('admin');
    await api.patch('/api/settings').set(auth(token)).send({ category: 'documents', values: { retention_days: 999 } });
    const res = await api.post('/api/settings/reset').set(auth(token)).send({ category: 'documents' });
    expect(res.status).toBe(200);
    expect(res.body.data[0].category).toBe('documents');
    expect(res.body.data[0].settings.retention_days.value).toBe(1825);
    expect(res.body.data[0].settings.retention_days.saved).toBe(false);

    const audit = await db(
      `SELECT resource, metadata FROM audit_logs WHERE resource = $1 AND action = 'reset' ORDER BY id DESC LIMIT 1`,
      ['settings.documents']
    );
    expect(audit.rows.length).toBeGreaterThan(0);
    expect(audit.rows[0].metadata.deleted).toBeGreaterThan(0);
  });

  it('rejects reset with an unknown or missing category', async () => {
    const { token } = await loginAs('admin');
    const bad = await api.post('/api/settings/reset').set(auth(token)).send({ category: 'nope' });
    expect(bad.status).toBe(400);
    const none = await api.post('/api/settings/reset').set(auth(token)).send({});
    expect(none.status).toBe(400);
  });

  it('resets every category back to defaults', async () => {
    const { token } = await loginAs('admin');
    await api.patch('/api/settings').set(auth(token)).send({ category: 'security', values: { password_min_length: 12 } });
    const res = await api.post('/api/settings/reset').set(auth(token)).send({ all: true });
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(6);
    const security = res.body.data.find((c: SettingPayload) => c.category === 'security');
    expect(security!.settings.password_min_length.value).toBe(8);
    expect(security!.settings.password_min_length.saved).toBe(false);
  });

  it('preserves uploaded logo, favicon and signature URLs when resetting settings', async () => {
    const { token } = await loginAs('admin');
    const set = await api.patch('/api/settings').set(auth(token)).send({
      category: 'general',
      values: {
        logo_url: 'https://example.com/logo.png',
        favicon_url: 'https://example.com/favicon.ico',
        signature_url: 'https://example.com/signature.png',
        footer_logo_url: 'https://example.com/footer-logo.png',
        company_tagline: 'To be wiped on reset',
      },
    });
    expect(set.status).toBe(200);

    const res = await api.post('/api/settings/reset').set(auth(token)).send({ all: true });
    expect(res.status).toBe(200);
    const general = res.body.data.find((c: SettingPayload) => c.category === 'general');
    expect(general!.settings.logo_url.value).toBe('https://example.com/logo.png');
    expect(general!.settings.logo_url.saved).toBe(true);
    expect(general!.settings.favicon_url.value).toBe('https://example.com/favicon.ico');
    expect(general!.settings.favicon_url.saved).toBe(true);
    expect(general!.settings.signature_url.value).toBe('https://example.com/signature.png');
    expect(general!.settings.signature_url.saved).toBe(true);
    expect(general!.settings.footer_logo_url.value).toBe('https://example.com/footer-logo.png');
    expect(general!.settings.footer_logo_url.saved).toBe(true);
    expect(general!.settings.company_tagline.saved).toBe(false);

    await api.delete('/api/settings/logo').set(auth(token));
    await api.delete('/api/settings/favicon').set(auth(token));
    await api.delete('/api/settings/signature').set(auth(token));
    await api.delete('/api/settings/footer-logo').set(auth(token));
  });

  it('blocks low-privilege users from viewing, changing, auditing or resetting settings', async () => {
    const { token } = await loginAs('sso.demo');
    const view = await api.get('/api/settings').set(auth(token));
    expect(view.status).toBe(403);
    expect(view.body.error.code).toBe('FORBIDDEN');
    const update = await api.patch('/api/settings').set(auth(token)).send({ category: 'general', values: { low_stock_threshold: 9 } });
    expect(update.status).toBe(403);
    const audit = await api.get('/api/settings/audit').set(auth(token));
    expect(audit.status).toBe(403);
    const reset = await api.post('/api/settings/reset').set(auth(token)).send({ all: true });
    expect(reset.status).toBe(403);
  });
});
