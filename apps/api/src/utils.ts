import { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'node:crypto';

export class ApiError extends Error {
  status: number;
  code: string;
  details?: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (msg: string, details?: unknown) => new ApiError(400, 'BAD_REQUEST', msg, details);
export const unauthorized = (msg = 'Authentication required') => new ApiError(401, 'UNAUTHORIZED', msg);
export const forbidden = (msg = 'Access denied') => new ApiError(403, 'FORBIDDEN', msg);
export const notFound = (msg = 'Not found') => new ApiError(404, 'NOT_FOUND', msg);
export const conflict = (msg: string) => new ApiError(409, 'CONFLICT', msg);

export type AsyncHandler = (req: Request, res: Response, next: NextFunction) => Promise<unknown>;

export const asyncHandler = (fn: AsyncHandler) => (req: Request, res: Response, next: NextFunction) => {
  fn(req, res, next).catch(next);
};

export const correlationId = () => randomUUID();

export const parsePagination = (query: Record<string, unknown>) => {
  const page = Math.max(1, Number(query.page) || 1);
  const pageSize = Math.min(500, Math.max(1, Number(query.pageSize) || 25));
  return { page, pageSize, offset: (page - 1) * pageSize };
};

export const camelToSnake = (s: string) => s.replace(/[A-Z]/g, (m) => '_' + m.toLowerCase());

export const snakeToCamel = (s: string) => s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

export const toCamelRow = (row: Record<string, unknown>): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) out[snakeToCamel(k)] = v;
  return out;
};

export const toCamelRows = (rows: Record<string, unknown>[]) => rows.map(toCamelRow);

export const safePick = (obj: Record<string, unknown>, keys: string[]) => {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
};

export const nowIso = () => new Date().toISOString();

/**
 * Format a value returned by Postgres for a DATE column as 'YYYY-MM-DD'.
 * pg returns DATE columns as JS Date objects at local midnight; calling
 * String(date) or toISOString() would mangle the day, so format from the
 * local calendar parts. Plain 'YYYY-MM-DD' strings pass through unchanged.
 */
export function toISODate(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) {
    const y = v.getFullYear();
    const m = String(v.getMonth() + 1).padStart(2, '0');
    const d = String(v.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  const s = String(v);
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
}
