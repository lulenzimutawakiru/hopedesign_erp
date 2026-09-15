import pg from 'pg';
import { Ctx } from '../../db.js';
import { badRequest, notFound, toCamelRow, toCamelRows } from '../../utils.js';
import { logAudit } from '../audit.js';

/**
 * Retention and backup configuration.
 *
 * There is a read path for retention policies in database-admin.ts, but it
 * projects a narrow subset of the row (id, category, retention_days,
 * legal_hold, applies_to, notes) for the database console. The settings screen
 * needs the columns that decide what actually happens to a record when its
 * clock runs out - purge_action, archive_after_days, legal_basis - so the
 * listing here reads the whole row. The audit resource differs too, which
 * keeps "an operator nudged the number in the DB console" distinguishable from
 * "an administrator changed the retention rule" in the trail.
 *
 * The controlling idea: retention is the only place in the ERP where the
 * correct behaviour is to destroy data, so it is the only place that has to
 * prove it is allowed to. Statutory categories cannot be set to DELETE at all,
 * and a policy under legal hold cannot be purged whatever it says.
 */

export const RETENTION_CATEGORIES = [
  'AUDIT', 'DOCUMENTS', 'PAYROLL', 'FINANCIAL', 'TICKETS', 'QR_HISTORY',
  'ATTENDANCE', 'MANUFACTURING', 'INVENTORY', 'HR', 'SALES', 'PROCUREMENT',
  'COMMUNICATION', 'INTEGRATION_LOGS', 'OTHER',
] as const;

export const PURGE_ACTIONS = ['RETAIN', 'ARCHIVE', 'ANONYMISE', 'DELETE'] as const;
export type PurgeAction = (typeof PURGE_ACTIONS)[number];

/**
 * Categories whose records exist because a law or a regulator requires them.
 * A retention policy over one of these may archive or anonymise, never delete.
 */
export const STATUTORY_CATEGORIES: ReadonlySet<string> = new Set([
  'AUDIT', 'PAYROLL', 'FINANCIAL', 'DOCUMENTS', 'QR_HISTORY',
]);

export const BACKUP_SCOPES = ['DATABASE', 'DOCUMENTS', 'FILES', 'CONFIGURATION', 'FULL'] as const;
export const BACKUP_FREQUENCIES = ['HOURLY', 'DAILY', 'WEEKLY', 'MONTHLY'] as const;

function text(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  return s.length === 0 ? null : s;
}

function pick<T extends readonly string[]>(
  value: unknown,
  allowed: T,
  field: string,
  fallback: T[number]
): T[number] {
  const s = text(value);
  if (!s) return fallback;
  const up = s.toUpperCase();
  if (!(allowed as readonly string[]).includes(up)) {
    throw badRequest(field + ' must be one of: ' + allowed.join(', '));
  }
  return up as T[number];
}

function positiveIntOrNull(value: unknown, field: string, allowZero = false): number | null {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) throw badRequest(field + ' must be a number');
  const i = Math.trunc(n);
  if (i < 0 || (!allowZero && i === 0)) {
    throw badRequest(field + ' must be ' + (allowZero ? 'zero or a positive integer' : 'a positive integer'));
  }
  return i;
}

// ---------------------------------------------------------------------------
// Retention policies
// ---------------------------------------------------------------------------

export async function listRetentionPolicies(client: pg.PoolClient, ctx: Ctx) {
  const res = await client.query(
    `SELECT * FROM db_retention_policies
      WHERE tenant_id = $1 AND (company_id = $2 OR company_id IS NULL)
      ORDER BY category, applies_to`,
    [ctx.tenantId ?? null, ctx.companyId ?? null]
  );
  return toCamelRows(res.rows);
}

export async function getRetentionPolicy(client: pg.PoolClient, ctx: Ctx, id: number) {
  const res = await client.query(
    'SELECT * FROM db_retention_policies WHERE id = $1 AND tenant_id = $2',
    [id, ctx.tenantId ?? null]
  );
  if (res.rows.length === 0) throw notFound('Retention policy not found');
  return res.rows[0];
}

