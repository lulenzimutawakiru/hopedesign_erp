import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { rateLimit } from 'express-rate-limit';
import { config, isProd } from './config.js';
import { contextMiddleware } from './middleware/context.js';
import { requireModule } from './middleware/moduleAccess.js';
import { authenticate } from './middleware/auth.js';
import { notFoundHandler, errorHandler } from './middleware/error.js';
import { healthRouter } from './routes/health.js';
import { authRouter } from './routes/auth.js';
import { publicVerificationRouter } from './routes/publicVerification.js';
import { approvalsRouter } from './routes/approvals.js';
import { notificationsRouter } from './routes/notifications.js';
import { dashboardRouter } from './routes/dashboard.js';
import { searchRouter } from './routes/search.js';
import { qrRouter } from './routes/qr.js';
import { reportsRouter } from './routes/reports.js';
import { analyticsRouter } from './routes/analytics.js';
import { importExportRouter } from './routes/importExport.js';
import { metaRouter } from './routes/meta.js';
import { documentsRouter } from './routes/documents.js';
import { settingsRouter } from './routes/settings.js';
import { adminRouter } from './routes/admin.js';
import { databaseAdminRouter } from './routes/databaseAdmin.js';
import { adminCronRouter } from './routes/adminCron.js';
import { runDueReportSchedules } from './services/reportScheduler.js';
import { runDueCronJobs } from './services/cronJobs.js';
import { processNotificationDeliveries } from './services/communication.js';
import { mountCrud } from './routes/registry.js';
import { salesOpsRouter } from './routes/ops/sales.js';
import { crmOpsRouter } from './routes/ops/crm.js';
import { procurementOpsRouter } from './routes/ops/procurement.js';
import { productionOpsRouter } from './routes/ops/production.js';
import { manufacturingOpsRouter } from './routes/ops/manufacturing.js';
import { inventoryOpsRouter } from './routes/ops/inventory.js';
import { inventoryIntelRouter } from './routes/ops/inventoryIntel.js';
import { financeOpsRouter } from './routes/ops/finance.js';
import { securityOpsRouter } from './routes/ops/security.js';
import { mrpOpsRouter } from './routes/ops/mrp.js';
import { healthcareOpsRouter } from './routes/ops/healthcare.js';
import { hrOpsRouter } from './routes/ops/hr.js';
import { contractsOpsRouter } from './routes/ops/contracts.js';
import { hcmOpsRouter } from './routes/ops/hcm.js';
import { assetsOpsRouter } from './routes/ops/assets.js';
import { employeeIdentityOpsRouter } from './routes/ops/employeeIdentity.js';
import { requisitionsOpsRouter } from './routes/ops/requisitions.js';
import { expenditureOpsRouter } from './routes/ops/expenditure.js';
import { communicationOpsRouter } from './routes/ops/communication.js';
import { documentsOpsRouter } from './routes/ops/documents.js';

export const app = express();

app.disable('x-powered-by');
app.set('trust proxy', 1);

const PRINT_JS = `(function () {
  var done = false;
  function autoPrint() {
    if (done) return;
    done = true;
    window.print();
  }
  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    setTimeout(autoPrint, 250);
  } else {
    window.addEventListener('load', function () { setTimeout(autoPrint, 250); });
  }
})();
`;
app.get('/assets/print.js', (_req, res) => {
  res
    .type('application/javascript')
    .set('Cache-Control', 'public, max-age=31536000, immutable')
    .send(PRINT_JS);
});
const allowedOrigins = isProd
  ? [config.webPublicUrl]
  : [config.webPublicUrl, 'http://localhost:3000', 'http://localhost:3001', 'http://localhost:5173', 'http://localhost:5174'];

