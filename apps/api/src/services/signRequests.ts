import pg from 'pg';
import { createHash, randomBytes } from 'node:crypto';
import { Ctx, query } from '../db.js';
import { config } from '../config.js';
import { badRequest, conflict, forbidden, notFound, toCamelRow, toCamelRows } from '../utils.js';
import { logAudit } from './audit.js';
import { notifyUsers } from './communication.js';
import path from 'node:path';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';

const num = (v: unknown): number | null =>
  v === null || v === undefined || v === '' ? null : Number(v);
const str = (v: unknown): string | null =>
  v === null || v === undefined ? null : String(v);

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function makeSignToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: sha256Hex(token) };
}

const REQUEST_ACTIVE = new Set(['SENT', 'PARTIALLY_SIGNED']);
const SIGNER_PENDING = new Set(['SENT', 'VIEWED']);

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

async function defaultCompanyId(client: pg.PoolClient, ctx: Ctx): Promise<number | null> {
  if (ctx.companyId) return ctx.companyId;
  const { rows } = await client.query(
    'SELECT id FROM companies WHERE tenant_id = $1 ORDER BY id ASC LIMIT 1',
    [ctx.tenantId]
  );
  return rows.length ? Number(rows[0].id) : null;
}

interface RequestRow {
  id: number;
  tenant_id: number;
  company_id: number;
  code: string;
  status: string;
  signature_order: string;
  file_name: string | null;
  mime_type: string | null;
  storage_key: string | null;
  title: string;
  message: string | null;
  expires_at: Date | null;
  [k: string]: unknown;
}

async function getRequest(
  client: pg.PoolClient,
  ctx: Ctx,
  id: number,
  forUpdate = false
): Promise<RequestRow> {
  const lock = forUpdate ? ' FOR UPDATE' : '';
  const { rows } = await client.query(
    'SELECT * FROM sign_requests WHERE id = $1 AND tenant_id = $2' + lock,
    [id, ctx.tenantId]
  );
  if (rows.length === 0) throw notFound('Sign request not found');
  return rows[0] as RequestRow;
}

async function audit(
  client: pg.PoolClient,
  ctx: Ctx,
  entry: {
    action: string; resource: string; recordId: number; recordCode?: string | null;
    oldValues?: Record<string, unknown>; newValues?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
  }
): Promise<void> {
  await logAudit(client, ctx, {
    action: entry.action,
    resource: entry.resource,
    recordId: entry.recordId,
    recordCode: entry.recordCode ?? null,
    oldValues: entry.oldValues ?? null,
    newValues: entry.newValues ?? null,
    metadata: entry.metadata ?? {},
  });
}

// Recompute the envelope status from its signers. Idempotent; safe to call
// after any signer transition. REFUSED / REVOKED are terminal and left alone.
async function recomputeRequestStatus(client: pg.PoolClient, requestId: number): Promise<void> {
  await client.query(
    `UPDATE sign_requests SET
       status = CASE
         WHEN status IN ('REFUSED','REVOKED') THEN status
         WHEN NOT EXISTS (
           SELECT 1 FROM sign_request_signers
            WHERE sign_request_id = $1 AND status <> 'SIGNED'
         ) THEN 'COMPLETED'
         ELSE 'PARTIALLY_SIGNED'
       END,
       completed_at = CASE
         WHEN status IN ('REFUSED','REVOKED') THEN completed_at
         WHEN NOT EXISTS (
           SELECT 1 FROM sign_request_signers
            WHERE sign_request_id = $1 AND status <> 'SIGNED'
         ) THEN now()
         ELSE completed_at
       END,
       updated_at = now()
     WHERE id = $1`,
    [requestId]
  );
}

// Sanitise a file name to a safe basename and validate the extension against
// the declared MIME type so the stored path can never carry traversal.
function safeStorageName(fileName: string, mimeType: string): string {
  const base = path.basename(String(fileName).replace(/\\/g, '/')).replace(/[^\w.\- ]+/g, '_').trim();
  const fallback = 'document.pdf';
  if (!base || base === '.' || base === '..') return fallback;
  const ext = path.extname(base).toLowerCase();
  if (!ext) {
    if (mimeType === 'application/pdf') return base + '.pdf';
    if (mimeType === 'image/png') return base + '.png';
    if (mimeType === 'image/jpeg') return base + '.jpg';
    return base;
  }
  return base;
}

