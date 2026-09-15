/**
 * Normalisation of the two Equity notification envelopes into one record.
 *
 * The InstantPaymentNotification API publishes two inbound legs that mean the
 * same thing but are shaped differently:
 *
 *   POST /account-notification   (flat)
 *     { transactionReference, requestId, channelCode, timestamp,
 *       transactionAmount, currency, customerReference, customerName,
 *       customerMobileNumber, balance, narration, creditAccountIdentifier,
 *       organizationShortCode, tillNumber }
 *
 *   POST /till-notification      (nested)
 *     { header: { messageID, originatorConversationID, channelCode, timeStamp },
 *       requestPayload: { primaryData: { businessKey, businessKeyType },
 *         additionalData: { notificationData: { businessKey,
 *           businessKeyType, debitMSISDN, transactionAmt, transactionDate,
 *           transactionID, firstName, middleName, lastName, currency,
 *           narration, transactionType, balance } } } }
 *
 * Equity's field names differ between the two (transactionAmount vs transactionAmt,
 * customerMobileNumber vs debitMSISDN, timestamp vs transactionDate) and the till
 * leg's date is not ISO at all ("Mon May 19 13:30:54 EAT 2025"). Both envelopes
 * are therefore flattened into one alias map and read defensively: a field we do
 * not understand becomes null, it never throws. An unparsed notification still
 * has to be stored, because the raw payload is what an operator reconciles.
 */

/**
 * VALIDATION is never inferred from a payload: the optional OTC / agency
 * validation leg is an authorisation check the caller opts into by endpoint, so
 * the receiver forces the type rather than guessing it.
 */
export type EquityNotificationType = 'ACCOUNT' | 'TILL' | 'VALIDATION';

