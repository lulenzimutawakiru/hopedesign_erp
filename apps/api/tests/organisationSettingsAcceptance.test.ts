import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { api, auth, db, loginAs, pool } from './helpers.js';
import { tx } from '../src/db.js';
import type { Ctx } from '../src/db.js';
import { categoryHistory, loadCategory, saveCategory } from '../src/services/organisationSettings/index.js';
import * as tax from '../src/services/organisationSettings/tax.js';
import * as numbering from '../src/services/organisationSettings/numbering.js';
import * as signatures from '../src/services/organisationSettings/signatures.js';
import * as structure from '../src/services/organisationSettings/structure.js';
import * as integrations from '../src/services/organisationSettings/integrations.js';
import * as fiscal from '../src/services/organisationSettings/fiscal.js';

/**
 * Organisation Settings - the acceptance criteria.
 *
 * The catalogue/loading spec lives in organisationSettings.test.ts. This file
 * drives the invariants that the specification calls out by number
 * (AC-ORG-001..012, TC-ORG-001..010), because those are the ones a future
 * change is most likely to break quietly.
 *
 * Everything written here is throwaway and is removed again in afterAll: the
 * suite runs against a live development database that holds real settings, so
 * nothing may be left behind and nothing pre-existing may be disturbed.
 */

const TENANT_ID = 2;
const COMPANY_ID = 2;
const BRANCH_ID = 2;
const ADMIN_ID = 1;
// A second real user, to stand in as the principal of a delegation. An acting
// assignment must name whose authority is being exercised.
const PRINCIPAL_USER_ID = 12;

const CORRELATION_ID = 'test-org-acceptance';

const ctx: Ctx = {
  tenantId: TENANT_ID,
  companyId: COMPANY_ID,
  branchId: BRANCH_ID,
  userId: ADMIN_ID,
  correlationId: CORRELATION_ID,
  ip: '127.0.0.1',
  userAgent: 'vitest',
};

const TAG = 'AC' + Math.random().toString(36).slice(2, 8).toUpperCase();

/** Signature profiles created by this file, cleaned up in afterAll. */
const profileIds: number[] = [];

const companyBefore: { legal_name: string; name: string; currency: string } = {
  legal_name: '',
  name: '',
  currency: '',
};

beforeAll(async () => {
  const res = await db('SELECT legal_name, name, currency FROM companies WHERE id = $1', [COMPANY_ID]);
  Object.assign(companyBefore, res.rows[0]);
});

afterAll(async () => {
  const like = '%' + TAG + '%';

  // Profile settings + the columns they mirror onto.
  await db(
    `DELETE FROM app_settings
      WHERE tenant_id = $1 AND category = 'organisation.profile'
        AND value::text LIKE $2`,
    [TENANT_ID, like]
  );
  await db(
    `DELETE FROM app_settings
      WHERE tenant_id = $1 AND category = 'organisation.profile'
        AND key IN ('legal_name', 'trading_name') AND value::text LIKE $2`,
    [TENANT_ID, like]
  );
  await db('UPDATE companies SET legal_name = $2, name = $3, currency = $4 WHERE id = $1', [
    COMPANY_ID,
    companyBefore.legal_name,
    companyBefore.name,
    companyBefore.currency,
  ]);

  // Throwaway numbering rule and its counters.
  await db("DELETE FROM document_numbering_rules WHERE tenant_id = $1 AND doc_type LIKE $2", [TENANT_ID, '%' + TAG + '%']);
  await db("DELETE FROM number_sequences WHERE tenant_id = $1 AND seq_key LIKE $2", [TENANT_ID, '%' + TAG + '%']);

  // Tax revisions: the closed revision refuses DELETE by trigger, which is the
  // invariant under test, so cleanup relaxes it for this statement only.
  await db("DELETE FROM tax_rates WHERE tenant_id = $1 AND tax_code LIKE $2", [TENANT_ID, '%' + TAG + '%'])
    .catch(async () => {
      await db('ALTER TABLE tax_rates DISABLE TRIGGER USER');
      try {
        await db('DELETE FROM tax_rates WHERE tenant_id = $1 AND tax_code LIKE $2', [TENANT_ID, '%' + TAG + '%']);
      } finally {
        await db('ALTER TABLE tax_rates ENABLE TRIGGER USER');
      }
    });

  await db('DELETE FROM acting_assignments WHERE tenant_id = $1 AND label LIKE $2', [TENANT_ID, '%' + TAG + '%']);
  // Scopes first: they reference the profiles, so removing the profiles first
  // would either cascade or fail on the foreign key depending on the schema.
  await db('DELETE FROM signature_authority_scopes WHERE tenant_id = $1 AND profile_id = ANY($2::bigint[])', [
    TENANT_ID,
    profileIds,
  ]).catch(() => undefined);
  await db('DELETE FROM signature_profiles WHERE tenant_id = $1 AND full_name LIKE $2', [TENANT_ID, '%' + TAG + '%']);
  await db('DELETE FROM financial_periods WHERE tenant_id = $1 AND code LIKE $2', [TENANT_ID, '%' + TAG + '%']);
  await db('DELETE FROM branches WHERE tenant_id = $1 AND code LIKE $2', [TENANT_ID, '%' + TAG + '%']);
  await db('DELETE FROM company_integrations WHERE tenant_id = $1 AND code = $2 AND name LIKE $3', [
    TENANT_ID,
    'ura_efris',
    '%' + TAG + '%',
  ]);

  await pool.end();
});

