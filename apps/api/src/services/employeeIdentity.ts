import pg from 'pg';
import { randomBytes } from 'node:crypto';
import { Ctx } from '../db.js';
import { badRequest, notFound, toCamelRow, toCamelRows, toISODate } from '../utils.js';
import { emitEvent } from './events.js';
import { logAudit } from './audit.js';
import { generateQr } from './qr.js';

const TERMINAL_STATUSES = ['TERMINATED', 'RESIGNED', 'RETIRED', 'ARCHIVED'];

function requireCompany(ctx: Ctx) {
  if (!ctx.companyId) throw badRequest('Company context required');
}

async function loadEmployeeForUpdate(client: pg.PoolClient, ctx: Ctx, employeeId: number) {
  const res = await client.query(
    `SELECT e.*, d.name AS department_name, b.name AS branch_name, pos.title AS position_title
       FROM employees e
       LEFT JOIN departments d ON d.id = e.department_id
       LEFT JOIN branches b ON b.id = e.branch_id
       LEFT JOIN positions pos ON pos.id = e.position_id
      WHERE e.id = $1 AND e.tenant_id = $2 AND e.company_id = $3
      FOR UPDATE OF e`,
    [employeeId, ctx.tenantId, ctx.companyId]
  );
  if (res.rows.length === 0) throw notFound('Employee not found');
  return res.rows[0];
}

/** Lock (creating if missing) the per-year ID sequence for a sequence type. */
async function lockSequence(
  client: pg.PoolClient,
  ctx: Ctx,
  seqType: 'OFFICIAL' | 'SHORT',
  year: number
) {
  const prefix = seqType === 'OFFICIAL' ? 'HDG-EMP' : 'HDG';
  const pad = seqType === 'OFFICIAL' ? 6 : 4;
  const format = seqType === 'OFFICIAL' ? '{PREFIX}-{YEAR}-{SEQUENCE}' : 'HDG{YY}{SEQUENCE}';
  await client.query(
    `INSERT INTO employee_id_sequences (tenant_id, company_id, seq_type, doc_year, prefix, pad, format)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (tenant_id, company_id, seq_type, doc_year) DO NOTHING`,
    [ctx.tenantId, ctx.companyId, seqType, year, prefix, pad, format]
  );
  const res = await client.query(
    `SELECT * FROM employee_id_sequences
      WHERE tenant_id = $1 AND company_id = $2 AND seq_type = $3 AND doc_year = $4
      FOR UPDATE`,
    [ctx.tenantId, ctx.companyId, seqType, year]
  );
  return res.rows[0];
}

