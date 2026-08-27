import { Router } from 'express';
import multer from 'multer';
import pg from 'pg';
import { tx, Ctx } from '../../db.js';
import { requirePermission } from '../../middleware/authorize.js';
import { asyncHandler, badRequest } from '../../utils.js';
import * as hcm from '../../services/hcm.js';
import * as hcmLists from '../../services/hcmLists.js';

export const hcmOpsRouter = Router();
const hcmUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

type OpFn = (client: pg.PoolClient, ctx: Ctx, body: any, params: Record<string, string>) => Promise<unknown>;
type QueryFn = (client: pg.PoolClient, ctx: Ctx, query: Record<string, unknown>, params: Record<string, string>) => Promise<unknown>;

const run = (permission: string | string[], fn: OpFn) => [
  requirePermission(permission),
  asyncHandler(async (req, res) => {
    const out = await tx((client) => fn(client, req.ctx, req.body ?? {}, req.params as Record<string, string>), req.ctx);
    res.json({ data: out });
  }),
];

const runGet = (permission: string | string[], fn: QueryFn) => [
  requirePermission(permission),
  asyncHandler(async (req, res) => {
    const out = await tx(
      (client) => fn(client, req.ctx, req.query as Record<string, unknown>, req.params as Record<string, string>),
      req.ctx
    );
    res.json({ data: out });
  }),
];

// ============================================================
// ORGANIZATION MANAGEMENT
// ============================================================
hcmOpsRouter.get('/dashboard', ...runGet('hr.employees.view', (c, ctx) => hcm.hcmDashboard(c, ctx)));
hcmOpsRouter.get('/org-chart', ...runGet('hr.employees.view', (c, ctx) => hcm.orgChart(c, ctx)));
hcmOpsRouter.get('/org-refs', ...runGet('hr.employees.view', (c, ctx) => hcm.orgRefs(c, ctx)));
hcmOpsRouter.get('/positions/occupancy', ...runGet('hr.positions.view', (c, ctx, q) => hcm.positionOccupancy(c, ctx, q.positionId != null ? Number(q.positionId) : null)));
hcmOpsRouter.get('/positions', ...runGet('hr.positions.view', (c, ctx, q) => hcm.listPositions(c, ctx, {
  departmentId: q.departmentId != null ? Number(q.departmentId) : null,
  status: q.status != null ? String(q.status) : null,
  q: q.q != null ? String(q.q) : null,
})));
hcmOpsRouter.post('/positions', ...run('hr.positions.create', (c, ctx, b) => hcm.createPosition(c, ctx, {
  title: String(b.title ?? ''),
  departmentId: b.departmentId != null ? Number(b.departmentId) : null,
  branchId: b.branchId != null ? Number(b.branchId) : null,
  divisionId: b.divisionId != null ? Number(b.divisionId) : null,
  orgUnitId: b.orgUnitId != null ? Number(b.orgUnitId) : null,
  teamId: b.teamId != null ? Number(b.teamId) : null,
  locationId: b.locationId != null ? Number(b.locationId) : null,
  jobFamilyId: b.jobFamilyId != null ? Number(b.jobFamilyId) : null,
  jobGradeId: b.jobGradeId != null ? Number(b.jobGradeId) : null,
  costCentreId: b.costCentreId != null ? Number(b.costCentreId) : null,
  reportToPositionId: b.reportToPositionId != null ? Number(b.reportToPositionId) : null,
  approvedHeadcount: b.approvedHeadcount != null ? Number(b.approvedHeadcount) : undefined,
  salaryMin: b.salaryMin != null ? Number(b.salaryMin) : null,
  salaryMax: b.salaryMax != null ? Number(b.salaryMax) : null,
  currency: b.currency != null ? String(b.currency) : undefined,
  requiredQualifications: b.requiredQualifications != null ? String(b.requiredQualifications) : null,
  requiredSkills: b.requiredSkills != null ? b.requiredSkills : null,
  jobDescription: b.jobDescription != null ? String(b.jobDescription) : null,
})));
hcmOpsRouter.patch('/positions/:id', ...run('hr.positions.update', (c, ctx, b, p) => hcm.updatePosition(c, ctx, Number(p.id), {
  title: b.title != null ? String(b.title) : undefined,
  approvedHeadcount: b.approvedHeadcount != null ? Number(b.approvedHeadcount) : undefined,
  salaryMin: b.salaryMin !== undefined ? (b.salaryMin == null ? null : Number(b.salaryMin)) : undefined,
  salaryMax: b.salaryMax !== undefined ? (b.salaryMax == null ? null : Number(b.salaryMax)) : undefined,
  status: b.status != null ? String(b.status) : undefined,
})));

