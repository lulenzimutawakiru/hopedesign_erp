import { Router } from 'express';
import multer from 'multer';
import pg from 'pg';
import { tx, Ctx } from '../../db.js';
import { requirePermission } from '../../middleware/authorize.js';
import { asyncHandler, badRequest, notFound } from '../../utils.js';
import * as hr from '../../services/hr.js';
import * as finalSettlement from '../../services/finalSettlement.js';
import * as offCycle from '../../services/offCycle.js';
import * as arrears from '../../services/arrears.js';
import * as payrollValidation from '../../services/payrollValidation.js';
import * as payments from '../../services/payments.js';
import * as loansService from '../../services/loans.js';
import * as identityLink from '../../services/identityLink.js';

export const hrOpsRouter = Router();
const photoUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

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

hrOpsRouter.get('/board', ...runGet('hr.employees.view', (c, ctx) => hr.hrBoard(c, ctx)));
hrOpsRouter.get('/departments', ...runGet('hr.employees.view', (c, ctx) => hr.listDepartments(c, ctx)));

hrOpsRouter.get('/exceptions', ...runGet('hr.payrolls.view', (c, ctx, q) => payrollValidation.exceptionCentre(c, ctx, {
  status: q.status != null && q.status !== '' ? String(q.status) : undefined,
  severity: q.severity != null && q.severity !== '' ? String(q.severity) : undefined,
  q: q.q != null && q.q !== '' ? String(q.q) : undefined,
  page: q.page != null ? Number(q.page) : undefined,
  pageSize: q.pageSize != null ? Number(q.pageSize) : undefined,
})));
hrOpsRouter.post('/exceptions/:id/resolve', ...run('hr.payrolls.approve', (c, ctx, b, p) => payrollValidation.resolveException(
  c,
  ctx,
  Number(p.id),
  b.status != null ? String(b.status) : 'RESOLVED',
  b.note != null && b.note !== '' ? String(b.note) : undefined
)));