function writeDocument(
  requestId: number,
  tenantId: number,
  doc: { name?: unknown; mimeType?: unknown; dataUrl?: unknown }
): { fileName: string; mimeType: string; storageKey: string; size: number } | null {
  const dataUrl = str(doc.dataUrl);
  if (!dataUrl) return null;
  const m = /^data:([^;]+);base64,(.*)$/s.exec(dataUrl.trim());
  if (!m) throw badRequest('document.dataUrl must be a base64 data URL');
  const declaredMime = String(doc.mimeType ?? m[1] ?? 'application/octet-stream');
  const fileName = safeStorageName(str(doc.name) ?? 'document', declaredMime);
  const bytes = Buffer.from(m[2], 'base64');
  const rel = path.posix.join('sign', String(tenantId), String(requestId), fileName);
  const abs = path.resolve(config.storageRoot, rel.split('/').join(path.sep));
  const root = path.resolve(config.storageRoot);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw badRequest('Document storage path is invalid');
  }
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, bytes);
  return { fileName, mimeType: declaredMime, storageKey: rel, size: bytes.length };
}

function resolveStoredFile(storageKey: string | null): { abs: string; ok: boolean } {
  if (!storageKey) return { abs: '', ok: false };
  const rel = String(storageKey).replace(/\\/g, '/');
  const root = path.resolve(config.storageRoot);
  const abs = path.resolve(root, rel.split('/').join(path.sep));
  if (abs !== root && !abs.startsWith(root + path.sep)) return { abs: '', ok: false };
  return { abs, ok: existsSync(abs) };
}

interface SignerInput {
  signerType?: unknown;
  signerUserId?: unknown;
  signerName?: unknown;
  signerEmail?: unknown;
  orderIndex?: unknown;
}

// ---------------------------------------------------------------------------
// List / detail
// ---------------------------------------------------------------------------

export async function listSignRequests(
  client: pg.PoolClient,
  ctx: Ctx,
  opts: { status?: string | null } = {}
): Promise<Record<string, unknown>[]> {
  const params: unknown[] = [ctx.tenantId];
  const conds = ['r.tenant_id = $1'];
  let i = 2;
  if (ctx.companyId) { conds.push('r.company_id = $' + i); params.push(ctx.companyId); i += 1; }
  if (opts.status) { conds.push('r.status = $' + i); params.push(opts.status); i += 1; }
  const { rows } = await client.query(
    `SELECT r.*,
       cu.first_name AS creator_first_name, cu.last_name AS creator_last_name,
       (SELECT count(*)::int FROM sign_request_signers s WHERE s.sign_request_id = r.id) AS signer_count,
       (SELECT count(*)::int FROM sign_request_signers s WHERE s.sign_request_id = r.id AND s.status = 'SIGNED') AS signed_count
       FROM sign_requests r
       LEFT JOIN users cu ON cu.id = r.created_by
      WHERE ${conds.join(' AND ')}
      ORDER BY r.id DESC LIMIT 200`,
    params
  );
  return toCamelRows(rows);
}

export async function getSignRequestDetail(client: pg.PoolClient, ctx: Ctx, id: number) {
  const r = await getRequest(client, ctx, id);
  const { rows } = await client.query(
    `SELECT s.*, u.first_name, u.last_name
       FROM sign_request_signers s
       LEFT JOIN users u ON u.id = s.signer_user_id
      WHERE s.sign_request_id = $1 AND s.tenant_id = $2
      ORDER BY s.order_index, s.id`,
    [id, ctx.tenantId]
  );
  const signers = toCamelRows(rows).map((s) => {
    const clean = { ...s };
    delete (clean as Record<string, unknown>).tokenHash;
    return clean;
  });
  return { request: toCamelRow(r), signers };
}

// ---------------------------------------------------------------------------
// Create / update / delete (DRAFT lifecycle)
// ---------------------------------------------------------------------------

