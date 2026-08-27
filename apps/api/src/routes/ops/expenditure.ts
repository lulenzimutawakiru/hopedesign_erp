import { Router } from 'express';
import pg from 'pg';
import multer from 'multer';
import { tx, Ctx } from '../../db.js';
import { requirePermission } from '../../middleware/authorize.js';
import { asyncHandler, badRequest } from '../../utils.js';
import * as exp from '../../services/expenses.js';
import * as proc from '../../services/procurement.js';

export const expenditureOpsRouter = Router();
const expUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

type OpFn = (client: pg.PoolClient, ctx: Ctx, body: any, params: Record<string, string>) => Promise<unknown>;
type QueryFn = (client: pg.PoolClient, ctx: Ctx, query: Record<string, unknown>, params: Record<string, string>) => Promise<unknown>;

const run = (permission: string, fn: OpFn) => [
  requirePermission(permission),
  asyncHandler(async (req, res) => {
    const out = await tx((client) => fn(client, req.ctx, req.body ?? {}, req.params as Record<string, string>), req.ctx);
    res.json({ data: out });
  }),
];

const runGet = (permission: string, fn: QueryFn) => [
  requirePermission(permission),
  asyncHandler(async (req, res) => {
    const out = await tx(
      (client) => fn(client, req.ctx, req.query as Record<string, unknown>, req.params as Record<string, string>),
      req.ctx
    );
    res.json({ data: out });
  }),
];

// Meta + fraud guard
expenditureOpsRouter.get('/meta', ...runGet('expenditure.expenses.view', (c, ctx) => exp.expenseMeta(c, ctx)));
expenditureOpsRouter.post('/duplicate-scan', ...run('expenditure.expenses.create', (c, ctx, b) => exp.duplicateScan(c, ctx, b)));

// Expenses
expenditureOpsRouter.get('/expenses', ...runGet('expenditure.expenses.view', (c, ctx, q) => exp.listExpenses(c, ctx, {
  q: q.q != null ? String(q.q) : undefined,
  status: q.status != null ? String(q.status) : undefined,
  paymentStatus: q.paymentStatus != null ? String(q.paymentStatus) : undefined,
  departmentId: q.departmentId != null ? Number(q.departmentId) : undefined,
  costCentreId: q.costCentreId != null ? Number(q.costCentreId) : undefined,
  categoryId: q.categoryId != null ? Number(q.categoryId) : undefined,
  projectId: q.projectId != null ? Number(q.projectId) : undefined,
  supplierId: q.supplierId != null ? Number(q.supplierId) : undefined,
  employeeId: q.employeeId != null ? Number(q.employeeId) : undefined,
  from: q.from != null ? String(q.from) : undefined,
  to: q.to != null ? String(q.to) : undefined,
  page: q.page != null ? Number(q.page) : undefined,
  pageSize: q.pageSize != null ? Number(q.pageSize) : undefined,
})));
expenditureOpsRouter.get('/expenses/:id', ...runGet('expenditure.expenses.view', (c, ctx, _q, p) => exp.getExpense(c, ctx, Number(p.id))));
expenditureOpsRouter.post('/expenses', ...run('expenditure.expenses.create', (c, ctx, b) => exp.createExpense(c, ctx, b)));
expenditureOpsRouter.post('/expenses/:id/update', ...run('expenditure.expenses.update', (c, ctx, b, p) => exp.updateExpense(c, ctx, Number(p.id), b)));
expenditureOpsRouter.post('/expenses/:id/submit', ...run('expenditure.expenses.submit', (c, ctx, _b, p) => exp.submitExpense(c, ctx, Number(p.id))));
expenditureOpsRouter.post('/expenses/:id/pay', ...run('expenditure.expenses.approve', (c, ctx, b, p) => exp.payExpense(c, ctx, Number(p.id), b)));
expenditureOpsRouter.post('/expenses/:id/post', ...run('expenditure.expenses.post', (c, ctx, _b, p) => exp.postExpense(c, ctx, Number(p.id))));
expenditureOpsRouter.post('/expenses/:id/void', ...run('expenditure.expenses.void', (c, ctx, b, p) => exp.voidExpense(c, ctx, Number(p.id), b.reason != null ? String(b.reason) : null)));
expenditureOpsRouter.get('/board', ...runGet('expenditure.expenses.view', (c, ctx) => exp.expenseBoard(c, ctx)));
expenditureOpsRouter.get('/summary', ...runGet('expenditure.expenses.view', (c, ctx) => exp.expenseSummary(c, ctx)));