export async function generateEmployeeId(
  client: pg.PoolClient,
  ctx: Ctx,
  input: { employeeId: number }
) {
  requireCompany(ctx);
  const emp = await loadEmployeeForUpdate(client, ctx, input.employeeId);
  if (emp.employee_number && emp.short_employee_number) {
    return {
      employeeId: Number(emp.id),
      official: String(emp.employee_number),
      short: String(emp.short_employee_number),
      alreadyGenerated: true,
    };
  }
  if (TERMINAL_STATUSES.includes(String(emp.status))) {
    throw badRequest(`Cannot generate an ID for an employee with status ${emp.status}`);
  }
  const year = new Date().getFullYear();
  const officialSeq = await lockSequence(client, ctx, 'OFFICIAL', year);
  const shortSeq = await lockSequence(client, ctx, 'SHORT', year);

  const nextOfficial = Number(officialSeq.current_sequence) + 1;
  const nextShort = Number(shortSeq.current_sequence) + 1;
  const official = `${officialSeq.prefix}-${year}-${String(nextOfficial).padStart(Number(officialSeq.pad), '0')}`;
  const short = `HDG${String(year).slice(2)}${String(nextShort).padStart(Number(shortSeq.pad), '0')}`;

  await client.query(
    `UPDATE employee_id_sequences SET current_sequence = $1 WHERE id = $2`,
    [nextOfficial, officialSeq.id]
  );
  await client.query(
    `UPDATE employee_id_sequences SET current_sequence = $1 WHERE id = $2`,
    [nextShort, shortSeq.id]
  );

  await client.query(
    `UPDATE employees SET employee_number = $1, short_employee_number = $2 WHERE id = $3`,
    [official, short, emp.id]
  );

  await client.query(
    `INSERT INTO employee_identities (tenant_id, company_id, employee_id, identity_type, identity_number, status, issued_by, metadata)
     VALUES ($1,$2,$3,'OFFICIAL_EMPLOYEE_ID',$4,'ACTIVE',$5,'{"source":"generated"}'::jsonb)`,
    [ctx.tenantId, ctx.companyId, emp.id, official, ctx.userId ?? null]
  );
  await client.query(
    `INSERT INTO employee_identities (tenant_id, company_id, employee_id, identity_type, identity_number, status, issued_by, metadata)
     VALUES ($1,$2,$3,'SHORT_BADGE_ID',$4,'ACTIVE',$5,'{"source":"generated"}'::jsonb)`,
    [ctx.tenantId, ctx.companyId, emp.id, short, ctx.userId ?? null]
  );

  // Initial HIRE assignment (only when the employee has no assignment history yet).
  const existing = await client.query(
    `SELECT 1 FROM employee_assignments WHERE employee_id = $1 LIMIT 1`,
    [emp.id]
  );
  if (existing.rows.length === 0) {
    const effFrom = toISODate(emp.hire_date) ?? new Date().toISOString().slice(0, 10);
    await client.query(
      `INSERT INTO employee_assignments
         (tenant_id, company_id, employee_id, branch_id, department_id, position_id, position, assignment_type, effective_from, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'HIRE',$8,$9)`,
      [ctx.tenantId, ctx.companyId, emp.id, emp.branch_id ?? null, emp.department_id ?? null, emp.position_id ?? null, emp.position ?? null, effFrom, ctx.userId ?? null]
    );
  }

  await logAudit(client, ctx, {
    action: 'generate',
    resource: 'employee_identities',
    recordId: Number(emp.id),
    recordCode: official,
    newValues: { official, short, year },
  });
  await emitEvent(client, ctx, {
    eventType: 'hr.employee_id_generated',
    entityType: 'employees',
    entityId: Number(emp.id),
    entityCode: official,
    payload: { official, short, year },
  });
  return { employeeId: Number(emp.id), official, short, alreadyGenerated: false };
}

export async function identityDashboard(client: pg.PoolClient, ctx: Ctx) {
  requireCompany(ctx);
  const agg = await client.query(
    `SELECT
       (SELECT count(*)::int FROM employees WHERE tenant_id=$1 AND company_id=$2) AS total_employees,
       (SELECT count(*)::int FROM employees WHERE tenant_id=$1 AND company_id=$2 AND status IN ('ACTIVE','PROBATION','ON_LEAVE')) AS active_employees,
       (SELECT count(*)::int FROM employees WHERE tenant_id=$1 AND company_id=$2 AND employee_number IS NULL) AS pending_ids,
       (SELECT count(*)::int FROM employee_id_cards WHERE tenant_id=$1 AND company_id=$2 AND status='ACTIVE' AND expiry_date <= (CURRENT_DATE + 60)) AS cards_expiring_60,
       (SELECT count(*)::int FROM employee_id_cards WHERE tenant_id=$1 AND company_id=$2 AND status IN ('LOST','DAMAGED')) AS lost_damaged_cards,
       (SELECT count(*)::int FROM employee_id_cards WHERE tenant_id=$1 AND company_id=$2 AND status='DRAFT') AS pending_cards,
       (SELECT count(*)::int FROM employee_identities WHERE tenant_id=$1 AND company_id=$2 AND identity_type='OFFICIAL_EMPLOYEE_ID' AND issued_at >= date_trunc('month', now())) AS new_ids_this_month`,
    [ctx.tenantId, ctx.companyId]
  );
  const recent = await client.query(
    `SELECT e.id, e.employee_number, e.short_employee_number, e.first_name, e.last_name, e.status,
            e.position, d.name AS department_name, b.name AS branch_name, e.updated_at
       FROM employees e
       LEFT JOIN departments d ON d.id = e.department_id
       LEFT JOIN branches b ON b.id = e.branch_id
      WHERE e.tenant_id=$1 AND e.company_id=$2 AND e.employee_number IS NOT NULL
      ORDER BY e.updated_at DESC, e.id DESC
      LIMIT 10`,
    [ctx.tenantId, ctx.companyId]
  );
  return { ...toCamelRow(agg.rows[0]), recent: toCamelRows(recent.rows) };
}