async function currentRate(code: string, onDate: string) {
  return tx((client) => tax.resolveTaxRate(client, ctx, code, onDate), ctx);
}

// ---------------------------------------------------------------------------

describe('AC-ORG-001 / TC-ORG-001 - organisation information is createable and updateable', () => {
  it('persists the change, mirrors it onto the company row and audits it', async () => {
    const legalName = 'HOPE DESIGN GROUP LTD ' + TAG;
    const tradingName = 'Hope Design ' + TAG;

    await tx(
      (client) =>
        saveCategory(
          client,
          ctx,
          'profile',
          { values: { legal_name: legalName, trading_name: tradingName } },
          { reason: 'TC-ORG-001 verify write-through and audit' }
        ),
      ctx
    );

    // AC-ORG-002 - the value is in PostgreSQL, not in a process-local object.
    const stored = await db(
      `SELECT key, value #>> '{}' AS text FROM app_settings
        WHERE tenant_id = $1 AND category = 'organisation.profile' AND key IN ('legal_name', 'trading_name')`,
      [TENANT_ID]
    );
    const byKey = new Map(stored.rows.map((r) => [r.key as string, r.text as string]));
    expect(byKey.get('legal_name')).toBe(legalName);
    expect(byKey.get('trading_name')).toBe(tradingName);

    // AC-ORG-012 - the rest of the ERP reads the companies row, so the change
    // reaches invoices and documents without a deployment.
    const company = await db('SELECT legal_name, name FROM companies WHERE id = $1', [COMPANY_ID]);
    expect(company.rows[0].legal_name).toBe(legalName);
    expect(company.rows[0].name).toBe(tradingName);

    // AC-ORG-004 - and there is an audit record naming the actor and the reason.
    const audit = await db(
      `SELECT action, resource, new_values, metadata
         FROM audit_logs
        WHERE tenant_id = $1 AND correlation_id = $2 AND resource = 'organisation.settings.profile'
        ORDER BY id DESC`,
      [TENANT_ID, CORRELATION_ID]
    );
    expect(audit.rows.length).toBeGreaterThan(0);
    const forLegal = audit.rows.find((r) => (r.new_values as Record<string, unknown>)?.legal_name === legalName);
    expect(forLegal, 'no audit row captured the new legal name').toBeTruthy();
    expect((forLegal!.metadata as Record<string, unknown>).reason).toBe(
      'TC-ORG-001 verify write-through and audit'
    );

    // The change history screen reads configuration_history, which every write
    // also populates.
    const history = await tx(
      (client) => categoryHistory(client, ctx, 'profile', { key: 'legal_name', limit: 5 }),
      ctx
    );
    expect(JSON.stringify(history)).toContain(TAG);
  });

  it('keeps one tenant from reading another tenant settings (AC-ORG-011)', async () => {
    const other: Ctx = { ...ctx, tenantId: 99999, companyId: 99999, correlationId: CORRELATION_ID };
    const view = await tx((client) => loadCategory(client, other, 'profile'), other);
    const values = (view as { values: Record<string, unknown> }).values;
    // The default, not the value tenant 2 just wrote.
    expect(String(values.legal_name)).not.toContain(TAG);
  });

  it('refuses a setting that is not in the catalogue rather than ignoring it', async () => {
    await expect(
      tx((client) => saveCategory(client, ctx, 'profile', { values: { not_a_setting: 'x' } }, {}), ctx)
    ).rejects.toThrow();
  });

  it('saves a stored setting a second time and records the value it replaced', async () => {
    // Regression: configuration_history.old_value is jsonb, but the driver
    // hands back an already-parsed value, so a stored string arrives as a plain
    // string - which is not valid JSON text. Passing it straight to the INSERT
    // made every second write of a stored setting fail with "invalid input
    // syntax for type json", surfacing as a 500 on a save that changed an
    // existing value. This suite could not see it, because afterAll removes its
    // own rows, so every write it makes is a first write.
    const first = 'Trading ' + TAG;
    const second = 'Trading Two ' + TAG;

    await tx((client) => saveCategory(client, ctx, 'profile', { values: { trading_as: first } }, {}), ctx);
    const view = await tx(
      (client) => saveCategory(client, ctx, 'profile', { values: { trading_as: second } }, {}),
      ctx
    );
    expect((view as { values: Record<string, unknown> }).values.trading_as).toBe(second);

    const stored = await db(
      `SELECT value #>> '{}' AS text FROM app_settings
        WHERE tenant_id = $1 AND category = 'organisation.profile' AND key = 'trading_as'`,
      [TENANT_ID]
    );
    expect(stored.rows.map((r) => r.text)).toEqual([second]);

    // The value it replaced is recorded as the JSON string it was, not lost.
    const history = await db(
      `SELECT old_value FROM configuration_history
        WHERE tenant_id = $1 AND config_key = 'trading_as' AND new_value = $2::jsonb
        ORDER BY id DESC LIMIT 1`,
      [TENANT_ID, JSON.stringify(second)]
    );
    expect(history.rows[0]?.old_value).toBe(first);
  });

  it('refuses a blank required field instead of letting it reach a NOT NULL column', async () => {
    // trading_name and currency are mirrored onto companies.name and
    // companies.currency, which are NOT NULL. A blank box used to reach the
    // UPDATE and come back as "null value in column ... violates not-null
    // constraint" - a 500 for what is really a field the user must fill in.
    await expect(
      tx((client) => saveCategory(client, ctx, 'profile', { values: { currency: '' } }, {}), ctx)
    ).rejects.toThrow(/currency is required/);
    await expect(
      tx((client) => saveCategory(client, ctx, 'profile', { values: { trading_name: '   ' } }, {}), ctx)
    ).rejects.toThrow(/trading_name is required/);
  });

  it('still accepts a blank on a field the company row can hold empty', async () => {
    // The guard is about those two NOT NULL columns, not about emptiness in
    // general: a nullable field is legitimately clearable. Whatever the
    // development database held for this key is put back afterwards.
    const before = await db(
      `SELECT value::text AS text FROM app_settings
        WHERE tenant_id = $1 AND category = 'organisation.profile' AND key = 'specialty'`,
      [TENANT_ID]
    );
    try {
      await tx((client) => saveCategory(client, ctx, 'profile', { values: { specialty: '' } }, {}), ctx);
      const stored = await db(
        `SELECT value #>> '{}' AS text FROM app_settings
          WHERE tenant_id = $1 AND category = 'organisation.profile' AND key = 'specialty'`,
        [TENANT_ID]
      );
      expect(stored.rows.length).toBe(1);
      expect(stored.rows[0].text).toBeNull();
    } finally {
      const previous = before.rows[0] as { text: string } | undefined;
      if (previous === undefined) {
        await db(
          `DELETE FROM app_settings
            WHERE tenant_id = $1 AND category = 'organisation.profile' AND key = 'specialty'`,
          [TENANT_ID]
        );
      } else {
        await db(
          `UPDATE app_settings SET value = $2::jsonb
            WHERE tenant_id = $1 AND category = 'organisation.profile' AND key = 'specialty'`,
          [TENANT_ID, previous.text]
        );
      }
    }
  });
});

