/**
 * Secure event ingest for Hikvision DS-K1T terminals.
 *
 * Contract: a terminal presents its serial + shared key (headers preferred,
 * query allowed only for devices with allow_query_key). The device is
 * authenticated by hikvision_auth_device() (constant-time key compare,
 * optional IP allow-list), the payload is parsed defensively (JSON/XML/FORM),
 * and the event is written FIRST to hikvision_raw_events before anything
 * else happens. Webhook responses are fast and opaque; heavy processing is
 * deferred to the queue worker (processor.ts).
 */
import pg from 'pg';
import { pool, tx } from '../../db.js';
import { logAudit } from '../audit.js';
import { badRequest, unauthorized } from '../../utils.js';
import { parseEventPayload, PayloadFormat } from './parser.js';
import { sha256Hex, normalizeIp } from './security.js';
import { Ctx } from '../../db.js';

export interface DeviceAuthRow {
  id: number;
  tenant_id: number;
  company_id: number;
  branch_id: number | null;
  department_id: number | null;
  code: string;
  name: string;
  model: string | null;
  serial_number: string;
  device_purpose: string;
  timezone: string;
  enabled: boolean;
  connection_status: string;
  allow_query_key: boolean;
  duplicate_window_seconds: number;
  replay_window_seconds: number;
  allow_future_minutes: number;
  allow_past_minutes: number;
  attendance_enabled: boolean;
  access_events_enabled: boolean;
  break_start: string | null;
  break_end: string | null;
  default_shift_code: string | null;
  clock_drift_warning_seconds: number;
  heartbeat_stale_seconds: number;
}

export interface WebhookCredentials {
  /** Serial number supplied via trusted header (authoritative). */
  headerSerial: string | null;
  /** Shared key supplied via trusted header. */
  headerKey: string | null;
  /** Query-string fallback credentials. */
  querySerial: string | null;
  queryKey: string | null;
}

export interface IngestResult {
  accepted: boolean;
  rawEventId: number | null;
  status: 'RECEIVED' | 'DUPLICATE' | 'REJECTED';
  duplicateOfRawEventId?: number | null;
}

export interface HeaderMap {
  [name: string]: string | string[] | number | undefined;
}

interface StoredPayload {
  format: PayloadFormat;
  raw: unknown;
  fields: Record<string, unknown>;
  employee_identifier: string | null;
  device_serial: string | null;
  event_time: string | null;
  event_type: string | null;
  verification: string | null;
  access_status: string | null;
  attendance_status: string | null;
}

async function authDevice(serial: string, key: string, ip: string): Promise<DeviceAuthRow> {
  const res = await pool.query('SELECT * FROM hikvision_auth_device($1,$2,$3)', [serial, key, ip]);
  if (res.rows.length === 0) throw unauthorized();
  return res.rows[0] as unknown as DeviceAuthRow;
}

const readHeader = (headers: HeaderMap, name: string): string | null => {
  const v = headers[name] ?? headers[name.toLowerCase()];
  if (v === undefined || v === null) return null;
  const s = Array.isArray(v) ? (v[0] ?? '') : String(v);
  const t = s.trim();
  return t === '' ? null : t;
};

function buildStoredPayload(
  format: PayloadFormat,
  raw: unknown,
  parsed: ReturnType<typeof parseEventPayload>
): StoredPayload {
  return {
    format,
    raw,
    fields: parsed.fields,
    employee_identifier: parsed.employeeIdentifier,
    device_serial: parsed.serialRaw,
    event_time: parsed.eventTimeIso,
    event_type: parsed.eventTypeRaw,
    verification: parsed.verifyRaw,
    access_status: parsed.accessStatus,
    attendance_status: parsed.attendanceStatus,
  };
}

/**
 * Authenticate + store one inbound terminal event.
 * Never throws user-visible internals; on a clean authentication failure it
 * throws a generic 401 and on an unparsable payload a generic 400.
 */