export async function listIdentities(
  client: pg.PoolClient,
  ctx: Ctx,
  filters: { q?: string; status?: string; page?: number; pageSize?: number }
) {
  requireCompany(ctx);
  const page = Math.max(1, filters.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, filters.pageSize ?? 40));
  const params: unknown[] = [ctx.tenantId, ctx.companyId];
  const where = ['e.tenant_id = $1', 'e.company_id = $2'];
  if (filters.q?.trim()) {
    params.push(`%${filters.q.trim()}%`);
    const n = params.length;
    where.push(
      `(e.employee_number ILIKE $${n} OR e.short_employee_number ILIKE $${n} OR e.employee_no ILIKE $${n}
        OR e.first_name ILIKE $${n} OR e.last_name ILIKE $${n} OR e.email ILIKE $${n} OR e.phone ILIKE $${n})`
    );
  }
  if (filters.status) {
    params.push(filters.status);
    where.push(`e.status = $${params.length}`);
  }
  params.push(pageSize, (page - 1) * pageSize);
  const rows = await client.query(
    `SELECT e.id, e.employee_number, e.short_employee_number, e.employee_no, e.first_name, e.last_name,
            e.status, e.position, e.email, e.phone, e.hire_date, e.updated_at,
            d.name AS department_name, b.name AS branch_name,
            (SELECT count(*)::int FROM employee_id_cards c WHERE c.employee_id = e.id AND c.status='ACTIVE') AS active_cards,
            (SELECT count(*)::int FROM employee_identities i WHERE i.employee_id = e.id AND i.identity_type='QR_IDENTITY' AND i.status <> 'REVOKED') AS has_qr
       FROM employees e
       LEFT JOIN departments d ON d.id = e.department_id
       LEFT JOIN branches b ON b.id = e.branch_id
      WHERE ${where.join(' AND ')}
      ORDER BY e.updated_at DESC, e.id DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  const countParams = params.slice(0, params.length - 2);
  const countRes = await client.query(
    `SELECT count(*)::int AS total FROM employees e WHERE ${where.join(' AND ')}`,
    countParams
  );
  return {
    items: toCamelRows(rows.rows),
    total: Number(countRes.rows[0].total),
    page,
    pageSize,
  };
}

export async function getIdentity(client: pg.PoolClient, ctx: Ctx, employeeId: number) {
  requireCompany(ctx);
  const empRes = await client.query(
    `SELECT e.*, d.name AS department_name, b.name AS branch_name, pos.title AS position_title
       FROM employees e
       LEFT JOIN departments d ON d.id = e.department_id
       LEFT JOIN branches b ON b.id = e.branch_id
       LEFT JOIN positions pos ON pos.id = e.position_id
      WHERE e.id = $1 AND e.tenant_id = $2 AND e.company_id = $3`,
    [employeeId, ctx.tenantId, ctx.companyId]
  );
  if (empRes.rows.length === 0) throw notFound('Employee not found');
  const identities = await client.query(
    `SELECT i.*, u.first_name AS issued_by_name, u.last_name AS issued_by_last
       FROM employee_identities i
       LEFT JOIN users u ON u.id = i.issued_by
      WHERE i.employee_id = $1
      ORDER BY i.identity_type, i.created_at DESC`,
    [employeeId]
  );
  const cards = await client.query(
    `SELECT c.*, q.code AS qr_code, u.first_name AS issued_by_name, u.last_name AS issued_by_last
       FROM employee_id_cards c
       LEFT JOIN qr_codes q ON q.id = c.qr_id
       LEFT JOIN users u ON u.id = c.issued_by
      WHERE c.employee_id = $1
      ORDER BY c.created_at DESC`,
    [employeeId]
  );
  const assignments = await client.query(
    `SELECT a.*, d.name AS department_name, b.name AS branch_name, pos.title AS position_title,
            u.first_name AS created_by_name, u.last_name AS created_by_last
       FROM employee_assignments a
       LEFT JOIN departments d ON d.id = a.department_id
       LEFT JOIN branches b ON b.id = a.branch_id
       LEFT JOIN positions pos ON pos.id = a.position_id
       LEFT JOIN users u ON u.id = a.created_by
      WHERE a.employee_id = $1
      ORDER BY a.effective_from DESC, a.id DESC`,
    [employeeId]
  );
  return {
    employee: toCamelRow(empRes.rows[0]),
    identities: toCamelRows(identities.rows),
    cards: toCamelRows(cards.rows),
    assignments: toCamelRows(assignments.rows),
  };
}

async function nextCardNo(client: pg.PoolClient, ctx: Ctx): Promise<string> {
  const res = await client.query('SELECT next_doc_no($1,$2,6) AS code', [ctx.tenantId, 'ECARD']);
  return String(res.rows[0].code);
}

export async function generateEmployeeCard(
  client: pg.PoolClient,
  ctx: Ctx,
  input: { employeeId: number; serialNumber?: string | null }
) {
  requireCompany(ctx);
  const emp = await loadEmployeeForUpdate(client, ctx, input.employeeId);
  if (!emp.employee_number) throw badRequest('Generate the official employee ID first');
  if (TERMINAL_STATUSES.includes(String(emp.status))) {
    throw badRequest(`Cannot generate a card for an employee with status ${emp.status}`);
  }
  const cardNo = await nextCardNo(client, ctx);
  const serial = input.serialNumber?.trim() || randomBytes(5).toString('hex').toUpperCase();
  const ins = await client.query(
    `INSERT INTO employee_id_cards (tenant_id, company_id, employee_id, card_no, serial_number, status)
     VALUES ($1,$2,$3,$4,$5,'DRAFT') RETURNING *`,
    [ctx.tenantId, ctx.companyId, emp.id, cardNo, serial]
  );
  const card = ins.rows[0];
  await logAudit(client, ctx, {
    action: 'card_generate',
    resource: 'employee_id_cards',
    recordId: Number(card.id),
    recordCode: cardNo,
    newValues: { employeeId: Number(emp.id), serialNumber: serial },
  });
  await emitEvent(client, ctx, {
    eventType: 'hr.employee_card_generated',
    entityType: 'employee_id_cards',
    entityId: Number(card.id),
    entityCode: cardNo,
    payload: { employeeId: Number(emp.id), serialNumber: serial },
  });
  return toCamelRow(card);
}

export async function issueEmployeeCard(client: pg.PoolClient, ctx: Ctx, cardId: number) {
  requireCompany(ctx);
  const res = await client.query(
    `SELECT * FROM employee_id_cards WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
    [cardId, ctx.tenantId]
  );
  if (res.rows.length === 0) throw notFound('Card not found');
  const card = res.rows[0];
  if (card.status !== 'DRAFT') throw badRequest(`Only draft cards can be issued (current: ${card.status})`);

  const official = await client.query(
    `SELECT id FROM employee_identities
      WHERE employee_id = $1 AND identity_type = 'OFFICIAL_EMPLOYEE_ID' AND status <> 'REVOKED'
      ORDER BY created_at DESC LIMIT 1`,
    [card.employee_id]
  );
  // Supersede any other active card for the same employee.
  await client.query(
    `UPDATE employee_id_cards SET status = 'REPLACED', replaced_by_card_id = $1
      WHERE employee_id = $2 AND status = 'ACTIVE' AND id <> $1`,
    [card.id, card.employee_id]
  );
  const upd = await client.query(
    `UPDATE employee_id_cards
        SET status = 'ACTIVE', issue_date = CURRENT_DATE,
            expiry_date = CURRENT_DATE + INTERVAL '3 years',
            issued_at = now(), issued_by = $2, identity_id = $3
      WHERE id = $1 RETURNING *`,
    [card.id, ctx.userId ?? null, official.rows[0]?.id ?? null]
  );
  await logAudit(client, ctx, {
    action: 'card_issue',
    resource: 'employee_id_cards',
    recordId: Number(card.id),
    recordCode: String(card.card_no),
    newValues: { status: 'ACTIVE', issuedBy: ctx.userId },
  });
  await emitEvent(client, ctx, {
    eventType: 'hr.employee_card_issued',
    entityType: 'employee_id_cards',
    entityId: Number(card.id),
    entityCode: String(card.card_no),
    payload: { employeeId: Number(card.employee_id) },
  });
  return toCamelRow(upd.rows[0]);
}