// ============================================================
// WORKFORCE PLANNING
// ============================================================
hcmOpsRouter.post('/workforce-plans', ...run('hr.workforce_plans.create', (c, ctx, b) => hcm.createWorkforcePlan(c, ctx, {
  planName: String(b.planName ?? ''),
  fiscalYear: String(b.fiscalYear ?? ''),
  periodStart: b.periodStart != null ? String(b.periodStart) : null,
  periodEnd: b.periodEnd != null ? String(b.periodEnd) : null,
  budgetAmount: b.budgetAmount != null ? Number(b.budgetAmount) : undefined,
  currency: b.currency != null ? String(b.currency) : null,
  branchId: b.branchId != null ? Number(b.branchId) : null,
  departmentId: b.departmentId != null ? Number(b.departmentId) : null,
  notes: b.notes != null ? String(b.notes) : null,
  lines: Array.isArray(b.lines) ? b.lines.map((l: any) => ({
    positionId: Number(l.positionId),
    currentHeadcount: l.currentHeadcount != null ? Number(l.currentHeadcount) : undefined,
    plannedHeadcount: l.plannedHeadcount != null ? Number(l.plannedHeadcount) : undefined,
    expectedDepartures: l.expectedDepartures != null ? Number(l.expectedDepartures) : undefined,
    retirements: l.retirements != null ? Number(l.retirements) : undefined,
    newPositions: l.newPositions != null ? Number(l.newPositions) : undefined,
    salaryBudget: l.salaryBudget != null ? Number(l.salaryBudget) : undefined,
    notes: l.notes != null ? String(l.notes) : null,
  })) : undefined,
})));
hcmOpsRouter.post('/workforce-plans/:id/submit', ...run('hr.workforce_plans.submit', (c, ctx, _b, p) => hcm.submitWorkforcePlan(c, ctx, Number(p.id))));
hcmOpsRouter.get('/workforce-plans', ...runGet('hr.workforce_plans.view', (c, ctx, q) => hcm.listWorkforcePlans(c, ctx, {
  status: q.status != null && String(q.status) !== '' ? String(q.status) : null,
  fiscalYear: q.fiscalYear != null ? Number(q.fiscalYear) : null,
  q: q.q != null && String(q.q) !== '' ? String(q.q) : null,
  page: q.page != null ? Number(q.page) : undefined,
  pageSize: q.pageSize != null ? Number(q.pageSize) : undefined,
})));
hcmOpsRouter.get('/workforce-plans/:id', ...runGet('hr.workforce_plans.view', (c, ctx, _q, p) => hcm.getWorkforcePlan(c, ctx, Number(p.id))));
hcmOpsRouter.post('/workforce-plans/:id/scenarios', ...run('hr.workforce_scenarios.simulate', (c, ctx, b, p) => hcm.runWorkforceScenario(c, ctx, Number(p.id), {
  name: String(b.name ?? ''),
  growthPct: b.growthPct != null ? Number(b.growthPct) : undefined,
  avgMonthlySalary: b.avgMonthlySalary != null ? Number(b.avgMonthlySalary) : null,
  benefitsPct: b.benefitsPct != null ? Number(b.benefitsPct) : undefined,
  trainingCostPerHead: b.trainingCostPerHead != null ? Number(b.trainingCostPerHead) : undefined,
  monthlyPayrollPerHead: b.monthlyPayrollPerHead != null ? Number(b.monthlyPayrollPerHead) : null,
  notes: b.notes != null ? String(b.notes) : null,
})));

// ============================================================
// RECRUITMENT / ATS
// ============================================================
hcmOpsRouter.post('/requisitions', ...run('hr.requisitions.create', (c, ctx, b) => hcm.createRequisition(c, ctx, {
  title: String(b.title ?? ''),
  departmentId: b.departmentId != null ? Number(b.departmentId) : null,
  branchId: b.branchId != null ? Number(b.branchId) : null,
  positionId: b.positionId != null ? Number(b.positionId) : null,
  jobFamilyId: b.jobFamilyId != null ? Number(b.jobFamilyId) : null,
  jobGradeId: b.jobGradeId != null ? Number(b.jobGradeId) : null,
  employmentType: b.employmentType != null ? String(b.employmentType) : undefined,
  headcount: b.headcount != null ? Number(b.headcount) : undefined,
  salaryMin: b.salaryMin != null ? Number(b.salaryMin) : null,
  salaryMax: b.salaryMax != null ? Number(b.salaryMax) : null,
  currency: b.currency != null ? String(b.currency) : undefined,
  justification: b.justification != null ? String(b.justification) : null,
  budgetCode: b.budgetCode != null ? String(b.budgetCode) : null,
  hiringManagerId: b.hiringManagerId != null ? Number(b.hiringManagerId) : null,
  requiredQualifications: b.requiredQualifications != null ? String(b.requiredQualifications) : null,
  requiredSkills: b.requiredSkills != null ? b.requiredSkills : null,
  experienceYears: b.experienceYears != null ? Number(b.experienceYears) : null,
  jobDescription: b.jobDescription != null ? String(b.jobDescription) : null,
  isReplacement: b.isReplacement != null ? Boolean(b.isReplacement) : undefined,
  requiredDate: b.requiredDate != null ? String(b.requiredDate) : null,
})));
hcmOpsRouter.post('/requisitions/:id/submit', ...run('hr.requisitions.submit', (c, ctx, _b, p) => hcm.submitRequisition(c, ctx, Number(p.id))));