export async function upsertRetentionPolicy(
  client: pg.PoolClient,
  ctx: Ctx,
  input: Record<string, unknown>
) {
  const id = input.id == null ? null : Number(input.id);
  const before = id == null ? null : await getRetentionPolicy(client, ctx, id);

  const category = pick(input.category ?? before?.category, RETENTION_CATEGORIES, 'category', 'OTHER');
  const appliesTo = text(input.appliesTo ?? input.applies_to) ?? (before ? String(before.applies_to) : 'ALL_RECORDS');
  const retentionDays = positiveIntOrNull(
    input.retentionDays ?? input.retention_days ?? before?.retention_days,
    'retentionDays'
  ) ?? 365;
  const purgeAction = pick(
    input.purgeAction ?? input.purge_action ?? before?.purge_action,
    PURGE_ACTIONS,
    'purgeAction',
    'RETAIN'
  );
  const archiveAfterDays = positiveIntOrNull(
    input.archiveAfterDays ?? input.archive_after_days ?? before?.archive_after_days,
    'archiveAfterDays',
    true
  );
  const legalHold = input.legalHold === undefined && input.legal_hold === undefined
    ? (before ? before.legal_hold === true : false)
    : input.legalHold === true || input.legal_hold === true;
  const legalBasis = text(input.legalBasis ?? input.legal_basis) ?? before?.legal_basis ?? null;
  const code = text(input.code) ?? before?.code ?? null;
  const name = text(input.name) ?? before?.name ?? null;
  const notes = text(input.notes) ?? before?.notes ?? null;
  const isActive = input.isActive === undefined
    ? (before ? before.is_active !== false : true)
    : input.isActive === true;

  // The statutory guard. This is the whole point of the category list above.
  if (purgeAction === 'DELETE' && STATUTORY_CATEGORIES.has(category)) {
    throw badRequest(
      category + ' records are statutory. Retention may ARCHIVE or ANONYMISE them, but not DELETE them.'
    );
  }
  if (purgeAction !== 'RETAIN' && legalHold) {
    throw badRequest(
      'This policy is under legal hold, so no purge action can run. Release the hold first.'
    );
  }
  if (archiveAfterDays != null && archiveAfterDays >= retentionDays) {
    throw badRequest('archiveAfterDays must be shorter than retentionDays, otherwise nothing is ever archived');
  }

  const res = await client.query(
    `INSERT INTO db_retention_policies
        (tenant_id, company_id, category, applies_to, retention_days, archive_after_days,
         purge_action, legal_hold, legal_basis, code, name, notes, is_active, created_by, updated_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$14)
     ON CONFLICT (tenant_id, category, applies_to)
     DO UPDATE SET
        retention_days = EXCLUDED.retention_days,
        archive_after_days = EXCLUDED.archive_after_days,
        purge_action = EXCLUDED.purge_action,
        legal_hold = EXCLUDED.legal_hold,
        legal_basis = EXCLUDED.legal_basis,
        code = EXCLUDED.code,
        name = EXCLUDED.name,
        notes = EXCLUDED.notes,
        is_active = EXCLUDED.is_active,
        updated_by = EXCLUDED.updated_by,
        updated_at = now()
     RETURNING *`,
    [
      ctx.tenantId ?? null, ctx.companyId ?? null, category, appliesTo, retentionDays,
      archiveAfterDays, purgeAction, legalHold, legalBasis, code, name, notes, isActive,
      ctx.userId ?? null,
    ]
  );

  await logAudit(client, ctx, {
    action: before ? 'update' : 'create',
    resource: 'organisation.settings.retention',
    recordId: Number(res.rows[0].id),
    recordCode: category + '/' + appliesTo,
    oldValues: before,
    newValues: res.rows[0],
  });
  return toCamelRow(res.rows[0]);
}

/**
 * Legal hold is a one-way door while it is on: turning it on is free, turning
 * it off is what releases records to destruction, so it needs a reason.
 */
