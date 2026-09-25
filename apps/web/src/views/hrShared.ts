/**
 * Types and formatters shared by the People views.
 *
 * These live outside HrFlow so that views split out of the old monolithic
 * HrFlow.tsx can import them without pulling in the whole flow module.
 */
export type Rec = Record<string, unknown>;

/** Renders any date-ish value as an ISO day, or an em dash when absent. */
export function shortDate(v: unknown): string {
  if (!v) return '—';
  return String(v).slice(0, 10);
}
