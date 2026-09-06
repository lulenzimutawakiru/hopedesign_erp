import express, { Router } from 'express';
import crypto from 'node:crypto';
import { query, tx } from '../db.js';
import { asyncHandler, badRequest, notFound } from '../utils.js';
import { requirePermission } from '../middleware/authorize.js';
import { logAudit } from '../services/audit.js';

export const hikvisionIntegrationRouter = Router();
export const hikvisionRouter = Router();

type Incoming = Record<string, unknown>;
const text = (v: unknown) => typeof v === 'string' ? v.trim() : v == null ? '' : String(v);
const pick = (p: Incoming, ...names: string[]) => names.map((n) => p[n]).find((v) => v != null && text(v) !== '');
const xmlValue = (xml: string, name: string) => {
  const match = new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i').exec(xml);
  return match ? match[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/, '$1').trim() : undefined;
};
const parseXml = (xml: string): Incoming => {
  // Hikvision event XML is intentionally parsed as a flat, whitelisted set;
  // no entity expansion, DTD, or object construction is performed.
  if (/<!(?:DOCTYPE|ENTITY)/i.test(xml)) throw badRequest('Invalid event payload');
  const fields = ['employeeNoString', 'employeeNo', 'time', 'dateTime', 'verifyNo', 'serialNo', 'deviceSerialNo', 'eventType', 'deviceName'];
  return Object.fromEntries(fields.map((f) => [f, xmlValue(xml, f)]).filter(([, v]) => v !== undefined));
};
const timingSafe = (a: string, b: string) => {
  const left = Buffer.from(a, 'hex'); const right = Buffer.from(b, 'hex');
  return left.length === right.length && crypto.timingSafeEqual(left, right);
};

/** Device-facing receiver. It stores the immutable raw record and returns; processing happens asynchronously. */
hikvisionIntegrationRouter.post('/events', express.text({ type: ['application/xml', 'text/xml'], limit: '5mb' }), asyncHandler(async (req, res) => {
  const contentType = String(req.headers['content-type'] ?? '').toLowerCase();
  const raw = req.rawBody ?? (typeof req.body === 'string' ? Buffer.from(req.body) : Buffer.from(JSON.stringify(req.body ?? {})));
  const payload: Incoming = contentType.includes('xml') ? parseXml(raw.toString('utf8')) : (req.body ?? {});
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw badRequest('Invalid event payload');
  const serial = text(pick(payload, 'serialNo', 'deviceSerialNo'));
  const eventTime = text(pick(payload, 'time', 'dateTime'));
  if (!serial || !eventTime || !Number.isFinite(Date.parse(eventTime))) throw badRequest('Invalid event payload');
  const timestamp = text(req.headers['x-hikvision-timestamp']);
  const signature = text(req.headers['x-hikvision-signature']);
  const secret = text(req.headers['x-hikvision-secret']);
  const sentAt = Date.parse(timestamp);
  if (!timestamp || !signature || !secret || !Number.isFinite(sentAt) || Math.abs(Date.now() - sentAt) > 5 * 60_000) throw badRequest('Event not accepted');
  const expected = crypto.createHmac('sha256', secret).update(`${timestamp}.`).update(raw).digest('hex');
  if (!timingSafe(signature, expected)) throw badRequest('Event not accepted');
  const payloadHash = crypto.createHash('sha256').update(raw).digest('hex');
  try {
    const result = await query<{ hikvision_ingest_event: string }>(
      'SELECT hikvision_ingest_event($1,$2,$3::jsonb,$4,$5::timestamptz,$6,$7)',
      [serial, secret, JSON.stringify(payload), contentType.includes('xml') ? 'XML' : 'JSON', eventTime, text(pick(payload, 'eventType')) || 'ATTENDANCE', payloadHash]
    );
    res.status(202).json({ accepted: true, eventId: result.rows[0].hikvision_ingest_event });
  } catch (err: any) {
    // Authentication failures must not reveal whether a serial is registered.
    // A persistence failure remains retryable: returning 5xx makes devices retry
    // instead of silently discarding a biometric event.
    if (err?.code === '28000') return res.status(401).json({ accepted: false });
    return res.status(503).json({ accepted: false });
  }
}));