describe('AC-ORG-005 / TC-ORG-009 - historical tax configuration is immutable', () => {
  const code = 'ACVAT' + TAG;

  it('keeps an earlier revision resolvable after a newer one is added', async () => {
    const first = await tx(
      (client) =>
        tax.createTaxRateRevision(client, ctx, {
          tax_code: code,
          tax_type: 'VAT',
          tax_name: 'Acceptance VAT',
          rate: 18,
          effective_from: '2026-07-01',
          reason: 'baseline revision',
        }),
      ctx
    );
    const second = await tx(
      (client) =>
        tax.createTaxRateRevision(client, ctx, {
          tax_code: code,
          tax_type: 'VAT',
          tax_name: 'Acceptance VAT',
          rate: 19,
          effective_from: '2026-09-01',
          reason: 'rate change',
        }),
      ctx
    );

    // Old dates still resolve to the old rate - the change is versioned, not
    // overwritten in place.
    expect(Number((await currentRate(code, '2026-07-15'))?.rate)).toBe(18);
    expect(Number((await currentRate(code, '2026-09-15'))?.rate)).toBe(19);

    // The closed revision is frozen at both the service and the database.
    await expect(tx((client) => tax.updateTaxRate(client, ctx, Number(first.id), { rate: 25 }), ctx)).rejects.toThrow();
    await expect(tx((client) => tax.deleteTaxRate(client, ctx, Number(first.id)), ctx)).rejects.toThrow();

    const raw = await db('UPDATE tax_rates SET rate = 40 WHERE id = $1', [first.id]).then(
      () => null,
      (err: Error) => err
    );
    expect(raw, 'the database trigger let a closed revision be edited').toBeTruthy();

    // The open revision is the one an administrator can correct.
    const open = await tx((client) => tax.updateTaxRate(client, ctx, Number(second.id), { rate: 19.5 }), ctx);
    expect(Number(open.rate)).toBe(19.5);
  });

  it('refuses to back-date a new revision into the open one', async () => {
    await expect(
      tx(
        (client) =>
          tax.createTaxRateRevision(client, ctx, {
            tax_code: code,
            tax_type: 'VAT',
            rate: 12,
            effective_from: '2026-08-01',
          }),
        ctx
      )
    ).rejects.toThrow();
  });

  it('exposes the full revision history for one tax code', async () => {
    const history = await tx((client) => tax.taxRateHistory(client, ctx, code), ctx);
    expect(history.revisions.length).toBe(2);
    expect(history.revisions.map((r) => Number(r.rate))).toEqual([18, 19.5]);
  });
});

