import { Router } from 'express';
import multer from 'multer';
import pg from 'pg';
import { tx, Ctx } from '../../db.js';
import { requirePermission } from '../../middleware/authorize.js';
import { asyncHandler, badRequest, notFound } from '../../utils.js';
import * as contracts from '../../services/contracts.js';
import * as hr from '../../services/hr.js';
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { config } from '../../config.js';

export const contractsOpsRouter = Router();
const photoUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });
const signatureUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });
const SIGNATURE_MIME_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
};
const SIGNATURE_EXTS = ['.png', '.jpg'];

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

const camelize = (row: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key.replace(new RegExp('_([a-z])', 'g'), (_m: string, c: string) => c.toUpperCase()),
      value,
    ])
  );

const optStr = (v: unknown): string | undefined => (v != null && v !== '' ? String(v) : undefined);
const optNum = (v: unknown): number | undefined => (v != null && v !== '' ? Number(v) : undefined);
const optBool = (v: unknown): boolean | undefined => (v != null ? Boolean(v) : undefined);
const optStrArr = (v: unknown): string[] | undefined => (Array.isArray(v) ? v.map(String) : undefined);

// Dashboard, lists and smart queries
contractsOpsRouter.get('/contracts/board', ...runGet('hr.contracts.view', (c, ctx) => contracts.contractDashboard(c, ctx)));
contractsOpsRouter.get('/contracts', ...runGet('hr.contracts.view', (c, ctx, q) => contracts.listContracts(c, ctx, {
  q: optStr(q.q),
  status: optStr(q.status),
  contractType: optStr(q.contractType),
  employeeId: optNum(q.employeeId),
  departmentId: optNum(q.departmentId),
  branchId: optNum(q.branchId),
  expiringWithinDays: optNum(q.expiringWithinDays),
  probationEndingWithinDays: optNum(q.probationEndingWithinDays),
  page: optNum(q.page),
  pageSize: optNum(q.pageSize),
})));
contractsOpsRouter.get('/contracts/my', ...runGet('hr.contracts.view', (c, ctx, q) => contracts.myContracts(c, ctx, {
  page: optNum(q.page),
  pageSize: optNum(q.pageSize),
})));
contractsOpsRouter.get('/contracts/expiring', ...runGet('hr.contracts.view', (c, ctx, q) => contracts.expiringContracts(c, ctx, q.days != null ? Number(q.days) : 30)));
contractsOpsRouter.get('/contracts/probation-ending', ...runGet('hr.contracts.view', (c, ctx, q) => contracts.probationEnding(c, ctx, q.days != null ? Number(q.days) : 30)));
contractsOpsRouter.get('/contracts/missing-particulars', ...runGet('hr.contracts.view', (c, ctx) => contracts.missingParticulars(c, ctx)));

// Templates, clauses, legal rules and employment types (read side)
contractsOpsRouter.get('/contracts/templates', ...runGet('hr.contracts.view', (c, ctx) => contracts.listTemplates(c, ctx)));
contractsOpsRouter.get('/contracts/templates/:id', ...runGet('hr.contracts.view', (c, ctx, _q, p) => contracts.getTemplate(c, ctx, Number(p.id))));
contractsOpsRouter.get('/contracts/clauses', ...runGet('hr.contracts.view', (c, ctx, q) => contracts.listClauses(c, ctx, {
  category: optStr(q.category),
  status: optStr(q.status),
  q: optStr(q.q),
})));
contractsOpsRouter.get('/contracts/legal-rules', ...runGet('hr.contracts.view', (c, ctx, q) => contracts.listLegalRules(c, ctx, {
  status: optStr(q.status),
  code: optStr(q.code),
})));
contractsOpsRouter.get('/contracts/employment-types', ...runGet('hr.contracts.view', (c, ctx) => contracts.listEmploymentTypes(c, ctx)));
// Clause governance: tenants create custom clauses and version their own
// clause content. Statutory clauses are centrally controlled and read-only.
contractsOpsRouter.post('/contracts/clauses', ...run('hr.contracts.create', (c, ctx, b) => contracts.createClause(c, ctx, {
  clauseCode: b.clauseCode != null ? String(b.clauseCode) : undefined,
  name: b.name != null ? String(b.name) : undefined,
  category: b.category != null ? String(b.category) : undefined,
  text: b.text != null ? String(b.text) : undefined,
  requiredFlag: optStr(b.requiredFlag),
  effectiveFrom: optStr(b.effectiveFrom),
  effectiveTo: optStr(b.effectiveTo),
  applicableEmployeeTypes: optStrArr(b.applicableEmployeeTypes),
  applicableContractTypes: optStrArr(b.applicableContractTypes),
  conflictsWith: optStrArr(b.conflictsWith),
})));
contractsOpsRouter.post('/contracts/clauses/:id/versions', ...run('hr.contracts.create', (c, ctx, b, p) => contracts.createClauseVersion(c, ctx, Number(p.id), {
  name: b.name != null ? String(b.name) : undefined,
  category: b.category != null ? String(b.category) : undefined,
  text: b.text != null ? String(b.text) : undefined,
  status: optStr(b.status),
  effectiveFrom: optStr(b.effectiveFrom),
  effectiveTo: b.effectiveTo != null ? String(b.effectiveTo) : null,
})));

