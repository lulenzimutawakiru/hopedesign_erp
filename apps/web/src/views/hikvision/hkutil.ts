export function qs(p: Record<string, unknown>): string {
  const u = new URLSearchParams();
  Object.entries(p).forEach(([k, v]) => {
    if (v === undefined || v === null || v === '') return;
    u.set(k, String(v));
  });
  const s = u.toString();
  return s ? '?' + s : '';
}

export function isoToday(): string {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

export function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

export function monthRange(month: string): { from: string; to: string } {
  const parts = month.split('-');
  if (parts.length !== 2) return { from: isoDaysAgo(30), to: isoToday() };
  const y = Number(parts[0]);
  const m = Number(parts[1]);
  const last = new Date(y, m, 0);
  const pad = (n: number) => String(n).padStart(2, '0');
  return {
    from: y + '-' + pad(m) + '-01',
    to: y + '-' + pad(m) + '-' + pad(last.getDate()),
  };
}

export function toLocalInput(d: Date): string {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

export function toLocalDateTimeInput(d: Date): string {
  return toLocalInput(d) + 'T' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

export function toIso(v: string): string | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function commaList(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (Array.isArray(v)) return v.join(', ');
  return String(v);
}