// Receipts
expenditureOpsRouter.get('/receipts', ...runGet('expenditure.receipts.view', (c, ctx, q) => exp.listReceipts(c, ctx, {
  q: q.q != null ? String(q.q) : undefined,
  refType: q.refType != null ? String(q.refType) : undefined,
  refId: q.refId != null ? Number(q.refId) : undefined,
})));
expenditureOpsRouter.post(
  '/receipts',
  requirePermission('expenditure.receipts.upload'),
  expUpload.single('file'),
  asyncHandler(async (req, res) => {
    const out = await tx(
      (client) =>
        exp.uploadReceipt(client, req.ctx, {
          ...req.body,
          file: req.file
            ? { originalname: req.file!.originalname, mimetype: req.file!.mimetype, size: req.file!.size, buffer: req.file!.buffer }
            : undefined,
        }),
      req.ctx
    );
    res.json({ data: out });
  })
);
expenditureOpsRouter.post('/receipts/:id/verify', ...run('expenditure.receipts.verify', (c, ctx, b, p) => exp.verifyReceipt(c, ctx, Number(p.id), b)));

// Petty cash
expenditureOpsRouter.get('/petty-cash', ...runGet('expenditure.petty_cash.view', (c, ctx) => exp.pettyCashDesk(c, ctx)));
expenditureOpsRouter.get('/petty-cash/:id', ...runGet('expenditure.petty_cash.view', (c, ctx, _q, p) => exp.getPettyCashFund(c, ctx, Number(p.id))));
expenditureOpsRouter.post('/petty-cash/transactions', ...run('expenditure.petty_cash.create', (c, ctx, b) => exp.recordPettyCashTransaction(c, ctx, b)));
expenditureOpsRouter.post('/replenishments', ...run('expenditure.petty_cash.replenish', (c, ctx, b) => exp.requestReplenishment(c, ctx, b)));
expenditureOpsRouter.post('/replenishments/:id/submit', ...run('expenditure.petty_cash.replenish', (c, ctx, _b, p) => exp.submitReplenishment(c, ctx, Number(p.id))));
expenditureOpsRouter.post('/replenishments/:id/pay', ...run('expenditure.petty_cash.replenish', (c, ctx, b, p) => exp.payReplenishment(c, ctx, Number(p.id), b)));
expenditureOpsRouter.post('/petty-cash/reconcile', ...run('expenditure.petty_cash.reconcile', (c, ctx, b) => exp.reconcilePettyCash(c, ctx, b)));

// Employee expense claims
expenditureOpsRouter.get('/claims', ...runGet('expenditure.claims.view', (c, ctx, q) => exp.listClaims(c, ctx, {
  status: q.status != null ? String(q.status) : undefined,
  employeeId: q.employeeId != null ? Number(q.employeeId) : undefined,
})));
expenditureOpsRouter.get('/claims/:id', ...runGet('expenditure.claims.view', (c, ctx, _q, p) => exp.getClaim(c, ctx, Number(p.id))));
expenditureOpsRouter.post('/claims', ...run('expenditure.claims.create', (c, ctx, b) => exp.createClaim(c, ctx, b)));
expenditureOpsRouter.post('/claims/:id/submit', ...run('expenditure.claims.create', (c, ctx, _b, p) => exp.submitClaim(c, ctx, Number(p.id))));
expenditureOpsRouter.post('/claims/:id/reimburse', ...run('expenditure.claims.reimburse', (c, ctx, b, p) => exp.reimburseClaim(c, ctx, Number(p.id), b)));

// Daily close
expenditureOpsRouter.get('/daily-close/status', ...runGet('expenditure.daily_close.view', (c, ctx, q) => exp.dailyCloseStatus(c, ctx, q.date != null ? String(q.date) : undefined)));
expenditureOpsRouter.get('/daily-close', ...runGet('expenditure.daily_close.view', (c, ctx, q) => exp.listDailyClosings(c, ctx, {
  status: q.status != null ? String(q.status) : undefined,
  from: q.from != null ? String(q.from) : undefined,
  to: q.to != null ? String(q.to) : undefined,
})));
expenditureOpsRouter.post('/daily-close', ...run('expenditure.daily_close.create', (c, ctx, b) => exp.createDailyClose(c, ctx, b)));
expenditureOpsRouter.post('/daily-close/:id/submit', ...run('expenditure.daily_close.create', (c, ctx, _b, p) => exp.submitDailyClose(c, ctx, Number(p.id))));

// Cash control + command centre + reports
expenditureOpsRouter.get('/cash-position', ...runGet('expenditure.dashboards.view', (c, ctx, q) => exp.cashPosition(c, ctx, q)));
expenditureOpsRouter.get('/dashboard', ...runGet('expenditure.dashboards.view', (c, ctx) => exp.expenditureDashboard(c, ctx)));
expenditureOpsRouter.get('/reports', ...runGet('expenditure.reports.view', (c, ctx, q) => exp.expenseReports(c, ctx, q)));
expenditureOpsRouter.post('/three-way-match', ...run('expenditure.payments.view', (c, ctx, b) => proc.runThreeWayMatch(c, ctx, Number(b.poId))));