// Create a contract
contractsOpsRouter.post('/contracts', ...run('hr.contracts.create', (c, ctx, b) => {
  const probation = b.probation != null ? {
    startDate: b.probation.startDate != null ? String(b.probation.startDate) : undefined,
    endDate: b.probation.endDate != null ? String(b.probation.endDate) : undefined,
    durationDays: b.probation.durationDays != null ? Number(b.probation.durationDays) : undefined,
    review30Day: b.probation.review30Day != null ? String(b.probation.review30Day) : undefined,
    review60Day: b.probation.review60Day != null ? String(b.probation.review60Day) : undefined,
    reviewFinalDate: b.probation.reviewFinalDate != null ? String(b.probation.reviewFinalDate) : undefined,
  } : undefined;
  const salary = b.salary != null ? {
    basic: b.salary.basic != null ? Number(b.salary.basic) : undefined,
    gross: b.salary.gross != null ? Number(b.salary.gross) : undefined,
    currency: b.salary.currency != null ? String(b.salary.currency) : undefined,
    frequency: b.salary.frequency != null ? String(b.salary.frequency) : undefined,
    allowances: Array.isArray(b.salary.allowances) ? b.salary.allowances.map((a: any) => ({
      allowanceType: String(a.allowanceType ?? ''),
      name: a.name != null ? String(a.name) : undefined,
      amount: a.amount != null ? Number(a.amount) : undefined,
      percentage: a.percentage != null ? Number(a.percentage) : undefined,
      frequency: a.frequency != null ? String(a.frequency) : undefined,
      currency: a.currency != null ? String(a.currency) : undefined,
      taxable: a.taxable != null ? Boolean(a.taxable) : undefined,
      payrollTreatment: a.payrollTreatment != null ? String(a.payrollTreatment) : undefined,
      effectiveDate: a.effectiveDate != null ? String(a.effectiveDate) : undefined,
      endDate: a.endDate != null ? String(a.endDate) : undefined,
    })) : undefined,
    benefits: Array.isArray(b.salary.benefits) ? b.salary.benefits.map((x: any) => ({
      benefitType: String(x.benefitType ?? ''),
      name: x.name != null ? String(x.name) : undefined,
      employerCost: x.employerCost != null ? Number(x.employerCost) : undefined,
      employeeContribution: x.employeeContribution != null ? Number(x.employeeContribution) : undefined,
      frequency: x.frequency != null ? String(x.frequency) : undefined,
      currency: x.currency != null ? String(x.currency) : undefined,
      taxable: x.taxable != null ? Boolean(x.taxable) : undefined,
      effectiveDate: x.effectiveDate != null ? String(x.effectiveDate) : undefined,
      endDate: x.endDate != null ? String(x.endDate) : undefined,
    })) : undefined,
  } : undefined;
  return contracts.createContract(c, ctx, {
    employeeId: Number(b.employeeId),
    contractType: String(b.contractType ?? ''),
    templateId: b.templateId != null ? Number(b.templateId) : undefined,
    startDate: b.startDate != null ? String(b.startDate) : undefined,
    endDate: b.endDate != null ? String(b.endDate) : undefined,
    jobTitle: b.jobTitle != null ? String(b.jobTitle) : undefined,
    jobCode: b.jobCode != null ? String(b.jobCode) : undefined,
    departmentId: b.departmentId != null ? Number(b.departmentId) : undefined,
    branchId: b.branchId != null ? Number(b.branchId) : undefined,
    location: b.location != null ? String(b.location) : undefined,
    reportingManager: b.reportingManager != null ? Number(b.reportingManager) : undefined,
    employeeCategory: b.employeeCategory != null ? String(b.employeeCategory) : undefined,
    probation,
    noticePeriodDays: b.noticePeriodDays != null ? Number(b.noticePeriodDays) : undefined,
    noticeBasis: b.noticeBasis != null ? String(b.noticeBasis) : undefined,
    workingHoursPerWeek: b.workingHoursPerWeek != null ? Number(b.workingHoursPerWeek) : undefined,
    workingDays: optStrArr(b.workingDays),
    restDays: optStrArr(b.restDays),
    annualLeaveDays: b.annualLeaveDays != null ? Number(b.annualLeaveDays) : undefined,
    salary,
    currency: b.currency != null ? String(b.currency) : undefined,
    grossSalary: b.grossSalary != null ? Number(b.grossSalary) : undefined,
    employerRepName: b.employerRepName != null ? String(b.employerRepName) : undefined,
    employerRepTitle: b.employerRepTitle != null ? String(b.employerRepTitle) : undefined,
    renewalEligibility: optBool(b.renewalEligibility),
    expiryNotificationDate: b.expiryNotificationDate != null ? String(b.expiryNotificationDate) : undefined,
    reason: b.reason != null ? String(b.reason) : undefined,
    changeReason: b.changeReason != null ? String(b.changeReason) : undefined,
    previousContractId: b.previousContractId != null ? Number(b.previousContractId) : undefined,
    clauseCodes: optStrArr(b.clauseCodes),
    employmentTypeConfirmed: optBool(b.employmentTypeConfirmed),
    handlesPersonalData: optBool(b.handlesPersonalData),
    hasConfidentialAccess: optBool(b.hasConfidentialAccess),
    overtimeEligible: optBool(b.overtimeEligible),
  });
}));

