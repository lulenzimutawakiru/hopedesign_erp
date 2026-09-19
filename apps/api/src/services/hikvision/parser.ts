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

export type PayloadFormat = 'JSON' | 'XML' | 'FORM' | 'MULTIPART' | 'UNKNOWN';

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
const TIME_ALIASES = [
  'dateTime', 'DateTime', 'eventTime', 'EventTime', 'time', 'Time',
  'recordTime', 'RecordTime', 'happenedTime', 'HappenedTime',
];
const TYPE_ALIASES = ['eventType', 'event', 'attendanceStatus', 'accessStatus', 'EventType', 'AttendanceStatus', 'AccessStatus'];
const DEVICE_ALIASES = ['deviceName', 'DeviceName', 'name'];

/** Hikvision serialises absent values as the literal strings below. */
const ABSENT_VALUES = new Set(['undefined', 'null', 'nil', 'n/a', 'na', 'none', '-']);

/**
 * Hikvision nests the meaningful access-control fields inside an
 * `AccessControllerEvent` container, and the multipart part itself is usually
 * named `AccessControllerEvent`. Hoist nested members to the top level so the
 * alias lookups below see them regardless of how deep the device nested them.
 */
const EVENT_CONTAINER_KEYS = [
  'AccessControllerEvent', 'accessControllerEvent',
  'EventNotificationAlert', 'eventNotificationAlert',
  'EventInfo', 'eventInfo', 'Event', 'event',
];

function pick(obj: Record<string, unknown>, aliases: string[]): { key: string; value: unknown } | null {
  for (const a of aliases) {
    if (obj[a] !== undefined && obj[a] !== null && String(obj[a]).trim() !== '') return { key: a, value: obj[a] };
  }
  return null;
}

function toStringOrNull(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (s === '' || ABSENT_VALUES.has(s.toLowerCase())) return null;
  return s;
}

/** Flatten nested Hikvision event containers (up to three levels deep). */
export function hoistEventFields(input: Record<string, unknown>): Record<string, unknown> {
  const fields: Record<string, unknown> = { ...input };
  for (let depth = 0; depth < 3; depth += 1) {
    let changed = false;
    for (const key of EVENT_CONTAINER_KEYS) {
      const nested = fields[key];
      if (!nested || typeof nested !== 'object' || Array.isArray(nested)) continue;
      for (const [childKey, childValue] of Object.entries(nested as Record<string, unknown>)) {
        if (fields[childKey] === undefined) {
          fields[childKey] = childValue;
          changed = true;
        }
      }
    }
    if (!changed) break;
  }
  return fields;
}

export interface MultipartResult {
  /** Flattened event fields, ready for the alias lookups. */
  fields: Record<string, unknown>;
  /** Raw part-name -> part-value map, preserved for diagnostics. */
  raw: Record<string, unknown>;
}

/**
 * Decode a Hikvision multipart/form-data push. The HTTP listening host posts
 * one JSON part per event (named `AccessControllerEvent`), so a small,
 * dependency-free reader is enough and avoids adding a multipart middleware.
 */
export function parseMultipartBody(buffer: Buffer | string, contentType: string): MultipartResult | null {
  const boundaryMatch = /boundary\s*=\s*"?([^";,\s]+)"?/i.exec(String(contentType ?? ''));
  if (!boundaryMatch) return null;
  const delimiter = `--${boundaryMatch[1]}`;
  const text = typeof buffer === 'string' ? buffer : buffer.toString('utf8');
  const raw: Record<string, unknown> = {};
  for (const chunk of text.split(delimiter)) {
    const sep = chunk.includes('\r\n\r\n') ? '\r\n\r\n' : chunk.includes('\n\n') ? '\n\n' : null;
    if (!sep) continue;
    const idx = chunk.indexOf(sep);
    const head = chunk.slice(0, idx);
    const bodyText = chunk.slice(idx + sep.length).replace(/\r?\n--\s*$/, '').trim();
    if (!bodyText) continue;
    const nameMatch = /name\s*=\s*"([^"]+)"/i.exec(head) ?? /name\s*=\s*([^;\r\n]+)/i.exec(head);
    if (!nameMatch) continue;
    const name = nameMatch[1].trim();
    if (!name) continue;
    let value: unknown = bodyText;
    if (bodyText.startsWith('{') || bodyText.startsWith('[')) {
      try {
        value = JSON.parse(bodyText);
      } catch {
        value = bodyText;
      }
    }
    raw[name] = value;
  }
  if (Object.keys(raw).length === 0) return null;
  // Merge every object part into one flat namespace; the part name is kept so
  // the raw stored payload still shows which container the device used.
  const merged: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
        if (merged[childKey] === undefined) merged[childKey] = childValue;
      }
    }
    merged[name] = value;
  }
  return { fields: hoistEventFields(merged), raw };
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

  if (ct.includes('multipart/form-data') && body && typeof body === 'object' && !Array.isArray(body)) {
    format = 'MULTIPART';
    fields = hoistEventFields(body as Record<string, unknown>);
  } else if (body && typeof body === 'object' && !Array.isArray(body)) {
    format = 'JSON';
    fields = hoistEventFields(body as Record<string, unknown>);
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
      fields = hoistEventFields(JSON.parse(body) as Record<string, unknown>);
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