export async function setRetentionLegalHold(
  client: pg.PoolClient,
  ctx: Ctx,
  id: number,
  hold: boolean,
  reason?: string | null
) {
  const before = await getRetentionPolicy(client, ctx, id);
  if (before.legal_hold === true && hold === false && !text(reason)) {
    throw badRequest('Releasing a legal hold requires a reason');
  }
  const res = await client.query(
    `UPDATE db_retention_policies SET legal_hold = $3, updated_by = $4, updated_at = now()
      WHERE id = $1 AND tenant_id = $2 RETURNING *`,
    [id, ctx.tenantId ?? null, hold, ctx.userId ?? null]
  );
  if (res.rows.length === 0) throw notFound('Retention policy not found');
  await logAudit(client, ctx, {
    action: hold ? 'hold' : 'release_hold',
    resource: 'organisation.settings.retention',
    recordId: id,
    recordCode: String(before.category),
    oldValues: { legalHold: before.legal_hold },
    newValues: { legalHold: hold },
    metadata: { reason: text(reason) },
  });
  return toCamelRow(res.rows[0]);
}

// ---------------------------------------------------------------------------
// Backup policies
// ---------------------------------------------------------------------------

export async function listBackupPolicies(client: pg.PoolClient, ctx: Ctx) {
  const res = await client.query(
    'SELECT * FROM backup_policies WHERE tenant_id = $1 AND company_id = $2 ORDER BY scope, code',
    [ctx.tenantId ?? null, ctx.companyId ?? null]
  );
  return toCamelRows(res.rows);
}

export async function upsertBackupPolicy(
  client: pg.PoolClient,
  ctx: Ctx,
  input: Record<string, unknown>
) {
  const companyId = ctx.companyId;
  if (companyId == null) throw badRequest('A company must be selected to configure backups');

  const code = text(input.code);
  if (!code) throw badRequest('Backup policy code is required');
  const name = text(input.name) ?? code;
  const scope = pick(input.scope, BACKUP_SCOPES, 'scope', 'DATABASE');
  const frequency = pick(input.frequency, BACKUP_FREQUENCIES, 'frequency', 'DAILY');
  const runAt = text(input.runAt ?? input.run_at) ?? '02:00:00';
  if (!/^\d{2}:\d{2}(:\d{2})?$/.test(runAt)) throw badRequest('runAt must be a time such as 02:00');

  const retentionCount = positiveIntOrNull(input.retentionCount ?? input.retention_count, 'retentionCount');
  const retentionDays = positiveIntOrNull(input.retentionDays ?? input.retention_days, 'retentionDays');
  // The table's own CHECK says one of these must be present; failing here gives
  // the caller a sentence instead of a constraint violation.
  if (retentionCount == null && retentionDays == null) {
    throw badRequest('Set either retentionCount or retentionDays - a backup with no retention grows without bound');
  }

  const rpoMinutes = positiveIntOrNull(input.rpoMinutes ?? input.rpo_minutes, 'rpoMinutes');
  const rtoMinutes = positiveIntOrNull(input.rtoMinutes ?? input.rto_minutes, 'rtoMinutes');
  const destination = text(input.destination);
  const notes = text(input.notes);
  const encryptionRequired = input.encryptionRequired === undefined ? true : input.encryptionRequired === true;
  const offsiteRequired = input.offsiteRequired === undefined ? true : input.offsiteRequired === true;
  const verifyRestore = input.verifyRestore === undefined ? true : input.verifyRestore === true;
  const isActive = input.isActive === undefined ? true : input.isActive === true;

  const before = await client.query(
    'SELECT * FROM backup_policies WHERE company_id = $1 AND code = $2',
    [companyId, code]
  );

  const res = await client.query(
    `INSERT INTO backup_policies
        (tenant_id, company_id, code, name, scope, frequency, run_at, retention_count, retention_days,
         encryption_required, offsite_required, verify_restore, rpo_minutes, rto_minutes,
         destination, notes, is_active, created_by, updated_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$18)
     ON CONFLICT (company_id, code)
     DO UPDATE SET
        name = EXCLUDED.name,
        scope = EXCLUDED.scope,
        frequency = EXCLUDED.frequency,
        run_at = EXCLUDED.run_at,
        retention_count = EXCLUDED.retention_count,
        retention_days = EXCLUDED.retention_days,
        encryption_required = EXCLUDED.encryption_required,
        offsite_required = EXCLUDED.offsite_required,
        verify_restore = EXCLUDED.verify_restore,
        rpo_minutes = EXCLUDED.rpo_minutes,
        rto_minutes = EXCLUDED.rto_minutes,
        destination = EXCLUDED.destination,
        notes = EXCLUDED.notes,
        is_active = EXCLUDED.is_active,
        updated_by = EXCLUDED.updated_by,
        updated_at = now()
     RETURNING *`,
    [
      ctx.tenantId ?? null, companyId, code, name, scope, frequency, runAt,
      retentionCount, retentionDays, encryptionRequired, offsiteRequired, verifyRestore,
      rpoMinutes, rtoMinutes, destination, notes, isActive, ctx.userId ?? null,
    ]
  );

  await logAudit(client, ctx, {
    action: before.rows.length > 0 ? 'update' : 'create',
    resource: 'organisation.settings.backup',
    recordId: Number(res.rows[0].id),
    recordCode: code,
    oldValues: before.rows[0] ?? null,
    newValues: res.rows[0],
  });
  return toCamelRow(res.rows[0]);
}