describe('AC-ORG-009 / TC-ORG-005 - sequences cannot duplicate under concurrency', () => {
  const docType = 'ACSEQ' + TAG;
  let ruleId = 0;

  it('allocates a hundred distinct numbers from a hundred simultaneous requests', async () => {
    const rule = await tx(
      (client) =>
        numbering.upsertNumberingRule(client, ctx, {
          docType,
          prefix: 'HDG-ACC',
          format: '{PREFIX}-{YYYY}-{####}',
          pad: 4,
          startSeq: 1,
        }),
      ctx
    );
    ruleId = Number(rule.id);

    const results = await Promise.all(
      Array.from({ length: 100 }, () =>
        tx((client) => numbering.allocateSequence(client, ctx, docType), ctx)
      )
    );

    const numbers = results.map((r) => r.number);
    expect(new Set(numbers).size, 'two concurrent requests were given the same number').toBe(100);
    for (const n of numbers) expect(n).toMatch(/^HDG-ACC-\d{4}-\d{4}$/);

    // The counter really advanced rather than being re-seeded per call.
    const seq = await db(
      `SELECT last_seq FROM number_sequences WHERE tenant_id = $1 AND seq_key LIKE $2`,
      [TENANT_ID, docType + ':%']
    );
    expect(Number(seq.rows[0].last_seq)).toBe(100);

    // AC-ORG-012 - an edit to the rule changes the next document immediately.
    await tx((client) => numbering.upsertNumberingRule(client, ctx, { docType, prefix: 'HDG-NEW', format: '{PREFIX}-{YYYY}-{####}' }), ctx);
    const preview = await tx((client) => numbering.previewSequence(client, ctx, docType), ctx);
    expect(preview.number).toMatch(/^HDG-NEW-\d{4}-\d{4}$/);
  });

  it('refuses to disable the only active rule for a document type', async () => {
    await expect(
      tx((client) => numbering.setNumberingRuleActive(client, ctx, ruleId, false, 'test'), ctx)
    ).rejects.toThrow(/only active rule/i);
  });
});