app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        frameAncestors: ["'none'"],
        formAction: ["'self'"],
        upgradeInsecureRequests: null,
      },
    },
    strictTransportSecurity: isProd ? { maxAge: 15552000, includeSubDomains: true, preload: true } : { maxAge: 15552000 },
    crossOriginResourcePolicy: { policy: 'same-site' },
    referrerPolicy: { policy: 'no-referrer' },
  })
);
app.use(
  cors({
    origin: (origin, cb) => {
      // Allow same-origin (no Origin header) plus the explicit allow-list.
      if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
      return cb(null, false);
    },
    credentials: true,
  })
);
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true, limit: '5mb' }));
app.use(contextMiddleware);

// Global API rate limiting (login brute-force protection included).
const apiLimiter = rateLimit({
  windowMs: config.rateLimitWindowMs,
  max: config.env === 'test' ? 1_000_000 : config.rateLimitMax,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api', apiLimiter);

// ---- Public / unauthenticated ----
app.use('/api', healthRouter);                            // GET /api/health
app.use('/api/public', publicVerificationRouter);          // POST /api/public/verify
app.use('/api/auth', authRouter);                          // /api/auth/login, /refresh, /me ...

// ---- Authenticated API ----
app.use(authenticate);
app.use('/api/approvals', approvalsRouter);
app.use('/api/notifications', notificationsRouter);
app.use('/api/dashboard', dashboardRouter);
app.use('/api/search', searchRouter);
app.use('/api/qr', qrRouter);
app.use('/api/reports', reportsRouter);
app.use('/api/analytics', analyticsRouter);
app.use('/api/import-export', importExportRouter);
app.use('/api/meta', metaRouter);
app.use('/api/documents', documentsRouter);
app.use('/api/settings', settingsRouter);
app.use('/api/admin', adminRouter);
app.use('/api/admin/database', databaseAdminRouter);
app.use('/api/admin/cron', adminCronRouter);

// Business operations (transactional services; RBAC + SoD + ABAC enforced per route).
app.use('/api/ops/sales', salesOpsRouter);
app.use('/api/ops/crm', crmOpsRouter);
app.use('/api/ops/procurement', procurementOpsRouter);
app.use('/api/ops/production', productionOpsRouter);
app.use('/api/ops/manufacturing', manufacturingOpsRouter);
app.use('/api/ops/inventory', inventoryOpsRouter);
app.use('/api/ops/inventory-intel', inventoryIntelRouter);
app.use('/api/ops/finance', financeOpsRouter);
app.use('/api/ops/hr', hrOpsRouter);
app.use('/api/ops/hr/identity', employeeIdentityOpsRouter);
app.use('/api/ops/hr', contractsOpsRouter);
app.use('/api/ops/hcm', hcmOpsRouter);
app.use('/api/ops/security', securityOpsRouter);
app.use('/api/ops/mrp', mrpOpsRouter);
app.use('/api/ops/assets', assetsOpsRouter);
app.use('/api/ops/requisitions', requisitionsOpsRouter);
app.use('/api/ops/expenditure', expenditureOpsRouter);
        app.use('/api/ops/communication', communicationOpsRouter);
        app.use('/api/ops/documents', documentsOpsRouter);
        app.use('/api/ops/healthcare', requireModule('healthcare'), healthcareOpsRouter);

// Module-activation gate for the healthcare CRUD namespace (multi-tenant SaaS).
app.use('/api/healthcare', requireModule('healthcare'));

// Generic CRUD+ for all registered entities.
mountCrud(app);

app.use(notFoundHandler);
app.use(errorHandler);

// Report schedule worker: run due schedules every minute (idempotent).
setInterval(() => {
  runDueReportSchedules().catch((err: unknown) => {
    console.error('[reportScheduler]', err instanceof Error ? err.message : err);
  });
}, 60_000);

// Cron job worker: run due background jobs every minute (single-flight).
setInterval(() => {
  runDueCronJobs().catch((err: unknown) => {
    console.error('[cronJobs]', err instanceof Error ? err.message : err);
  });
}, 60_000);

// Notification delivery worker: dispatch queued EMAIL/SMS/WHATSAPP via Bird.
setInterval(() => {
  processNotificationDeliveries().catch((err: unknown) => {
    console.error('[notificationDispatch]', err instanceof Error ? err.message : err);
  });
}, 15_000);