// Detail, versions, audit and draft edits
contractsOpsRouter.get('/contracts/:id', ...runGet('hr.contracts.view', (c, ctx, _q, p) => contracts.getContract(c, ctx, Number(p.id))));
contractsOpsRouter.get(
  '/contracts/:id/employee-photo',
  requirePermission('hr.contracts.view'),
  asyncHandler(async (req, res) => {
    const photo = await tx(async (c) => {
      const detail = await contracts.getContract(c, req.ctx, Number(req.params.id));
      const employeeId = Number((detail.contract as { employeeId?: number }).employeeId);
      if (!employeeId) throw notFound('Employee not found on this contract');
      return hr.getEmployeePhoto(c, req.ctx, employeeId);
    }, req.ctx);
    if (!photo) throw notFound('No photograph on file');
    res.setHeader('Content-Type', photo.mime);
    res.setHeader('Cache-Control', 'private, max-age=120');
    res.setHeader('Content-Disposition', 'inline; filename="employee-photo"');
    res.send(photo.bytes);
  })
);
contractsOpsRouter.post(
  '/contracts/:id/employee-photo',
  requirePermission('hr.contracts.update'),
  photoUpload.single('file'),
  asyncHandler(async (req, res) => {
    if (!req.file) throw badRequest('A photograph file is required (field "file")');
    const out = await tx(async (c) => {
      const detail = await contracts.getContract(c, req.ctx, Number(req.params.id));
      const employeeId = Number((detail.contract as { employeeId?: number }).employeeId);
      if (!employeeId) throw notFound('Employee not found on this contract');
      return hr.uploadEmployeePhoto(c, req.ctx, employeeId, {
        originalname: req.file!.originalname,
        mimetype: req.file!.mimetype,
        size: req.file!.size,
        buffer: req.file!.buffer,
      }, req.body?.kind != null ? String(req.body.kind) : 'PASSPORT');
    }, req.ctx);
    res.json({ data: out });
  })
);
contractsOpsRouter.get('/contracts/:id/versions', ...runGet('hr.contracts.view', async (c, ctx, _q, p) => {
  const res = await c.query(
    'SELECT id, contract_no, contract_type, status, version, start_date, end_date, job_title, salary, gross_salary, currency, previous_contract_id, created_at, updated_at FROM employment_contracts WHERE tenant_id = $1 AND company_id = $2 AND (id = $3 OR previous_contract_id = $3) AND deleted_at IS NULL ORDER BY version',
    [ctx.tenantId, ctx.companyId, Number(p.id)]
  );
  return res.rows.map(camelize);
}));
contractsOpsRouter.get('/contracts/:id/audit', ...runGet('hr.contracts.view_audit', async (c, ctx, _q, p) => {
  const res = await c.query(
    "SELECT id, action, resource, record_id, record_code, user_id, ip, user_agent, device, metadata, created_at FROM audit_logs WHERE tenant_id = $1 AND company_id = $2 AND resource = 'employment_contracts' AND record_id = $3 ORDER BY id DESC LIMIT 50",
    [ctx.tenantId, ctx.companyId, Number(p.id)]
  );
  return res.rows.map(camelize);
}));
contractsOpsRouter.patch('/contracts/:id', ...run('hr.contracts.update', (c, ctx, b, p) => contracts.updateContractDraft(c, ctx, Number(p.id), {
  endDate: b.endDate != null ? (b.endDate ? String(b.endDate) : null) : undefined,
  jobTitle: b.jobTitle != null ? String(b.jobTitle) : undefined,
  jobCode: b.jobCode != null ? String(b.jobCode) : undefined,
  departmentId: b.departmentId != null ? Number(b.departmentId) : undefined,
  branchId: b.branchId != null ? Number(b.branchId) : undefined,
  location: b.location != null ? String(b.location) : undefined,
  reportingManager: b.reportingManager != null ? Number(b.reportingManager) : undefined,
  employeeCategory: b.employeeCategory != null ? String(b.employeeCategory) : undefined,
  noticePeriodDays: b.noticePeriodDays != null ? Number(b.noticePeriodDays) : undefined,
  noticeBasis: b.noticeBasis != null ? String(b.noticeBasis) : undefined,
  workingHoursPerWeek: b.workingHoursPerWeek != null ? Number(b.workingHoursPerWeek) : undefined,
  workingDays: optStrArr(b.workingDays),
  restDays: optStrArr(b.restDays),
  annualLeaveDays: b.annualLeaveDays != null ? Number(b.annualLeaveDays) : undefined,
  currency: b.currency != null ? String(b.currency) : undefined,
  grossSalary: b.grossSalary != null ? Number(b.grossSalary) : undefined,
  employerRepName: b.employerRepName != null ? String(b.employerRepName) : undefined,
  employerRepTitle: b.employerRepTitle != null ? String(b.employerRepTitle) : undefined,
  renewalEligibility: optBool(b.renewalEligibility),
  expiryNotificationDate: b.expiryNotificationDate != null ? (b.expiryNotificationDate ? String(b.expiryNotificationDate) : null) : undefined,
  reason: b.reason != null ? String(b.reason) : undefined,
  changeReason: b.changeReason != null ? String(b.changeReason) : undefined,
})));