export async function replaceEmployeeCard(
  client: pg.PoolClient,
  ctx: Ctx,
  cardId: number,
  reason?: string
) {
  requireCompany(ctx);
  const res = await client.query(
    `SELECT * FROM employee_id_cards WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
    [cardId, ctx.tenantId]
  );
  if (res.rows.length === 0) throw notFound('Card not found');
  const oldCard = res.rows[0];
  if (!['ACTIVE', 'LOST', 'DAMAGED', 'SUSPENDED', 'EXPIRED'].includes(String(oldCard.status))) {
    throw badRequest(`Card status ${oldCard.status} cannot be replaced`);
  }

  const emp = await loadEmployeeForUpdate(client, ctx, Number(oldCard.employee_id));
  if (!emp.employee_number) throw badRequest('Generate the official employee ID first');
  const cardNo = await nextCardNo(client, ctx);
  const serial = randomBytes(5).toString('hex').toUpperCase();
  const newRes = await client.query(
    `INSERT INTO employee_id_cards
       (tenant_id, company_id, employee_id, card_no, serial_number, status, issue_date, expiry_date, issued_at, issued_by, status_reason, metadata)
     VALUES ($1,$2,$3,$4,$5,'ACTIVE',CURRENT_DATE, CURRENT_DATE + INTERVAL '3 years', now(), $6,$7,
             jsonb_build_object('replacedCardId', $8::bigint, 'reason', COALESCE($7::text,'')))
     RETURNING *`,
    [ctx.tenantId, ctx.companyId, emp.id, cardNo, serial, ctx.userId ?? null, reason ?? null, oldCard.id]
  );
  const newCard = newRes.rows[0];
  await client.query(
    `UPDATE employee_id_cards SET status = 'VOID', status_reason = $1, replaced_by_card_id = $2 WHERE id = $3`,
    [reason ?? 'Replaced', newCard.id, oldCard.id]
  );
  await logAudit(client, ctx, {
    action: 'card_replace',
    resource: 'employee_id_cards',
    recordId: Number(oldCard.id),
    recordCode: String(oldCard.card_no),
    oldValues: { status: oldCard.status },
    newValues: { status: 'VOID', replacementCardId: Number(newCard.id), cardNo: cardNo, reason: reason ?? null },
  });
  await emitEvent(client, ctx, {
    eventType: 'hr.employee_card_replaced',
    entityType: 'employee_id_cards',
    entityId: Number(newCard.id),
    entityCode: cardNo,
    payload: { oldCardId: Number(oldCard.id), employeeId: Number(emp.id), reason: reason ?? null },
    severity: 'WARN',
  });
  return { oldCard: toCamelRow({ ...oldCard, status: 'VOID', replacedByCardId: Number(newCard.id) }), newCard: toCamelRow(newCard) };
}

export async function suspendEmployeeCard(
  client: pg.PoolClient,
  ctx: Ctx,
  cardId: number,
  reason?: string
) {
  return setCardStatus(client, ctx, cardId, 'SUSPENDED', reason);
}

export async function voidEmployeeCard(
  client: pg.PoolClient,
  ctx: Ctx,
  cardId: number,
  reason?: string
) {
  return setCardStatus(client, ctx, cardId, 'VOID', reason);
}

async function setCardStatus(
  client: pg.PoolClient,
  ctx: Ctx,
  cardId: number,
  status: 'SUSPENDED' | 'VOID',
  reason?: string
) {
  requireCompany(ctx);
  const res = await client.query(
    `SELECT * FROM employee_id_cards WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
    [cardId, ctx.tenantId]
  );
  if (res.rows.length === 0) throw notFound('Card not found');
  const card = res.rows[0];
  if (card.status === 'VOID') throw badRequest('A voided card cannot be changed');
  if (status === 'VOID' && card.status === 'VOID') throw badRequest('Card is already voided');
  const upd = await client.query(
    `UPDATE employee_id_cards SET status = $1, status_reason = $2 WHERE id = $3 RETURNING *`,
    [status, reason ?? null, card.id]
  );
  if (card.qr_id) {
    await client.query(
      `UPDATE qr_codes SET status = $1, status_reason = $2 WHERE id = $3`,
      [status === 'VOID' ? 'VOID' : 'SUSPENDED', reason ?? null, card.qr_id]
    );
  }
  await logAudit(client, ctx, {
    action: status === 'VOID' ? 'card_void' : 'card_suspend',
    resource: 'employee_id_cards',
    recordId: Number(card.id),
    recordCode: String(card.card_no),
    oldValues: { status: card.status },
    newValues: { status, reason: reason ?? null },
    metadata: { employeeId: Number(card.employee_id) },
  });
  await emitEvent(client, ctx, {
    eventType: status === 'VOID' ? 'hr.employee_card_voided' : 'hr.employee_card_suspended',
    entityType: 'employee_id_cards',
    entityId: Number(card.id),
    entityCode: String(card.card_no),
    payload: { employeeId: Number(card.employee_id), reason: reason ?? null },
    severity: 'WARN',
  });
  return toCamelRow(upd.rows[0]);
}

