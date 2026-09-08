/**
 * Payload parsing + normalization for Hikvision event webhooks.
 *
 * Accepted formats:
 *  - JSON (object or array)
 *  - XML  (Hikvision ISAPI style <EventNotificationAlert> trees)
 *  - FORM (application/x-www-form-urlencoded)
 *
 * XML is parsed with a strict, entity-free extractor: the DOCTYPE is rejected
 * and only leaf text is collected, so DTDs/external entities cannot influence
 * parsing (XXE safe by construction).
 */
import { badRequest } from '../../utils.js';
import { parseDeviceTime } from './time.js';

export type PayloadFormat = 'JSON' | 'XML' | 'FORM' | 'UNKNOWN';

export interface ParsedEvent {
  format: PayloadFormat;
  /** Canonical employee identifier (employeeNoString / employeeNo / cardNo). */
  employeeIdentifier: string | null;
  /** Canonical UTC ISO event time, when derivable. */
  eventTimeIso: string | null;
  timeRaw: string | null;
  eventTypeRaw: string | null;
  verifyRaw: string | null;
  serialRaw: string | null;
  deviceName: string | null;
  accessStatus: string | null;
  attendanceStatus: string | null;
  /** All extracted fields preserved verbatim for raw storage + diagnostics. */
  fields: Record<string, unknown>;
}

const VERIFY_ALIASES = ['verifyNo', 'verifyMode', 'verificationMethod', 'verifyMethod', 'verifyType', 'VerifyNo', 'VerifyMode'];
const SERIAL_ALIASES = ['serialNo', 'serialNumber', 'deviceSerial', 'SerialNo', 'SerialNumber'];
const EMP_ALIASES = ['employeeNoString', 'employeeNo', 'employeeNumber', 'empNo', 'cardNo', 'EmployeeNoString', 'EmployeeNo', 'CardNo', 'personId', 'employeeID'];
const TIME_ALIASES = ['time', 'eventTime', 'recordTime', 'Time', 'EventTime'];
const TYPE_ALIASES = ['eventType', 'event', 'attendanceStatus', 'accessStatus', 'EventType', 'AttendanceStatus', 'AccessStatus'];
const DEVICE_ALIASES = ['deviceName', 'DeviceName', 'name'];

function pick(obj: Record<string, unknown>, aliases: string[]): { key: string; value: unknown } | null {
  for (const a of aliases) {
    if (obj[a] !== undefined && obj[a] !== null && String(obj[a]).trim() !== '') return { key: a, value: obj[a] };
  }
  return null;
}