// Lifecycle: validate, submit, signature
contractsOpsRouter.post('/contracts/:id/validate', ...run('hr.contracts.validate', (c, ctx, _b, p) => contracts.validateContract(c, ctx, Number(p.id))));
contractsOpsRouter.post('/contracts/:id/submit', ...run('hr.contracts.submit', (c, ctx, _b, p) => contracts.submitContract(c, ctx, Number(p.id))));
contractsOpsRouter.post('/contracts/:id/request-signature', ...run('hr.contracts.sign', (c, ctx, b, p) => contracts.requestSignature(c, ctx, Number(p.id), {
  signerType: b.signerType != null ? String(b.signerType) : undefined,
})));
contractsOpsRouter.post('/contracts/:id/sign', ...run('hr.contracts.sign', (c, ctx, b, p) => contracts.signContract(c, ctx, Number(p.id), {
  signerType: String(b.signerType ?? 'EMPLOYEE') as 'EMPLOYEE' | 'EMPLOYER_REPRESENTATIVE' | 'WITNESS',
  signature: b.signature != null ? String(b.signature) : undefined,
  signatureUrl: b.signatureUrl != null ? String(b.signatureUrl) : undefined,
  witnessName: b.witnessName != null ? String(b.witnessName) : undefined,
  witnessEmail: b.witnessEmail != null ? String(b.witnessEmail) : undefined,
})));