/** The canonical, storage-shaped view of one inbound notification. */
export interface EquityNotification {
  notificationType: EquityNotificationType;
  /** The bank's own transaction reference; the replay-defence key. */
  equityTransactionId: string | null;
  /** Per-message / per-conversation id, when the leg supplies one. */
  requestId: string | null;
  transactionReference: string | null;
  customerName: string | null;
  customerReference: string | null;
  customerMsisdn: string | null;
  amount: number | null;
  currency: string | null;
  narration: string | null;
  channelCode: string | null;
  tillNumber: string | null;
  organizationShortCode: string | null;
  creditAccountIdentifier: string | null;
  balance: number | null;
  /** ISO-8601 instant, or null when Equity sent something we cannot read. */
  transactionAt: string | null;
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/**
 * UTC offsets in minutes for the zone tokens a bank stamps into a textual
 * date. Equity's collection leg has been seen to send
 * "Mon Sep 14 13:30:54 EAT 2026"; an unrecognised token falls back to the
 * caller's default rather than silently assuming UTC and shifting the
 * transaction onto the wrong day, which would post a receipt into the wrong
 * financial period.
 */
const ZONE_OFFSETS: Record<string, number> = {
  EAT: 180, CAT: 120, WAT: 60, SAST: 120, GMT: 0, UTC: 0,
};

/** Default zone offset (EAT, UTC+3, the bank's home market). */
export const DEFAULT_UTC_OFFSET_MINUTES = 180;

export function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** Case-insensitive field read: Equity mixes timeStamp / timestamp / transactionID. */
function field(source: Record<string, unknown>, name: string): unknown {
  if (name in source) return source[name];
  const lower = name.toLowerCase();
  for (const key of Object.keys(source)) {
    if (key.toLowerCase() === lower) return source[key];
  }
  return undefined;
}

/** Trim to a non-empty string, or null. */
export function str(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s.length === 0 ? null : s;
}

/** Numeric parse that never throws and never invents a value. */
export function num(v: unknown): number | null {
  const s = str(v);
  if (s === null) return null;
  const n = Number(s.replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

function toIso(
  year: number, month: number, day: number,
  hour: number, minute: number, second: number,
  offsetMinutes: number
): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  if (hour > 23 || minute > 59 || second > 60) return null;
  const ms = Date.UTC(year, month - 1, day, hour, minute, second) - offsetMinutes * 60_000;
  const dt = new Date(ms);
  return Number.isNaN(dt.getTime()) ? null : dt.toISOString();
}

/**
 * Parse the date Equity sends, in any of the three shapes it actually uses:
 * compact `YYYYMMDDHHMM` (account leg, e.g. 202111110305), compact with seconds
 * `YYYYMMDDHHMMSS` (till header, e.g. 20250519133100) and the textual
 * "Mon May 19 13:30:54 EAT 2025" of the till notificationData.
 */
export function parseEquityTransactionDate(
  value: unknown,
  defaultOffsetMinutes: number = DEFAULT_UTC_OFFSET_MINUTES
): string | null {
  const raw = str(value);
  if (raw === null) return null;

  const compact = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?$/.exec(raw);
  if (compact) {
    return toIso(
      Number(compact[1]), Number(compact[2]), Number(compact[3]),
      Number(compact[4]), Number(compact[5]), compact[6] ? Number(compact[6]) : 0,
      defaultOffsetMinutes
    );
  }

  const textual = /^[A-Za-z]{3,9}\s+([A-Za-z]{3,9})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+([A-Za-z]{2,5})\s+(\d{4})$/.exec(raw);
  if (textual) {
    const month = MONTHS[textual[1].slice(0, 3).toLowerCase()];
    if (!month) return null;
    const zone = ZONE_OFFSETS[textual[6].toUpperCase()];
    return toIso(
      Number(textual[7]), month, Number(textual[2]),
      Number(textual[3]), Number(textual[4]), Number(textual[5]),
      zone ?? defaultOffsetMinutes
    );
  }

  // Anything already carrying a zone designator (ISO-8601) is unambiguous.
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(raw)) {
    const parsed = Date.parse(raw);
    if (!Number.isNaN(parsed)) return new Date(parsed).toISOString();
  }
  return null;
}

/**
 * Flatten either envelope into a single alias map. Precedence is lowest first,
 * so the till leg's notificationData - the part that actually carries the money
 * - wins over primaryData's echo of the same keys.
 */
function flatten(body: Record<string, unknown>): Record<string, unknown> {
  const asRecord = (v: unknown): Record<string, unknown> | null => (isRecord(v) ? v : null);
  const header = asRecord(field(body, 'header'));
  const payload = asRecord(field(body, 'requestPayload'));
  const primary = payload ? asRecord(field(payload, 'primaryData')) : null;
  const additional = payload ? asRecord(field(payload, 'additionalData')) : null;
  const notification = additional ? asRecord(field(additional, 'notificationData')) : null;

  const out: Record<string, unknown> = {};
  for (const source of [body, header, primary, additional, notification]) {
    if (!source) continue;
    for (const key of Object.keys(source)) out[key] = source[key];
  }
  return out;
}

/** Read one notification body into its storage shape. Null when unusable. */
export function normalizeEquityNotification(
  body: unknown,
  opts: { defaultOffsetMinutes?: number; notificationType?: EquityNotificationType } = {}
): EquityNotification | null {
  if (!isRecord(body)) return null;
  const bag = flatten(body);
  const notificationType: EquityNotificationType =
    opts.notificationType ??
    (isRecord(field(body, 'header')) || isRecord(field(body, 'requestPayload')) ? 'TILL' : 'ACCOUNT');

  const first = (...names: string[]): string | null => {
    for (const name of names) {
      const v = str(field(bag, name));
      if (v !== null) return v;
    }
    return null;
  };
  const numFirst = (...names: string[]): number | null => {
    for (const name of names) {
      const v = num(field(bag, name));
      if (v !== null) return v;
    }
    return null;
  };

  const nameParts = [first('firstName'), first('middleName'), first('lastName')]
    .filter((p): p is string => p !== null);
  const offset = opts.defaultOffsetMinutes ?? DEFAULT_UTC_OFFSET_MINUTES;

  return {
    notificationType,
    // The account leg sends no transactionID at all, so its bank reference is
    // the only thing that can stop a Equity retry becoming a second ledger line.
    equityTransactionId: first('transactionID', 'transactionId', 'transactionReference'),
    requestId: notificationType === 'TILL'
      ? first('originatorConversationID')
      : first('requestId'),
    transactionReference: first('transactionReference', 'transactionID', 'transactionId'),
    customerName: first('customerName') ?? (nameParts.length > 0 ? nameParts.join(' ') : null),
    customerReference: first('customerReference', 'businessKey'),
    customerMsisdn: first('customerMobileNumber', 'debitMSISDN'),
    amount: numFirst('transactionAmount', 'transactionAmt'),
    currency: first('currency'),
    narration: first('narration'),
    channelCode: first('channelCode'),
    tillNumber: first('tillNumber'),
    organizationShortCode: first('organizationShortCode'),
    creditAccountIdentifier: first('creditAccountIdentifier'),
    balance: numFirst('balance'),
    transactionAt: parseEquityTransactionDate(
      first('transactionDate') ?? first('timestamp') ?? first('timeStamp'),
      offset
    ),
  };
}
