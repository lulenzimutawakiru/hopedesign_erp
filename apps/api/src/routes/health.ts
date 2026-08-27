import { Router } from 'express';
import { pingDb } from '../db.js';
import { asyncHandler } from '../utils.js';

export const healthRouter = Router();

healthRouter.get(
  '/health',
  asyncHandler(async (_req, res) => {
    await pingDb();
    res.json({
      status: 'ok',
      service: 'hopedesign-erp-api',
      version: '1.0.0',
      uptime: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
    });
  })
);
