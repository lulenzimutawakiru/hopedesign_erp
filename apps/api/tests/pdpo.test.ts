// ============================================================
// Personal Data Protection Office (PDPO) integration.
//
// The module has two halves and this file tests both. Every statutory
// rule lives in the database or in services/pdpo: the clocks are stamped
// by BEFORE triggers, the consent invariant is a partial unique index,
// and the register keeps itself consistent through CHECK constraints.
// So the first half writes rows directly and asserts what the database
// did with them - including the seven ways it refuses one.
//
// The second half goes through /api/ops/compliance, where the point is
// that the boundary adds nothing of its own: a status the caller sends
// is ignored because the register derives it, a second live consent for
// the same subject and purpose is a 409 rather than a 500, and a
// register a caller holds no grant for is a 403 rather than an empty
// list.
//
// Nothing here is unauthenticated, so unlike the bank feeds there is no
// signature to test. What is tested instead is who may write. The grants
// are asserted directly against role_permissions, because the admin
// account resolves every permission and would make an HTTP test of the
// same thing pass for the wrong reason.
// ============================================================
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { api, auth, loginAs, pool } from './helpers.js';

const TENANT_ID = 2;
const COMPANY_ID = 2;

/** Unique per run, so a row left by an earlier run cannot satisfy a test. */
const RUN = Math.random().toString(36).slice(2, 8).toUpperCase();
const tag = (suffix: string) => 'PDPOTEST-' + RUN + '-' + suffix;
const LIKE = 'PDPOTEST-' + RUN + '%';

type Row = Record<string, unknown>;

/** Ids created through the API, cleared in afterAll. */
const created = {
  activities: [] as number[],
  consents: [] as number[],
  requests: [] as number[],
  breaches: [] as number[],
  filings: [] as number[],
};

/** The integration row as it stood before this file ran, restored at the end. */
let rowBefore: Record<string, unknown> | null = null;

/**
 * Run statements as the test tenant and company, because the register tables
 * are ENABLE + FORCE row-level security and a write without a context is a
 * write the policies refuse.
 */
async function asTenant<T = Row>(text: string, params: unknown[] = []): Promise<T[]> {
  return asContext<T>(TENANT_ID, text, params);
}

/** The same, but under a caller-chosen tenant, for the isolation tests. */
async function asContext<T = Row>(tenantId: number, text: string, params: unknown[] = []): Promise<T[]> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT set_app_context($1,$2,NULL,NULL)', [tenantId, COMPANY_ID]);
    const res = await client.query(text, params);
    await client.query('COMMIT');
    return res.rows as T[];
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * What refused a statement, or nothing at all if it was not refused. The
 * SQLSTATE is what tells a constraint doing its job apart from a query that was
 * simply wrong, and the constraint name says which rule it was - so a test can
 * name the rule it is exercising instead of only asserting that something threw.
 */
async function refusedBy(fn: () => Promise<unknown>): Promise<{ code?: string; constraint?: string }> {
  try {
    await fn();
    return {};
  } catch (err) {
    const e = err as { code?: string; constraint?: string };
    return { code: e.code, constraint: e.constraint };
  }
}

const one = async <T>(text: string, params: unknown[] = []): Promise<T | null> => {
  const res = await pool.query(text, params);
  return res.rows.length > 0 ? (res.rows[0] as T) : null;
};

const count = async (text: string, params: unknown[] = []): Promise<number> =>
  Number((await pool.query(text, params)).rows[0].count);

/** Insert a minimal processing activity and remember it for cleanup. */
async function activityRow(code: string): Promise<number> {
  const rows = await asTenant<{ id: string }>(
    'INSERT INTO pdpo_processing_activities (tenant_id, company_id, code, name, purpose, lawful_basis) ' +
      'VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
    [TENANT_ID, COMPANY_ID, code, 'Registered activity', 'Registered by the PDPO suite', 'CONSENT']
  );
  const id = Number(rows[0].id);
  created.activities.push(id);
  return id;
}

/**
 * Row-level security is only testable through the application role. This
 * file's connection owns the tables and is a superuser, and Postgres exempts
 * both a table's owner under FORCE and a superuser itself, so a statement run
 * as-is would satisfy every isolation assertion for the wrong reason. Assuming
 * the application role is what makes the policy bite - and it is the role the
 * API itself connects as.
 */
async function asApp<T = Row>(tenantId: number | null, text: string, params: unknown[] = []): Promise<T[]> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (tenantId !== null) {
      await client.query('SELECT set_app_context($1,$2,NULL,NULL)', [tenantId, COMPANY_ID]);
    }
    await client.query('SET LOCAL ROLE hopedesign_app');
    const res = await client.query(text, params);
    await client.query('COMMIT');
    return res.rows as T[];
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * The service refuses to file a statutory submission until the company has a
 * PDPO integration, so the suite brings one into being when the deployment has
 * none, and puts the table back exactly as it found it afterwards. The seed is
 * left disconnected and switched off on purpose, so the tests that turn it on
 * are asserting the change rather than the fixture.
 */
const INTEGRATION = { code: 'PDPO', category: 'regulatory', name: 'Personal Data Protection Office' };
let adminToken = '';

beforeAll(async () => {
  adminToken = (await loginAs('admin')).token;

  const existing = await pool.query(
    'SELECT * FROM company_integrations WHERE tenant_id = $1 AND company_id = $2 AND code = $3 AND category = $4',
    [TENANT_ID, COMPANY_ID, INTEGRATION.code, INTEGRATION.category]
  );
  if (existing.rows.length > 0) {
    rowBefore = existing.rows[0] as Record<string, unknown>;
  } else {
    await pool.query(
      'INSERT INTO company_integrations ' +
        '(tenant_id, company_id, category, code, name, config, secrets, status, is_active) ' +
        "VALUES ($1,$2,$3,$4,$5,'{}'::jsonb,'{}'::jsonb,'DISCONNECTED',false)",
      [TENANT_ID, COMPANY_ID, INTEGRATION.category, INTEGRATION.code, INTEGRATION.name]
    );
  }
});

afterAll(async () => {
  const byId = async (table: string, ids: number[]) => {
    if (ids.length === 0) return;
    await asTenant('DELETE FROM ' + table + ' WHERE id = ANY($1::bigint[])', [ids]);
  };

  // Children before parents, because a consent points at an activity.
  await byId('pdpo_submissions', created.filings);
  await byId('pdpo_consents', created.consents);
  await byId('pdpo_breaches', created.breaches);
  await byId('pdpo_subject_requests', created.requests);
  await byId('pdpo_processing_activities', created.activities);

  // A tagged sweep on top of the ids, so a row a failed test left half-made
  // cannot survive into the next run and quietly satisfy something.
  await asTenant('DELETE FROM pdpo_submissions WHERE subject LIKE $1', [LIKE]);
  const sweep: Array<[string, string]> = [
    ['pdpo_consents', 'subject_reference'],
    ['pdpo_breaches', 'reference'],
    ['pdpo_subject_requests', 'reference'],
    ['pdpo_processing_activities', 'code'],
  ];
  for (const [table, column] of sweep) {
    await asTenant('DELETE FROM ' + table + ' WHERE ' + column + ' LIKE $1', [LIKE]);
  }

  // The integration row goes last, and only once the submissions that named it
  // are gone. Where the deployment already had one it is restored field for
  // field rather than deleted, because the API may have PATCHed it above.
  if (rowBefore === null) {
    await pool.query(
      'DELETE FROM company_integrations WHERE tenant_id = $1 AND company_id = $2 AND code = $3 AND category = $4',
      [TENANT_ID, COMPANY_ID, INTEGRATION.code, INTEGRATION.category]
    );
  } else {
    const before = rowBefore as {
      id: string;
      name: string | null;
      description: string | null;
      config: unknown;
      secrets: unknown;
      status: string;
      is_active: boolean;
      last_tested_at: Date | null;
      updated_by: number | null;
    };
    await pool.query(
      'UPDATE company_integrations SET name = $2, description = $3, config = $4, secrets = $5, ' +
        'status = $6, is_active = $7, last_tested_at = $8, updated_by = $9 WHERE id = $1',
      [
        before.id,
        before.name,
        before.description,
        before.config,
        before.secrets,
        before.status,
        before.is_active,
        before.last_tested_at,
        before.updated_by,
      ]
    );
  }
});

