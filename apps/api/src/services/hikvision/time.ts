/**
 * Timezone-aware helpers for device event timestamps.
 * Devices send either ISO-8601 timestamps (with offset/Z) or naive wall-clock
 * strings that must be interpreted in the device timezone (e.g. Africa/Kampala).
 */

export interface TzParts {
  date: string; // YYYY-MM-DD in tz
  hour: number;
  minute: number;
  second: number;
}

/** Wall-clock parts of a UTC instant rendered in `tz`. */
export function wallClock(utcMs: number, tz: string): TzParts {
  const dtf = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
  const parts = dtf.formatToParts(new Date(utcMs));
  const map: Record<string, string> = {};
  for (const p of parts) map[p.type] = p.value;
  const hour = Number(map.hour) % 24;
  return {
    date: `${map.year}-${map.month}-${map.day}`,
    hour,
    minute: Number(map.minute),
    second: Number(map.second),
  };
}

/** UTC offset (minutes east of UTC) in `tz` at a given UTC instant. */
export function tzOffsetMinutes(utcMs: number, tz: string): number {
  const wall = wallClock(utcMs, tz);
  const asUtc = Date.UTC(
    Number(wall.date.slice(0, 4)), Number(wall.date.slice(5, 7)) - 1, Number(wall.date.slice(8, 10)),
    wall.hour, wall.minute, wall.second
  );
  return Math.round((asUtc - utcMs) / 60000);
}

/** Local date key (YYYY-MM-DD) for a UTC instant rendered in `tz`. */
export function tzDateKey(utcMs: number, tz: string): string {
  return wallClock(utcMs, tz).date;
}

/**
 * Build a UTC ISO timestamp from a local date + time-of-day in `tz`.
 * timeOfDay accepts "HH:mm" or "HH:mm:ss".
 */
export function zonedDateTimeToUtc(dateKey: string, timeOfDay: string, tz: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey);
  if (!m) throw new Error('invalid date key');
  const t = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(timeOfDay.trim());
  if (!t) throw new Error('invalid time of day');
  const year = Number(m[1]); const month = Number(m[2]); const day = Number(m[3]);
  const hour = Number(t[1]) % 24; const minute = Number(t[2]); const second = Number(t[3] ?? 0);
  // Iterate twice: derive offset for the local wall time, then for the corrected
  // instant (handles offset transitions around DST).
  let guess = Date.UTC(year, month - 1, day, hour, minute, second);
  for (let i = 0; i < 2; i++) {
    const off = tzOffsetMinutes(guess, tz);
    guess = Date.UTC(year, month - 1, day, hour, minute, second) - off * 60000;
  }
  return new Date(guess).toISOString();
}

/** Try to parse a device-supplied timestamp to ISO-8601 UTC. */
export function parseDeviceTime(value: unknown, tz: string): { iso: string | null; raw: string | null; timezoneHint: boolean } {
  if (value === null || value === undefined || value === '') return { iso: null, raw: null, timezoneHint: false };
  if (typeof value === 'number' || /^\d{10,13}$/.test(String(value).trim())) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return { iso: null, raw: String(value), timezoneHint: false };
    const ms = String(value).trim().length <= 10 ? n * 1000 : n;
    return { iso: new Date(ms).toISOString(), raw: String(value), timezoneHint: true };
  }
  const s = String(value).trim();
  // ISO-8601 with explicit offset / Z
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/i.test(s)) {
    const iso = new Date(s.replace(' ', 'T')).toISOString();
    return Number.isNaN(Date.parse(iso)) ? { iso: null, raw: s, timezoneHint: false } : { iso, raw: s, timezoneHint: true };
  }
  // Naive wall clock "YYYY-MM-DD HH:mm[:ss]" interpreted in device timezone
  const naive = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(:\d{2})?)$/.exec(s);
  if (naive) {
    try {
      return { iso: zonedDateTimeToUtc(naive[1], naive[2], tz), raw: s, timezoneHint: false };
    } catch {
      return { iso: null, raw: s, timezoneHint: false };
    }
  }
  return { iso: null, raw: s, timezoneHint: false };
}

/** Shift start/end UTC instants for a local work date and shift times. */
export function shiftWindow(dateKey: string, startTime: string | null, endTime: string | null, tz: string):
  { startIso: string | null; endIso: string | null; overnight: boolean } {
  if (!startTime || !endTime) return { startIso: null, endIso: null, overnight: false };
  const [sh, sm] = startTime.split(':').map(Number);
  const [eh, em] = endTime.split(':').map(Number);
  const overnight = eh * 60 + em <= sh * 60 + sm;
  const startIso = zonedDateTimeToUtc(dateKey, startTime, tz);
  const endDay = overnight
    ? new Date(new Date(startIso).getTime() + 86400000).toISOString().slice(0, 10)
    : dateKey;
  const endIso = zonedDateTimeToUtc(endDay, endTime, tz);
  return { startIso, endIso, overnight };
}

/** Number of minutes between two ISO instants (rounded down). */
export function minutesBetween(aIso: string | null, bIso: string | null): number {
  if (!aIso || !bIso) return 0;
  return Math.max(0, Math.floor((Date.parse(bIso) - Date.parse(aIso)) / 60000));
}

export function isoOrNull(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}