export async function generateEmployeeQr(
  client: pg.PoolClient,
  ctx: Ctx,
  input: { employeeId: number }
) {
  requireCompany(ctx);
  const emp = await loadEmployeeForUpdate(client, ctx, input.employeeId);
  if (!emp.employee_number) throw badRequest('Generate the official employee ID first');
  if (TERMINAL_STATUSES.includes(String(emp.status))) {
    throw badRequest(`Cannot generate a QR for an employee with status ${emp.status}`);
  }
  const existing = await client.query(
    `SELECT id, identity_number, metadata FROM employee_identities
      WHERE employee_id = $1 AND identity_type = 'QR_IDENTITY' AND status <> 'REVOKED'
      ORDER BY created_at DESC LIMIT 1`,
    [emp.id]
  );
  if (existing.rows.length > 0) {
    const row = existing.rows[0];
    return {
      employeeId: Number(emp.id),
      token: String(row.identity_number),
      qrId: row.metadata?.qrId != null ? Number(row.metadata.qrId) : null,
      qrCode: row.metadata?.qrCode != null ? String(row.metadata.qrCode) : null,
      alreadyGenerated: true,
    };
  }
  const token = randomBytes(18).toString('base64url');
  const qrs = await generateQr(client, ctx, { entityType: 'EMPLOYEE', entityId: Number(emp.id) });
  const qr = qrs[0];
  await client.query(
    `INSERT INTO employee_identities (tenant_id, company_id, employee_id, identity_type, identity_number, status, issued_by, metadata)
     VALUES ($1,$2,$3,'QR_IDENTITY',$4,'ACTIVE',$5, jsonb_build_object('qrId', $6::bigint, 'qrCode', $7::text, 'payload', $4::text))`,
    [ctx.tenantId, ctx.companyId, emp.id, token, ctx.userId ?? null, qr.id, qr.code]
  );
  await logAudit(client, ctx, {
    action: 'qr_generate',
    resource: 'employee_identities',
    recordId: Number(emp.id),
    recordCode: String(emp.employee_number),
    newValues: { identityType: 'QR_IDENTITY', qrCode: qr.code },
  });
  await emitEvent(client, ctx, {
    eventType: 'hr.employee_qr_generated',
    entityType: 'qr_codes',
    entityId: qr.id,
    entityCode: qr.code,
    payload: { employeeId: Number(emp.id), employeeNumber: emp.employee_number },
  });
  return { employeeId: Number(emp.id), token, qrId: qr.id, qrCode: qr.code, alreadyGenerated: false };
}