describe('statutory clocks', () => {
  it('stamps the subject-request deadline from the window the row carries', async () => {
    const received = '2026-03-01T09:00:00.000Z';
    const rows = await asTenant<{ id: string; due_at: string }>(
      `INSERT INTO pdpo_subject_requests
         (tenant_id, company_id, reference, request_type, subject_reference, subject_type,
          received_at, response_window_days, status)
       VALUES ($1,$2,$3,'ACCESS',$4,'CUSTOMER',$5::timestamptz,30,'RECEIVED')
       RETURNING id, due_at`,
      [TENANT_ID, COMPANY_ID, tag('SAR-CLOCK'), tag('subject-clock'), received]
    );
    created.requests.push(Number(rows[0].id));
    expect(new Date(rows[0].due_at).toISOString()).toBe('2026-03-31T09:00:00.000Z');

    // The extension is recorded as days and applied by the trigger, because
    // the date the subject wrote in must not move to make a deadline fit.
    const moved = await asTenant<{ due_at: string; received_at: string }>(
      'UPDATE pdpo_subject_requests SET extension_days = 14, extension_reason = $2 WHERE id = $1 ' +
        'RETURNING due_at, received_at',
      [Number(rows[0].id), 'Volume of records to search']
    );
    expect(new Date(moved[0].due_at).toISOString()).toBe('2026-04-14T09:00:00.000Z');
    expect(new Date(moved[0].received_at).toISOString()).toBe(received);
  });

  it('derives late_notification from the breach clock, never from the caller', async () => {
    const discovered = '2026-05-04T06:00:00.000Z';
    const rows = await asTenant<{ id: string; notification_due_at: string; late_notification: boolean }>(
      `INSERT INTO pdpo_breaches
         (tenant_id, company_id, reference, title, nature, discovered_at,
          notification_window_hours, notifiable, status)
       VALUES ($1,$2,$3,'Laptop taken from a locked office',
               'A laptop holding case files was removed overnight.',
               $4::timestamptz, 72, true, 'OPEN')
       RETURNING id, notification_due_at, late_notification`,
      [TENANT_ID, COMPANY_ID, tag('BR-CLOCK'), discovered]
    );
    created.breaches.push(Number(rows[0].id));
    expect(new Date(rows[0].notification_due_at).toISOString()).toBe('2026-05-07T06:00:00.000Z');
    expect(rows[0].late_notification).toBe(false);

    const inTime = await asTenant<{ late_notification: boolean; status: string }>(
      `UPDATE pdpo_breaches
          SET notified_at = $2::timestamptz, notification_reference = 'PDPO-ACK-IN-TIME', status = 'REPORTED'
        WHERE id = $1
       RETURNING late_notification, status`,
      [Number(rows[0].id), '2026-05-07T05:00:00.000Z']
    );
    expect(inTime[0].late_notification).toBe(false);
    expect(inTime[0].status).toBe('REPORTED');

    // Move the notification past the due moment and the same row flips its
    // own flag: nothing in the application recomputes this.
    const late = await asTenant<{ late_notification: boolean }>(
      'UPDATE pdpo_breaches SET notified_at = $2::timestamptz WHERE id = $1 RETURNING late_notification',
      [Number(rows[0].id), '2026-05-09T06:00:00.000Z']
    );
    expect(late[0].late_notification).toBe(true);
  });
});