hcmOpsRouter.post('/vacancies', ...run('hr.vacancies.create', (c, ctx, b) => hcm.createVacancy(c, ctx, {
  requisitionId: Number(b.requisitionId),
  positionId: b.positionId != null ? Number(b.positionId) : null,
  locationId: b.locationId != null ? Number(b.locationId) : null,
  title: b.title != null ? String(b.title) : undefined,
  description: b.description != null ? String(b.description) : null,
  openings: b.openings != null ? Number(b.openings) : undefined,
  closesAt: b.closesAt != null ? String(b.closesAt) : null,
  externalUrl: b.externalUrl != null ? String(b.externalUrl) : null,
  applyUrl: b.applyUrl != null ? String(b.applyUrl) : null,
  isInternal: b.isInternal != null ? Boolean(b.isInternal) : undefined,
  isExternal: b.isExternal != null ? Boolean(b.isExternal) : undefined,
})));
hcmOpsRouter.post('/vacancies/:id/publish', ...run('hr.vacancies.publish', (c, ctx, b, p) => hcm.publishVacancy(c, ctx, Number(p.id), {
  closesAt: b.closesAt != null ? String(b.closesAt) : null,
  channels: Array.isArray(b.channels) ? b.channels : undefined,
})));
hcmOpsRouter.post('/vacancies/:id/views', ...run('hr.vacancies.view', (c, ctx, b, p) => hcm.trackVacancyView(c, ctx, Number(p.id), {
  source: b.source != null ? String(b.source) : null,
  referrer: b.referrer != null ? String(b.referrer) : null,
  userAgent: b.userAgent != null ? String(b.userAgent) : null,
  viewDate: b.viewDate != null ? String(b.viewDate) : null,
})));
hcmOpsRouter.get('/vacancies/pipeline', ...runGet('hr.vacancies.view', (c, ctx, q) => hcm.listVacancyPipeline(c, ctx, q.vacancyId != null ? Number(q.vacancyId) : null, q.status != null ? String(q.status) : null)));
hcmOpsRouter.get('/applications/pipeline', ...runGet('hr.applications.view', (c, ctx, q) => hcm.applicationPipeline(c, ctx, {
  vacancyId: q.vacancyId != null ? Number(q.vacancyId) : null,
  q: q.q != null ? String(q.q) : null,
})));

hcmOpsRouter.post('/applications', ...run('hr.applications.create', (c, ctx, b) => hcm.applyToVacancy(c, ctx, {
  vacancyId: Number(b.vacancyId),
  firstName: String(b.firstName ?? ''),
  lastName: String(b.lastName ?? ''),
  email: String(b.email ?? ''),
  phone: b.phone != null ? String(b.phone) : null,
  source: b.source != null ? String(b.source) : null,
  currentEmployer: b.currentEmployer != null ? String(b.currentEmployer) : null,
  currentTitle: b.currentTitle != null ? String(b.currentTitle) : null,
  coverLetter: b.coverLetter != null ? String(b.coverLetter) : null,
  expectedSalary: b.expectedSalary != null ? Number(b.expectedSalary) : null,
  currency: b.currency != null ? String(b.currency) : undefined,
  noticePeriodDays: b.noticePeriodDays != null ? Number(b.noticePeriodDays) : null,
  resumeDocumentId: b.resumeDocumentId != null ? Number(b.resumeDocumentId) : null,
})));
hcmOpsRouter.post('/applications/:id/advance', ...run('hr.applications.advance', (c, ctx, b, p) => hcm.advanceApplication(c, ctx, Number(p.id), {
  targetStage: b.targetStage != null ? String(b.targetStage) : undefined,
  rating: b.rating != null ? Number(b.rating) : null,
  note: b.note != null ? String(b.note) : null,
})));
hcmOpsRouter.post('/interviews', ...run('hr.interviews.create', (c, ctx, b) => hcm.scheduleInterview(c, ctx, {
  applicationId: Number(b.applicationId),
  scheduledAt: String(b.scheduledAt ?? ''),
  mode: b.mode != null ? String(b.mode) : undefined,
  interviewerIds: Array.isArray(b.interviewerIds) ? b.interviewerIds.map((x: unknown) => Number(x)) : undefined,
  durationMinutes: b.durationMinutes != null ? Number(b.durationMinutes) : null,
  location: b.location != null ? String(b.location) : null,
})));
hcmOpsRouter.post('/assessments', ...run('hr.assessments.create', (c, ctx, b) => hcm.recordAssessment(c, ctx, {
  applicationId: Number(b.applicationId),
  type: b.type != null ? String(b.type) : undefined,
  score: b.score != null ? Number(b.score) : null,
  maxScore: b.maxScore != null ? Number(b.maxScore) : null,
  result: b.result != null ? String(b.result) : undefined,
  assessedAt: b.assessedAt != null ? String(b.assessedAt) : null,
  notes: b.notes != null ? String(b.notes) : null,
})));
hcmOpsRouter.get('/candidates/:id', ...runGet('hr.candidates.view', (c, ctx, _q, p) => hcm.getCandidate(c, ctx, Number(p.id))));
hcmOpsRouter.post('/candidates/:id/documents', ...run('hr.candidates.update', (c, ctx, b, p) => hcm.attachCandidateDocument(c, ctx, {
  candidateId: Number(p.id),
  documentId: Number(b.documentId),
  isResume: b.isResume != null ? Boolean(b.isResume) : false,
})));
hcmOpsRouter.post(
  '/candidates/:id/documents/upload',
  requirePermission('hr.candidates.update'),
  hcmUpload.single('file'),
  asyncHandler(async (req, res) => {
    if (!req.file) throw badRequest('A PDF file is required (field "file")');
    const out = await tx(
      (client) =>
        hcm.uploadCandidateDocument(client, req.ctx, {
          candidateId: Number(req.params.id),
          file: {
            originalname: req.file!.originalname,
            mimetype: req.file!.mimetype,
            size: req.file!.size,
            buffer: req.file!.buffer,
          },
          title: req.body.title != null ? String(req.body.title) : null,
          category: req.body.category != null ? String(req.body.category) : null,
          isResume: req.body.isResume === 'true' || req.body.isResume === '1' || req.body.isResume === true,
        }),
      req.ctx
    );
    res.status(201).json({ data: out });
  })
);
hcmOpsRouter.get(
  '/candidates/:id/documents/:documentId/file',
  requirePermission('hr.candidates.view'),
  asyncHandler(async (req, res) => {
    const { buffer, doc } = await tx(
      (client) =>
        hcm.getCandidateDocumentFile(client, req.ctx, {
          candidateId: Number(req.params.id),
          documentId: Number(req.params.documentId),
        }),
      req.ctx
    );
    const safe = String(doc.fileName ?? 'document.pdf').replace(/[^A-Za-z0-9._-]+/g, '_');
    const disposition = String(req.query.download ?? '') === '1' ? 'attachment' : 'inline';
    res.setHeader('Content-Type', String(doc.mimeType ?? 'application/pdf'));
    res.setHeader('Content-Disposition', `${disposition}; filename="${safe}"`);
    res.setHeader('Content-Length', String(buffer.length));
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(buffer);
  })
);

