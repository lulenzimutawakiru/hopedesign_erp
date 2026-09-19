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
/**
 * Device-serial aliases. `serialNo`/`SerialNo` are deliberately excluded: in
 * access-control payloads they are the per-event sequence counter
 * (`serialNo: 217`, `frontSerialNo: 216`), never the device serial. Hoisting
 * them would make the payload/source cross-check in ingest.ts compare an event
 * counter against the authenticated serial and reject every real event.
 */
const SERIAL_ALIASES = ['serialNumber', 'SerialNumber', 'deviceSerial', 'deviceSerialNumber'];
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

/** Container nesting is walked to this depth; production payloads nest two deep. */
const MAX_CONTAINER_DEPTH = 16;

const CONTAINER_KEY_SET = new Set(EVENT_CONTAINER_KEYS);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Flatten nested Hikvision event containers so the alias lookups below see the
 * identity fields however deep the device buried them.
 *
 * The DS-K1T terminal we integrate with emits
 * `AccessControllerEvent.AccessControllerEvent.employeeNoString`: an outer
 * container that repeats its own name for the inner, event-specific object.
 * A single-level merge stops at the outer container, never reaches the inner
 * one, and silently turns every real punch into an unmapped event with no
 * employee number (which also disabled dedupe and left punch rows at zero).
 *
 * Scalars are hoisted inner-most-wins: a member found deeper overwrites a
 * same-named member from a shallower container, because the deeper one is the
 * event-specific value. The outermost container is kept under its own key for
 * diagnostics and never overwrites a flattened member.
 */
export function hoistEventFields(input: Record<string, unknown>): Record<string, unknown> {
  const fields: Record<string, unknown> = {};

  const walk = (obj: Record<string, unknown>, depth: number): void => {
    if (depth > MAX_CONTAINER_DEPTH) return;
    for (const [key, value] of Object.entries(obj)) {
      if (isPlainObject(value) && CONTAINER_KEY_SET.has(key)) {
        // Hoist the container's members first so deeper values win...
        walk(value, depth + 1);
        // ...then keep the outermost container for diagnostics.
        if (fields[key] === undefined) fields[key] = value;
        continue;
      }
      if (isPlainObject(value)) {
        // A non-container object is opaque: keep the first one we meet.
        if (fields[key] === undefined) fields[key] = value;
        continue;
      }
      fields[key] = value;
    }
  };

  walk(input, 0);
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
/** Postgres `jsonb` rejects the NUL escape; strip NULs from everything we persist. */
export function stripNul(value: string): string {
  return value.includes('\u0000') ? value.split('\u0000').join('') : value;
}

/** Recursively strip NUL characters so a payload is always safe for `jsonb`. */
export function sanitizeForJson<T>(value: T): T {
  if (typeof value === 'string') return stripNul(value) as unknown as T;
  if (Array.isArray(value)) return value.map((entry) => sanitizeForJson(entry)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[stripNul(key)] = sanitizeForJson(entry);
    }
    return out as unknown as T;
  }
  return value;
}

/** Case-insensitive byte search; the terminal's boundary casing is unreliable. */
function indexOfBytesCi(haystack: Buffer, needle: Buffer, from: number): number {
  const lower = (b: number) => (b >= 0x41 && b <= 0x5a ? b + 0x20 : b);
  const first = needle[0];
  const firstLower = lower(first);
  outer: for (let i = Math.max(0, from); i <= haystack.length - needle.length; i += 1) {
    const b = haystack[i];
    if (b !== first && b !== firstLower) continue;
    for (let let_j = 1; let_j < needle.length; let_j += 1) {
      if (lower(haystack[i + let_j]) !== lower(needle[let_j])) continue outer;
    }
    return i;
  }
  return -1;
}

/** Split the raw body on `--boundary`, returning the bytes between delimiters. */
function splitMultipartChunks(buffer: Buffer, delimiter: string): Buffer[] {
  const needle = Buffer.from(`--${delimiter}`, 'latin1');
  const positions: number[] = [];
  let from = 0;
  for (;;) {
    const idx = indexOfBytesCi(buffer, needle, from);
    if (idx < 0) break;
    positions.push(idx);
    from = idx + needle.length;
  }
  const chunks: Buffer[] = [];
  for (let i = 0; i < positions.length; i += 1) {
    const start = positions[i] + needle.length;
    const end = i + 1 < positions.length ? positions[i + 1] : buffer.length;
    chunks.push(buffer.subarray(start, end));
  }
  return chunks;
}

const CRLFCRLF = Buffer.from('\r\n\r\n');
const LFLF = Buffer.from('\n\n');

