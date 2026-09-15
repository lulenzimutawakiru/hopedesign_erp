import pg from 'pg';
import { Ctx } from '../../db.js';
import { badRequest, notFound, toCamelRow, toCamelRows } from '../../utils.js';
import { logAudit } from '../audit.js';
import {
  allocateDocNo,
  buildDocNo,
  previewDocNo,
  resetKeyFor,
  resolveNumberingRule,
} from '../companyConfig.js';

/**
 * Numbering and sequences.
 *
 * Nothing here invents its own counter. Allocation is delegated to
 * allocateDocNo(), which does the whole thing in one statement:
 *
 *   INSERT ... ON CONFLICT (tenant_id, seq_key, doc_year)
 *   DO UPDATE SET last_seq = number_sequences.last_seq + 1
 *
 * The row lock that Postgres takes for the conflicting insert is what makes a
 * hundred simultaneous invoice creations serialise onto distinct numbers
 * (AC-ORG-009, TC-ORG-005). A read-then-write counter would pass every
 * single-threaded test and fail in production, so this module does not offer
 * one.
 *
 * What this module adds on top is the administrative surface: what rules
 * exist, what they will produce, and how to reset a counter deliberately
 * rather than by editing rows by hand.
 */

/** Canonical document types. Existing rows may use others; this is the menu. */
export const NUMBERING_DOC_TYPES = [
  'INVOICE', 'QUOTATION', 'SALES_ORDER', 'DELIVERY_NOTE', 'CREDIT_NOTE', 'DEBIT_NOTE',
  'PURCHASE_ORDER', 'PURCHASE_REQUISITION', 'GRN', 'RECEIPT', 'PAYMENT_VOUCHER',
  'JOURNAL_VOUCHER', 'PAYSLIP', 'EMPLOYEE', 'LEAVE', 'ASSET', 'CONTRACT', 'REPORT',
  'STATEMENT', 'JOB_CARD', 'PRODUCTION_ORDER', 'MATERIAL_ISSUE', 'STOCK_TRANSFER',
  'SERVICE_DESK', 'RAW_MATERIAL', 'WIP', 'FINISHED_GOODS', 'PALLET',
] as const;

/**
 * Prefixes the ERP spec pins down, seeded only when a doc type has no rule yet.
 * Anything already configured is left exactly as the organisation set it.
 */
export const NUMBERING_PRESETS: ReadonlyArray<{ docType: string; prefix: string; format: string }> = [
  { docType: 'SERVICE_DESK', prefix: 'HDG-SD', format: '{PREFIX}-{YYYY}-{######}' },
  { docType: 'RAW_MATERIAL', prefix: 'HDG-RAW', format: '{PREFIX}-{YYYY}-{####}' },
  { docType: 'WIP', prefix: 'HDG-WIP', format: '{PREFIX}-{YYYY}-{####}' },
  { docType: 'FINISHED_GOODS', prefix: 'HDG-FG', format: '{PREFIX}-{YYYY}-{####}' },
  { docType: 'PALLET', prefix: 'HDG-PAL', format: '{PREFIX}-{YYYY}-{####}' },
];

// 'NONE' (not 'NEVER') is the token the database CHECK constraint and
// companyConfig.resetKeyFor both speak. Advertising a different spelling here
// let a value pass service validation and then fail on the column constraint.
export const RESET_FREQUENCIES = ['NONE', 'YEAR', 'FISCAL_YEAR', 'MONTH', 'QUARTER'] as const;

function text(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  return s.length === 0 ? null : s;
}

function normaliseDocType(value: unknown): string {
  const s = text(value);
  if (!s) throw badRequest('docType is required');
  return s.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
}

function intIn(value: unknown, field: string, min: number, max: number, fallback: number): number {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) throw badRequest(field + ' must be a number');
  const i = Math.trunc(n);
  if (i < min || i > max) throw badRequest(field + ' must be between ' + min + ' and ' + max);
  return i;
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

export async function listNumberingRules(
  client: pg.PoolClient,
  ctx: Ctx,
  opts: { includeInactive?: boolean } = {}
) {
  const res = await client.query(
    `SELECT r.*,
            c.code AS company_code,
            b.code AS branch_code,
            (r.company_id IS NULL)   AS is_tenant_default,
            (r.branch_id IS NULL)    AS is_company_default
       FROM document_numbering_rules r
       LEFT JOIN companies c ON c.id = r.company_id
       LEFT JOIN branches  b ON b.id = r.branch_id
      WHERE r.tenant_id = $1
        AND (r.company_id = $2 OR r.company_id IS NULL)
        AND ($3::boolean OR r.is_active = true)
      ORDER BY r.doc_type, (r.company_id IS NOT NULL) DESC, (r.branch_id IS NOT NULL) DESC`,
    [ctx.tenantId ?? null, ctx.companyId ?? null, opts.includeInactive === true]
  );
  return toCamelRows(res.rows);
}