hcmOpsRouter.post('/offers', ...run('hr.offers.create', (c, ctx, b) => hcm.createOffer(c, ctx, {
  applicationId: Number(b.applicationId),
  positionId: b.positionId != null ? Number(b.positionId) : null,
  baseSalary: Number(b.baseSalary ?? 0),
  allowances: b.allowances != null ? b.allowances : undefined,
  benefits: b.benefits != null ? String(b.benefits) : null,
  currency: b.currency != null ? String(b.currency) : undefined,
  contractType: b.contractType != null ? String(b.contractType) : undefined,
  startDate: b.startDate != null ? String(b.startDate) : null,
  probationMonths: b.probationMonths != null ? Number(b.probationMonths) : undefined,
  expiresAt: b.expiresAt != null ? String(b.expiresAt) : null,
})));
hcmOpsRouter.post('/offers/:id/send', ...run('hr.offers.send', (c, ctx, b, p) => hcm.sendOffer(c, ctx, Number(p.id), {
  expiresAt: b.expiresAt != null ? String(b.expiresAt) : null,
})));
hcmOpsRouter.post('/offers/:id/withdraw', ...run('hr.offers.withdraw', (c, ctx, _b, p) => hcm.withdrawOffer(c, ctx, Number(p.id))));
hcmOpsRouter.post('/offers/:id/decline', ...run('hr.offers.decline', (c, ctx, b, p) => hcm.declineOffer(c, ctx, Number(p.id), b.reason != null ? String(b.reason) : null)));
hcmOpsRouter.post('/offers/:id/accept', ...run('hr.offers.accept', (c, ctx, b, p) => hcm.acceptOffer(c, ctx, Number(p.id), {
  startDate: b.startDate != null ? String(b.startDate) : null,
  employeeNo: b.employeeNo != null ? String(b.employeeNo) : null,
  notes: b.notes != null ? String(b.notes) : null,
})));

// ============================================================
// ONBOARDING
// ============================================================
hcmOpsRouter.post('/onboarding/:id/start', ...run('hr.onboarding.start', (c, ctx, _b, p) => hcm.startOnboarding(c, ctx, Number(p.id))));
hcmOpsRouter.post('/onboarding/:id/tasks/:taskId/complete', ...run('hr.onboarding.update', (c, ctx, b, p) => hcm.completeOnboardingTask(c, ctx, Number(p.id), Number(p.taskId), b.notes != null ? String(b.notes) : null)));
hcmOpsRouter.post('/onboarding/:id/complete', ...run('hr.onboarding.complete', (c, ctx, _b, p) => hcm.completeOnboarding(c, ctx, Number(p.id))));
hcmOpsRouter.get('/onboardings', ...runGet('hr.onboarding.view', (c, ctx, q) => hcm.listOnboardings(c, ctx, {
  status: q.status != null ? String(q.status) : null,
  employeeId: q.employeeId != null ? Number(q.employeeId) : null,
  q: q.q != null ? String(q.q) : null,
  page: q.page != null ? Number(q.page) : undefined,
  pageSize: q.pageSize != null ? Number(q.pageSize) : undefined,
})));
hcmOpsRouter.get('/onboardings/:id', ...runGet('hr.onboarding.view', (c, ctx, _q, p) => hcm.getOnboarding(c, ctx, Number(p.id))));