function toStringOrNull(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

/** Collect XML leaf nodes (element path -> first text value). */
export function xmlToFlat(xml: string): Record<string, unknown> {
  if (/<!DOCTYPE/i.test(xml)) throw badRequest('XML payload must not declare a DOCTYPE');
  const out: Record<string, unknown> = {};
  const text: string[] = [];
  const stack: string[] = [];
  const nameRe = /[A-Za-z_][A-Za-z0-9_.:-]*/;
  const re = /<\s*(\/)?\s*([A-Za-z_][A-Za-z0-9_.:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)\s*(\/)?>|([^<]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const full = m[0];
    if (full.startsWith('<') === false && text.length === 0 && stack.length === 0) {
      // Leading plain text (whitespace / prolog) â€“ ignore.
      continue;
    }
    const closing = m[1];
    const tag = m[2];
    const selfClose = m[4];
    const body = m[5];
    if (body !== undefined) {
      const t = body.replace(/\s+/g, ' ').trim();
      if (t) text.push(t);
      continue;
    }
    if (!tag) continue;
    if (closing) {
      const leaf = text.splice(text.length - (text.length > 0 ? 1 : 0), 1)[0];
      const path = stack.join('/') + '/' + tag;
      if (leaf !== undefined && out[path] === undefined) out[path] = leaf;
      stack.pop();
      continue;
    }
    if (selfClose) {
      const path = [...stack, tag].join('/');
      if (out[path] === undefined) out[path] = '';
      continue;
    }
    stack.push(tag);
    text.push('');
  }
  return out;
}

/** Flatten nested XML output to leaf tags (last path segment). */
function xmlLeaves(flat: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [path, value] of Object.entries(flat)) {
    const seg = path.split('/').filter(Boolean);
    const key = seg[seg.length - 1] ?? path;
    if (out[key] === undefined) out[key] = value;
  }
  return out;
}

function parseFormBody(body: unknown): Record<string, unknown> {
  if (body && typeof body === 'object') return { ...(body as Record<string, unknown>) };
  const out: Record<string, unknown> = {};
  const s = String(body ?? '');
  for (const pair of s.split('&')) {
    const eq = pair.indexOf('=');
    if (eq > 0) {
      const k = decodeURIComponent(pair.slice(0, eq).replace(/\+/g, ' '));
      const v = decodeURIComponent(pair.slice(eq + 1).replace(/\+/g, ' '));
      if (!(k in out)) out[k] = v;
    }
  }
  return out;
}

/** Parse + normalize an inbound payload into the canonical event model. */
export function parseEventPayload(body: unknown, contentType: string, timezone: string): ParsedEvent {
  let format: PayloadFormat;
  let fields: Record<string, unknown> = {};
  const ct = String(contentType ?? '').toLowerCase();

  if (body && typeof body === 'object' && !Array.isArray(body)) {
    format = 'JSON';
    fields = { ...(body as Record<string, unknown>) };
  } else if (ct.includes('application/xml') || ct.includes('text/xml')) {
    format = 'XML';
    const xml = String(body ?? '');
    if (xml.trim() === '') throw badRequest('Empty XML payload');
    fields = xmlLeaves(xmlToFlat(xml));
  } else if (ct.includes('application/x-www-form-urlencoded')) {
    format = 'FORM';
    fields = parseFormBody(body);
  } else if (typeof body === 'string' && body.trim().startsWith('<')) {
    format = 'XML';
    fields = xmlLeaves(xmlToFlat(body));
  } else if (typeof body === 'string' && body.trim().startsWith('{')) {
    format = 'JSON';
    try {
      fields = JSON.parse(body) as Record<string, unknown>;
    } catch {
      throw badRequest('Invalid JSON payload');
    }
  } else {
    format = 'UNKNOWN';
  }

  // A payload that carried no recognizable content (empty object, empty form,
  // whitespace-only XML) is not an event; reject it before it is stored.
  if (format !== 'UNKNOWN' && Object.keys(fields).length === 0) {
    throw badRequest('Invalid event payload');
  }

  const empHit = pick(fields, EMP_ALIASES);
  const timeHit = pick(fields, TIME_ALIASES);
  const typeHit = pick(fields, TYPE_ALIASES);
  const verifyHit = pick(fields, VERIFY_ALIASES);
  const serialHit = pick(fields, SERIAL_ALIASES);
  const devHit = pick(fields, DEVICE_ALIASES);

  const parsedTime = parseDeviceTime(timeHit?.value ?? null, timezone);

  // Some devices post eventType that doubles as the access outcome.
  const evt = toStringOrNull(typeHit?.value);
  const acc = toStringOrNull(pick(fields, ['accessStatus', 'AccessStatus'])?.value);
  const att = toStringOrNull(pick(fields, ['attendanceStatus', 'AttendanceStatus'])?.value);

  return {
    format,
    employeeIdentifier: toStringOrNull(empHit?.value),
    eventTimeIso: parsedTime.iso,
    timeRaw: parsedTime.raw,
    eventTypeRaw: evt ?? acc ?? att ?? null,
    verifyRaw: toStringOrNull(verifyHit?.value),
    serialRaw: toStringOrNull(serialHit?.value),
    deviceName: toStringOrNull(devHit?.value),
    accessStatus: acc,
    attendanceStatus: att,
    fields,
  };
}

/** Access outcome helpers used during classification. */
export function looksLikeDenied(fields: Record<string, unknown>): boolean {
  const s = JSON.stringify(fields).toLowerCase();
  return s.includes('denied') || s.includes('fail') || /"status"\s*:\s*"?[012]"?/.test(s) === false;
}