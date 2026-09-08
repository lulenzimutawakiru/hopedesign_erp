/**
 * Attendance calculation engine + punch classification for Hikvision events.
 * Pure functions: deterministic, unit-testable, no DB access.
 */

export const VERIFICATION_METHODS = ['FACE', 'CARD', 'FINGERPRINT', 'PASSWORD', 'QR', 'UNKNOWN'] as const;
export type VerificationMethod = (typeof VERIFICATION_METHODS)[number];

export const PUNCH_TYPES = [
  'CHECK_IN', 'CHECK_OUT', 'BREAK_START', 'BREAK_END',
  'ACCESS_GRANTED', 'ACCESS_DENIED', 'UNKNOWN',
] as const;
export type PunchType = (typeof PUNCH_TYPES)[number];

export interface ShiftLike {
  startTime: string | null;
  endTime: string | null;
  graceMinutes: number;
  breakMinutes: number;
}

export interface MetricsInput extends ShiftLike {
  scheduledStartIso: string | null;
  scheduledEndIso: string | null;
  checkInIso: string | null;
  checkOutIso: string | null;
  breakStartIso: string | null;
  breakEndIso: string | null;
}

export interface AttendanceMetrics {
  scheduledMinutes: number;
  actualMinutes: number;
  workedMinutes: number;
  breakDurationMinutes: number;
  lateMinutes: number;
  earlyDepartureMinutes: number;
  overtimeMinutes: number;
  undertimeMinutes: number;
  attendanceStatus: string;
}

const MIN = 60000;
const clamp = (n: number) => Math.max(0, Math.round(n));

export function diffMinutes(aIso: string | null, bIso: string | null): number | null {
  if (!aIso || !bIso) return null;
  return Math.round((Date.parse(bIso) - Date.parse(aIso)) / MIN);
}

/** Map a raw Hikvision verify value (string/number label) to a canonical method. */
export function classifyVerification(raw: unknown): VerificationMethod {
  if (raw === null || raw === undefined || raw === '') return 'UNKNOWN';
  const s = String(raw).trim().toLowerCase();
  if (!s || s === '0' || s === 'unknown' || s === 'none') return 'UNKNOWN';
  const table: [RegExp, VerificationMethod][] = [
    [/face|visitor|recog/i, 'FACE'],
    [/card|rfid|ic\b|id\b|swipe/i, 'CARD'],
    [/finger|fp|biometric/i, 'FINGERPRINT'],
    [/qr\b|qrcode|2d\b/i, 'QR'],
    [/pass|pin|pswd|pwd/i, 'PASSWORD'],
  ];
  for (const [re, method] of table) if (re.test(s)) return method;
  // Hikvision verifyNo integer conventions (device dependent):
  const n = Number(s);
  if (Number.isInteger(n)) {
    if (n === 1) return 'FINGERPRINT';
    if (n === 2) return 'FACE';
    if (n === 3) return 'CARD';
    if (n === 4 || n === 5) return 'PASSWORD';
    if (n === 6 || n === 7) return 'QR';
  }
  return 'UNKNOWN';
}

export interface ClassifyContext {
  devicePurpose: string;
  rawEventType: string | null;
  accessStatus: string | null;
  attendanceStatus: string | null;
  /** Number of attendance punches already recorded for the day (before this one). */
  punchCountToday: number;
  hasCheckIn: boolean;
  hasCheckOut: boolean;
  lastPunchType: string | null;
}