hrOpsRouter.get('/employees', ...runGet('hr.employees.view', (c, ctx, q) => hr.listEmployees(c, ctx, {
  q: q.q != null ? String(q.q) : undefined,
  status: q.status != null ? String(q.status) : undefined,
  page: q.page != null ? Number(q.page) : undefined,
  pageSize: q.pageSize != null ? Number(q.pageSize) : undefined,
})));
hrOpsRouter.get('/employees/:id', ...runGet('hr.employees.view', (c, ctx, _q, p) => hr.getEmployee(c, ctx, Number(p.id))));
hrOpsRouter.get('/directory/users', ...runGet('hr.employees.view', (c, ctx, q) => identityLink.searchUsers(
  c,
  ctx,
  q.q != null ? String(q.q) : '',
  { unlinkedOnly: q.unlinked === '1' || q.unlinked === 'true' }
)));
hrOpsRouter.post('/employees/:id/link-user', ...run('hr.employees.update', (c, ctx, b, p) => identityLink.linkUserEmployee(c, ctx, {
  userId: Number(b.userId),
  employeeId: Number(p.id),
})));
hrOpsRouter.post('/employees/:id/unlink-user', ...run('hr.employees.update', (c, ctx, _b, p) => identityLink.unlinkUserEmployee(c, ctx, { employeeId: Number(p.id) })));
hrOpsRouter.get(
  '/employees/:id/photo',
  requirePermission('hr.employees.view'),
  asyncHandler(async (req, res) => {
    const photo = await tx((c) => hr.getEmployeePhoto(c, req.ctx, Number(req.params.id)), req.ctx);
    if (!photo) throw notFound('No photograph on file');
    res.setHeader('Content-Type', photo.mime);
    res.setHeader('Cache-Control', 'private, max-age=120');
    res.setHeader('Content-Disposition', 'inline; filename="employee-photo"');
    res.send(photo.bytes);
  })
);
hrOpsRouter.post(
  '/employees/:id/photo',
  requirePermission('hr.employees.update'),
  photoUpload.single('file'),
  asyncHandler(async (req, res) => {
    if (!req.file) throw badRequest('A photograph file is required (field "file")');
    const out = await tx(
      (c) =>
        hr.uploadEmployeePhoto(c, req.ctx, Number(req.params.id), {
          originalname: req.file!.originalname,
          mimetype: req.file!.mimetype,
          size: req.file!.size,
          buffer: req.file!.buffer,
        }, req.body?.kind != null ? String(req.body.kind) : undefined),
      req.ctx
    );
    res.json({ data: out });
  })
);
hrOpsRouter.post('/employees', ...run('hr.employees.create', (c, ctx, b) => hr.createEmployee(c, ctx, {
  firstName: String(b.firstName ?? ''),
  lastName: String(b.lastName ?? ''),
  departmentId: b.departmentId != null ? Number(b.departmentId) : null,
  position: b.position != null ? String(b.position) : null,
  hireDate: b.hireDate != null ? String(b.hireDate) : null,
  salaryType: b.salaryType != null ? String(b.salaryType) : undefined,
  baseSalary: b.baseSalary != null ? Number(b.baseSalary) : undefined,
  phone: b.phone != null ? String(b.phone) : null,
  email: b.email != null ? String(b.email) : null,
  tin: b.tin != null ? String(b.tin) : null,
  nssfNo: b.nssfNo != null ? String(b.nssfNo) : null,
  bankName: b.bankName != null ? String(b.bankName) : null,
  bankAccountNo: b.bankAccountNo != null ? String(b.bankAccountNo) : null,
  status: b.status != null ? String(b.status) : undefined,
  userId: b.userId != null && b.userId !== '' ? Number(b.userId) : null,
})));
hrOpsRouter.patch('/employees/:id', ...run('hr.employees.update', (c, ctx, b, p) => hr.updateEmployee(c, ctx, Number(p.id), {
  firstName: b.firstName !== undefined && b.firstName !== null ? String(b.firstName) : undefined,
  lastName: b.lastName !== undefined && b.lastName !== null ? String(b.lastName) : undefined,
  departmentId: b.departmentId !== undefined ? (b.departmentId === null || b.departmentId === '' ? null : Number(b.departmentId)) : undefined,
  position: b.position !== undefined ? (b.position === null || b.position === '' ? null : String(b.position)) : undefined,
  hireDate: b.hireDate !== undefined && b.hireDate !== null ? String(b.hireDate) : undefined,
  salaryType: b.salaryType !== undefined && b.salaryType !== null ? String(b.salaryType) : undefined,
  baseSalary: b.baseSalary !== undefined && b.baseSalary !== null ? Number(b.baseSalary) : undefined,
  phone: b.phone !== undefined ? (b.phone === null || b.phone === '' ? null : String(b.phone)) : undefined,
  email: b.email !== undefined ? (b.email === null || b.email === '' ? null : String(b.email)) : undefined,
  tin: b.tin !== undefined ? (b.tin === null || b.tin === '' ? null : String(b.tin)) : undefined,
  nssfNo: b.nssfNo !== undefined ? (b.nssfNo === null || b.nssfNo === '' ? null : String(b.nssfNo)) : undefined,
  bankName: b.bankName !== undefined ? (b.bankName === null || b.bankName === '' ? null : String(b.bankName)) : undefined,
  bankAccountNo: b.bankAccountNo !== undefined ? (b.bankAccountNo === null || b.bankAccountNo === '' ? null : String(b.bankAccountNo)) : undefined,
  status: b.status !== undefined && b.status !== null ? String(b.status) : undefined,
})));
hrOpsRouter.post('/employees/:id/terminate', ...run('hr.employees.terminate', (c, ctx, b, p) => hr.terminateEmployee(c, ctx, Number(p.id), b.terminationDate != null ? String(b.terminationDate) : null)));
hrOpsRouter.post('/employees/:id/clock-in', ...run('hr.attendance.create', (c, ctx, _b, p) => hr.clockIn(c, ctx, Number(p.id))));
hrOpsRouter.post('/employees/:id/clock-out', ...run('hr.attendance.create', (c, ctx, _b, p) => hr.clockOut(c, ctx, Number(p.id))));
hrOpsRouter.post('/employees/:id/loans', ...run('hr.loans.create', (c, ctx, b, p) => loansService.createLoan(c, ctx, {
  employeeId: Number(p.id),
  amount: Number(b.amount),
  interestRate: b.interestRate != null ? Number(b.interestRate) : undefined,
  tenureMonths: b.tenureMonths != null ? Number(b.tenureMonths) : undefined,
  monthlyDeduction: b.monthlyDeduction != null ? Number(b.monthlyDeduction) : undefined,
  startDate: b.startDate != null ? String(b.startDate) : null,
  reason: b.reason != null ? String(b.reason) : null,
})));
hrOpsRouter.get('/employees/:id/loans', ...runGet('hr.loans.view', (c, ctx, _q, p) => loansService.listLoans(c, ctx, { employeeId: Number(p.id) })));
hrOpsRouter.get('/loans', ...runGet('hr.loans.view', (c, ctx, q) => loansService.listLoans(c, ctx, {
  employeeId: q.employeeId != null ? Number(q.employeeId) : undefined,
  status: q.status != null && q.status !== '' ? String(q.status) : undefined,
  q: q.q != null && q.q !== '' ? String(q.q) : undefined,
  page: q.page != null ? Number(q.page) : undefined,
  pageSize: q.pageSize != null ? Number(q.pageSize) : undefined,
})));
hrOpsRouter.get('/loans/:id', ...runGet('hr.loans.view', (c, ctx, _q, p) => loansService.getLoan(c, ctx, Number(p.id))));
hrOpsRouter.post('/loans/:id/approve', ...run('hr.loans.approve', (c, ctx, _b, p) => loansService.approveLoan(c, ctx, Number(p.id))));
hrOpsRouter.post('/loans/:id/reject', ...run('hr.loans.approve', (c, ctx, _b, p) => loansService.rejectLoan(c, ctx, Number(p.id))));
hrOpsRouter.post('/loans/:id/pause', ...run('hr.loans.update', (c, ctx, _b, p) => loansService.pauseLoan(c, ctx, Number(p.id))));
hrOpsRouter.post('/loans/:id/write-off', ...run('hr.loans.write_off', (c, ctx, _b, p) => loansService.writeOffLoan(c, ctx, Number(p.id))));
hrOpsRouter.get('/advances', ...runGet('hr.advances.view', (c, ctx, q) => loansService.listAdvances(c, ctx, {
  employeeId: q.employeeId != null ? Number(q.employeeId) : undefined,
  status: q.status != null && q.status !== '' ? String(q.status) : undefined,
  q: q.q != null && q.q !== '' ? String(q.q) : undefined,
  page: q.page != null ? Number(q.page) : undefined,
  pageSize: q.pageSize != null ? Number(q.pageSize) : undefined,
})));
hrOpsRouter.get('/advances/:id', ...runGet('hr.advances.view', (c, ctx, _q, p) => loansService.getAdvance(c, ctx, Number(p.id))));
hrOpsRouter.post('/employees/:id/advances', ...run('hr.advances.create', (c, ctx, b, p) => loansService.createAdvance(c, ctx, {
  employeeId: Number(p.id),
  amount: Number(b.amount),
  monthlyDeduction: b.monthlyDeduction != null ? Number(b.monthlyDeduction) : undefined,
  startDate: b.startDate != null ? String(b.startDate) : null,
  reason: b.reason != null ? String(b.reason) : null,
})));
hrOpsRouter.post('/advances/:id/approve', ...run('hr.advances.approve', (c, ctx, _b, p) => loansService.approveAdvance(c, ctx, Number(p.id))));
hrOpsRouter.post('/advances/:id/reject', ...run('hr.advances.approve', (c, ctx, _b, p) => loansService.rejectAdvance(c, ctx, Number(p.id))));
hrOpsRouter.post('/advances/:id/close', ...run('hr.advances.update', (c, ctx, _b, p) => loansService.closeAdvance(c, ctx, Number(p.id))));