// ============================================================
// OFFBOARDING / EXIT CLEARANCE / ALUMNI
// ============================================================
hcmOpsRouter.post('/offboardings', ...run('hr.offboardings.create', (c, ctx, b) => hcm.createOffboarding(c, ctx, {
  employeeId: Number(b.employeeId),
  offboardingType: b.offboardingType != null ? String(b.offboardingType) : null,
  effectiveDate: b.effectiveDate != null ? String(b.effectiveDate) : null,
  lastWorkingDate: b.lastWorkingDate != null ? String(b.lastWorkingDate) : null,
  reason: b.reason != null ? String(b.reason) : null,
  checklistId: b.checklistId != null ? Number(b.checklistId) : null,
  finalSettlementRequired: b.finalSettlementRequired,
  notes: b.notes != null ? String(b.notes) : null,
})));
hcmOpsRouter.get('/offboardings', ...runGet('hr.offboardings.view', (c, ctx, q) => hcm.listOffboardings(c, ctx, {
  status: q.status != null ? String(q.status) : null,
  employeeId: q.employeeId != null ? Number(q.employeeId) : null,
  q: q.q != null ? String(q.q) : null,
  page: q.page != null ? Number(q.page) : undefined,
  pageSize: q.pageSize != null ? Number(q.pageSize) : undefined,
})));
hcmOpsRouter.get('/offboardings/:id', ...runGet('hr.offboardings.view', (c, ctx, _q, p) => hcm.getOffboarding(c, ctx, Number(p.id))));
hcmOpsRouter.post('/offboardings/:id/start', ...run('hr.offboardings.start', (c, ctx, _b, p) => hcm.startOffboarding(c, ctx, Number(p.id))));
hcmOpsRouter.post('/offboardings/:id/tasks/:taskId/complete', ...run('hr.offboardings.waive', (c, ctx, b, p) => hcm.completeOffboardingTask(c, ctx, Number(p.id), Number(p.taskId), {
  status: b.status != null ? String(b.status) : 'COMPLETED',
  notes: b.notes != null ? String(b.notes) : null,
})));
hcmOpsRouter.post('/offboardings/:id/complete', ...run('hr.offboardings.complete', (c, ctx, b, p) => hcm.completeOffboarding(c, ctx, Number(p.id), {
  exitInterviewNotes: b.exitInterviewNotes != null ? String(b.exitInterviewNotes) : null,
  alumniDate: b.alumniDate != null ? String(b.alumniDate) : null,
  rehireEligible: b.rehireEligible,
})));
hcmOpsRouter.post('/offboardings/:id/cancel', ...run('hr.offboardings.cancel', (c, ctx, b, p) => hcm.cancelOffboarding(c, ctx, Number(p.id), b.reason != null ? String(b.reason) : null)));

// ============================================================
// EMPLOYEE MOVEMENTS (promotion / transfer / secondment)
// ============================================================
hcmOpsRouter.post('/movements', ...run('hr.employees.update', (c, ctx, b) => hcm.recordMovement(c, ctx, {
  employeeId: Number(b.employeeId),
  positionId: Number(b.positionId),
  movementType: String(b.movementType ?? 'TRANSFER'),
  effectiveFrom: String(b.effectiveFrom ?? ''),
  notes: b.notes != null ? String(b.notes) : null,
  reason: b.reason != null ? String(b.reason) : null,
  salary: b.salary !== undefined && b.salary !== null ? Number(b.salary) : null,
  salaryEffective: b.salaryEffective != null ? String(b.salaryEffective) : null,
})));

// ============================================================
// EMPLOYEE LIFECYCLE TIMELINE
// ============================================================
hcmOpsRouter.get('/employees/:id/timeline', ...runGet('hr.employees.view', (c, ctx, _q, p) => hcm.employeeTimeline(c, ctx, Number(p.id))));

// ============================================================
// ATTENDANCE / SHIFTS / TIMESHEETS
// ============================================================
hcmOpsRouter.get('/shifts', ...runGet('hr.shifts.view', (c, ctx) => hcmLists.listShifts(c, ctx)));
hcmOpsRouter.get('/shifts/assignments', ...runGet('hr.shift_assignments.view', (c, ctx) => hcmLists.listShiftAssignments(c, ctx)));
hcmOpsRouter.get('/timesheets', ...runGet('hr.timesheets.view', (c, ctx, q) => hcmLists.listTimesheets(c, ctx, q.status != null ? String(q.status) : null)));
hcmOpsRouter.post('/timesheets', ...run('hr.timesheets.create', (c, ctx, b) => hcmLists.createTimesheet(c, ctx, {
  employeeId: Number(b.employeeId),
  periodStart: String(b.periodStart ?? ''),
  periodEnd: String(b.periodEnd ?? ''),
  totalHours: b.totalHours != null ? Number(b.totalHours) : undefined,
  notes: b.notes != null ? String(b.notes) : null,
})));
hcmOpsRouter.post('/shifts', ...run('hr.shifts.create', (c, ctx, b) => hcm.createShift(c, ctx, {
  code: String(b.code ?? ''),
  name: String(b.name ?? ''),
  startTime: String(b.startTime ?? ''),
  endTime: String(b.endTime ?? ''),
  graceMinutes: b.graceMinutes != null ? Number(b.graceMinutes) : undefined,
  breakMinutes: b.breakMinutes != null ? Number(b.breakMinutes) : undefined,
  workHours: b.workHours != null ? Number(b.workHours) : null,
  appliesTo: b.appliesTo != null ? b.appliesTo : null,
  branchId: b.branchId != null ? Number(b.branchId) : null,
})));
hcmOpsRouter.post('/shifts/assignments', ...run('hr.shift_assignments.create', (c, ctx, b) => hcm.assignShift(c, ctx, {
  employeeId: Number(b.employeeId),
  shiftId: Number(b.shiftId),
  effectiveFrom: String(b.effectiveFrom ?? ''),
  effectiveTo: b.effectiveTo != null ? String(b.effectiveTo) : null,
})));
hcmOpsRouter.post('/timesheets/:id/submit', ...run('hr.timesheets.submit', (c, ctx, b, p) => hcm.submitTimesheet(c, ctx, Number(p.id), b.totalHours != null ? Number(b.totalHours) : null)));
hcmOpsRouter.post('/timesheets/:id/approve', ...run('hr.timesheets.approve', (c, ctx, _b, p) => hcm.approveTimesheet(c, ctx, Number(p.id))));