async function resolveSigner(
  client: pg.PoolClient,
  ctx: Ctx,
  input: SignerInput,
  companyId: number
): Promise<{ type: string; userId: number | null; name: string; email: string | null }> {
  const type = str(input.signerType)?.toUpperCase() === 'EMPLOYEE' ? 'EMPLOYEE' : 'CONTACT';
  if (type === 'EMPLOYEE') {
    const uid = num(input.signerUserId);
    if (!uid) throw badRequest('signerUserId is required for an EMPLOYEE signer');
    const { rows } = await client.query(
      'SELECT id, first_name, last_name, email FROM users WHERE id = $1 AND tenant_id = $2',
      [uid, ctx.tenantId]
    );
    if (rows.length === 0) throw badRequest('Employee signer not found in this tenant');
    const name = (rows[0].first_name + ' ' + rows[0].last_name).trim();
    return { type, userId: Number(rows[0].id), name, email: rows[0].email ?? null };
  }
  const name = str(input.signerName);
  const email = str(input.signerEmail);
  if (!name || !name.trim()) throw badRequest('signerName is required for a CONTACT signer');
  if (!email || !email.trim()) throw badRequest('signerEmail is required for a CONTACT signer');
  return { type, userId: null, name: name.trim(), email: email.trim() };
}