describe('the database refuses what the register cannot mean', () => {
  /** A statement that is expected to be refused, and the rule that refused it. */
  const refusedInsert = (sql: string, params: unknown[]) => refusedBy(() => asTenant(sql, params));

  it('refuses a second processing activity with the same code', async () => {
    const code = tag('ACT-DUP');
    await activityRow(code);
    const refused = await refusedInsert(
      'INSERT INTO pdpo_processing_activities (tenant_id, company_id, code, name, purpose, lawful_basis) ' +
        'VALUES ($1,$2,$3,$4,$5,$6)',
      [TENANT_ID, COMPANY_ID, code, 'Registered twice', 'The same activity, twice', 'CONSENT']
    );
    expect(refused.code).toBe('23505');
    expect(refused.constraint).toBe('pdpo_activities_code_unique');
  });

  it('refuses a transfer flagged with no destination, and a destination with no flag', async () => {
    const flagged = await refusedInsert(
      'INSERT INTO pdpo_processing_activities ' +
        '(tenant_id, company_id, code, name, purpose, lawful_basis, cross_border) ' +
        'VALUES ($1,$2,$3,$4,$5,$6,true)',
      [TENANT_ID, COMPANY_ID, tag('ACT-XB-FLAG'), 'Sent abroad', 'A flag with nothing behind it', 'CONSENT']
    );
    expect(flagged.code).toBe('23514');
    expect(flagged.constraint).toBe('pdpo_activities_transfer_consistent');

    const silent = await refusedInsert(
      'INSERT INTO pdpo_processing_activities ' +
        '(tenant_id, company_id, code, name, purpose, lawful_basis, cross_border, transfer_countries) ' +
        'VALUES ($1,$2,$3,$4,$5,$6,false,$7::text[])',
      [
        TENANT_ID, COMPANY_ID, tag('ACT-XB-SILENT'), 'Sent abroad quietly',
        'A destination with no flag', 'CONSENT', ['KE'],
      ]
    );
    expect(silent.code).toBe('23514');
    expect(silent.constraint).toBe('pdpo_activities_transfer_consistent');
  });

  it('refuses a withdrawal with no timestamp, and a timestamp with no withdrawal', async () => {
    const noDate = await refusedInsert(
      'INSERT INTO pdpo_consents (tenant_id, company_id, subject_reference, subject_type, purpose, status) ' +
        "VALUES ($1,$2,$3,'CUSTOMER',$4,'WITHDRAWN')",
      [TENANT_ID, COMPANY_ID, tag('SUBJ-W1'), tag('PURPOSE-W1')]
    );
    expect(noDate.code).toBe('23514');
    expect(noDate.constraint).toBe('pdpo_consents_withdrawal_consistent');

    const noStatus = await refusedInsert(
      'INSERT INTO pdpo_consents ' +
        '(tenant_id, company_id, subject_reference, subject_type, purpose, status, withdrawn_at) ' +
        "VALUES ($1,$2,$3,'CUSTOMER',$4,'GRANTED',now())",
      [TENANT_ID, COMPANY_ID, tag('SUBJ-W2'), tag('PURPOSE-W2')]
    );
    expect(noStatus.code).toBe('23514');
    expect(noStatus.constraint).toBe('pdpo_consents_withdrawal_consistent');
  });

  it('refuses a second live consent for the same subject and purpose', async () => {
    const subject = tag('SUBJ-DUP');
    const purpose = tag('PURPOSE-DUP');
    const rows = await asTenant<{ id: string }>(
      'INSERT INTO pdpo_consents (tenant_id, company_id, subject_reference, subject_type, purpose) ' +
        "VALUES ($1,$2,$3,'CUSTOMER',$4) RETURNING id",
      [TENANT_ID, COMPANY_ID, subject, purpose]
    );
    created.consents.push(Number(rows[0].id));

    const duplicate = await refusedInsert(
      'INSERT INTO pdpo_consents (tenant_id, company_id, subject_reference, subject_type, purpose) ' +
        "VALUES ($1,$2,$3,'CUSTOMER',$4)",
      [TENANT_ID, COMPANY_ID, subject, purpose]
    );
    expect(duplicate.code).toBe('23505');
    expect(duplicate.constraint).toBe('uq_pdpo_consents_active');

    // Withdraw it and the same subject may consent to the same thing again: the
    // index only covers live grants, so both halves of the history survive.
    await asTenant(
      "UPDATE pdpo_consents SET status = 'WITHDRAWN', withdrawn_at = now() WHERE id = $1",
      [Number(rows[0].id)]
    );
    const regranted = await asTenant<{ id: string }>(
      'INSERT INTO pdpo_consents (tenant_id, company_id, subject_reference, subject_type, purpose) ' +
        "VALUES ($1,$2,$3,'CUSTOMER',$4) RETURNING id",
      [TENANT_ID, COMPANY_ID, subject, purpose]
    );
    created.consents.push(Number(regranted[0].id));
  });

  it('refuses a breach assessed as not notifiable and notifiable at once', async () => {
    const refused = await refusedInsert(
      'INSERT INTO pdpo_breaches (tenant_id, company_id, reference, title, nature, notifiable, status) ' +
        "VALUES ($1,$2,$3,'Contradictory assessment','Assessed both ways.',true,'NOT_NOTIFIABLE')",
      [TENANT_ID, COMPANY_ID, tag('BR-CONTRA')]
    );
    expect(refused.code).toBe('23514');
    expect(refused.constraint).toBe('pdpo_breaches_notifiable_consistent');
  });

  it('refuses a reported breach with no notification timestamp', async () => {
    const refused = await refusedInsert(
      'INSERT INTO pdpo_breaches (tenant_id, company_id, reference, title, nature, status) ' +
        "VALUES ($1,$2,$3,'Reported without a report','Says it was sent, with no time it was sent.','REPORTED')",
      [TENANT_ID, COMPANY_ID, tag('BR-NOREP')]
    );
    expect(refused.code).toBe('23514');
    expect(refused.constraint).toBe('pdpo_breaches_report_consistent');
  });

  it('refuses a discovery dated before the incident it discovered', async () => {
    const refused = await refusedInsert(
      'INSERT INTO pdpo_breaches ' +
        '(tenant_id, company_id, reference, title, nature, occurred_at, discovered_at) ' +
        "VALUES ($1,$2,$3,'Found before it happened','The clock cannot run backwards.'," +
        " '2026-06-02T00:00:00.000Z'::timestamptz, '2026-06-01T00:00:00.000Z'::timestamptz)",
      [TENANT_ID, COMPANY_ID, tag('BR-BACK')]
    );
    expect(refused.code).toBe('23514');
    expect(refused.constraint).toBe('pdpo_breaches_discovered_after_occurred');
  });

  it('will not let a breach be recorded as late when nothing was ever notified', async () => {
    // late_notification is derived by the trigger from notified_at, and the
    // CHECK behind it refuses the same combination, so a caller trying to write
    // the claim directly has it corrected rather than stored.
    const rows = await asTenant<{ id: string; late_notification: boolean }>(
      'INSERT INTO pdpo_breaches ' +
        '(tenant_id, company_id, reference, title, nature, notifiable, status, late_notification) ' +
        "VALUES ($1,$2,$3,'Late with no notification','Claims to be late.',true,'OPEN',true) " +
        'RETURNING id, late_notification',
      [TENANT_ID, COMPANY_ID, tag('BR-LATE-NULL')]
    );
    created.breaches.push(Number(rows[0].id));
    expect(rows[0].late_notification).toBe(false);
  });

  it('refuses a response window or an extension outside the statutory range', async () => {
    const zero = await refusedInsert(
      'INSERT INTO pdpo_subject_requests ' +
        '(tenant_id, company_id, reference, request_type, subject_reference, subject_type, response_window_days) ' +
        "VALUES ($1,$2,$3,'ACCESS',$4,'CUSTOMER',0)",
      [TENANT_ID, COMPANY_ID, tag('SAR-ZERO'), tag('SUBJ-ZERO')]
    );
    expect(zero.code).toBe('23514');
    expect(zero.constraint).toBe('pdpo_subject_requests_response_window_days_check');

    const beyond = await refusedInsert(
      'INSERT INTO pdpo_subject_requests ' +
        '(tenant_id, company_id, reference, request_type, subject_reference, subject_type, ' +
        ' extension_days, extension_reason) ' +
        "VALUES ($1,$2,$3,'ACCESS',$4,'CUSTOMER',181,'Longer than the Act allows')",
      [TENANT_ID, COMPANY_ID, tag('SAR-181'), tag('SUBJ-181')]
    );
    expect(beyond.code).toBe('23514');
    expect(beyond.constraint).toBe('pdpo_subject_requests_extension_days_check');
  });

  it('refuses an extension with no reason', async () => {
    const refused = await refusedInsert(
      'INSERT INTO pdpo_subject_requests ' +
        '(tenant_id, company_id, reference, request_type, subject_reference, subject_type, extension_days) ' +
        "VALUES ($1,$2,$3,'ACCESS',$4,'CUSTOMER',30)",
      [TENANT_ID, COMPANY_ID, tag('SAR-EXT-NOREASON'), tag('SUBJ-EXT-NOREASON')]
    );
    expect(refused.code).toBe('23514');
    expect(refused.constraint).toBe('pdpo_subject_requests_extension_consistent');
  });

  it('refuses a refusal with no reason', async () => {
    const refused = await refusedInsert(
      'INSERT INTO pdpo_subject_requests ' +
        '(tenant_id, company_id, reference, request_type, subject_reference, subject_type, ' +
        ' status, completed_at) ' +
        "VALUES ($1,$2,$3,'ACCESS',$4,'CUSTOMER','REFUSED',now())",
      [TENANT_ID, COMPANY_ID, tag('SAR-NOREASON'), tag('SUBJ-NOREASON')]
    );
    expect(refused.code).toBe('23514');
    expect(refused.constraint).toBe('pdpo_subject_requests_refusal_consistent');
  });

  it('refuses a request closed with no completion timestamp', async () => {
    const refused = await refusedInsert(
      'INSERT INTO pdpo_subject_requests ' +
        '(tenant_id, company_id, reference, request_type, subject_reference, subject_type, status) ' +
        "VALUES ($1,$2,$3,'ACCESS',$4,'CUSTOMER','COMPLETED')",
      [TENANT_ID, COMPANY_ID, tag('SAR-NODATE'), tag('SUBJ-NODATE')]
    );
    expect(refused.code).toBe('23514');
    expect(refused.constraint).toBe('pdpo_subject_requests_completion_consistent');
  });

  it('refuses a filing whose related pair is only half set', async () => {
    const tableOnly = await refusedInsert(
      'INSERT INTO pdpo_submissions (tenant_id, company_id, submission_type, subject, related_table) ' +
        "VALUES ($1,$2,'ANNUAL_RETURN','Points at a register with no row','pdpo_breaches')",
      [TENANT_ID, COMPANY_ID]
    );
    expect(tableOnly.code).toBe('23514');
    expect(tableOnly.constraint).toBe('pdpo_submissions_related_pair');

    const idOnly = await refusedInsert(
      'INSERT INTO pdpo_submissions (tenant_id, company_id, submission_type, subject, related_id) ' +
        "VALUES ($1,$2,'ANNUAL_RETURN','Points at a row with no register',1)",
      [TENANT_ID, COMPANY_ID]
    );
    expect(idOnly.code).toBe('23514');
    expect(idOnly.constraint).toBe('pdpo_submissions_related_pair');
  });

  it('refuses a filed entry with no filing time, an acknowledgement with no timestamp, and a rejection with no reason', async () => {
    const filed = await refusedInsert(
      'INSERT INTO pdpo_submissions (tenant_id, company_id, submission_type, subject, status) ' +
        "VALUES ($1,$2,'ANNUAL_RETURN','Filed but never sent','FILED')",
      [TENANT_ID, COMPANY_ID]
    );
    expect(filed.code).toBe('23514');
    expect(filed.constraint).toBe('pdpo_submissions_filed_consistent');

    const acknowledged = await refusedInsert(
      'INSERT INTO pdpo_submissions (tenant_id, company_id, submission_type, subject, status, filed_at) ' +
        "VALUES ($1,$2,'ANNUAL_RETURN','Acknowledged with no date','ACKNOWLEDGED',now())",
      [TENANT_ID, COMPANY_ID]
    );
    expect(acknowledged.code).toBe('23514');
    expect(acknowledged.constraint).toBe('pdpo_submissions_ack_consistent');

    const rejected = await refusedInsert(
      'INSERT INTO pdpo_submissions (tenant_id, company_id, submission_type, subject, status) ' +
        "VALUES ($1,$2,'ANNUAL_RETURN','Rejected with no reason','REJECTED')",
      [TENANT_ID, COMPANY_ID]
    );
    expect(rejected.code).toBe('23514');
    expect(rejected.constraint).toBe('pdpo_submissions_rejection_consistent');
  });
});