/** Internal operational QR scan: authenticates, records the scan, blocks suspended/terminated. */
export async function scanEmployeeQr(
  client: pg.PoolClient,
  ctx: Ctx,
  input: { token: string; location?: string | null }
) {
  requireCompany(ctx);
  const token = String(input.token ?? '').trim();
  if (!token) throw badRequest('QR token is required');
  const res = await client.query(
    `SELECT i.*, e.id AS employee_id, e.first_name, e.last_name, e.status AS employee_status,
            e.employee_number, e.position, e.department_id, d.name AS department_name,
            b.name AS branch_name
       FROM employee_identities i
       JOIN employees e ON e.id = i.employee_id
       LEFT JOIN departments d ON d.id = e.department_id
       LEFT JOIN branches b ON b.id = e.branch_id
      WHERE i.identity_type = 'QR_IDENTITY' AND i.identity_number = $1 AND i.tenant_id = $2`,
    [token, ctx.tenantId]
  );
  if (res.rows.length === 0) throw notFound('Employee QR identity not found');
  const row = res.rows[0];
  let result = 'VERIFIED';
  if (String(row.status) !== 'ACTIVE') result = 'INACTIVE';
  else if (row.expires_at && new Date(row.expires_at) < new Date()) result = 'EXPIRED';
  else if (String(row.employee_status) === 'TERMINATED' || String(row.employee_status) === 'RESIGNED' || String(row.employee_status) === 'RETIRED') result = 'INACTIVE';
  else if (String(row.employee_status) === 'SUSPENDED') result = 'SUSPENDED';

  const scanResult = result === 'VERIFIED' ? 'AUTHENTIC' : 'SUSPICIOUS';
  const scanRes = await client.query(
    `INSERT INTO qr_scans
       (company_id, tenant_id, qr_id, payload, scan_type, action, result, verified, ip, user_agent, device, location, scanned_by, metadata)
     VALUES ($1,$2,$3,$4,'INTERNAL','VERIFY',$5,$6,$7,$8,$9,$10,$11, jsonb_build_object('identity_type','EMPLOYEE','employee_result', $12::text))
     RETURNING id`,
    [
      row.company_id,
      row.tenant_id,
      row.metadata?.qrId != null ? Number(row.metadata.qrId) : null,
      token,
      scanResult,
      result === 'VERIFIED',
      ctx.ip ?? null,
      ctx.userAgent ?? null,
      ctx.device ?? null,
      input.location ?? null,
      ctx.userId ?? null,
      result,
    ]
  );
  const scanId = Number(scanRes.rows[0].id);
  if (row.metadata?.qrId != null) {
    await client.query(
      `UPDATE qr_codes SET last_scan_at = now(), scan_count = scan_count + 1 WHERE id = $1`,
      [Number(row.metadata.qrId)]
    );
  }
  await emitEvent(client, ctx, {
    eventType: 'hr.employee_qr_scanned',
    entityType: 'employee_identities',
    entityId: Number(row.id),
    entityCode: String(row.identity_number),
    payload: { result, employeeId: Number(row.employee_id) },
  });
  return {
    result,
    verified: result === 'VERIFIED',
    scanId,
    employeeId: Number(row.employee_id),
    employeeNumber: row.employee_number,
    name: String(row.first_name ?? '') && String(row.last_name ?? '')
      ? `${row.first_name} ${row.last_name}`
      : null,
    department: row.department_name ?? '',
    position: row.position ?? '',
    status: result === 'VERIFIED' ? row.employee_status : undefined,
  };
}