hrOpsRouter.get('/attendance', ...runGet('hr.attendance.view', (c, ctx, q) => hr.listAttendance(c, ctx, q.date != null ? String(q.date) : undefined)));

hrOpsRouter.get('/leave', ...runGet('hr.leave.view', (c, ctx, q) => hr.listLeave(c, ctx, {
  status: q.status != null ? String(q.status) : undefined,
})));
hrOpsRouter.post('/leave', ...run('hr.leave.create', (c, ctx, b) => hr.createLeave(c, ctx, {
  employeeId: Number(b.employeeId),
  leaveType: b.leaveType != null ? String(b.leaveType) : undefined,
  startDate: String(b.startDate),
  endDate: String(b.endDate),
  reason: b.reason != null ? String(b.reason) : null,
})));
hrOpsRouter.post('/leave/:id/approve', ...run('hr.leave.approve', (c, ctx, _b, p) => hr.decideLeave(c, ctx, Number(p.id), 'APPROVED')));
hrOpsRouter.post('/leave/:id/reject', ...run('hr.leave.approve', (c, ctx, _b, p) => hr.decideLeave(c, ctx, Number(p.id), 'REJECTED')));

hrOpsRouter.get('/payrolls', ...runGet('hr.payrolls.view', (c, ctx) => hr.listPayrolls(c, ctx)));
hrOpsRouter.get('/payrolls/:id', ...runGet('hr.payrolls.view', (c, ctx, _q, p) => hr.getPayroll(c, ctx, Number(p.id))));
hrOpsRouter.get('/payrolls/:id/exceptions', ...runGet('hr.payrolls.view', (c, ctx, _q, p) => payrollValidation.listExceptions(c, ctx, Number(p.id))));
hrOpsRouter.post('/payrolls/:id/validate', ...run('hr.payrolls.update', (c, ctx, _b, p) => payrollValidation.validatePayroll(c, ctx, Number(p.id))));
hrOpsRouter.post('/payrolls', ...run('hr.payrolls.create', (c, ctx, b) => hr.createPayroll(c, ctx, {
  periodStart: String(b.periodStart),
  periodEnd: String(b.periodEnd),
  payrollGroupId: b.payrollGroupId != null && b.payrollGroupId !== '' ? Number(b.payrollGroupId) : undefined,
})));
hrOpsRouter.post('/payrolls/:id/calculate', ...run('hr.payrolls.update', (c, ctx, _b, p) => hr.calculatePayroll(c, ctx, Number(p.id))));
hrOpsRouter.post('/payrolls/:id/submit', ...run('hr.payrolls.submit', (c, ctx, _b, p) => hr.submitPayroll(c, ctx, Number(p.id))));
hrOpsRouter.post('/payrolls/:id/post', ...run('hr.payrolls.post', (c, ctx, _b, p) => hr.postPayrollRun(c, ctx, Number(p.id))));