describe('row-level security', () => {
  it('keeps another tenant from reading or editing a row it does not own', async () => {
    const rows = await asTenant<{ id: string }>(
      'INSERT INTO pdpo_consents (tenant_id, company_id, subject_reference, subject_type, purpose) ' +
        "VALUES ($1,$2,$3,'CUSTOMER',$4) RETURNING id",
      [TENANT_ID, COMPANY_ID, tag('SUBJ-RLS'), tag('PURPOSE-RLS')]
    );
    const id = Number(rows[0].id);
    created.consents.push(id);

    const seenByOther = await asApp<{ id: string }>(1, 'SELECT id FROM pdpo_consents WHERE id = $1', [id]);
    expect(seenByOther).toHaveLength(0);

    const updatedByOther = await asApp<{ id: string }>(
      1,
      "UPDATE pdpo_consents SET purpose = 'hijacked' WHERE id = $1 RETURNING id",
      [id]
    );
    expect(updatedByOther).toHaveLength(0);

    const after = await asApp<{ purpose: string }>(
      TENANT_ID,
      'SELECT purpose FROM pdpo_consents WHERE id = $1',
      [id]
    );
    expect(after).toHaveLength(1);
    expect(after[0].purpose).not.toBe('hijacked');

    // A connection that set no context has no tenant to compare against, so the
    // policy hides every row rather than falling through to showing all of them.
    const withoutContext = await asApp<{ id: string }>(null, 'SELECT id FROM pdpo_consents WHERE id = $1', [id]);
    expect(withoutContext).toHaveLength(0);

    // And writing with no context is refused outright rather than scoped to
    // nothing, which is what keeps a missing context from becoming a silent
    // no-op a caller mistakes for success.
    const refused = await refusedBy(() =>
      asApp(
        null,
        'INSERT INTO pdpo_consents (tenant_id, company_id, subject_reference, subject_type, purpose) ' +
          "VALUES ($1,$2,$3,'CUSTOMER',$4)",
        [TENANT_ID, COMPANY_ID, tag('SUBJ-RLS-VOID'), tag('PURPOSE-RLS-VOID')]
      )
    );
    expect(refused.code).toBe('42501');
  });
});