// ============================================================
// LEAVE
// ============================================================
hcmOpsRouter.post('/leave/accrual/run', ...run('hr.leave_accruals.accrue', (c, ctx, b) => hcm.runLeaveAccrual(c, ctx, b.year != null ? Number(b.year) : null)));
hcmOpsRouter.get('/leave/balances', ...runGet('hr.leave_balances.view', (c, ctx, q) => hcm.listLeaveBalances(c, ctx, {
  employeeId: q.employeeId != null ? Number(q.employeeId) : null,
  year: q.year != null ? Number(q.year) : null,
  leaveTypeId: q.leaveTypeId != null ? Number(q.leaveTypeId) : null,
})));

// ============================================================
// PERFORMANCE
// ============================================================
hcmOpsRouter.get('/performance/goals', ...runGet('hr.performance_goals.view', (c, ctx, q) => hcmLists.listPerformanceGoals(c, ctx, q.status != null ? String(q.status) : null)));
hcmOpsRouter.get('/performance/reviews', ...runGet('hr.performance_reviews.view', (c, ctx, q) => hcmLists.listPerformanceReviews(c, ctx, q.status != null ? String(q.status) : null)));
hcmOpsRouter.get('/performance/pips', ...runGet('hr.pips.view', (c, ctx, q) => hcmLists.listPips(c, ctx, q.status != null ? String(q.status) : null)));
hcmOpsRouter.post('/performance/goals', ...run('hr.performance_goals.create', (c, ctx, b) => hcm.createPerformanceGoal(c, ctx, {
  employeeId: Number(b.employeeId),
  title: String(b.title ?? ''),
  description: b.description != null ? String(b.description) : null,
  category: b.category != null ? String(b.category) : undefined,
  startDate: b.startDate != null ? String(b.startDate) : null,
  dueDate: b.dueDate != null ? String(b.dueDate) : null,
  weight: b.weight != null ? Number(b.weight) : undefined,
  kpis: Array.isArray(b.kpis) ? b.kpis.map((k: any) => ({
    name: String(k.name ?? ''),
    unit: k.unit != null ? String(k.unit) : undefined,
    targetValue: k.targetValue != null ? Number(k.targetValue) : undefined,
    weight: k.weight != null ? Number(k.weight) : undefined,
  })) : undefined,
})));
hcmOpsRouter.patch('/performance/kpis/:id', ...run('hr.performance_kpis.update', (c, ctx, b, p) => hcm.updateKpi(c, ctx, Number(p.id), {
  actualValue: b.actualValue != null ? Number(b.actualValue) : null,
  status: b.status != null ? String(b.status) : undefined,
  notes: b.notes != null ? String(b.notes) : null,
})));
hcmOpsRouter.post('/performance/reviews', ...run('hr.performance_reviews.create', (c, ctx, b) => hcm.startPerformanceReview(c, ctx, {
  employeeId: Number(b.employeeId),
  reviewType: b.reviewType != null ? String(b.reviewType) : undefined,
  periodStart: b.periodStart != null ? String(b.periodStart) : null,
  periodEnd: b.periodEnd != null ? String(b.periodEnd) : null,
  dueDate: b.dueDate != null ? String(b.dueDate) : null,
  reviewerId: b.reviewerId != null ? Number(b.reviewerId) : null,
})));
hcmOpsRouter.post('/performance/reviews/:id/complete', ...run('hr.performance_reviews.complete', (c, ctx, b, p) => hcm.completeReview(c, ctx, Number(p.id), {
  overallRating: b.overallRating != null ? Number(b.overallRating) : null,
  summary: b.summary != null ? String(b.summary) : null,
})));
hcmOpsRouter.post('/performance/pips', ...run('hr.pips.create', (c, ctx, b) => hcm.createPip(c, ctx, {
  employeeId: Number(b.employeeId),
  reason: String(b.reason ?? ''),
  startDate: b.startDate != null ? String(b.startDate) : null,
  endDate: b.endDate != null ? String(b.endDate) : null,
  goals: Array.isArray(b.goals) ? b.goals.map((g: any) => ({ title: String(g.title ?? ''), target: String(g.target ?? '') })) : undefined,
})));
hcmOpsRouter.post('/performance/pips/:id/close', ...run('hr.pips.close', (c, ctx, b, p) => hcm.closePip(c, ctx, Number(p.id), b.outcome != null ? String(b.outcome) : null)));