export async function getNumberingRule(client: pg.PoolClient, ctx: Ctx, id: number) {
  const res = await client.query(
    'SELECT * FROM document_numbering_rules WHERE id = $1 AND tenant_id = $2',
    [id, ctx.tenantId ?? null]
  );
  if (res.rows.length === 0) throw notFound('Numbering rule not found');
  return toCamelRow(res.rows[0]);
}

function validateFormat(format: string): void {
  // The format string is interpolated by buildDocNo(); an unknown token would
  // survive into the document number itself, so it is rejected at the door.
  const known = ['{PREFIX}', '{YYYY}', '{YY}', '{YEAR}', '{MM}', '{DD}', '{BRANCH}', '{DEPARTMENT}', '{COMPANY}', '{SEQ}'];
  const tokens = format.match(/\{[^}]*\}/g) ?? [];
  for (const t of tokens) {
    if (known.includes(t)) continue;
    if (/^\{#+\}$/.test(t)) continue;
    throw badRequest('Unknown token ' + t + ' in the number format');
  }
  if (!/\{#+\}|\{SEQ\}/.test(format)) {
    throw badRequest('The format must contain a sequence token such as {####} or {SEQ}');
  }
}

export async function upsertNumberingRule(
  client: pg.PoolClient,
  ctx: Ctx,
  input: Record<string, unknown>
) {
  const docType = normaliseDocType(input.docType ?? input.doc_type);
  const prefix = text(input.prefix);
  if (!prefix) throw badRequest('prefix is required');
  if (!/^[A-Za-z0-9._/-]+$/.test(prefix)) {
    throw badRequest('prefix may contain letters, digits, dot, dash, slash and underscore only');
  }
  const format = text(input.format) ?? '{PREFIX}-{YYYY}-{SEQ}';
  validateFormat(format);

  const resetFrequency = (text(input.resetFrequency) ?? 'YEAR').toUpperCase();
  if (!(RESET_FREQUENCIES as readonly string[]).includes(resetFrequency)) {
    throw badRequest('resetFrequency must be one of: ' + RESET_FREQUENCIES.join(', '));
  }

  const pad = intIn(input.pad, 'pad', 1, 12, 6);
  const startSeq = intIn(input.startSeq, 'startSeq', 1, 999999999, 1);
  const suffix = text(input.suffix);
  const description = text(input.description);
  const includeYear = input.includeYear === undefined ? resetFrequency !== 'NONE' : input.includeYear === true;
  const includeBranch = input.includeBranch === true;
  const includeDepartment = input.includeDepartment === true;

  const companyId = input.tenantWide === true ? null : (ctx.companyId ?? null);
  const branchId = input.branchId == null ? null : Number(input.branchId);

  // Select-then-write rather than ON CONFLICT: the unique index is on an
  // expression (COALESCE(company_id,0), COALESCE(branch_id,0)), and matching a
  // functional index in a conflict target is easy to get subtly wrong.
  const found = await client.query(
    `SELECT * FROM document_numbering_rules
      WHERE tenant_id = $1 AND doc_type = $2
        AND COALESCE(company_id,0) = COALESCE($3::int,0)
        AND COALESCE(branch_id,0)  = COALESCE($4::int,0)`,
    [ctx.tenantId ?? null, docType, companyId, branchId]
  );

  const params = [
    prefix, format, includeYear, includeBranch, includeDepartment,
    pad, startSeq, suffix, resetFrequency, description,
  ];

  let row: Record<string, unknown>;
  if (found.rows.length > 0) {
    const before = found.rows[0];
    const res = await client.query(
      `UPDATE document_numbering_rules
          SET prefix = $2, format = $3, include_year = $4, include_branch = $5,
              include_department = $6, pad = $7, start_seq = $8, suffix = $9,
              reset_frequency = $10, description = $11, is_active = true, updated_at = now()
        WHERE id = $1
        RETURNING *`,
      [before.id, ...params]
    );
    row = res.rows[0];
    await logAudit(client, ctx, {
      action: 'update',
      resource: 'organisation.settings.numbering',
      recordId: Number(row.id),
      recordCode: docType,
      oldValues: before,
      newValues: row,
    });
  } else {
    const res = await client.query(
      `INSERT INTO document_numbering_rules
          (tenant_id, company_id, branch_id, doc_type, prefix, format, include_year,
           include_branch, include_department, pad, start_seq, suffix, reset_frequency,
           description, is_active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,true)
       RETURNING *`,
      [ctx.tenantId ?? null, companyId, branchId, docType, ...params.slice(0, 5), ...params.slice(5)]
    );
    row = res.rows[0];
    await logAudit(client, ctx, {
      action: 'create',
      resource: 'organisation.settings.numbering',
      recordId: Number(row.id),
      recordCode: docType,
      newValues: row,
    });
  }
  return toCamelRow(row);
}

export async function setNumberingRuleActive(
  client: pg.PoolClient,
  ctx: Ctx,
  id: number,
  active: boolean,
  reason?: string | null
) {
  const before = await getNumberingRule(client, ctx, id);
  if (before.isActive === false && active === false) return before;

  // Disabling is only safe while something else still resolves for the scope
  // this rule serves. A rule covers a document created at (company, branch)
  // when it is tenant-wide, company-wide, or branch-specific to that branch,
  // which is exactly the fallback order resolveNumberingRule() applies. The
  // guard therefore looks for another active rule that could still answer for
  // this rule's own scope, rather than only watching the tenant-wide row: a
  // company rule is just as load-bearing as a tenant-wide one for the company
  // that has no tenant-wide rule to fall back to.
  if (!active) {
    const remaining = await client.query(
      `SELECT count(*)::int AS n FROM document_numbering_rules
        WHERE tenant_id = $1 AND doc_type = $2 AND is_active = true AND id <> $3
          AND (company_id IS NOT DISTINCT FROM $4::bigint OR company_id IS NULL)
          AND (branch_id IS NOT DISTINCT FROM $5::bigint OR branch_id IS NULL)`,
      [ctx.tenantId ?? null, before.docType, id, before.companyId ?? null, before.branchId ?? null]
    );
    if (Number(remaining.rows[0].n) === 0) {
      throw badRequest(
        'Refusing to disable the only active rule for ' + before.docType +
        ' in this scope - document creation would fail with no rule to fall back to'
      );
    }
  }

  const res = await client.query(
    'UPDATE document_numbering_rules SET is_active = $3, updated_at = now() WHERE id = $1 AND tenant_id = $2 RETURNING *',
    [id, ctx.tenantId ?? null, active]
  );
  if (res.rows.length === 0) throw notFound('Numbering rule not found');
  await logAudit(client, ctx, {
    action: active ? 'activate' : 'deactivate',
    resource: 'organisation.settings.numbering',
    recordId: id,
    recordCode: String(before.docType),
    oldValues: { isActive: before.isActive },
    newValues: { isActive: active },
    metadata: { reason: reason ?? null },
  });
  return toCamelRow(res.rows[0]);
}

// ---------------------------------------------------------------------------
// Sequences
// ---------------------------------------------------------------------------

/** What the next number would be. Consumes nothing, so it is safe in a UI. */
export function previewSequence(client: pg.PoolClient, ctx: Ctx, docType: string) {
  return previewDocNo(client, ctx, normaliseDocType(docType));
}

/**
 * Consume the next number. Caller must already be inside a transaction - the
 * counter's correctness depends on the surrounding transaction rolling back
 * with whatever document it was allocated for.
 */
export function allocateSequence(client: pg.PoolClient, ctx: Ctx, docType: string) {
  return allocateDocNo(client, ctx, normaliseDocType(docType));
}

/** Live counters, resolved back to a document number for legibility. */
export async function listSequences(client: pg.PoolClient, ctx: Ctx, limit = 200) {
  const res = await client.query(
    `SELECT * FROM number_sequences
      WHERE tenant_id = $1
      ORDER BY updated_at DESC
      LIMIT $2`,
    [ctx.tenantId ?? null, Math.min(Math.max(Number(limit) || 200, 1), 1000)]
  );
  const rows = toCamelRows(res.rows);
  return rows.map((r: Record<string, unknown>) => ({
    ...r,
    nextSeq: Number(r.lastSeq ?? 0) + 1,
  }));
}

/**
 * Reset a counter so the next allocation returns a chosen number.
 *
 * This is the one genuinely destructive operation in the module: it can hand
 * out a number that a document already holds. It is therefore reason-gated,
 * audited, and it refuses to reset below the current value unless the caller
 * explicitly says that is what they want.
 */
export async function resetSequence(
  client: pg.PoolClient,
  ctx: Ctx,
  docType: string,
  input: { reason?: string | null; nextSeq?: number | null; toStart?: boolean; force?: boolean }
) {
  const type = normaliseDocType(docType);
  const reason = text(input.reason);
  if (!reason) throw badRequest('A reason is required to reset a number sequence');

  const rule = await resolveNumberingRule(client, ctx, type);
  if (!rule) throw notFound('No active numbering rule configured for ' + type);

  const key = resetKeyFor(type, ctx.companyId, ctx.branchId, rule.resetFrequency, new Date().getFullYear());
  const { seqKey, docYear } = key;

  // Lock the counter row for the rest of the transaction so a concurrent
  // allocation cannot slip between the read and the write below.
  const seqRow = await client.query(
    'SELECT * FROM number_sequences WHERE tenant_id = $1 AND seq_key = $2 AND doc_year = $3 FOR UPDATE',
    [ctx.tenantId ?? null, seqKey, docYear]
  );

  const current = seqRow.rows.length > 0 ? Number(seqRow.rows[0].last_seq) : 0;
  let target: number;
  if (input.toStart === true) {
    target = rule.startSeq - 1;
  } else if (input.nextSeq != null) {
    const n = Number(input.nextSeq);
    if (!Number.isFinite(n) || n < 1) throw badRequest('nextSeq must be a positive number');
    target = Math.trunc(n) - 1;
  } else {
    throw badRequest('Provide nextSeq, or toStart to return to the rule start');
  }

  if (target < current && input.force !== true) {
    throw badRequest(
      'Resetting to ' + (target + 1) + ' would re-issue numbers already used up to ' + current +
      '. Pass force to confirm, and state the reason.'
    );
  }

  const res = await client.query(
    `INSERT INTO number_sequences (tenant_id, seq_key, doc_year, last_seq)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (tenant_id, seq_key, doc_year)
     DO UPDATE SET last_seq = $4, updated_at = now()
     RETURNING *`,
    [ctx.tenantId ?? null, seqKey, docYear, target]
  );

  await logAudit(client, ctx, {
    action: 'reset',
    resource: 'organisation.settings.numbering',
    recordId: rule.id ?? null,
    recordCode: type,
    oldValues: { lastSeq: current },
    newValues: { lastSeq: target, nextSeq: target + 1 },
    metadata: { reason, seqKey, docYear, forced: input.force === true },
  });

  return { ...toCamelRow(res.rows[0]), nextSeq: target + 1 };
}

/** Render what a rule would produce right now, without touching the counter. */
export async function renderSample(
  client: pg.PoolClient,
  ctx: Ctx,
  docType: string,
  seq?: number
) {
  const type = normaliseDocType(docType);
  const rule = await resolveNumberingRule(client, ctx, type);
  if (!rule) throw notFound('No active numbering rule configured for ' + type);
  const preview = await previewDocNo(client, ctx, type);
  const sample = seq == null ? preview.number : buildDocNo(rule, seq, {
    year: new Date().getFullYear(),
    month: new Date().getMonth() + 1,
    day: new Date().getDate(),
    companyCode: undefined,
    branchCode: undefined,
    departmentCode: undefined,
  });
  return { docType: type, next: preview.number, sample, rule };
}

/**
 * Seed the prefixes the spec names, but only where nothing is configured.
 * Idempotent, so it can run on every startup without disturbing edits.
 */
export async function seedMissingNumberingRules(client: pg.PoolClient, ctx: Ctx) {
  const created: string[] = [];
  for (const preset of NUMBERING_PRESETS) {
    const found = await client.query(
      `SELECT id FROM document_numbering_rules
        WHERE tenant_id = $1 AND doc_type = $2
          AND COALESCE(company_id,0) = COALESCE($3::int,0) AND branch_id IS NULL`,
      [ctx.tenantId ?? null, preset.docType, ctx.companyId ?? null]
    );
    if (found.rows.length > 0) continue;
    await upsertNumberingRule(client, ctx, {
      docType: preset.docType,
      prefix: preset.prefix,
      format: preset.format,
      resetFrequency: 'YEAR',
      pad: 6,
    });
    created.push(preset.docType);
  }
  return { created };
}