/** Upload a signatory's signature image (stored on disk; attached to their signature row). */
contractsOpsRouter.post(
  '/contracts/:id/signature-image',
  requirePermission('hr.contracts.sign'),
  signatureUpload.single('file'),
  asyncHandler(async (req, res) => {
    if (!req.file) throw badRequest('A signature image file is required (field "file")');
    const signerType = String(req.body?.signerType ?? '').toUpperCase();
    if (!['EMPLOYEE', 'EMPLOYER_REPRESENTATIVE', 'WITNESS'].includes(signerType)) {
      throw badRequest('signerType must be EMPLOYEE, EMPLOYER_REPRESENTATIVE or WITNESS');
    }
    const ext = SIGNATURE_MIME_EXT[req.file.mimetype];
    if (!ext) throw badRequest('Unsupported image type. Use PNG or JPG.');
    const contractId = Number(req.params.id);
    if (!Number.isFinite(contractId) || contractId <= 0) throw badRequest('Invalid contract id');

    const tenantId = req.ctx.tenantId;
    const companyId = req.ctx.companyId ?? null;
    const dir = path.join('branding', String(tenantId ?? 0), String(companyId ?? 0));
    for (const oldExt of SIGNATURE_EXTS) {
      const oldPath = path.join(config.storageRoot, dir, `contract-sig-${contractId}-${signerType}${oldExt}`);
      if (existsSync(oldPath)) {
        try { unlinkSync(oldPath); } catch { /* ignore */ }
      }
    }

    const absolute = path.join(config.storageRoot, dir, `contract-sig-${contractId}-${signerType}${ext}`);
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, req.file.buffer);

    const url = `${config.apiPublicUrl}/api/public/branding/contract-signature?tenant=${tenantId}&company=${companyId ?? 0}&contract=${contractId}&signer=${signerType}&t=${Date.now()}`;
    res.json({ data: { url } });
  })
);

// Variations, renewals and certificates of service
contractsOpsRouter.post('/contracts/:id/variations', ...run('hr.contracts.vary', (c, ctx, b, p) => contracts.createVariation(c, ctx, Number(p.id), {
  variationType: String(b.variationType ?? ''),
  reason: b.reason != null ? String(b.reason) : undefined,
  changes: Array.isArray(b.changes) ? b.changes.map((x: any) => ({
    field: String(x.field ?? ''),
    label: x.label != null ? String(x.label) : undefined,
    oldValue: x.oldValue ?? undefined,
    newValue: x.newValue ?? undefined,
  })) : undefined,
  oldValues: b.oldValues != null ? b.oldValues : undefined,
  newValues: b.newValues != null ? b.newValues : undefined,
  effectiveDate: b.effectiveDate != null ? String(b.effectiveDate) : undefined,
})));
contractsOpsRouter.post('/contracts/variations/:vid/apply', ...run('hr.contracts.vary', (c, ctx, _b, p) => contracts.applyVariation(c, ctx, Number(p.vid))));
contractsOpsRouter.post('/contracts/:id/renewals', ...run('hr.contracts.renew', (c, ctx, b, p) => contracts.createRenewal(c, ctx, Number(p.id), {
  newStartDate: b.newStartDate != null ? String(b.newStartDate) : undefined,
  newEndDate: b.newEndDate != null ? String(b.newEndDate) : undefined,
  reason: b.reason != null ? String(b.reason) : undefined,
  renewalEligibility: optBool(b.renewalEligibility),
})));
contractsOpsRouter.post('/contracts/renewals/:rid/apply', ...run('hr.contracts.renew', (c, ctx, _b, p) => contracts.applyRenewal(c, ctx, Number(p.rid))));
contractsOpsRouter.post('/contracts/certificates', ...run('hr.certificates.create', (c, ctx, b) => contracts.createCertificateOfService(c, ctx, {
  employeeId: Number(b.employeeId),
  contractId: b.contractId != null ? Number(b.contractId) : undefined,
  periodStart: b.periodStart != null ? String(b.periodStart) : undefined,
  periodEnd: b.periodEnd != null ? String(b.periodEnd) : undefined,
  natureOfBusiness: b.natureOfBusiness != null ? String(b.natureOfBusiness) : undefined,
  position: b.position != null ? String(b.position) : undefined,
  wagesAtTermination: b.wagesAtTermination != null ? Number(b.wagesAtTermination) : undefined,
  reasonForTermination: b.reasonForTermination != null ? String(b.reasonForTermination) : undefined,
})));
contractsOpsRouter.post('/contracts/certificates/:id/issue', ...run('hr.certificates.issue', (c, ctx, _b, p) => contracts.issueCertificate(c, ctx, Number(p.id))));