// ============================================================
// EMPLOYEE RELATIONS
// ============================================================
hcmOpsRouter.get('/relations/grievances', ...runGet('hr.grievances.view', (c, ctx, q) => hcmLists.listGrievances(c, ctx, q.status != null ? String(q.status) : null)));
hcmOpsRouter.get('/relations/disciplinary-cases', ...runGet('hr.disciplinary.view', (c, ctx, q) => hcmLists.listDisciplinaryCases(c, ctx, q.status != null ? String(q.status) : null)));
hcmOpsRouter.get('/relations/warnings', ...runGet('hr.warnings.view', (c, ctx, q) => hcmLists.listWarnings(c, ctx, q.status != null ? String(q.status) : null)));
hcmOpsRouter.post('/relations/grievances', ...run('hr.grievances.create', (c, ctx, b) => hcm.registerGrievance(c, ctx, {
  employeeId: Number(b.employeeId),
  category: String(b.category ?? ''),
  subject: String(b.subject ?? ''),
  description: b.description != null ? String(b.description) : null,
  priority: b.priority != null ? String(b.priority) : undefined,
})));
hcmOpsRouter.post('/relations/grievances/:id/resolve', ...run('hr.grievances.resolve', (c, ctx, b, p) => hcm.resolveGrievance(c, ctx, Number(p.id), {
  resolution: String(b.resolution ?? ''),
  resolvedBy: b.resolvedBy != null ? Number(b.resolvedBy) : null,
})));
hcmOpsRouter.post('/relations/investigations', ...run('hr.investigations.create', (c, ctx, b) => hcm.startInvestigation(c, ctx, {
  grievanceId: b.grievanceId != null ? Number(b.grievanceId) : null,
  disciplinaryCaseId: b.disciplinaryCaseId != null ? Number(b.disciplinaryCaseId) : null,
  investigatorUserId: b.investigatorUserId != null ? Number(b.investigatorUserId) : null,
})));
hcmOpsRouter.post('/relations/investigations/:id/complete', ...run('hr.investigations.complete', (c, ctx, b, p) => hcm.completeInvestigation(c, ctx, Number(p.id), {
  findings: String(b.findings ?? ''),
  disciplinaryCaseId: b.disciplinaryCaseId != null ? Number(b.disciplinaryCaseId) : null,
})));
hcmOpsRouter.post('/relations/disciplinary-cases', ...run('hr.disciplinary.create', (c, ctx, b) => hcm.openDisciplinaryCase(c, ctx, {
  employeeId: Number(b.employeeId),
  incidentDate: b.incidentDate != null ? String(b.incidentDate) : null,
  category: String(b.category ?? ''),
  description: b.description != null ? String(b.description) : null,
})));
hcmOpsRouter.post('/relations/disciplinary-actions', ...run('hr.disciplinary.create', (c, ctx, b) => hcm.recordDisciplinaryAction(c, ctx, {
  caseId: Number(b.caseId),
  actionType: String(b.actionType ?? ''),
  description: b.description != null ? String(b.description) : null,
  effectiveDate: b.effectiveDate != null ? String(b.effectiveDate) : null,
  durationDays: b.durationDays != null ? Number(b.durationDays) : null,
  decision: b.decision != null ? String(b.decision) : null,
})));
hcmOpsRouter.post('/relations/warnings', ...run('hr.warnings.issue', (c, ctx, b) => hcm.issueWarning(c, ctx, {
  employeeId: Number(b.employeeId),
  warningType: b.warningType != null ? String(b.warningType) : undefined,
  reason: String(b.reason ?? ''),
  issuedAt: b.issuedAt != null ? String(b.issuedAt) : null,
  expiresAt: b.expiresAt != null ? String(b.expiresAt) : null,
})));

// ============================================================
// LEARNING & DEVELOPMENT
// ============================================================
hcmOpsRouter.get('/training/catalog', ...runGet('hr.training_catalog.view', (c, ctx) => hcmLists.listTrainingCatalog(c, ctx)));
hcmOpsRouter.post('/training/catalog', ...run('hr.training_catalog.create', (c, ctx, b) => hcmLists.createTrainingCourse(c, ctx, {
  code: b.code != null ? String(b.code) : undefined,
  title: String(b.title ?? ''),
  category: b.category != null ? String(b.category) : null,
  durationHours: b.durationHours != null ? Number(b.durationHours) : null,
  provider: b.provider != null ? String(b.provider) : null,
  cost: b.cost != null ? Number(b.cost) : undefined,
})));
hcmOpsRouter.get('/training/sessions', ...runGet('hr.training_sessions.view', (c, ctx) => hcmLists.listTrainingSessions(c, ctx)));
hcmOpsRouter.post('/training/sessions', ...run('hr.training_sessions.create', (c, ctx, b) => hcmLists.createTrainingSession(c, ctx, {
  trainingId: Number(b.trainingId),
  startDate: String(b.startDate ?? ''),
  endDate: b.endDate != null ? String(b.endDate) : null,
  location: b.location != null ? String(b.location) : null,
  trainer: b.trainer != null ? String(b.trainer) : null,
  capacity: b.capacity != null ? Number(b.capacity) : null,
})));
hcmOpsRouter.get('/training/requests', ...runGet('hr.training_requests.view', (c, ctx, q) => hcmLists.listTrainingRequests(c, ctx, q.status != null ? String(q.status) : null)));
hcmOpsRouter.get('/training/enrollments', ...runGet('hr.training_enrollments.view', (c, ctx, q) => hcmLists.listTrainingEnrollments(c, ctx, q.status != null ? String(q.status) : null)));
hcmOpsRouter.post('/training/requests', ...run('hr.training_requests.create', (c, ctx, b) => hcm.requestTraining(c, ctx, {
  trainingId: Number(b.trainingId),
  employeeId: Number(b.employeeId),
  reason: b.reason != null ? String(b.reason) : null,
})));
hcmOpsRouter.post('/training/requests/:id/approve', ...run('hr.training_requests.approve', (c, ctx, _b, p) => hcm.approveTrainingRequest(c, ctx, Number(p.id))));
hcmOpsRouter.post('/training/enrollments', ...run('hr.training_enrollments.create', (c, ctx, b) => hcm.enrollTraining(c, ctx, {
  sessionId: Number(b.sessionId),
  employeeId: Number(b.employeeId),
})));
hcmOpsRouter.post('/training/enrollments/:id/complete', ...run('hr.training_sessions.complete', (c, ctx, b, p) => hcm.completeTraining(c, ctx, Number(p.id), {
  score: b.score != null ? Number(b.score) : null,
})));