export async function setBackupPolicyActive(
  client: pg.PoolClient,
  ctx: Ctx,
  id: number,
  active: boolean,
  reason?: string | null
) {
  const before = await client.query(
    'SELECT * FROM backup_policies WHERE id = $1 AND tenant_id = $2',
    [id, ctx.tenantId ?? null]
  );
  if (before.rows.length === 0) throw notFound('Backup policy not found');

  if (!active) {
    const remaining = await client.query(
      'SELECT count(*)::int AS n FROM backup_policies WHERE tenant_id = $1 AND company_id = $2 AND is_active = true AND id <> $3',
      [ctx.tenantId ?? null, before.rows[0].company_id, id]
    );
    if (Number(remaining.rows[0].n) === 0) {
      throw badRequest('Refusing to disable the last active backup policy - the company would have no scheduled backups');
    }
  }

  const res = await client.query(
    'UPDATE backup_policies SET is_active = $3, updated_by = $4, updated_at = now() WHERE id = $1 AND tenant_id = $2 RETURNING *',
    [id, ctx.tenantId ?? null, active, ctx.userId ?? null]
  );
  await logAudit(client, ctx, {
    action: active ? 'activate' : 'deactivate',
    resource: 'organisation.settings.backup',
    recordId: id,
    recordCode: String(before.rows[0].code),
    oldValues: { isActive: before.rows[0].is_active },
    newValues: { isActive: active },
    metadata: { reason: text(reason) },
  });
  return toCamelRow(res.rows[0]);
}

export async function retentionOverview(client: pg.PoolClient, ctx: Ctx) {
  const policies = await listRetentionPolicies(client, ctx);
  const backups = await listBackupPolicies(client, ctx);
  return {
    policies,
    backups,
    statutory: policies.filter((p: Record<string, unknown>) => STATUTORY_CATEGORIES.has(String(p.category))),
    underHold: policies.filter((p: Record<string, unknown>) => p.legalHold === true),
    destructive: policies.filter((p: Record<string, unknown>) => p.purgeAction === 'DELETE'),
    activeBackups: backups.filter((b: Record<string, unknown>) => b.isActive === true).length,
    /** The shortest RPO in the set is what the disaster-recovery plan can claim. */
    bestRpoMinutes: backups.reduce<number | null>((best: number | null, b: Record<string, unknown>) => {
      const v = b.rpoMinutes == null ? null : Number(b.rpoMinutes);
      if (v == null) return best;
      return best == null || v < best ? v : best;
    }, null),
  };
}
