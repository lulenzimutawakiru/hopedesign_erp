import { NextFunction, Request, Response } from 'express';
import { RequestContext } from '../types.js';
import { correlationId } from '../utils.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      ctx: RequestContext;
      auth?: import('../types.js').AuthUser;
    }
  }
}

export function contextMiddleware(req: Request, _res: Response, next: NextFunction) {
  req.ctx = {
    correlationId: correlationId(),
    ip: req.ip ?? req.socket.remoteAddress ?? '',
    userAgent: req.headers['user-agent'] ?? '',
    device: String(req.headers['x-device'] ?? req.headers['x-device-id'] ?? ''),
  };
  next();
}