// ============================================================
// BENEFITS
// ============================================================
hcmOpsRouter.get('/benefits/plans', ...runGet('hr.benefit_plans.view', (c, ctx) => hcmLists.listBenefitPlans(c, ctx)));
hcmOpsRouter.post('/benefits/plans', ...run('hr.benefit_plans.create', (c, ctx, b) => hcmLists.createBenefitPlan(c, ctx, {
  code: b.code != null ? String(b.code) : undefined,
  name: String(b.name ?? ''),
  category: b.category != null ? String(b.category) : undefined,
  provider: b.provider != null ? String(b.provider) : null,
  cost: b.cost != null ? Number(b.cost) : undefined,
  employeeContribution: b.employeeContribution != null ? Number(b.employeeContribution) : undefined,
  employerContribution: b.employerContribution != null ? Number(b.employerContribution) : undefined,
})));
hcmOpsRouter.get('/benefits/enrollments', ...runGet('hr.benefit_enrollments.view', (c, ctx, q) => hcmLists.listBenefitEnrollments(c, ctx, q.status != null ? String(q.status) : null)));
hcmOpsRouter.post('/benefits/enrollments', ...run('hr.benefit_enrollments.enroll', (c, ctx, b) => hcm.enrollBenefit(c, ctx, {
  employeeId: Number(b.employeeId),
  planId: Number(b.planId),
  dependantId: b.dependantId != null ? Number(b.dependantId) : null,
  effectiveFrom: b.effectiveFrom != null ? String(b.effectiveFrom) : null,
  effectiveTo: b.effectiveTo != null ? String(b.effectiveTo) : null,
  monthlyCost: b.monthlyCost != null ? Number(b.monthlyCost) : null,
})));
hcmOpsRouter.post('/benefits/enrollments/:id/resign', ...run('hr.benefit_enrollments.update', (c, ctx, b, p) => hcm.resignBenefit(c, ctx, Number(p.id), b.effectiveTo != null ? String(b.effectiveTo) : null)));

// ============================================================
// ASSET MANAGEMENT
// ============================================================
hcmOpsRouter.post('/assets/assignments', ...run('hr.asset_assignments.create', (c, ctx, b) => hcm.assignAsset(c, ctx, {
  assetId: Number(b.assetId),
  employeeId: Number(b.employeeId),
  expectedReturnDate: b.expectedReturnDate != null ? String(b.expectedReturnDate) : null,
  notes: b.notes != null ? String(b.notes) : null,
})));
hcmOpsRouter.post('/assets/assignments/:id/return', ...run('hr.asset_assignments.return', (c, ctx, b, p) => hcm.returnAsset(c, ctx, Number(p.id), {
  condition: b.condition != null ? String(b.condition) : null,
  notes: b.notes != null ? String(b.notes) : null,
})));

// ============================================================
// EMPLOYEE SELF-SERVICE
// ============================================================
hcmOpsRouter.get('/me', ...runGet(['hr.employees.view', 'hr.leave.view', 'hr.payslips.view'], (c, ctx) => hcm.myProfile(c, ctx)));
hcmOpsRouter.get('/me/leave', ...runGet('hr.leave.view', (c, ctx) => hcm.myLeave(c, ctx)));
hcmOpsRouter.get('/me/attendance', ...runGet('hr.attendance.view', (c, ctx) => hcm.myAttendance(c, ctx)));
hcmOpsRouter.get('/me/payslips', ...runGet('hr.payslips.view', (c, ctx) => hcm.myPayslips(c, ctx)));
hcmOpsRouter.get('/me/documents', ...runGet(['hr.employees.view', 'hr.leave.view'], (c, ctx) => hcm.myDocuments(c, ctx)));
hcmOpsRouter.get('/me/requests', ...runGet('hr.employee_requests.view', (c, ctx) => hcm.myRequests(c, ctx)));

// ============================================================
// CALENDAR / REPORTING
// ============================================================
hcmOpsRouter.get('/calendar', ...runGet('hr.holidays.view', (c, ctx, q) => hcm.hrCalendar(c, ctx, {
  startDate: q.startDate != null ? String(q.startDate) : null,
  endDate: q.endDate != null ? String(q.endDate) : null,
})));