hrOpsRouter.post('/payrolls/:id/payment-batch', ...run('hr.payrolls.update', (c, ctx, b, p) => payments.createPaymentBatch(c, ctx, { payrollId: Number(p.id), fileFormat: b.fileFormat != null && b.fileFormat !== '' ? String(b.fileFormat) : undefined })));
hrOpsRouter.get('/payment-batches', ...runGet('hr.payrolls.view', (c, ctx, q) => payments.listPaymentBatches(c, ctx, { status: q.status != null && q.status !== '' ? String(q.status) : undefined, payrollId: q.payrollId != null ? Number(q.payrollId) : undefined, q: q.q != null && q.q !== '' ? String(q.q) : undefined, page: q.page != null ? Number(q.page) : undefined, pageSize: q.pageSize != null ? Number(q.pageSize) : undefined })));
hrOpsRouter.get('/payment-batches/:id', ...runGet('hr.payrolls.view', (c, ctx, _q, p) => payments.getPaymentBatch(c, ctx, Number(p.id))));
hrOpsRouter.post('/payment-batches/:id/validate', ...run('hr.payrolls.update', (c, ctx, _b, p) => payments.validatePaymentBatch(c, ctx, Number(p.id))));
hrOpsRouter.post('/payment-batches/:id/approve', ...run('hr.payrolls.approve', (c, ctx, _b, p) => payments.approvePaymentBatch(c, ctx, Number(p.id))));
hrOpsRouter.post('/payment-batches/:id/export', ...run('hr.payrolls.post', (c, ctx, _b, p) => payments.exportPaymentBatch(c, ctx, Number(p.id))));
hrOpsRouter.post('/payment-batches/:id/confirm', ...run('hr.payrolls.post', (c, ctx, _b, p) => payments.confirmPaymentBatch(c, ctx, Number(p.id))));
hrOpsRouter.post('/payrolls/:id/publish-payslips', ...run('hr.payrolls.post', (c, ctx, _b, p) => payments.publishPayslips(c, ctx, Number(p.id))));
hrOpsRouter.get('/payrolls/:id/payslips', ...runGet('hr.payslips.view', (c, ctx, _q, p) => payments.listPayslips(c, ctx, { payrollId: Number(p.id) })));
hrOpsRouter.get('/reconciliation', ...runGet('hr.payrolls.view', (c, ctx) => payments.reconciliationCentre(c, ctx)));
hrOpsRouter.post('/payrolls/:id/reconcile', ...run('hr.payrolls.approve', (c, ctx, _b, p) => payments.reconcilePayments(c, ctx, { payrollId: Number(p.id) })));
hrOpsRouter.get('/payment-dashboard', ...runGet('hr.payrolls.view', (c, ctx) => payments.paymentDashboard(c, ctx)));