export function classifyPunch(ctx: ClassifyContext): { eventType: PunchType; reason: string } {
  const raw = [ctx.rawEventType, ctx.accessStatus, ctx.attendanceStatus]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  const purpose = String(ctx.devicePurpose ?? '').toUpperCase();

  // 1) Explicit access denial always wins.
  if (/denied|reject|fail/i.test(raw) && !/grant/i.test(raw)) {
    return { eventType: 'ACCESS_DENIED', reason: `access denial signalled (${raw.trim()})` };
  }

  // 2) Break terminals.
  if (purpose === 'BREAK_ENTRY') return { eventType: 'BREAK_START', reason: 'device purpose BREAK_ENTRY' };
  if (purpose === 'BREAK_EXIT') return { eventType: 'BREAK_END', reason: 'device purpose BREAK_EXIT' };

  // 3) Directional gate terminals.
  if (purpose === 'ENTRY') return { eventType: 'CHECK_IN', reason: 'device purpose ENTRY (gate-in terminal)' };
  if (purpose === 'EXIT') return { eventType: 'CHECK_OUT', reason: 'device purpose EXIT (gate-out terminal)' };

  // 4) Dedicated attendance terminal: alternate in/out punches (1st = IN, 2nd = OUT).
  if (purpose === 'ATTENDANCE') {
    const attendancePunches = ctx.punchCountToday + (ctx.hasCheckOut && !ctx.hasCheckIn ? 1 : 0);
    const isEven = attendancePunches % 2 === 0;
    return {
      eventType: isEven ? 'CHECK_IN' : 'CHECK_OUT',
      reason: `attendance terminal alternation (punch ${attendancePunches + 1} of the day)`,
    };
  }

  // 5) Access-oriented purposes default to ACCESS_GRANTED.
  if (purpose === 'PRODUCTION' || purpose === 'WAREHOUSE' || purpose === 'SECURE_AREA') {
    return { eventType: 'ACCESS_GRANTED', reason: `access terminal purpose ${purpose}` };
  }

  // 6) Payload-driven fallback.
  if (/out|exit|leave|off-duty/i.test(raw) && /check|attendance|in|out/i.test(raw)) {
    return { eventType: 'CHECK_OUT', reason: 'payload event indicates checkout' };
  }
  if (/in|entry|arrive|on-duty|check/i.test(raw)) {
    return { eventType: 'CHECK_IN', reason: 'payload event indicates check-in' };
  }
  if (/grant|pass|allow|success/i.test(raw)) {
    return { eventType: 'ACCESS_GRANTED', reason: 'payload event indicates access granted' };
  }
  return { eventType: 'UNKNOWN', reason: `unclassifiable payload event (${raw.trim() || 'no type'})` };
}

export function isAttendancePunch(t: string): boolean {
  return t === 'CHECK_IN' || t === 'CHECK_OUT' || t === 'BREAK_START' || t === 'BREAK_END';
}

/** Derive full attendance metrics for a record. */
export function computeMetrics(input: MetricsInput): AttendanceMetrics {
  const scheduledMinutes = diffMinutes(input.scheduledStartIso, input.scheduledEndIso) ?? 0;
  const rawScheduled = Math.max(0, scheduledMinutes - Math.max(0, Math.round(input.breakMinutes || 0)));

  const actualMinutes = diffMinutes(input.checkInIso, input.checkOutIso) ?? 0;

  // Explicit break punches win; otherwise fall back to the shift's configured break.
  const explicitBreak = diffMinutes(input.breakStartIso, input.breakEndIso);
  const breakDuration = explicitBreak ?? Math.min(Math.max(0, Math.round(input.breakMinutes || 0)), actualMinutes);
  const workedMinutes = Math.max(0, actualMinutes - breakDuration);

  const startMs = input.scheduledStartIso ? Date.parse(input.scheduledStartIso) : null;
  const endMs = input.scheduledEndIso ? Date.parse(input.scheduledEndIso) : null;
  const inMs = input.checkInIso ? Date.parse(input.checkInIso) : null;
  const outMs = input.checkOutIso ? Date.parse(input.checkOutIso) : null;

  let lateMinutes = 0;
  if (startMs !== null && inMs !== null) {
    lateMinutes = clamp((inMs - (startMs + Math.max(0, Math.round(input.graceMinutes || 0)) * MIN)) / MIN);
  }
  let earlyDepartureMinutes = 0;
  if (endMs !== null && outMs !== null && outMs < endMs) {
    earlyDepartureMinutes = clamp((endMs - outMs) / MIN);
  }
  let overtimeMinutes = 0;
  if (endMs !== null && outMs !== null && outMs > endMs) {
    overtimeMinutes = clamp((outMs - endMs) / MIN);
  }
  const undertimeMinutes = outMs !== null ? Math.max(0, rawScheduled - workedMinutes) : 0;

  let attendanceStatus = 'PRESENT';
  if (!input.checkInIso || !input.checkOutIso) {
    attendanceStatus = 'PRESENT'; // partial day; missing-punch exceptions are raised separately
  } else if (lateMinutes > 0) {
    attendanceStatus = 'LATE';
  } else if (earlyDepartureMinutes > 0) {
    attendanceStatus = 'EARLY_DEPARTURE';
  }

  return {
    scheduledMinutes: rawScheduled,
    actualMinutes,
    workedMinutes,
    breakDurationMinutes: breakDuration,
    lateMinutes,
    earlyDepartureMinutes,
    overtimeMinutes,
    undertimeMinutes,
    attendanceStatus,
  };
}

/** Human readable duration, e.g. 507 -> '8h 27m'. */
export function minutesToText(minutes: number | null | undefined): string {
  const m = Math.max(0, Math.round(Number(minutes ?? 0)));
  const h = Math.floor(m / 60);
  const r = m % 60;
  return h > 0 ? `${h}h ${r}m` : `${r}m`;
}