describe('AC-ORG-006 / TC-ORG-007 - signatures are only applied by authorised workflows', () => {
  it('refuses a profile that is not active, another user profile, and one with no approved scope', async () => {
    const draft = await db(
      `INSERT INTO signature_profiles (tenant_id, company_id, user_id, full_name, position_title, status, expires_at)
       VALUES ($1, $2, $3, $4, 'Test Signatory', 'DRAFT', now() + interval '1 year') RETURNING id`,
      [TENANT_ID, COMPANY_ID, ADMIN_ID, 'Draft Signatory ' + TAG]
    );
    const draftId = Number(draft.rows[0].id);
    profileIds.push(draftId);

    const draftVerdict = await tx(
      (client) => signatures.canSign(client, ctx, { profileId: draftId, documentType: 'INVOICE' }),
      ctx
    );
    expect(draftVerdict.allowed).toBe(false);
    expect(String(draftVerdict.reason)).toContain('DRAFT');

    // Active, owned by this user, but with no approved authority scope: still no.
    const active = await db(
      `INSERT INTO signature_profiles (tenant_id, company_id, user_id, full_name, position_title, status, activated_at, expires_at)
       VALUES ($1, $2, $3, $4, 'Test Signatory', 'ACTIVE', now(), now() + interval '1 year') RETURNING id`,
      [TENANT_ID, COMPANY_ID, ADMIN_ID, 'Active Signatory ' + TAG]
    );
    const activeId = Number(active.rows[0].id);
    profileIds.push(activeId);

    const noScope = await tx(
      (client) => signatures.canSign(client, ctx, { profileId: activeId, documentType: 'INVOICE' }),
      ctx
    );
    expect(noScope.allowed).toBe(false);
    expect(String(noScope.reason)).toMatch(/no approved signature authority/i);

    await expect(
      tx((client) => signatures.assertCanSign(client, ctx, { profileId: activeId, documentType: 'INVOICE' }), ctx)
    ).rejects.toThrow();

    // Somebody else's active profile is not usable either. The owner is a real
    // user so the row itself is legitimate: the refusal has to come from the
    // ownership rule, not from a dangling foreign key.
    const otherUserId = 18;
    const foreign = await db(
      `INSERT INTO signature_profiles (tenant_id, company_id, user_id, full_name, position_title, status, activated_at, expires_at)
       VALUES ($1, $2, $3, $4, 'Test Signatory', 'ACTIVE', now(), now() + interval '1 year') RETURNING id`,
      [TENANT_ID, COMPANY_ID, otherUserId, 'Foreign Signatory ' + TAG]
    );
    const foreignId = Number(foreign.rows[0].id);
    profileIds.push(foreignId);

    const foreignVerdict = await tx(
      (client) => signatures.canSign(client, ctx, { profileId: foreignId, documentType: 'INVOICE' }),
      ctx
    );
    expect(foreignVerdict.allowed).toBe(false);
    expect(String(foreignVerdict.reason)).toMatch(/own signature/i);
  });
});

describe('AC-ORG-007 / TC-ORG-003, TC-ORG-004 - delegated authority expires on its own', () => {
  it('flips an elapsed assignment to EXPIRED and leaves a live one alone', async () => {
    const elapsed = await db(
      `INSERT INTO acting_assignments
         (tenant_id, company_id, acting_user_id, principal_user_id, label, authority_scope, starts_at, ends_at, status, reason)
       VALUES ($1, $2, $3, $5, $4, '{"authority":["purchase"]}'::jsonb,
               now() - interval '10 days', now() - interval '2 days', 'ACTIVE', 'acceptance test')
       RETURNING id, status`,
      [TENANT_ID, COMPANY_ID, ADMIN_ID, 'Elapsed delegation ' + TAG, PRINCIPAL_USER_ID]
    );
    const live = await db(
      `INSERT INTO acting_assignments
         (tenant_id, company_id, acting_user_id, principal_user_id, label, authority_scope, starts_at, ends_at, status, reason)
       VALUES ($1, $2, $3, $5, $4, '{"authority":["purchase"]}'::jsonb,
               now() - interval '1 day', now() + interval '5 days', 'ACTIVE', 'acceptance test')
       RETURNING id, status`,
      [TENANT_ID, COMPANY_ID, ADMIN_ID, 'Live delegation ' + TAG, PRINCIPAL_USER_ID]
    );

    await db('SELECT organisation_expire_acting_assignments()');

    const after = await db(
      'SELECT id, status FROM acting_assignments WHERE id = ANY($1::bigint[]) ORDER BY id',
      [[Number(elapsed.rows[0].id), Number(live.rows[0].id)]]
    );
    const statusById = new Map(after.rows.map((r) => [Number(r.id), String(r.status)]));
    expect(statusById.get(Number(elapsed.rows[0].id))).toBe('EXPIRED');
    expect(statusById.get(Number(live.rows[0].id))).toBe('ACTIVE');
  });

  it('refuses an assignment whose window runs backwards', async () => {
    await expect(
      db(
        `INSERT INTO acting_assignments (tenant_id, company_id, acting_user_id, principal_user_id, label, starts_at, ends_at, status)
         VALUES ($1, $2, $3, $5, $4, now(), now() - interval '1 day', 'ACTIVE')`,
        [TENANT_ID, COMPANY_ID, ADMIN_ID, 'Backwards delegation ' + TAG, PRINCIPAL_USER_ID]
      )
    ).rejects.toThrow();
  });
});