/** Drop the CRLF that separates a part body from the following boundary. */
function trimPartTail(body: Buffer): Buffer {
  let end = body.length;
  if (end >= 2 && body[end - 2] === 0x0d && body[end - 1] === 0x0a) end -= 2;
  else if (end >= 1 && body[end - 1] === 0x0a) end -= 1;
  return body.subarray(0, end);
}

function partName(head: string): string | null {
  const m = /name\s*=\s*"([^"]+)"/i.exec(head) ?? /name\s*=\s*([^;\r\n]+)/i.exec(head);
  const name = m?.[1]?.trim();
  return name ? name : null;
}

function partContentType(head: string): string | null {
  const m = /content-type\s*:\s*([^;\r\n]+)/i.exec(head);
  const value = m?.[1]?.trim();
  return value ? value.toLowerCase() : null;
}

const TEXT_PART_TYPE = /^(text\/|application\/(json|xml|x-www-form-urlencoded|problem\+json))/i;
const BINARY_PART_TYPE = /^(image\/|audio\/|video\/|application\/(octet-stream|pdf|zip))/i;

/**
 * A JPEG snapshot (pictureURLType=binary) arrives as a binary part. Decoding
 * its bytes as UTF-8 turns them into replacement characters and NUL bytes,
 * and Postgres `jsonb` rejects \u0000 outright - so keep it as a descriptor.
 */
function isBinaryPart(name: string, type: string | null, body: Buffer): boolean {
  if (body.includes(0)) return true;
  if (type && BINARY_PART_TYPE.test(type)) return true;
  if (type && !TEXT_PART_TYPE.test(type)) return true;
  if (!type && /picture|image|photo|snap|face|finger/i.test(name)) return true;
  return false;
}

/** Decode a text part: prefer JSON, recovering a JSON literal from stray delimiters. */
function decodeTextPart(bodyText: string): unknown {
  if (bodyText.startsWith('{') || bodyText.startsWith('[')) {
    try {
      return JSON.parse(bodyText);
    } catch {
      const start = bodyText.search(/[{[]/);
      const end = Math.max(bodyText.lastIndexOf('}'), bodyText.lastIndexOf(']'));
      if (start >= 0 && end > start) {
        try {
          return JSON.parse(bodyText.slice(start, end + 1));
        } catch {
          return bodyText;
        }
      }
      return bodyText;
    }
  }
  return bodyText;
}

export function parseMultipartBody(buffer: Buffer | string, contentType: string): MultipartResult | null {
  const boundaryMatch = /boundary\s*=\s*"?([^";,\s]+)"?/i.exec(String(contentType ?? ''));
  if (!boundaryMatch) return null;
  const delimiter = boundaryMatch[1];
  const bytes = typeof buffer === 'string' ? Buffer.from(buffer, 'utf8') : buffer;
  const raw: Record<string, unknown> = {};
  // The terminal advertises the boundary as `mime_boundary` but actually
  // delimits the body with `MIME_boundary`, so the split must ignore case.
  for (const chunk of splitMultipartChunks(bytes, delimiter)) {
    const crlfAt = chunk.indexOf(CRLFCRLF);
    const lfAt = crlfAt >= 0 ? -1 : chunk.indexOf(LFLF);
    const idx = crlfAt >= 0 ? crlfAt : lfAt;
    if (idx < 0) continue;
    const sepLen = crlfAt >= 0 ? 4 : 2;
    const head = chunk.subarray(0, idx).toString('latin1');
    const bodyBytes = trimPartTail(chunk.subarray(idx + sepLen));
    if (bodyBytes.length === 0) continue;
    const name = partName(head);
    if (!name) continue;
    const partType = partContentType(head);
    if (isBinaryPart(name, partType, bodyBytes)) {
      raw[name] = { binary: true, contentType: partType ?? 'application/octet-stream', bytes: bodyBytes.length };
      continue;
    }
    const bodyText = stripNul(bodyBytes.toString('utf8')).trim();
    if (!bodyText) continue;
    raw[name] = decodeTextPart(bodyText);
  }
  if (Object.keys(raw).length === 0) return null;
  // Merge every object part into one flat namespace; the part name is kept so
  // the raw stored payload still shows which container the device used.
  const merged: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      if ((value as { binary?: boolean }).binary) continue; // diagnostics only
      for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
        if (merged[childKey] === undefined) merged[childKey] = childValue;
      }
      // Keep the container for diagnostics, but never let the part name
      // overwrite a member just flattened out of it: the part is named
      // `AccessControllerEvent` and nests a second `AccessControllerEvent`
      // that holds the employee identity, so an unconditional assignment here
      // hides the employee number behind the outer container.
      if (merged[name] === undefined) merged[name] = value;
    } else {
      merged[name] = value;
    }
  }
  return { fields: hoistEventFields(sanitizeForJson(merged)), raw: sanitizeForJson(raw) };
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