hrOpsRouter.get('/off-cycle', ...runGet('hr.payrolls.view', (c, ctx) => offCycle.listOffCycleRuns(c, ctx)));
hrOpsRouter.get('/off-cycle/:id', ...runGet('hr.payrolls.view', (c, ctx, _q, p) => hr.getPayroll(c, ctx, Number(p.id))));
hrOpsRouter.get('/off-cycle/:id/exceptions', ...runGet('hr.payrolls.view', (c, ctx, _q, p) => payrollValidation.listExceptions(c, ctx, Number(p.id))));
hrOpsRouter.post('/off-cycle/:id/validate', ...run('hr.payrolls.update', (c, ctx, _b, p) => payrollValidation.validatePayroll(c, ctx, Number(p.id))));
hrOpsRouter.post('/off-cycle', ...run('hr.payrolls.create', (c, ctx, b) => offCycle.createOffCycleRun(c, ctx, {
  periodStart: String(b.periodStart),
  periodEnd: String(b.periodEnd),
  offCycleType: String(b.offCycleType ?? ''),
  reason: String(b.reason ?? ''),
  employeeIds: Array.isArray(b.employeeIds) ? b.employeeIds.map(Number) : [],
  extraEarnings: b.extraEarnings != null ? Number(b.extraEarnings) : undefined,
  extraDeductions: b.extraDeductions != null ? Number(b.extraDeductions) : undefined,
  deductLoans: b.deductLoans != null ? Boolean(b.deductLoans) : undefined,
  paymentDate: b.paymentDate != null ? String(b.paymentDate) : undefined,
})));
hrOpsRouter.post('/off-cycle/:id/calculate', ...run('hr.payrolls.update', (c, ctx, _b, p) => hr.calculatePayroll(c, ctx, Number(p.id))));
hrOpsRouter.post('/off-cycle/:id/submit', ...run('hr.payrolls.submit', (c, ctx, _b, p) => hr.submitPayroll(c, ctx, Number(p.id))));
hrOpsRouter.post('/off-cycle/:id/post', ...run('hr.payrolls.post', (c, ctx, _b, p) => hr.postPayrollRun(c, ctx, Number(p.id))));

hrOpsRouter.get('/arrears', ...runGet('hr.payrolls.view', (c, ctx, q) => arrears.listArrears(c, ctx, {
  status: q.status != null ? String(q.status) : undefined,
})));
hrOpsRouter.post('/arrears', ...run('hr.payrolls.create', (c, ctx, b) => arrears.createArrears(c, ctx, {
  employeeId: Number(b.employeeId),
  originalPay: Number(b.originalPay),
  correctPay: Number(b.correctPay),
  fromPeriodStart: String(b.fromPeriodStart),
  toPeriodEnd: String(b.toPeriodEnd),
  reason: b.reason != null ? String(b.reason) : null,
  currency: b.currency != null ? String(b.currency) : undefined,
})));
hrOpsRouter.post('/arrears/:id/approve', ...run('hr.payrolls.approve', (c, ctx, _b, p) => arrears.decideArrears(c, ctx, Number(p.id), 'APPROVED')));
hrOpsRouter.post('/arrears/:id/reject', ...run('hr.payrolls.approve', (c, ctx, _b, p) => arrears.decideArrears(c, ctx, Number(p.id), 'REJECTED')));

hrOpsRouter.get('/final-settlements', ...runGet('hr.final_settlements.view', (c, ctx, q) => finalSettlement.listFinalSettlements(c, ctx, {
  q: q.q != null ? String(q.q) : undefined,
  status: q.status != null ? String(q.status) : undefined,
  page: q.page != null ? Number(q.page) : undefined,
  pageSize: q.pageSize != null ? Number(q.pageSize) : undefined,
})));
hrOpsRouter.get('/final-settlements/:id', ...runGet('hr.final_settlements.view', (c, ctx, _q, p) => finalSettlement.getFinalSettlement(c, ctx, Number(p.id))));
hrOpsRouter.post('/employees/:id/final-settlement', ...run('hr.final_settlements.create', (c, ctx, b, p) => finalSettlement.prepareFinalSettlement(c, ctx, Number(p.id), {
  currency: b.currency != null ? String(b.currency) : undefined,
  otherDeductions: b.otherDeductions != null ? Number(b.otherDeductions) : undefined,
})));
hrOpsRouter.post('/final-settlements/:id/submit', ...run('hr.final_settlements.submit', (c, ctx, _b, p) => finalSettlement.submitFinalSettlement(c, ctx, Number(p.id))));
hrOpsRouter.post('/final-settlements/:id/approve', ...run('hr.final_settlements.approve', (c, ctx, _b, p) => finalSettlement.approveFinalSettlement(c, ctx, Number(p.id))));
hrOpsRouter.post('/final-settlements/:id/reject', ...run('hr.final_settlements.reject', (c, ctx, _b, p) => finalSettlement.rejectFinalSettlement(c, ctx, Number(p.id))));
hrOpsRouter.post('/final-settlements/:id/pay', ...run('hr.final_settlements.pay', (c, ctx, b, p) => finalSettlement.payFinalSettlement(c, ctx, Number(p.id), {
  paymentMethod: b.paymentMethod != null ? String(b.paymentMethod) : undefined,
})));