const secured = (permission: string, fn: (req: any, res: any) => Promise<void>) => [requirePermission(permission), asyncHandler(fn)];
hikvisionRouter.get('/devices', ...secured('hikvision.devices.view', async (req, res) => {
  const result = await query('SELECT id, name, model, serial_number, ip_address, physical_location, purpose, timezone, firmware_version, status, last_heartbeat_at, last_event_at FROM hikvision_devices WHERE tenant_id = $1 ORDER BY name', [req.ctx.tenantId], req.ctx);
  res.json({ data: result.rows });
}));
hikvisionRouter.post('/devices', ...secured('hikvision.devices.create', async (req, res) => {
  const b = req.body ?? {}; if (!text(b.name) || !text(b.serialNumber) || !text(b.webhookSecret)) throw badRequest('Name, serial number, and webhook secret are required');
  const row = await tx(async (c) => {
    const out = await c.query(`INSERT INTO hikvision_devices (tenant_id,company_id,branch_id,department_id,name,model,serial_number,ip_address,physical_location,purpose,timezone,firmware_version,webhook_secret_hash)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,encode(digest($13,'sha256'),'hex')) RETURNING id,name,serial_number,status`, [req.ctx.tenantId, req.ctx.companyId, b.branchId ?? req.ctx.branchId, b.departmentId ?? null, text(b.name), text(b.model) || null, text(b.serialNumber), text(b.ipAddress) || null, text(b.physicalLocation) || null, text(b.purpose) || 'ATTENDANCE', text(b.timezone) || 'UTC', text(b.firmwareVersion) || null, text(b.webhookSecret)]);
    await logAudit(c, req.ctx, { action: 'HIKVISION_DEVICE_ADDED', resource: 'hikvision_devices', recordCode: text(b.serialNumber), metadata: { deviceId: out.rows[0].id } }); return out.rows[0];
  }, req.ctx); res.status(201).json({ data: row });
}));
hikvisionRouter.get('/devices/:id', ...secured('hikvision.devices.view', async (req, res) => {
  const result = await query('SELECT id,name,model,serial_number,ip_address,mac_address,physical_location,purpose,timezone,firmware_version,status,last_heartbeat_at,last_event_at,duplicate_window_seconds FROM hikvision_devices WHERE id=$1 AND tenant_id=$2', [req.params.id, req.ctx.tenantId], req.ctx);
  if (!result.rows[0]) throw notFound('Device not found'); res.json({ data: result.rows[0] });
}));
hikvisionRouter.patch('/devices/:id', ...secured('hikvision.devices.update', async (req, res) => {
  const b = req.body ?? {}; const allowed: Record<string, unknown> = { name: b.name, model: b.model, ip_address: b.ipAddress, physical_location: b.physicalLocation, purpose: b.purpose, timezone: b.timezone, firmware_version: b.firmwareVersion, status: b.status, duplicate_window_seconds: b.duplicateWindowSeconds };
  const entries = Object.entries(allowed).filter(([, value]) => value !== undefined); if (!entries.length) throw badRequest('No editable fields supplied');
  const result = await tx(async (c) => { const set = entries.map(([key], i) => `${key}=$${i + 1}`).join(','); const out = await c.query(`UPDATE hikvision_devices SET ${set},updated_at=now() WHERE id=$${entries.length + 1} AND tenant_id=$${entries.length + 2} RETURNING id,name,status`, [...entries.map(([, value]) => value), req.params.id, req.ctx.tenantId]); if (!out.rows[0]) throw notFound('Device not found'); await logAudit(c, req.ctx, { action: 'HIKVISION_DEVICE_UPDATED', resource: 'hikvision_devices', recordCode: req.params.id, newValues: allowed }); return out.rows[0]; }, req.ctx); res.json({ data: result });
}));
hikvisionRouter.delete('/devices/:id', ...secured('hikvision.devices.delete', async (req, res) => {
  const result = await tx(async (c) => { const out = await c.query(`UPDATE hikvision_devices SET status='DISABLED',updated_at=now() WHERE id=$1 AND tenant_id=$2 RETURNING id,status`, [req.params.id, req.ctx.tenantId]); if (!out.rows[0]) throw notFound('Device not found'); await logAudit(c, req.ctx, { action: 'HIKVISION_DEVICE_DISABLED', resource: 'hikvision_devices', recordCode: req.params.id }); return out.rows[0]; }, req.ctx); res.json({ data: result });
}));
hikvisionRouter.get('/events', ...secured('hikvision.events.view', async (req, res) => {
  const result = await query(`SELECT r.id,r.device_serial_number,r.received_at,r.device_event_time,r.event_type,r.processing_status,r.retry_count,r.error_message,n.employee_identifier,n.employee_id,n.verification_method,n.classification
    FROM hikvision_raw_events r LEFT JOIN hikvision_normalized_events n ON n.raw_event_id=r.id WHERE r.tenant_id=$1 ORDER BY r.received_at DESC LIMIT 200`, [req.ctx.tenantId], req.ctx); res.json({ data: result.rows });
}));
hikvisionRouter.post('/events/:id/:action(retry|reprocess|reject)', ...secured('hikvision.events.retry', async (req, res) => {
  const action = req.params.action; const status = action === 'reject' ? 'REJECTED' : 'QUEUED';
  const result = await tx(async (c) => { const out = await c.query(`UPDATE hikvision_raw_events SET processing_status=$1,retry_count=CASE WHEN $1='QUEUED' THEN retry_count+1 ELSE retry_count END,error_message=NULL WHERE id=$2 AND tenant_id=$3 RETURNING id,processing_status`, [status, req.params.id, req.ctx.tenantId]); if (!out.rows[0]) throw notFound('Event not found'); await logAudit(c, req.ctx, { action: `HIKVISION_EVENT_${action.toUpperCase()}`, resource: 'hikvision_raw_events', recordCode: req.params.id }); return out.rows[0]; }, req.ctx); res.json({ data: result });
}));