// ============================================================
// The HTTP surface.
//
// Same registers, reached the way the workspace reaches them. What is
// asserted here is the boundary and not the register: the envelope
// every reply is wrapped in, the status code a service refusal turns
// into, and the fields a caller must not be able to set because the
// register derives them - a breach status, a filing status, a
// deadline. No rule tested against the database above is re-tested
// here; this is the layer that decides who may ask and what a refusal
// looks like when it arrives.
// ============================================================
describe('HTTP surface', () => {
  const base = '/api/ops/compliance';
  const get = (p: string) => api.get(base + p).set(auth(adminToken));
  const post = (p: string, body?: unknown) =>
    body === undefined
      ? api.post(base + p).set(auth(adminToken))
      : api.post(base + p).set(auth(adminToken)).send(body);
  const patch = (p: string, body: unknown) => api.patch(base + p).set(auth(adminToken)).send(body);
  const del = (p: string) => api.delete(base + p).set(auth(adminToken));

  /** The envelope: every successful reply is { data }. */
  const ok = (res: { body: unknown }): Record<string, unknown> =>
    (res.body as { data?: Record<string, unknown> }).data ?? {};

  /** A YYYY-MM-DD date n days from today, which is what the config takes. */
  const dayOffset = (n: number): string =>
    new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

  it('answers status with the counters the register actually holds', async () => {
    const res = await get('/status');
    expect(res.status).toBe(200);
    const status = ok(res);
    expect(Object.keys(status).sort()).toEqual([
      'config', 'lastFiledAt', 'nextBreachDueAt', 'nextRequestDueAt', 'totals', 'warnings',
    ]);
    const totals = status.totals as Record<string, unknown>;
    expect(Object.keys(totals).sort()).toEqual([
      'activitiesActive', 'activitiesRetired', 'breachesLate', 'breachesNotified', 'breachesOpen',
      'breachesOverdue', 'consentsExpired', 'consentsGranted', 'consentsWithdrawn', 'requestsClosed',
      'requestsOpen', 'requestsOverdue', 'submissionsAcknowledged', 'submissionsDraft',
      'submissionsFiled', 'submissionsRejected',
    ]);
    for (const value of Object.values(totals)) expect(typeof value).toBe('number');
    expect(Array.isArray(status.warnings)).toBe(true);
  });

  it('projects the integration without ever echoing a secret', async () => {
    const secret = tag('PORTAL-KEY');
    const saved = await patch('/config', {
      portalApiKey: secret,
      registrationNumber: tag('REG'),
      registrationExpiresOn: dayOffset(400),
      dpoName: 'Data Protection Officer',
      dpoEmail: 'dpo@example.com',
      dpoPhone: '+256700000000',
      portalBaseUrl: 'https://pdpo.go.ug',
      breachNotificationHours: 72,
      subjectRequestDays: 30,
      isActive: true,
    });
    expect(saved.status).toBe(200);

    const view = ok(saved).config as Record<string, unknown>;
    expect(view.portalApiKeyPresent).toBe(true);
    expect(view.registrationState).toBe('REGISTERED');
    expect(view.readyToFile).toBe(true);
    expect(view.environment).toBe('SANDBOX');
    // A credential is reported as present, never as itself - not in the
    // field, and not anywhere else in the serialised reply either.
    expect(JSON.stringify(saved.body)).not.toContain(secret);
    expect(ok(saved).warnings).toEqual([]);

    const read = await get('/config');
    expect(read.status).toBe(200);
    const readView = ok(read);
    expect(readView.portalApiKeyPresent).toBe(true);
    expect(JSON.stringify(read.body)).not.toContain(secret);
    // The projection is the whole of what an administrator may see, so a
    // column added to the row later cannot start leaking by accident.
    expect(Object.keys(readView).sort()).toEqual([
      'breachNotificationHours', 'configured', 'dpoEmail', 'dpoName', 'dpoPhone', 'environment',
      'integrationId', 'isActive', 'lastTestedAt', 'name', 'portalApiKeyPresent', 'portalBaseUrl',
      'readyToFile', 'registrationDaysRemaining', 'registrationExpiresOn', 'registrationNumber',
      'registrationState', 'status', 'subjectRequestDays',
    ]);
  });

  it('leaves a field alone when the patch omits it and clears it when the patch empties it', async () => {
    const phone = tag('PHONE');
    const set = await patch('/config', { dpoPhone: phone });
    expect(set.status).toBe(200);
    expect((ok(set).config as Record<string, unknown>).dpoPhone).toBe(phone);

    // A patch that says nothing about the phone must not touch it. This is
    // the difference between an omitted key and an empty one, and it is the
    // reason the service does not spread the body into the stored config.
    const other = await patch('/config', { dpoName: 'Named Officer' });
    expect(other.status).toBe(200);
    expect((ok(other).config as Record<string, unknown>).dpoPhone).toBe(phone);

    const cleared = await patch('/config', { dpoPhone: '' });
    expect(cleared.status).toBe(200);
    expect((ok(cleared).config as Record<string, unknown>).dpoPhone).toBeNull();

    // The officer email is back after this, because the connection test
    // below depends on it being recorded.
    await patch('/config', { dpoPhone: phone, dpoEmail: 'dpo@example.com' });
  });

  it('classifies a registration from its date rather than from what it is told', async () => {
    const far = await patch('/config', { registrationNumber: tag('REG'), registrationExpiresOn: dayOffset(400) });
    expect((ok(far).config as Record<string, unknown>).registrationState).toBe('REGISTERED');

    const soon = await patch('/config', { registrationExpiresOn: dayOffset(30) });
    const soonView = ok(soon).config as Record<string, unknown>;
    expect(soonView.registrationState).toBe('EXPIRING');
    expect(soonView.registrationDaysRemaining as number).toBeLessThanOrEqual(60);
    expect((ok(soon).warnings as string[]).join(' ')).toContain('expires on');

    const lapsed = await patch('/config', { registrationExpiresOn: dayOffset(-1) });
    expect((ok(lapsed).config as Record<string, unknown>).registrationState).toBe('EXPIRED');
    expect((ok(lapsed).warnings as string[]).join(' ')).toContain('lapsed');

    // Unregistered is the honest default: a number that was cleared is not a
    // registration, so nothing is assumed on the company behalf.
    const none = await patch('/config', { registrationNumber: '' });
    expect((ok(none).config as Record<string, unknown>).registrationState).toBe('UNREGISTERED');

    await patch('/config', { registrationNumber: tag('REG'), registrationExpiresOn: dayOffset(400) });
  });

  it('tests the connection against the recorded facts and writes the outcome down', async () => {
    // Switched off, so the first critical check has to fail even though the
    // certificate and the officer are on record: nothing can be attributed.
    await patch('/config', { isActive: false });
    const off = await post('/test-connection');
    expect(off.status).toBe(200);
    const offBody = ok(off);
    expect(offBody.ok).toBe(false);
    expect(offBody.status).toBe('ERROR');
    const checks = offBody.checks as Array<{ key: string; ok: boolean; critical: boolean; detail: string }>;
    expect(checks.map((c) => c.key)).toEqual(['integration', 'registration', 'officer', 'clock', 'register', 'portal']);
    expect(checks.find((c) => c.key === 'integration')!.ok).toBe(false);
    expect(checks.filter((c) => c.critical).map((c) => c.key)).toEqual([
      'integration', 'registration', 'officer', 'clock',
    ]);
    // The overall verdict is the critical checks and nothing else, so a
    // non-critical gap is reported without blocking a filing.
    expect(offBody.ok).toBe(checks.every((c) => !c.critical || c.ok));

    await patch('/config', { isActive: true });
    const on = await post('/test-connection');
    expect(on.status).toBe(200);
    const onBody = ok(on);
    expect(onBody.ok).toBe(true);
    expect(onBody.status).toBe('CONNECTED');
    expect(typeof onBody.testedAt).toBe('string');
    // The outcome is written onto the integration row, so a screen shows the
    // last time anyone actually checked rather than the last time it worked.
    expect((onBody.config as Record<string, unknown>).lastTestedAt).not.toBeNull();
    const reread = await get('/config');
    expect(ok(reread).lastTestedAt).not.toBeNull();
  });

  it('records a processing activity, upper-cases its code, and refuses a second under it', async () => {
    const code = tag('ACT-ROPA');
    const first = await post('/activities', {
      code: code.toLowerCase(),
      name: 'Payroll processing',
      purpose: 'Paying staff the wages they have earned',
      lawfulBasis: 'contract',
      dataCategories: ['identifiers', 'financial'],
      subjectCategories: ['employees'],
    });
    expect(first.status).toBe(200);
    const activity = ok(first);
    // The vocabulary is fixed, so a caller sending lower case is understood
    // rather than refused: the register stores the Act's spelling.
    expect(activity.code).toBe(code);
    expect(activity.lawfulBasis).toBe('CONTRACT');
    expect(activity.dataCategories).toEqual(['IDENTIFIERS', 'FINANCIAL']);
    expect(activity.subjectCategories).toEqual(['EMPLOYEES']);
    expect(activity.status).toBe('ACTIVE');
    expect(activity.crossBorder).toBe(false);
    created.activities.push(Number(activity.id));

    // The code is how the register names the activity, so a second row under
    // the same one is a conflict and not a duplicate.
    const again = await post('/activities', {
      code: code,
      name: 'Payroll processing, described a second time',
      purpose: 'The same processing entered twice',
      lawfulBasis: 'CONTRACT',
    });
    expect(again.status).toBe(409);
    const err = again.body as { error: { code: string; message: string } };
    expect(err.error.code).toBe('CONFLICT');
    expect(err.error.message).toContain(code);
  });

  it('refuses a cross-border claim that names no destination, and follows the ones that are named', async () => {
    const refused = await post('/activities', {
      code: tag('ACT-XB'),
      name: 'Offshore hosting',
      purpose: 'Holding the customer database outside Uganda',
      lawfulBasis: 'LEGITIMATE_INTERESTS',
      crossBorder: true,
    });
    expect(refused.status).toBe(400);
    const err = refused.body as { error: { code: string; message: string } };
    expect(err.error.code).toBe('BAD_REQUEST');
    expect(err.error.message).toContain('destination country');

    // Naming the destination is the transfer, so the flag follows the
    // countries instead of being taken at face value.
    const named = await post('/activities', {
      code: tag('ACT-XB'),
      name: 'Offshore hosting',
      purpose: 'Holding the customer database outside Uganda',
      lawfulBasis: 'LEGITIMATE_INTERESTS',
      transferCountries: ['ke'],
    });
    expect(named.status).toBe(200);
    const view = ok(named);
    expect(view.crossBorder).toBe(true);
    expect(view.transferCountries).toEqual(['KE']);
    created.activities.push(Number(view.id));
  });

  it('finds an activity by its code without the caller having to know its id', async () => {
    const code = tag('ACT-SEARCH');
    const made = await post('/activities', {
      code: code,
      name: 'Marketing list',
      purpose: 'Sending offers to people who asked for them',
      lawfulBasis: 'CONSENT',
    });
    expect(made.status).toBe(200);
    created.activities.push(Number(ok(made).id));

    const found = await get('/activities?search=' + code);
    expect(found.status).toBe(200);
    const page = ok(found);
    const rows = page.rows as Array<{ code: string }>;
    expect(rows.map((r) => r.code)).toContain(code);
    // The search is confined to this company's register, and the term is
    // unique to this run, so nothing else can arrive through it.
    expect(rows.every((r) => r.code === code)).toBe(true);
    expect(page.total).toBe(1);
    expect(page.limit).toBe(50);
    expect(page.offset).toBe(0);
  });

  it('refuses a second live consent for one subject and purpose, then records the withdrawal', async () => {
    const subject = tag('SUBJ-LIVE');
    const purpose = tag('PURPOSE-LIVE');
    const first = await post('/consents', { subjectReference: subject, purpose: purpose, subjectType: 'CUSTOMER' });
    expect(first.status).toBe(200);
    const consent = ok(first);
    expect(consent.status).toBe('GRANTED');
    expect(consent.withdrawnAt).toBeNull();
    const id = Number(consent.id);
    created.consents.push(id);

    // Two live grants for one purpose would double-count the evidence, so the
    // partial unique index turns the second into a conflict rather than a
    // duplicate the register would later have to explain.
    const again = await post('/consents', { subjectReference: subject, purpose: purpose, subjectType: 'CUSTOMER' });
    expect(again.status).toBe(409);
    const err = again.body as { error: { code: string; message: string } };
    expect(err.error.code).toBe('CONFLICT');
    expect(err.error.message).toContain('already exists');
    expect(err.error.message).toContain('Withdraw it first');

    const withdrawn = await post('/consents/' + id + '/withdraw', { reason: 'Subject asked us to stop' });
    expect(withdrawn.status).toBe(200);
    const after = ok(withdrawn);
    expect(after.status).toBe('WITHDRAWN');
    expect(typeof after.withdrawnAt).toBe('string');
    expect(after.withdrawalReason).toBe('Subject asked us to stop');

    // Withdrawing twice would restamp the moment consent ended, so the second
    // attempt is refused and the first one stands.
    const twice = await post('/consents/' + id + '/withdraw', {});
    expect(twice.status).toBe(409);
    expect((twice.body as { error: { message: string } }).error.message).toContain('already been withdrawn');
  });

  it('refuses to delete a live consent but removes one that has already ended', async () => {
    const live = await post('/consents', {
      subjectReference: tag('SUBJ-DEL'),
      purpose: tag('PURPOSE-DEL'),
      subjectType: 'CUSTOMER',
    });
    expect(live.status).toBe(200);
    const liveId = Number(ok(live).id);
    created.consents.push(liveId);

    // Deleting a live consent would erase the evidence that processing was
    // ever permitted, which is the one thing this register exists to show.
    const refused = await del('/consents/' + liveId);
    expect(refused.status).toBe(400);
    const err = refused.body as { error: { code: string; message: string } };
    expect(err.error.code).toBe('BAD_REQUEST');
    expect(err.error.message).toContain('cannot be deleted');

    await post('/consents/' + liveId + '/withdraw', {});
    const removed = await del('/consents/' + liveId);
    expect(removed.status).toBe(200);
    expect(ok(removed).deleted).toBe(true);
    const gone = await get('/consents/' + liveId);
    expect(gone.status).toBe(404);
  });

  it('derives a breach status from notifiability instead of accepting the one it is sent', async () => {
    const quiet = await post('/breaches', {
      title: tag('BR-QUIET'),
      nature: 'An encrypted laptop left on a train and never unlocked',
      severity: 'LOW',
      notifiable: false,
      status: 'REPORTED',
    });
    expect(quiet.status).toBe(200);
    const quietView = ok(quiet);
    expect(quietView.notifiable).toBe(false);
    // A breach assessed as not notifiable is not an open notification clock,
    // so the status is NOT_NOTIFIABLE whatever the caller sent with it.
    expect(quietView.status).toBe('NOT_NOTIFIABLE');
    expect(quietView.open).toBe(false);
    created.breaches.push(Number(quietView.id));

    const loud = await post('/breaches', {
      title: tag('BR-LOUD'),
      nature: 'A customer extract mailed to the wrong recipient',
      severity: 'HIGH',
      notifiable: true,
      status: 'REPORTED',
    });
    expect(loud.status).toBe(200);
    const loudView = ok(loud);
    expect(loudView.notifiable).toBe(true);
    // Sending REPORTED is ignored because reporting has its own call and its
    // own evidence; a breach that has not been reported is still open.
    expect(loudView.status).toBe('OPEN');
    expect(loudView.notifiedAt).toBeNull();
    expect(String(loudView.reference).startsWith('PDPO-BR')).toBe(true);
    created.breaches.push(Number(loudView.id));
  });

  it('refuses a discovery that precedes the incident it was discovered from', async () => {
    const now = Date.now();
    const res = await post('/breaches', {
      title: tag('BR-CLOCK-X'),
      nature: 'A discovery date that cannot be true',
      occurredAt: new Date(now).toISOString(),
      discoveredAt: new Date(now - 86400000).toISOString(),
    });
    expect(res.status).toBe(400);
    expect((res.body as { error: { message: string } }).error.message).toContain(
      'discoveredAt cannot be earlier than occurredAt'
    );
  });

  it('reports and closes a breach only along the paths the register allows', async () => {
    const discovered = Date.now() - 3 * 3600000;
    const made = await post('/breaches', {
      title: tag('BR-LIFE'),
      nature: 'Customer records read through a misconfigured bucket',
      severity: 'CRITICAL',
      notifiable: true,
      occurredAt: new Date(discovered - 3600000).toISOString(),
      discoveredAt: new Date(discovered).toISOString(),
    });
    expect(made.status).toBe(200);
    const breach = ok(made);
    const id = Number(breach.id);
    created.breaches.push(id);
    expect(breach.notifiedAt).toBeNull();
    expect(breach.overdue).toBe(false);

    // Closing an unreported notifiable breach would drop an obligation that is
    // still running, so the clock has to be discharged first.
    const early = await post('/breaches/' + id + '/close', {});
    expect(early.status).toBe(400);
    expect((early.body as { error: { message: string } }).error.message).toContain('has not been reported');

    // REPORTED is an outcome with its own evidence, so a PATCH may not set it.
    const bogus = await patch('/breaches/' + id, { status: 'REPORTED' });
    expect(bogus.status).toBe(400);
    expect((bogus.body as { error: { message: string } }).error.message).toContain('status must be one of');

    const reported = await post('/breaches/' + id + '/report', { notificationReference: tag('BR-REF') });
    expect(reported.status).toBe(200);
    const afterReport = ok(reported);
    expect(afterReport.status).toBe('REPORTED');
    expect(typeof afterReport.notifiedAt).toBe('string');
    // The window was 72 hours and three have passed, so this was in time and
    // the trigger says so without being told.
    expect(afterReport.lateNotification).toBe(false);
    expect(afterReport.notificationReference).toBe(tag('BR-REF'));

    // A notification that reached the Office cannot be un-sent by deleting
    // our copy of it.
    const refusedDelete = await del('/breaches/' + id);
    expect(refusedDelete.status).toBe(400);
    expect((refusedDelete.body as { error: { message: string } }).error.message).toContain('cannot be deleted');

    const closed = await post('/breaches/' + id + '/close', {});
    expect(closed.status).toBe(200);
    expect(ok(closed).status).toBe('CLOSED');
    expect(typeof ok(closed).closedAt).toBe('string');

    const edit = await patch('/breaches/' + id, { severity: 'HIGH' });
    expect(edit.status).toBe(409);
    expect((edit.body as { error: { message: string } }).error.message).toContain('closed');

    const twice = await post('/breaches/' + id + '/close', {});
    expect(twice.status).toBe(409);
    expect((twice.body as { error: { message: string } }).error.message).toContain('already closed');
  });

  it('re-assesses a breach as notifiable before it will report one', async () => {
    const made = await post('/breaches', {
      title: tag('BR-REASSESS'),
      nature: 'Initially thought harmless, later found to expose records',
      severity: 'MEDIUM',
      notifiable: false,
    });
    expect(made.status).toBe(200);
    const id = Number(ok(made).id);
    created.breaches.push(id);
    expect(ok(made).status).toBe('NOT_NOTIFIABLE');

    // Saying both "not notifiable" and "reported" is a contradiction the
    // register refuses to hold, so the assessment has to move first.
    const tooSoon = await post('/breaches/' + id + '/report', {});
    expect(tooSoon.status).toBe(409);
    expect((tooSoon.body as { error: { message: string } }).error.message).toContain('not_notifiable');

    // Changing only one half of the pair is enough: the register fixes the
    // other so the caller gets a coherent row instead of a constraint error.
    const reassessed = await patch('/breaches/' + id, { notifiable: true });
    expect(reassessed.status).toBe(200);
    expect(ok(reassessed).notifiable).toBe(true);
    expect(ok(reassessed).status).toBe('OPEN');

    const reported = await post('/breaches/' + id + '/report', {});
    expect(reported.status).toBe(200);
    expect(ok(reported).status).toBe('REPORTED');

    const closed = await post('/breaches/' + id + '/close', {});
    expect(closed.status).toBe(200);
    expect(ok(closed).status).toBe('CLOSED');
  });

  it('carries the response window onto the request so its deadline cannot move', async () => {
    const made = await post('/subject-requests', {
      requestType: 'ACCESS',
      subjectReference: tag('SAR-REQ'),
      subjectType: 'CUSTOMER',
      responseWindowDays: 14,
    });
    expect(made.status).toBe(200);
    const request = ok(made);
    const id = Number(request.id);
    created.requests.push(id);
    expect(String(request.reference).startsWith('PDPO-SAR')).toBe(true);
    expect(request.status).toBe('RECEIVED');
    expect(request.open).toBe(true);
    expect(request.responseWindowDays).toBe(14);
    expect(typeof request.dueAt).toBe('string');
    expect(request.daysRemaining as number).toBeGreaterThan(12);
    expect(request.daysRemaining as number).toBeLessThan(15);
  });

  it('requires a reason to close a request and refuses to delete one already acted on', async () => {
    const made = await post('/subject-requests', {
      requestType: 'ERASURE',
      subjectReference: tag('SAR-DECIDE'),
      subjectType: 'CUSTOMER',
    });
    expect(made.status).toBe(200);
    const id = Number(ok(made).id);
    created.requests.push(id);
    const reference = String(ok(made).reference);

    // A completion without a summary says nothing about what was done, and a
    // refusal without a reason is a decision the subject cannot challenge.
    const bare = await post('/subject-requests/' + id + '/complete', {});
    expect(bare.status).toBe(400);
    expect((bare.body as { error: { message: string } }).error.message).toContain('outcomeSummary is required');

    const unreasoned = await post('/subject-requests/' + id + '/refuse', {});
    expect(unreasoned.status).toBe(400);
    expect((unreasoned.body as { error: { message: string } }).error.message).toContain('refusalReason is required');

    const acknowledged = await post('/subject-requests/' + id + '/acknowledge', {});
    expect(acknowledged.status).toBe(200);
    expect(ok(acknowledged).status).toBe('IN_PROGRESS');
    expect(typeof ok(acknowledged).acknowledgedAt).toBe('string');

    // Once acknowledged the row is the evidence that a deadline was met or
    // missed, which is the one edit that would make the register useless.
    const refusedDelete = await del('/subject-requests/' + id);
    expect(refusedDelete.status).toBe(400);
    expect((refusedDelete.body as { error: { message: string } }).error.message).toContain(reference);
    expect((refusedDelete.body as { error: { message: string } }).error.message).toContain('cannot be deleted');

    const completed = await post('/subject-requests/' + id + '/complete', {
      outcomeSummary: 'The requested extract was sent to the subject.',
    });
    expect(completed.status).toBe(200);
    expect(ok(completed).status).toBe('COMPLETED');
    expect(ok(completed).open).toBe(false);
    expect(typeof ok(completed).completedAt).toBe('string');
    // Completing twice would restamp the day the deadline was met.
    const again = await post('/subject-requests/' + id + '/complete', { outcomeSummary: 'Again' });
    expect(again.status).toBe(409);
    expect((again.body as { error: { message: string } }).error.message).toContain('already closed');
  });

  it('records a refusal with the reason it was made and will not restate it', async () => {
    const made = await post('/subject-requests', {
      requestType: 'OBJECTION',
      subjectReference: tag('SAR-REFUSE'),
      subjectType: 'CUSTOMER',
    });
    expect(made.status).toBe(200);
    const id = Number(ok(made).id);
    created.requests.push(id);

    const refused = await post('/subject-requests/' + id + '/refuse', {
      reason: 'The processing is required by a legal obligation.',
    });
    expect(refused.status).toBe(200);
    expect(ok(refused).status).toBe('REFUSED');
    expect(ok(refused).refusalReason).toBe('The processing is required by a legal obligation.');
    expect(ok(refused).open).toBe(false);

    const twice = await post('/subject-requests/' + id + '/refuse', { reason: 'Another reason' });
    expect(twice.status).toBe(409);
    expect((twice.body as { error: { message: string } }).error.message).toContain('already closed');
  });

  it('creates a filing as a draft and drives it only through the transitions it has', async () => {
    const draft = await post('/filings', {
      submissionType: 'ANNUAL_RETURN',
      subject: tag('FIL-DRAFT'),
      channel: 'PORTAL',
      status: 'FILED',
      filedAt: new Date().toISOString(),
      relatedTable: 'pdpo_breaches',
    });
    // A relation needs both halves, because a filing that names a table and no
    // row cannot be followed back to what it was about.
    expect(draft.status).toBe(400);
    expect((draft.body as { error: { message: string } }).error.message).toContain('together');

    // The same pair, completed, is how a filing says what it is about, so the
    // register has to accept it and then be able to find the filing by it.
    const about = await post('/breaches', {
      title: tag('BR-REL'),
      nature: 'The incident the return was filed about',
      severity: 'LOW',
      notifiable: false,
    });
    expect(about.status).toBe(200);
    const aboutId = Number(ok(about).id);
    created.breaches.push(aboutId);

    const attached = await post('/filings', {
      submissionType: 'BREACH_NOTIFICATION',
      subject: tag('FIL-REL'),
      channel: 'EMAIL',
      relatedTable: 'pdpo_breaches',
      relatedId: aboutId,
    });
    expect(attached.status).toBe(200);
    const linked = ok(attached);
    created.filings.push(Number(linked.id));
    expect(linked.relatedTable).toBe('pdpo_breaches');
    expect(linked.relatedId).toBe(aboutId);

    // The relation is also a filter, which is how a filing is found from the
    // row it is about rather than from the filing register's own order.
    const byRelated = await get('/filings?relatedTable=pdpo_breaches&relatedId=' + aboutId);
    expect(byRelated.status).toBe(200);
    const relatedIds = (ok(byRelated).rows as Array<{ id: number }>).map((r) => Number(r.id));
    expect(relatedIds).toContain(Number(linked.id));

    const made = await post('/filings', {
      submissionType: 'ANNUAL_RETURN',
      subject: tag('FIL-DRAFT'),
      channel: 'PORTAL',
      // A filing becomes a filing when it is sent, so neither the status nor
      // the date can be handed in already filled out.
      status: 'ACKNOWLEDGED',
      filedAt: new Date().toISOString(),
    });
    expect(made.status).toBe(200);
    const filing = ok(made);
    const id = Number(filing.id);
    created.filings.push(id);
    expect(filing.status).toBe('DRAFT');
    expect(filing.draft).toBe(true);
    expect(filing.filed).toBe(false);
    expect(filing.filedAt).toBeNull();

    // A draft may be edited freely, because nothing has left the building yet.
    const edited = await patch('/filings/' + id, { notes: 'Ready to send' });
    expect(edited.status).toBe(200);
    expect(ok(edited).notes).toBe('Ready to send');

    const filed = await post('/filings/' + id + '/file', {});
    expect(filed.status).toBe(200);
    const sent = ok(filed);
    expect(sent.status).toBe('FILED');
    expect(sent.draft).toBe(false);
    expect(sent.filed).toBe(true);
    expect(typeof sent.filedAt).toBe('string');
    expect(typeof sent.filedBy).toBe('number');

    const refiled = await post('/filings/' + id + '/file', {});
    expect(refiled.status).toBe(409);
    expect((refiled.body as { error: { message: string } }).error.message).toContain('already been filed');

    // Its content is the evidence of what was sent, so it stops being editable.
    const editedAfter = await patch('/filings/' + id, { notes: 'Changed my mind' });
    expect(editedAfter.status).toBe(409);
    expect((editedAfter.body as { error: { message: string } }).error.message).toContain('cannot be edited');

    const refusedDelete = await del('/filings/' + id);
    expect(refusedDelete.status).toBe(400);
    expect((refusedDelete.body as { error: { message: string } }).error.message).toContain('Only a draft filing');

    // The acknowledgement is the Office's own reference; without it there is
    // nothing on the record that ties our filing to theirs.
    const bareAck = await post('/filings/' + id + '/acknowledge', {});
    expect(bareAck.status).toBe(400);
    expect((bareAck.body as { error: { message: string } }).error.message).toContain('acknowledgementReference');

    const acked = await post('/filings/' + id + '/acknowledge', { acknowledgementReference: tag('FIL-ACK') });
    expect(acked.status).toBe(200);
    expect(ok(acked).status).toBe('ACKNOWLEDGED');
    expect(ok(acked).acknowledgementReference).toBe(tag('FIL-ACK'));
    expect(typeof ok(acked).acknowledgedAt).toBe('string');
  });

  it('records a rejection with the reason the Office gave', async () => {
    const made = await post('/filings', {
      submissionType: 'BREACH_NOTIFICATION',
      subject: tag('FIL-REJ'),
      channel: 'EMAIL',
    });
    expect(made.status).toBe(200);
    const id = Number(ok(made).id);
    created.filings.push(id);

    // Nothing has been sent, so there is nothing to reject yet.
    const early = await post('/filings/' + id + '/reject', { reason: 'Not applicable' });
    expect(early.status).toBe(409);
    expect((early.body as { error: { message: string } }).error.message).toContain('has not been sent');

    await post('/filings/' + id + '/file', {});
    const bare = await post('/filings/' + id + '/reject', {});
    expect(bare.status).toBe(400);
    expect((bare.body as { error: { message: string } }).error.message).toContain('rejectionReason is required');

    const rejected = await post('/filings/' + id + '/reject', { reason: 'The reference was missing.' });
    expect(rejected.status).toBe(200);
    expect(ok(rejected).status).toBe('REJECTED');
    expect(ok(rejected).rejectionReason).toBe('The reference was missing.');
    expect(ok(rejected).draft).toBe(false);
  });

  it('hands the whole register over as an inspection pack, and says when it was capped', async () => {
    const res = await get('/export');
    expect(res.status).toBe(200);
    const pack = ok(res);
    expect(Object.keys(pack).sort()).toEqual([
      'breaches', 'config', 'consents', 'filings', 'generatedAt', 'processingActivities', 'subjectRequests',
    ]);
    expect(typeof pack.generatedAt).toBe('string');
    expect((pack.config as Record<string, unknown>).registrationState).toBe('REGISTERED');

    for (const key of ['processingActivities', 'consents', 'subjectRequests', 'breaches', 'filings']) {
      const slice = pack[key] as { rows: unknown[]; total: number; truncated: boolean };
      expect(Array.isArray(slice.rows)).toBe(true);
      expect(typeof slice.total).toBe('number');
      expect(slice.total).toBeGreaterThanOrEqual(slice.rows.length);
      // An export that silently truncated the breach register would look
      // complete, which is worse than an export that admits it was capped.
      expect(slice.truncated).toBe(slice.total > slice.rows.length);
    }
  });

  it('writes every register change into the audit trail under its own resource name', async () => {
    const ids = [
      ...created.activities,
      ...created.consents,
      ...created.requests,
      ...created.breaches,
      ...created.filings,
    ];
    const rows = await asTenant<{ resource: string; action: string }>(
      "SELECT resource, action FROM audit_logs WHERE resource LIKE 'compliance.%' AND record_id = ANY($1::bigint[])",
      [ids]
    );
    const resources = Array.from(new Set(rows.map((r) => r.resource)));
    const actions = Array.from(new Set(rows.map((r) => r.action)));

    // The service names a register in the singular, which is what tells a
    // service write apart from the row trigger's own audit row - that one is
    // named for the table and is written on every INSERT, UPDATE and DELETE.
    expect(resources).toContain('compliance.processing_activity');
    expect(resources).toContain('compliance.consent');
    expect(resources).toContain('compliance.subject_request');
    expect(resources).toContain('compliance.breach');
    expect(resources).toContain('compliance.submission');

    for (const action of [
      'create', 'update', 'delete', 'withdraw', 'acknowledge', 'complete', 'refuse', 'report', 'close', 'file', 'reject',
    ]) {
      expect(actions).toContain(action);
    }

    // The configuration is audited against the integration row rather than
    // against a register, so it is looked up on that row's own id.
    const integrationId = Number(ok(await get('/config')).integrationId);
    const configRows = await asTenant<{ action: string }>(
      "SELECT action FROM audit_logs WHERE resource = 'compliance.pdpo.config' AND record_id = $1",
      [integrationId]
    );
    const configActions = Array.from(new Set(configRows.map((r) => r.action)));
    expect(configActions).toContain('update');
    expect(configActions).toContain('test');
  });

  it('refuses an operator who holds no grant on the register', async () => {
    const token = (await loginAs('sarah.sales')).token;
    const attempts: Array<[string, string]> = [
      ['get', '/activities'],
      ['get', '/status'],
      ['post', '/consents'],
    ];
    for (const [method, path] of attempts) {
      const res = method === 'get'
        ? await api.get(base + path).set(auth(token))
        : await api.post(base + path).set(auth(token)).send({ subjectReference: tag('SUBJ-403'), purpose: tag('PURPOSE-403') });
      // Held back at the boundary rather than answered with an empty list: a
      // register a caller cannot read must not look like a register with
      // nothing in it.
      expect(res.status).toBe(403);
      expect((res.body as { error: { code: string } }).error.code).toBe('FORBIDDEN');
    }
  });
});