export async function ingestDeviceEvent(opts: {
  credentials: WebhookCredentials;
  contentType: string;
  body: unknown; // parsed JSON/FORM object, or raw XML text
  rawText: string | null;
  headers: HeaderMap;
  ip: string;
}): Promise<IngestResult> {
  const { credentials, contentType, body, rawText, headers } = opts;
  const ip = normalizeIp(opts.ip);

  let serial = readHeader(headers, 'x-hikvision-serial') ?? credentials.headerSerial;
  let key = readHeader(headers, 'x-hikvision-key') ?? credentials.headerKey;
  let credentialFromQuery = false;
  if (!serial || !key) {
    serial = serial ?? credentials.querySerial;
    key = key ?? credentials.queryKey;
    if (serial && key) credentialFromQuery = true;
  }
  if (!serial || !key) throw unauthorized();

  let device: DeviceAuthRow;
  try {
    device = await authDevice(serial, key, ip);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('ERR_INVALID_DEVICE_CREDENTIALS') || msg.includes('ERR_SOURCE_NOT_ALLOWED')) {
      throw unauthorized();
    }
    throw err;
  }
  if (!device.enabled) throw unauthorized();
  // Query-string keys are only honoured when the device is configured for it.
  if (credentialFromQuery && !device.allow_query_key) throw unauthorized();

  let parsed;
  try {
    parsed = parseEventPayload(body, contentType, device.timezone);
  } catch (err) {
    if (err instanceof Error && 'status' in err && (err as { status: number }).status === 400) throw err;
    throw badRequest('Invalid event payload');
  }
  if (parsed.format === 'UNKNOWN') throw badRequest('Unsupported payload format');

  // Cross-check: a terminal that knows its own serial must not disagree with the
  // authenticated source. This stops payload/source spoofing on shared links.
  if (parsed.serialRaw && parsed.serialRaw !== serial) {
    throw badRequest('Invalid event payload');
  }

  const nowMs = Date.now();
  const eventTimeIso = parsed.eventTimeIso;
  const employeeIdentifier = parsed.employeeIdentifier;

  // Replay / timestamp validation (future events and events older than the
  // device's configured window are preserved but flagged REJECTED).
  let status: 'RECEIVED' | 'DUPLICATE' | 'REJECTED' = 'RECEIVED';
  let rejectionReason: string | null = null;
  let evMs: number | null = null;
  if (eventTimeIso) {
    evMs = Date.parse(eventTimeIso);
    if (Number.isFinite(evMs)) {
      if (evMs > nowMs + device.allow_future_minutes * 60000) {
        status = 'REJECTED';
        rejectionReason = 'INVALID_TIMESTAMP_FUTURE';
      } else if (evMs < nowMs - device.allow_past_minutes * 60000) {
        status = 'REJECTED';
        rejectionReason = 'INVALID_TIMESTAMP_TOO_OLD';
      }
    }
  }

  const dedupeKey =
    employeeIdentifier && evMs !== null && Number.isFinite(evMs)
      ? sha256Hex(`${serial}:${employeeIdentifier}:${Math.floor(evMs / 1000)}`)
      : null;

  const payload = buildStoredPayload(parsed.format, rawText ?? body, parsed);
  const format = parsed.format;
  const rawEventType = parsed.eventTypeRaw ?? 'UNKNOWN';
  const deviceEventTime = eventTimeIso;
  const sourceHeaders = {
    'content-type': contentType || null,
    'user-agent': readHeader(headers, 'user-agent'),
    'x-hikvision-model': readHeader(headers, 'x-hikvision-model'),
    'x-hikvision-firmware': readHeader(headers, 'x-hikvision-firmware'),
  };

  const ctx: Ctx = {
    tenantId: device.tenant_id,
    companyId: device.company_id,
    branchId: device.branch_id,
    ip,
  };

  const result = await tx(async (client) => {
    let rawId: number | null = null;
    let duplicateOf: number | null = null;
    let finalStatus: 'RECEIVED' | 'DUPLICATE' | 'REJECTED' = status;

    // Exact-repeat protection (unique dedupe index). Preserve the duplicate as
    // its own raw row (dedupe_key cleared so the marker row can exist).
    const existing = dedupeKey
      ? await client.query(
          `SELECT id FROM hikvision_raw_events WHERE device_id = $1 AND dedupe_key = $2 LIMIT 1`,
          [device.id, dedupeKey]
        )
      : { rows: [] as { id: number }[] };
    if (existing.rows.length > 0) {
      duplicateOf = Number(existing.rows[0].id);
      finalStatus = 'DUPLICATE';
      const dup = await client.query(
        `INSERT INTO hikvision_raw_events
           (tenant_id, company_id, device_id, device_serial_number, payload, payload_format,
            received_at, device_event_time, event_type, source_ip, source_headers,
            dedupe_key, duplicate_of_raw_event_id, processing_status, error_message)
         VALUES ($1,$2,$3,$4,$5,$6,now(),$7,$8,$9,$10,NULL,$11,$12,$13)
         RETURNING id`,
        [
          device.tenant_id, device.company_id, device.id, serial, JSON.stringify(payload), format,
          deviceEventTime, rawEventType, ip, JSON.stringify(sourceHeaders),
          duplicateOf, 'DUPLICATE', `duplicate of raw event ${duplicateOf}`,
        ]
      );
      rawId = Number(dup.rows[0].id);
    } else {
      const ins = await client.query(
        `INSERT INTO hikvision_raw_events
           (tenant_id, company_id, device_id, device_serial_number, payload, payload_format,
            received_at, device_event_time, event_type, source_ip, source_headers,
            dedupe_key, processing_status, error_message)
         VALUES ($1,$2,$3,$4,$5,$6,now(),$7,$8,$9,$10,$11,$12,$13)
         RETURNING id`,
        [
          device.tenant_id, device.company_id, device.id, serial, JSON.stringify(payload), format,
          deviceEventTime, rawEventType, ip, JSON.stringify(sourceHeaders),
          dedupeKey, finalStatus, rejectionReason,
        ]
      );
      rawId = Number(ins.rows[0].id);

      // Configurable duplicate WINDOW: the same employee punching again on the
      // same device within N seconds (even at a slightly different second) is a
      // duplicate. This implements the 08:00:01 / 08:00:04 scenario.
      if (finalStatus === 'RECEIVED' && employeeIdentifier && evMs !== null && rawId) {
        const windowRes = await client.query(
          `SELECT id FROM hikvision_raw_events
            WHERE device_id = $1
              AND duplicate_of_raw_event_id IS NULL
              AND processing_status <> 'REJECTED'
              AND id <> $2
              AND payload->>'employee_identifier' = $3
              AND device_event_time IS NOT NULL
              AND abs(extract(epoch FROM (device_event_time - $4::timestamptz)))::int <= $5
            ORDER BY device_event_time ASC
            LIMIT 1`,
          [device.id, rawId, employeeIdentifier, eventTimeIso, device.duplicate_window_seconds]
        );
        if (windowRes.rows.length > 0) {
          const originalId = Number(windowRes.rows[0].id);
          await client.query(
            `UPDATE hikvision_raw_events
                SET processing_status = 'DUPLICATE',
                    duplicate_of_raw_event_id = $2,
                    error_message = $3,
                    updated_at = now()
              WHERE id = $1`,
            [rawId, originalId, `duplicate within ${device.duplicate_window_seconds}s window of raw event ${originalId}`]
          );
          duplicateOf = originalId;
          finalStatus = 'DUPLICATE';
        }
      }
    }

    // Device telemetry: mark online and refresh last-seen (never override
    // MAINTENANCE / DISABLED that an administrator set explicitly).
    await client.query(
      `UPDATE hikvision_devices
          SET last_event_at = now(),
              last_heartbeat_at = now(),
              connection_status = CASE
                WHEN connection_status IN ('MAINTENANCE','DISABLED') THEN connection_status
                ELSE 'ONLINE' END,
              updated_at = now()
        WHERE id = $1`,
      [device.id]
    );
    await client.query(
      `INSERT INTO hikvision_device_heartbeats
         (tenant_id, company_id, device_id, heartbeat_at, device_time, clock_drift_seconds, ip_address)
       VALUES ($1,$2,$3,now(),$4,0,$5)`,
      [device.tenant_id, device.company_id, device.id, deviceEventTime, ip]
    );

    if (finalStatus === 'REJECTED') {
      await client.query(
        `INSERT INTO hikvision_device_health_logs
           (tenant_id, company_id, device_id, health_type, message, severity, metadata)
         VALUES ($1,$2,$3,'EVENT',$4,'WARN',$5)`,
        [device.tenant_id, device.company_id, device.id, rejectionReason ?? 'REJECTED', JSON.stringify({ rawEventId: rawId })]
      );
    }

    if (rawId) {
      await logAudit(client, ctx, {
        action: 'hikvision.event.received',
        resource: 'hikvision_raw_events',
        recordId: rawId,
        recordCode: serial,
        metadata: {
          deviceId: device.id,
          deviceCode: device.code,
          format,
          status: finalStatus,
          employeeIdentifier,
          eventTime: eventTimeIso,
          eventType: rawEventType,
          duplicateOfRawEventId: duplicateOf,
        },
      });
    }

    return { rawId, duplicateOf, finalStatus };
  }, ctx);

  return {
    accepted: result.rawId !== null,
    rawEventId: result.rawId,
    status: result.finalStatus,
    duplicateOfRawEventId: result.duplicateOf,
  };
}