export async function createSignRequest(
  client: pg.PoolClient,
  ctx: Ctx,
  body: Record<string, unknown>
) {
  const title = str(body.title);
  if (!title || !title.trim()) throw badRequest('title is required');
  const companyId = (await defaultCompanyId(client, ctx)) ?? num(body.companyId);
  if (!companyId) throw badRequest('A company scope is required');
  const order = str(body.signatureOrder)?.toUpperCase() === 'SEQUENTIAL' ? 'SEQUENTIAL' : 'ANY';
  const expiresRaw = str(body.expiresAt);
  const expiresAt = expiresRaw ? new Date(expiresRaw) : null;
  if (expiresRaw && Number.isNaN(expiresAt?.getTime())) throw badRequest('expiresAt must be a valid ISO timestamp');

  const { rows } = await client.query(
    `INSERT INTO sign_requests
       (tenant_id, company_id, branch_id, department_id, title, message, document_type,
        document_code, signature_order, expires_at, created_by, updated_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11)
     RETURNING *`,
    [
      ctx.tenantId, companyId, num(body.branchId), num(body.departmentId),
      title.trim(), str(body.message), str(body.documentType) ?? 'GENERAL',
      str(body.documentCode), order, expiresAt, ctx.userId,
    ]
  );
  const request = rows[0] as RequestRow;

  const signersIn = Array.isArray(body.signers) ? (body.signers as SignerInput[]) : [];
  if (signersIn.length > 0) {
    for (let idx = 0; idx < signersIn.length; idx++) {
      const resolved = await resolveSigner(client, ctx, signersIn[idx], companyId);
      await client.query(
        `INSERT INTO sign_request_signers
           (tenant_id, company_id, sign_request_id, signer_type, signer_user_id,
            signer_name, signer_email, order_index)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          ctx.tenantId, companyId, Number(request.id), resolved.type, resolved.userId,
          resolved.name, resolved.email, num(signersIn[idx].orderIndex) ?? idx,
        ]
      );
    }
  }

  if (body.document && typeof body.document === 'object') {
    const doc = writeDocument(Number(request.id), Number(ctx.tenantId), body.document as Record<string, unknown>);
    if (doc) {
      await client.query(
        'UPDATE sign_requests SET file_name = $1, mime_type = $2, storage_key = $3, file_size = $4, updated_at = now() WHERE id = $5',
        [doc.fileName, doc.mimeType, doc.storageKey, doc.size, Number(request.id)]
      );
    }
  }

  await audit(client, ctx, {
    action: 'create', resource: 'sign.sign_request', recordId: Number(request.id),
    recordCode: String(request.code), newValues: toCamelRow(request) as Record<string, unknown>,
  });
  return (await getSignRequestDetail(client, ctx, Number(request.id))).request;
}

export async function updateSignRequest(
  client: pg.PoolClient,
  ctx: Ctx,
  id: number,
  body: Record<string, unknown>
) {
  const r = await getRequest(client, ctx, id, true);
  if (String(r.status) !== 'DRAFT') throw conflict('Only a draft sign request can be edited');
  const before = toCamelRow(r);
  const sets: string[] = [];
  const vals: unknown[] = [];
  const push = (col: string, val: unknown) => {
    if (val !== undefined) { sets.push(col + ' = $' + (vals.length + 1)); vals.push(val); }
  };
  if (body.title !== undefined) {
    const t = str(body.title);
    if (!t || !t.trim()) throw badRequest('title cannot be empty');
    push('title', t.trim());
  }
  push('message', body.message === undefined ? undefined : str(body.message));
  push('document_type', str(body.documentType));
  push('document_code', str(body.documentCode));
  push('branch_id', num(body.branchId));
  push('department_id', num(body.departmentId));
  if (body.signatureOrder !== undefined) {
    push('signature_order', str(body.signatureOrder)?.toUpperCase() === 'SEQUENTIAL' ? 'SEQUENTIAL' : 'ANY');
  }
  if (body.expiresAt !== undefined) {
    const raw = str(body.expiresAt);
    const d = raw ? new Date(raw) : null;
    if (raw && Number.isNaN(d?.getTime())) throw badRequest('expiresAt must be a valid ISO timestamp');
    push('expires_at', d);
  }

  // Replace signers in a draft: delete and re-insert keeps ordering explicit.
  if (Array.isArray(body.signers)) {
    await client.query('DELETE FROM sign_request_signers WHERE sign_request_id = $1 AND tenant_id = $2', [id, ctx.tenantId]);
    const signersIn = body.signers as SignerInput[];
    for (let idx = 0; idx < signersIn.length; idx++) {
      const resolved = await resolveSigner(client, ctx, signersIn[idx], Number(r.company_id));
      await client.query(
        `INSERT INTO sign_request_signers
           (tenant_id, company_id, sign_request_id, signer_type, signer_user_id, signer_name, signer_email, order_index)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [ctx.tenantId, r.company_id, id, resolved.type, resolved.userId, resolved.name, resolved.email, num(signersIn[idx].orderIndex) ?? idx]
      );
    }
  }

  if (body.document && typeof body.document === 'object') {
    const doc = writeDocument(id, Number(ctx.tenantId), body.document as Record<string, unknown>);
    if (doc) {
      push('file_name', doc.fileName);
      push('mime_type', doc.mimeType);
      push('storage_key', doc.storageKey);
      push('file_size', doc.size);
    }
  }

  if (sets.length > 0) {
    sets.push('updated_by = $' + (vals.length + 1));
    vals.push(ctx.userId);
    await client.query('UPDATE sign_requests SET ' + sets.join(', ') + ' WHERE id = $' + (vals.length + 1), [...vals, id]);
  }

  await audit(client, ctx, {
    action: 'update', resource: 'sign.sign_request', recordId: id,
    recordCode: String(r.code), oldValues: before,
    newValues: toCamelRow(await getRequest(client, ctx, id)) as Record<string, unknown>,
  });
  return (await getSignRequestDetail(client, ctx, id)).request;
}

export async function deleteSignRequest(client: pg.PoolClient, ctx: Ctx, id: number) {
  const r = await getRequest(client, ctx, id, true);
  if (String(r.status) !== 'DRAFT') throw conflict('Only a draft sign request can be deleted');
  await client.query('DELETE FROM sign_requests WHERE id = $1 AND tenant_id = $2', [id, ctx.tenantId]);
  await audit(client, ctx, {
    action: 'delete', resource: 'sign.sign_request', recordId: id,
    recordCode: String(r.code), oldValues: toCamelRow(r) as Record<string, unknown>,
  });
  return { deleted: true, id };
}

// ---------------------------------------------------------------------------
// Send / revoke / resend
// ---------------------------------------------------------------------------

function signUrlFor(token: string): string {
  return config.webPublicUrl + '/#/sign/' + token;
}

async function loadSignersForDelivery(
  client: pg.PoolClient,
  requestId: number
): Promise<Record<string, unknown>[]> {
  const { rows } = await client.query(
    'SELECT * FROM sign_request_signers WHERE sign_request_id = $1 ORDER BY order_index, id',
    [requestId]
  );
  return rows;
}

