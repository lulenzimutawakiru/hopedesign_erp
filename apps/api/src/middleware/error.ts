import { NextFunction, Request, Response } from 'express';
import { ApiError } from '../utils.js';
import { ZodError } from 'zod';

export function notFoundHandler(_req: Request, res: Response) {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Route not found' } });
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
  if (err instanceof ApiError) {
    return res.status(err.status).json({
      error: { code: err.code, message: err.message, details: err.details },
    });
  }
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[error] ${req.method} ${req.originalUrl}`, err);
  const status = (err as { status?: number })?.status && (err as { status?: number }).status! < 500 ? (err as { status?: number }).status! : 500;
  res.status(status >= 400 && status < 500 ? status : 500).json({
    error: { code: 'INTERNAL_ERROR', message: status >= 500 ? 'Internal server error' : message },
  });
}
