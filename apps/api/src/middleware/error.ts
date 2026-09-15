import { NextFunction, Request, Response } from 'express';
import { ApiError } from '../utils.js';
import { ZodError } from 'zod';

export function notFoundHandler(_req: Request, res: Response) {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Route not found' } });
}

function pgCode(err: unknown): string | undefined {
  if (err && typeof err === 'object' && 'code' in err && (err as { code?: unknown }).code != null) {
    return String((err as { code: unknown }).code);
  }
  return undefined;
}

/**
 * Postgres RAISE EXCEPTION and constraint failures are business refusals, not
 * server crashes. Mapping them here is what stops inventory pick/dispatch
 * (and similar writers) from surfacing as "Internal server error" when the
 * floor is simply short of stock.
 */
function fromPostgres(err: unknown): ApiError | null {
  const code = pgCode(err);
  if (!code) return null;
  const message = err instanceof Error ? err.message : String(err);
  if (code === 'P0001') return new ApiError(400, 'BAD_REQUEST', message);
  if (code === '23505') return new ApiError(409, 'CONFLICT', message);
  if (code === '23503' || code === '23514' || code === '23502') {
    return new ApiError(400, 'BAD_REQUEST', message);
  }
  return null;
}

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  if (err instanceof ZodError) {
    return res.status(400).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Request validation failed',
        details: err.issues,
      },
    });
  }
  const pg = err instanceof ApiError ? null : fromPostgres(err);
  const fault = err instanceof ApiError ? err : pg;
  if (fault) {
    // A 5xx ApiError is a server-side fault, so it must leave a server-side
    // trace. Without this the response is silent and a failed request cannot
    // be diagnosed in production. 4xx are expected client outcomes.
    if (fault.status >= 500) {
      console.error(`[error] ${req.method} ${req.originalUrl}`, fault.status, fault.code, fault.message, fault.details ?? '');
    }
    return res.status(fault.status).json({
      error: { code: fault.code, message: fault.message, details: fault.details },
    });
  }
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[error] ${req.method} ${req.originalUrl}`, err);
  const status = (err as { status?: number })?.status && (err as { status?: number }).status! < 500 ? (err as { status?: number }).status! : 500;
  res.status(status >= 400 && status < 500 ? status : 500).json({
    error: { code: 'INTERNAL_ERROR', message: status >= 500 ? 'Internal server error' : message },
  });
}