export async function createAssignment(
  client: pg.PoolClient,
  ctx: Ctx,
  input: {
    employeeId: number;
    assignmentType?: string;
    branchId?: number | null;
    departmentId?: number | null;
    positionId?: number | null;
    position?: string | null;
    effectiveFrom?: string | null;
    reason?: string | null;
  }
) {
  requireCompany(ctx);
  const emp = await loadEmployeeForUpdate(client, ctx, input.employeeId);
  if (TERMINAL_STATUSES.includes(String(emp.status))) {
    throw badRequest(`Cannot reassign an employee with status ${emp.status}`);
  }
  const assignmentType = input.assignmentType && ['HIRE', 'TRANSFER', 'PROMOTION', 'DEMOTION', 'SECONDMENT', 'REASSIGNMENT'].includes(String(input.assignmentType))
    ? String(input.assignmentType)
    : 'TRANSFER';
  const effectiveFrom = toISODate(input.effectiveFrom) ?? new Date().toISOString().slice(0, 10);

  let position = input.position?.trim() || emp.position || null;
  let positionId = input.positionId ?? emp.position_id ?? null;
  if (positionId) {
    const pos = await client.query('SELECT id, title FROM positions WHERE id = $1 AND tenant_id = $2', [positionId, ctx.tenantId]);
    if (pos.rows.length > 0) {
      position = pos.rows[0].title;
    }
  }

  await client.query(
    `UPDATE employee_assignments SET effective_to = $1::date - 1
      WHERE employee_id = $2 AND effective_to IS NULL`,
    [effectiveFrom, emp.id]
  );
  const ins = await client.query(
    `INSERT INTO employee_assignments
       (tenant_id, company_id, employee_id, branch_id, department_id, position_id, position, assignment_type, effective_from, reason, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [
      ctx.tenantId, ctx.companyId, emp.id,
      input.branchId ?? emp.branch_id ?? null,
      input.departmentId ?? emp.department_id ?? null,
      positionId,
      position,
      assignmentType,
      effectiveFrom,
      input.reason ?? null,
      ctx.userId ?? null,
    ]
  );
  await client.query(
    `UPDATE employees SET branch_id = $1, department_id = $2, position_id = $3, position = $4 WHERE id = $5`,
    [input.branchId ?? emp.branch_id ?? null, input.departmentId ?? emp.department_id ?? null, positionId, position, emp.id]
  );
  const row = ins.rows[0];
  await logAudit(client, ctx, {
    action: 'assignment_create',
    resource: 'employee_assignments',
    recordId: Number(row.id),
    recordCode: String(emp.employee_number ?? emp.employee_no),
    newValues: {
      assignmentType,
      branchId: row.branch_id,
      departmentId: row.department_id,
      positionId: row.position_id,
      position,
      effectiveFrom,
      reason: input.reason ?? null,
    },
  });
  await emitEvent(client, ctx, {
    eventType: 'hr.employee_assignment_created',
    entityType: 'employee_assignments',
    entityId: Number(row.id),
    entityCode: String(emp.employee_number ?? emp.employee_no),
    payload: { employeeId: Number(emp.id), assignmentType, effectiveFrom },
  });
  return toCamelRow(row);
}

/** Public, unauthenticated QR verification - safe data only (SECURITY DEFINER). */
export async function verifyEmployeePublic(token: string, ip?: string, userAgent?: string, device?: string) {
  const { query } = await import('../db.js');
  const res = await query('SELECT verify_employee_public($1,$2,$3,$4) AS result', [token, ip ?? null, userAgent ?? null, device ?? null]);
  return res.rows[0].result;
}