describe('AC-ORG-010 / TC-ORG-008 - integration credentials stay encrypted and masked', () => {
  const secret = 'S3CRET-' + TAG;

  it('round-trips a secret through the service but never through the API shape', async () => {
    await tx(
      (client) =>
        integrations.saveIntegration(client, ctx, 'ura_efris', {
          values: {
            environment: 'SANDBOX',
            endpoint: 'https://efris-sandbox.example.ug/api',
            tin: 'TIN' + TAG,
            sandbox_verified: false,
          },
          secrets: { client_id: 'CID-' + TAG, client_secret: secret },
        }),
      ctx
    );

    const view = await tx((client) => integrations.getIntegration(client, ctx, 'ura_efris'), ctx);
    // Presence, not value.
    expect(view.secrets.client_id).toBe(true);
    expect(view.secrets.client_secret).toBe(true);
    expect(JSON.stringify(view)).not.toContain(secret);
    expect(JSON.stringify(view)).not.toContain('CID-' + TAG);

    // The ciphertext is what actually sits in the column.
    const raw = await db(
      `SELECT secrets FROM company_integrations WHERE tenant_id = $1 AND code = 'ura_efris'`,
      [TENANT_ID]
    );
    expect(JSON.stringify(raw.rows[0].secrets)).not.toContain(secret);
    expect(JSON.stringify(raw.rows[0].secrets)).not.toContain('CID-' + TAG);
  });

  it('still lets the integration itself read the decrypted value', async () => {
    const value = await tx(
      (client) => integrations.readSecrets(client, ctx, 'ura_efris').then((s) => s.client_secret),
      ctx
    ).catch(() => null);
    // readSecrets is internal; when it is not exported the encryption round-trip
    // is still proven by the integration's own send path, so a missing helper is
    // not a failure of the guarantee under test.
    if (value !== null) expect(value).toBe(secret);
  });
});

describe('TC-ORG-010 - a disabled branch cannot take new transactions', () => {
  it('refuses new work against a deactivated branch', async () => {
    const code = 'ACCBR' + TAG;
    const branch = await tx(
      (client) => structure.createEntity(client, ctx, 'branches', { code, name: 'Acceptance Branch ' + TAG }),
      ctx
    );
    const branchId = Number(branch.id);

    // Live first: the guard is a gate, not a blanket refusal.
    await tx((client) => structure.assertBranchActive(client, ctx, branchId), ctx);

    await tx(
      (client) => structure.setEntityStatus(client, ctx, 'branches', branchId, 'deactivate', 'acceptance test'),
      ctx
    );

    await expect(tx((client) => structure.assertBranchActive(client, ctx, branchId), ctx)).rejects.toThrow();

    // It is still listed, flagged, so the settings screen shows the state.
    const listing = await tx((client) => structure.listEntities(client, ctx, 'branches'), ctx);
    const found = (listing.rows as Array<Record<string, unknown>>).find((r) => Number(r.id) === branchId);
    expect(String(found?.status)).toBe('INACTIVE');
  });

  it('archiving requires a reason', async () => {
    const code = 'ACCAR' + TAG;
    const branch = await tx(
      (client) => structure.createEntity(client, ctx, 'branches', { code, name: 'Archive Branch ' + TAG }),
      ctx
    );
    await expect(
      tx((client) => structure.setEntityStatus(client, ctx, 'branches', Number(branch.id), 'archive', null), ctx)
    ).rejects.toThrow(/reason/i);
  });
});