export async function sendSignRequest(client: pg.PoolClient, ctx: Ctx, id: number) {
  const r = await getRequest(client, ctx, id, true);
  if (String(r.status) !== 'DRAFT') throw conflict('Only a draft sign request can be sent');
  const signers = await loadSignersForDelivery(client, id);
  if (signers.length === 0) throw badRequest('Add at least one signer before sending');

  const internalNotifications: { userId: number; name: string; code: string }[] = [];
  const externalDeliveries: { email: string; name: string; signUrl: string; title: string; code: string }[] = [];

  for (const s of signers) {
    const { token, hash } = makeSignToken();
    await client.query(
      `UPDATE sign_request_signers
          SET token_hash = $1, status = 'SENT', sent_at = now(), updated_at = now()
        WHERE id = $2`,
      [hash, Number(s.id)]
    );
    if (String(s.signer_type) === 'EMPLOYEE' && s.signer_user_id) {
      internalNotifications.push({ userId: Number(s.signer_user_id), name: String(s.signer_name), code: String(r.code) });
    } else if (String(s.signer_type) === 'CONTACT' && s.signer_email) {
      externalDeliveries.push({
        email: String(s.signer_email),
        name: String(s.signer_name),
        signUrl: signUrlFor(token),
        title: String(r.title),
        code: String(r.code),
      });
    }
  }

  await client.query(
    `UPDATE sign_requests SET status = 'SENT', sent_at = now(), updated_at = now() WHERE id = $1`,
    [id]
  );
  await audit(client, ctx, {
    action: 'send', resource: 'sign.sign_request', recordId: id,
    recordCode: String(r.code), oldValues: { status: 'DRAFT' }, newValues: { status: 'SENT' },
    metadata: { signerCount: signers.length },
  });

  // Internal signers are reached through the in-app + queued delivery system.
  for (const n of internalNotifications) {
    await notifyUsers(
      client,
      ctx,
      {
        type: 'sign.request_received',
        title: 'Signing requested',
        body: 'You have been asked to sign "' + String(r.title) + '" (' + n.code + ').',
        link: '/esign/' + id,
        severity: 'INFO',
        priority: 'HIGH',
        actionLabel: 'Review & sign',
        actionTarget: '/esign/' + id,
        channels: ['IN_APP'],
        data: { signRequestId: id, code: n.code },
      },
      [n.userId]
    );
  }

  const detail = await getSignRequestDetail(client, ctx, id);
  return { request: detail.request, signers: detail.signers, externalDeliveries };
}

export async function revokeSignRequest(
  client: pg.PoolClient,
  ctx: Ctx,
  id: number,
  reason?: string | null
) {
  const r = await getRequest(client, ctx, id, true);
  if (!REQUEST_ACTIVE.has(String(r.status))) {
    throw conflict('Only a sent or partially signed request can be revoked (current: ' + r.status + ')');
  }
  await client.query(
    `UPDATE sign_requests SET status = 'REVOKED', revoked_at = now(), revoked_by = $1, revoked_reason = $2, updated_at = now() WHERE id = $3`,
    [ctx.userId, reason ?? 'Revoked', id]
  );
  await client.query(
    `UPDATE sign_request_signers SET status = 'REVOKED', updated_at = now()
      WHERE sign_request_id = $1 AND status IN ('SENT','VIEWED')`,
    [id]
  );
  await audit(client, ctx, {
    action: 'revoke', resource: 'sign.sign_request', recordId: id,
    recordCode: String(r.code), oldValues: { status: r.status }, newValues: { status: 'REVOKED', reason: reason ?? null },
  });
  return (await getSignRequestDetail(client, ctx, id)).request;
}