// ------------------------------------------------------------ who may write
// The grants are asserted against role_permissions rather than over HTTP,
// because the administrator account resolves every permission and would make
// an HTTP test of the same thing pass for the wrong reason.
describe('role grants', () => {
  /** The compliance permissions a role code holds, as the roles table stores them. */
  const grantsFor = async (code: string): Promise<string[]> => {
    const rows = await pool.query(
      'SELECT p.code FROM role_permissions rp ' +
        'JOIN roles r ON r.id = rp.role_id ' +
        'JOIN permissions p ON p.id = rp.permission_id ' +
        "WHERE r.code = $1 AND p.module = 'compliance' ORDER BY p.code",
      [code]
    );
    return rows.rows.map((r: { code: string }) => r.code);
  };

  it('gives the data protection officer the whole register', async () => {
    const grants = await grantsFor('data_protection_officer');
    expect(grants).toHaveLength(22);
    expect(grants).toContain('compliance.breaches.close');
    expect(grants).toContain('compliance.breaches.report');
    expect(grants).toContain('compliance.consents.withdraw');
    expect(grants).toContain('compliance.pdpo.export');
    expect(grants).toContain('compliance.pdpo.manage');
    expect(grants).toContain('compliance.processing_activities.delete');
    expect(grants).toContain('compliance.subject_requests.fulfil');
    // Nothing about another module arrives through this one.
    expect(grants.every((g) => g.startsWith('compliance.'))).toBe(true);
  });

  it('lets the human resources roles keep the registers they raise and not the breach register', async () => {
    for (const code of ['hr_director', 'hr_manager', 'hr_officer']) {
      const grants = await grantsFor(code);
      expect(grants).toHaveLength(11);
      expect(grants).toContain('compliance.consents.create');
      expect(grants).toContain('compliance.subject_requests.fulfil');
      expect(grants).toContain('compliance.processing_activities.update');
      // A breach notification is the officer's call, not a departmental one.
      expect(grants.filter((g) => g.startsWith('compliance.breaches'))).toEqual([]);
      // Nor may a department erase a row from the register.
      expect(grants.filter((g) => g.endsWith('.delete'))).toEqual([]);
    }
  });

  it('gives security the breach register and read-only sight of the rest', async () => {
    const grants = await grantsFor('security_administrator');
    expect(grants).toHaveLength(10);
    expect(grants).toContain('compliance.breaches.close');
    expect(grants).toContain('compliance.breaches.report');
    expect(grants).toContain('compliance.pdpo.export');
    expect(grants).toContain('compliance.consents.view');
    expect(grants).toContain('compliance.processing_activities.view');
    expect(grants).not.toContain('compliance.consents.create');
    expect(grants).not.toContain('compliance.processing_activities.update');
  });

  it('leaves the audit and system roles able to read the register and nothing more', async () => {
    const readOnly = [
      'compliance.breaches.view',
      'compliance.consents.view',
      'compliance.pdpo.export',
      'compliance.pdpo.view',
      'compliance.processing_activities.view',
      'compliance.subject_requests.view',
    ];
    for (const code of ['audit_administrator', 'internal_auditor', 'system_administrator']) {
      expect(await grantsFor(code)).toEqual(readOnly);
    }
  });

  it('grants nothing on the register to a role that has no compliance business', async () => {
    expect(await grantsFor('sales_manager')).toEqual([]);
  });
});