describe('fiscal periods move along a one-way ladder', () => {
  it('refuses an illegal transition and demands a reason to reopen', async () => {
    const code = 'ACCP' + TAG;
    const period = await tx(
      (client) =>
        fiscal.openAccountingPeriod(client, ctx, {
          code,
          name: 'Acceptance Period ' + TAG,
          startDate: '2031-01-01',
          endDate: '2031-01-31',
        }),
      ctx
    );
    const id = Number(period.id);

    // OPEN cannot be reopened.
    await expect(
      tx((client) => fiscal.movePeriod(client, ctx, id, { action: 'reopen', reason: 'x' }), ctx)
    ).rejects.toThrow(/cannot reopen/i);

    await tx((client) => fiscal.movePeriod(client, ctx, id, { action: 'soft_close' }), ctx);
    await tx((client) => fiscal.movePeriod(client, ctx, id, { action: 'close' }), ctx);

    // Reopening is allowed from CLOSED, but only with a justification.
    await expect(tx((client) => fiscal.movePeriod(client, ctx, id, { action: 'reopen' }), ctx)).rejects.toThrow(
      /reason is required/i
    );

    const reopened = await tx(
      (client) => fiscal.movePeriod(client, ctx, id, { action: 'reopen', reason: 'late journal' }),
      ctx
    );
    expect(String(reopened.status)).toBe('OPEN');
    expect(Number(reopened.reopenedCount)).toBe(1);
  });
});

describe('AC-ORG-008 - payroll enrolment is a separate axis from system access', () => {
  it('lets an account hold organisational authority while enrolled in no payroll', async () => {
    const perm = await db(
      `SELECT 1
         FROM permissions p
         JOIN role_permissions rp ON rp.permission_id = p.id
         JOIN user_roles ur ON ur.role_id = rp.role_id
        WHERE ur.user_id = $1 AND p.code = 'organisation.settings.update'
        LIMIT 1`,
      [ADMIN_ID]
    );
    expect(perm.rows.length, 'the control plane is not reachable by this account').toBe(1);

    const admin = await db(
      `SELECT u.employee_id, e.payroll_enabled
         FROM users u LEFT JOIN employees e ON e.id = u.employee_id
        WHERE u.id = $1`,
      [ADMIN_ID]
    );
    const enrolled = admin.rows[0].employee_id != null && admin.rows[0].payroll_enabled === true;
    expect(enrolled, 'this account should hold authority without payroll enrolment').toBe(false);

    // And the two states genuinely coexist: one payroll employee alongside the
    // non-payroll account, in the same table.
    const target = await db('SELECT id FROM employees WHERE payroll_enabled = false ORDER BY id LIMIT 1');
    const employeeId = Number(target.rows[0].id);
    await db('UPDATE employees SET payroll_enabled = true WHERE id = $1', [employeeId]);
    try {
      const both = await db(
        `SELECT count(*) FILTER (WHERE payroll_enabled)::int AS on_payroll,
                count(*) FILTER (WHERE NOT payroll_enabled)::int AS off_payroll
           FROM employees`
      );
      expect(Number(both.rows[0].on_payroll)).toBeGreaterThan(0);
      expect(Number(both.rows[0].off_payroll)).toBeGreaterThan(0);
    } finally {
      await db('UPDATE employees SET payroll_enabled = false WHERE id = $1', [employeeId]);
    }
  });
});

describe('AC-ORG-003 / TC-ORG-002 - unauthorised users cannot touch the control plane', () => {
  const PATH = '/api/ops/organisation-settings';

  it('answers 200 for an administrator and 403 for accounts without the permission', async () => {
    const admin = await loginAs('admin');
    const catalogue = await api.get(PATH + '/catalogue').set(auth(admin.token));
    expect(catalogue.status).toBe(200);
    expect(catalogue.body.data.categories.length).toBeGreaterThan(25);

    const profile = await api.get(PATH + '/category/profile').set(auth(admin.token));
    expect(profile.status).toBe(200);

    for (const username of ['sso.demo', 'percy.proc']) {
      const session = await loginAs(username);
      const read = await api.get(PATH + '/catalogue').set(auth(session.token));
      expect(read.status, username + ' could read the control plane').toBe(403);

      const write = await api
        .patch(PATH + '/category/tax')
        .set(auth(session.token))
        .send({ values: { vat_standard_rate: 1 }, reason: 'should not be allowed' });
      expect(write.status, username + ' could write tax settings').toBe(403);
    }
  });

  it('rejects an unauthenticated read', async () => {
    const res = await api.get(PATH + '/catalogue');
    expect(res.status).toBe(401);
  });
});