export async function resendSigner(client: pg.PoolClient, ctx: Ctx, signerId: number) {
  const { rows } = await client.query(
    `SELECT s.*, r.title, r.code, r.status AS request_status
       FROM sign_request_signers s JOIN sign_requests r ON r.id = s.sign_request_id
      WHERE s.id = $1 AND s.tenant_id = $2 FOR UPDATE`,
    [signerId, ctx.tenantId]
  );
  if (rows.length === 0) throw notFound('Signer not found');
  const s = rows[0];
  if (!REQUEST_ACTIVE.has(String(s.request_status))) {
    throw conflict('The sign request is not active; a link cannot be resent');
  }
  if (!SIGNER_PENDING.has(String(s.status))) {
    throw conflict('Only a pending signer can be reminded (current: ' + s.status + ')');
  }
  const { token, hash } = makeSignToken();
  await client.query(
    'UPDATE sign_request_signers SET token_hash = $1, status = $2, sent_at = now(), updated_at = now() WHERE id = $3',
    [hash, 'SENT', signerId]
  );
  await audit(client, ctx, {
    action: 'send', resource: 'sign.sign_request_signer', recordId: signerId,
    recordCode: String(s.code), newValues: { signerName: String(s.signer_name), resent: true },
  });

  let externalDelivery: { email: string; name: string; signUrl: string; title: string; code: string } | null = null;
  if (String(s.signer_type) === 'EMPLOYEE' && s.signer_user_id) {
    await notifyUsers(
      client,
      ctx,
      {
        type: 'sign.request_reminder',
        title: 'Signing reminder',
        body: 'A reminder to sign "' + String(s.title) + '" (' + s.code + ').',
        link: '/esign/' + s.sign_request_id,
        severity: 'INFO',
        priority: 'HIGH',
        channels: ['IN_APP'],
        data: { signRequestId: Number(s.sign_request_id) },
      },
      [Number(s.signer_user_id)]
    );
  } else if (String(s.signer_type) === 'CONTACT' && s.signer_email) {
    externalDelivery = {
      email: String(s.signer_email),
      name: String(s.signer_name),
      signUrl: signUrlFor(token),
      title: String(s.title),
      code: String(s.code),
    };
  }

  return { signer: toCamelRow(s), externalDelivery };
}

// ---------------------------------------------------------------------------
// Authenticated internal signing
// ---------------------------------------------------------------------------

async function assertCanSignNow(client: pg.PoolClient, requestId: number, orderIndex: number, order: string): Promise<void> {
  if (order === 'SEQUENTIAL') {
    const { rows } = await client.query(
      `SELECT 1 FROM sign_request_signers
        WHERE sign_request_id = $1 AND order_index < $2 AND status <> 'SIGNED' LIMIT 1`,
      [requestId, orderIndex]
    );
    if (rows.length > 0) throw conflict('Earlier signers must sign first');
  }
}

export async function signInternally(
  client: pg.PoolClient,
  ctx: Ctx,
  id: number,
  body: Record<string, unknown>
) {
  const r = await getRequest(client, ctx, id, true);
  if (!REQUEST_ACTIVE.has(String(r.status))) {
    throw conflict('This sign request is not open for signing (current: ' + r.status + ')');
  }
  if (r.expires_at && new Date(r.expires_at).getTime() <= Date.now()) {
    throw conflict('This sign request has expired');
  }
  const { rows } = await client.query(
    `SELECT * FROM sign_request_signers
      WHERE sign_request_id = $1 AND signer_user_id = $2 AND tenant_id = $3 FOR UPDATE`,
    [id, ctx.userId, ctx.tenantId]
  );
  if (rows.length === 0) throw forbidden('You are not a signer on this request');
  const s = rows[0];
  if (!SIGNER_PENDING.has(String(s.status))) {
    throw conflict('You have already decided this request (current: ' + s.status + ')');
  }
  await assertCanSignNow(client, id, Number(s.order_index), String(r.signature_order));

  await client.query(
    `UPDATE sign_request_signers
        SET status = 'SIGNED', signed_at = now(),
            signature = COALESCE(NULLIF($1, ''), signer_name),
            signature_data = COALESCE($2::jsonb, '{}'::jsonb),
            consent = COALESCE($3::jsonb, '{}'::jsonb),
            viewed_at = COALESCE(viewed_at, now()), updated_at = now()
      WHERE id = $4`,
    [
      str(body.signature) ?? String(s.signer_name),
      body.signatureData ? JSON.stringify(body.signatureData) : '{}',
      body.consent ? JSON.stringify(body.consent) : '{}',
      Number(s.id),
    ]
  );
  await recomputeRequestStatus(client, id);
  await audit(client, ctx, {
    action: 'sign', resource: 'sign.sign_request_signer', recordId: Number(s.id),
    recordCode: String(r.code), newValues: { signerName: String(s.signer_name), status: 'SIGNED' },
  });
  return (await getSignRequestDetail(client, ctx, id)).request;
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

export async function signRequestDashboard(client: pg.PoolClient, ctx: Ctx) {
  const params: unknown[] = [ctx.tenantId];
  let companySql = '';
  if (ctx.companyId) { companySql = ' AND company_id = $2'; params.push(ctx.companyId); }
  const { rows } = await client.query(
    'SELECT status, count(*)::int AS total FROM sign_requests WHERE tenant_id = $1' + companySql + ' GROUP BY status',
    params
  );
  const byStatus: Record<string, number> = {};
  let total = 0;
  for (const r of rows) {
    byStatus[String(r.status)] = Number(r.total);
    total += Number(r.total);
  }
  const mineRes = await client.query(
    `SELECT count(*)::int AS total FROM sign_request_signers s
       JOIN sign_requests r ON r.id = s.sign_request_id
      WHERE s.tenant_id = $1 AND s.signer_user_id = $2 AND s.status IN ('SENT','VIEWED')`,
    [ctx.tenantId, ctx.userId]
  );
  return {
    total,
    byStatus,
    sent: byStatus['SENT'] ?? 0,
    partiallySigned: byStatus['PARTIALLY_SIGNED'] ?? 0,
    completed: byStatus['COMPLETED'] ?? 0,
    draft: byStatus['DRAFT'] ?? 0,
    awaitingMySignature: Number(mineRes.rows[0]?.total ?? 0),
  };
}

// ---------------------------------------------------------------------------
// Public (token-authenticated) functions
// ---------------------------------------------------------------------------

export async function publicSignSession(tokenHash: string): Promise<Record<string, unknown> | null> {
  const res = await query('SELECT public.sign_public_session($1) AS session', [tokenHash]);
  const session = res.rows[0]?.session;
  if (!session || session === null) return null;
  return session as Record<string, unknown>;
}

export async function publicSubmitSign(
  tokenHash: string,
  body: { signature?: string; signatureData?: unknown; consent?: unknown },
  ip: string | null | undefined,
  userAgent: string | null | undefined,
  device: string | null | undefined
): Promise<Record<string, unknown>> {
  const res = await query(
    `SELECT public.sign_public_submit($1, $2, $3::jsonb, $4::jsonb, $5, $6, $7) AS result`,
    [
      tokenHash,
      str(body.signature) ?? '',
      body.signatureData ? JSON.stringify(body.signatureData) : '{}',
      body.consent ? JSON.stringify(body.consent) : '{}',
      ip ?? null,
      userAgent ?? null,
      device ?? null,
    ]
  );
  return (res.rows[0]?.result ?? { ok: false, reason: 'NO_RESULT' }) as Record<string, unknown>;
}

export async function publicRefuseSign(
  tokenHash: string,
  reason: string | null,
  ip: string | null | undefined,
  userAgent: string | null | undefined,
  device: string | null | undefined
): Promise<Record<string, unknown>> {
  const res = await query(
    'SELECT public.sign_public_refuse($1, $2, $3, $4, $5) AS result',
    [tokenHash, reason ?? null, ip ?? null, userAgent ?? null, device ?? null]
  );
  return (res.rows[0]?.result ?? { ok: false, reason: 'NO_RESULT' }) as Record<string, unknown>;
}

export async function publicMarkViewed(tokenHash: string): Promise<void> {
  await query('SELECT public.sign_public_mark_viewed($1)', [tokenHash]);
}

export async function publicSignFile(
  tokenHash: string
): Promise<{ abs: string; fileName: string; mimeType: string } | null> {
  const session = await publicSignSession(tokenHash);
  if (!session) return null;
  const storageKey = str(session.storageKey ?? null);
  const resolved = resolveStoredFile(storageKey);
  if (!resolved.ok) return null;
  return {
    abs: resolved.abs,
    fileName: String(session.fileName ?? 'document'),
    mimeType: String(session.mimeType ?? 'application/octet-stream'),
  };
}
