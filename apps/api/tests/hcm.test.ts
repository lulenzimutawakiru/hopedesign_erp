import { describe, it, expect } from 'vitest';
import { api, auth, loginAs, db, deleteEmployees, findPendingTask } from './helpers.js';
import { deflateSync } from 'node:zlib';

/** Submit an entity, delegate the approval task to an approver, then approve. */
async function delegateAndApprove(
  creatorToken: string,
  approverToken: string,
  approverUserId: number,
  entityType: string,
  entityId: number
) {
  const creatorTask = await findPendingTask(creatorToken, entityType, entityId, 1);
  expect(creatorTask).toBeTruthy();
  const delegated = await api.post(`/api/approvals/${creatorTask}/decide`).set(auth(creatorToken)).send({
    decision: 'DELEGATED',
    delegateToUserId: approverUserId,
  });
  expect(delegated.status).toBe(200);
  const approverTask = await findPendingTask(approverToken, entityType, entityId, 1);
  expect(approverTask).toBeTruthy();
  const approved = await api.post(`/api/approvals/${approverTask}/decide`).set(auth(approverToken)).send({
    decision: 'APPROVED',
  });
  expect(approved.status).toBe(200);
}

describe('HCM lifecycle', () => {
  it(
    'runs workforce plan -> requisition -> ATS -> hire -> onboarding -> leave accrual -> payroll',
    async () => {
      const { token: hrToken } = await loginAs('hr.hannah');
      const admin = await loginAs('admin');
      const adminToken = admin.token;
      const adminId = Number(admin.user.id);

      // Defensive: clear a leftover payroll from a crashed run for the same period.
      await db(
        `DELETE FROM payrolls
         WHERE company_id = (SELECT id FROM companies WHERE code = 'HDG')
           AND period_start <= '2026-08-31' AND period_end >= '2026-08-01'`
      );

      // Resolve deterministic HCM configuration ids (seeded by db:seed).
      const scope = `tenant_id = (SELECT id FROM tenants WHERE code = 'HDG') AND company_id = (SELECT id FROM companies WHERE code = 'HDG')`;
      const dept = await db(`SELECT id FROM departments WHERE ${scope} AND code = 'PROD'`);
      const family = await db(`SELECT id FROM job_families WHERE ${scope} AND code = 'OPS'`);
      const grade = await db(`SELECT id FROM job_grades WHERE ${scope} AND code = 'G3'`);
      const cc = await db(`SELECT id FROM cost_centres WHERE ${scope} AND code = 'CC-PROD'`);
      expect(dept.rows.length && family.rows.length && grade.rows.length && cc.rows.length).toBeTruthy();
      const departmentId = Number(dept.rows[0].id);
      const jobFamilyId = Number(family.rows[0].id);
      const jobGradeId = Number(grade.rows[0].id);
      const costCentreId = Number(cc.rows[0].id);

      // 1. Position
      const position = await api.post('/api/ops/hcm/positions').set(auth(hrToken)).send({
        title: 'Production Supervisor',
        departmentId,
        costCentreId,
        jobFamilyId,
        jobGradeId,
        approvedHeadcount: 5,
        salaryMin: 1200000,
        salaryMax: 2500000,
        requiredQualifications: 'Diploma in Production Management',
        requiredSkills: ['Lean Manufacturing', 'Team Leadership'],
      });
      expect(position.status).toBe(200);
      const positionId = Number(position.body.data.positionId);

      // 2. Workforce plan (submit -> delegate -> approve)
      const plan = await api.post('/api/ops/hcm/workforce-plans').set(auth(hrToken)).send({
        planName: '2026 Production Headcount Plan',
        fiscalYear: '2026',
        periodStart: '2026-01-01',
        periodEnd: '2026-12-31',
        budgetAmount: 60000000,
        departmentId,
        lines: [
          {
            positionId,
            currentHeadcount: 4,
            plannedHeadcount: 5,
            expectedDepartures: 1,
            retirements: 0,
            newPositions: 1,
            salaryBudget: 1800000,
          },
        ],
      });
      expect(plan.status).toBe(200);
      const planId = Number(plan.body.data.planId);
      const planSubmit = await api.post(`/api/ops/hcm/workforce-plans/${planId}/submit`).set(auth(hrToken));
      expect(planSubmit.status).toBe(200);
      await delegateAndApprove(hrToken, adminToken, adminId, 'hr.workforce_plans', planId);
      const planRow = await db(`SELECT status FROM workforce_plans WHERE id = $1`, [planId]);
      expect(planRow.rows[0].status).toBe('APPROVED');

      // 3. Requisition (submit -> delegate -> approve)
      const req = await api.post('/api/ops/hcm/requisitions').set(auth(hrToken)).send({
        title: 'Production Supervisor',
        departmentId,
        positionId,
        headcount: 1,
        salaryMin: 1200000,
        salaryMax: 2500000,
        jobFamilyId,
        jobGradeId,
        justification: 'Backfill per approved 2026 workforce plan',
        requiredQualifications: 'Diploma in Production Management',
        requiredSkills: ['Lean Manufacturing'],
      });
      expect(req.status).toBe(200);
      const requisitionId = Number(req.body.data.requisitionId);
      const reqSubmit = await api.post(`/api/ops/hcm/requisitions/${requisitionId}/submit`).set(auth(hrToken));
      expect(reqSubmit.status).toBe(200);
      await delegateAndApprove(hrToken, adminToken, adminId, 'hr.requisitions', requisitionId);
      const reqRow = await db(`SELECT status FROM job_requisitions WHERE id = $1`, [requisitionId]);
      expect(reqRow.rows[0].status).toBe('APPROVED');

      // 4. Vacancy
      const vacancy = await api.post('/api/ops/hcm/vacancies').set(auth(hrToken)).send({
        requisitionId,
        positionId,
        openings: 1,
      });
      expect(vacancy.status).toBe(200);
      const vacancyId = Number(vacancy.body.data.vacancyId);
      const publish = await api.post(`/api/ops/hcm/vacancies/${vacancyId}/publish`).set(auth(hrToken)).send({});
      expect(publish.status).toBe(200);
      expect(publish.body.data.status).toBe('PUBLISHED');

      // 5. ATS pipeline (screen -> shortlist -> interview -> assessment -> references)
     const application = await api.post('/api/ops/hcm/applications').set(auth(hrToken)).send({
       vacancyId,
       firstName: 'Sarah',
       lastName: 'Nakato',
       email: `hcm.${Date.now()}@example.com`,
       phone: '+256700000000',
       source: 'LINKEDIN',
        nationalId: 'CM890123456789012',
        bankAccountNo: '9020112345678',
        healthDetails: 'none',
     });
     expect(application.status).toBe(200);
     const applicationId = Number(application.body.data.applicationId);
     const candidateId = Number(application.body.data.candidateId);
      // Recruitment source is captured; unnecessary sensitive PII is never persisted.
      const privacyProfile = await api.get(`/api/ops/hcm/candidates/${candidateId}`).set(auth(hrToken));
      expect(privacyProfile.status).toBe(200);
      const candidateRow = privacyProfile.body.data?.candidate ?? {};
      expect(candidateRow.source).toBe('LINKEDIN');
      expect(candidateRow.nationalId).toBeUndefined();
      expect(candidateRow.bankAccountNo).toBeUndefined();
      expect(candidateRow.healthDetails).toBeUndefined();
     for (const stage of ['SCREENING', 'SHORTLISTED']) {
        const adv = await api
          .post(`/api/ops/hcm/applications/${applicationId}/advance`)
          .set(auth(hrToken))
          .send({ targetStage: stage });
        expect(adv.status).toBe(200);
      }
      const interview = await api.post('/api/ops/hcm/interviews').set(auth(hrToken)).send({
        applicationId,
        scheduledAt: '2026-09-15T10:00:00Z',
        mode: 'IN_PERSON',
        interviewerIds: [],
      });
      expect(interview.status).toBe(200);
      const assessment = await api.post('/api/ops/hcm/assessments').set(auth(hrToken)).send({
        applicationId,
        type: 'TECHNICAL',
        score: 85,
        maxScore: 100,
        result: 'PASS',
      });
     expect(assessment.status).toBe(200);
      // Assessment results are part of the candidate profile record.
      const profile = await api.get(`/api/ops/hcm/candidates/${candidateId}`).set(auth(hrToken));
      expect(profile.status).toBe(200);
      const profileAssessments = profile.body.data?.assessments ?? [];
      const scored = profileAssessments.find((a: any) => a.type === 'TECHNICAL');
     expect(scored).toBeTruthy();
      expect(Number(scored.score)).toBe(85);
     expect(Number(scored.maxScore)).toBe(100);
     expect(scored.result).toBe('PASS');

      // Documents are part of the candidate profile record.
      const docCreate = await api.post('/api/documents/documents').set(auth(adminToken)).send({
        doc_no: `DOC-${Date.now()}`,
        title: 'Sarah Nakato - CV',
        category: 'CV',
        file_name: 'sarah-nakato-cv.pdf',
        mime_type: 'application/pdf',
        file_size: 1024,
        storage_key: `candidates/${Date.now()}-cv.pdf`,
      });
      expect(docCreate.status).toBe(201);
      const documentId = Number(docCreate.body.data.id);
      const attach = await api
        .post(`/api/ops/hcm/candidates/${candidateId}/documents`)
        .set(auth(hrToken))
        .send({ documentId, isResume: true });
      expect(attach.status).toBe(200);
      const profileWithDocs = await api.get(`/api/ops/hcm/candidates/${candidateId}`).set(auth(hrToken));
      expect(profileWithDocs.status).toBe(200);
      const profileDocuments = profileWithDocs.body.data?.documents ?? [];
      const cv = profileDocuments.find((d: any) => Number(d.id) === documentId);
      expect(cv).toBeTruthy();
      expect(cv.isResume).toBe(true);
      expect(cv.title).toBe('Sarah Nakato - CV');

      // PDF CV upload: stored, parsed (page count + text), checksummed and served back.
      const pdfBody = [
        'BT /F1 12 Tf 72 720 Td',
        '(Sarah Nakato - Curriculum Vitae) Tj',
        '0 -16 Td',
        '[(Production Supervisor) 12 ( - 5 years experience)] TJ',
        'ET',
      ].join('\n');
      const pdfStream = deflateSync(Buffer.from(pdfBody, 'latin1'));
      const pdfObjects = [
        '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj',
        '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj',
        '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj',
        `4 0 obj << /Length ${pdfStream.length} /Filter /FlateDecode >> stream\n${pdfStream.toString('latin1')}\nendstream endobj`,
        '5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj',
        '6 0 obj << /Title (Sarah Nakato CV) /Author (Sarah Nakato) >> endobj',
        'trailer << /Size 7 /Root 1 0 R >>',
      ].join('\n');
      const pdfBuffer = Buffer.from(`%PDF-1.4\n${pdfObjects}\n%%EOF\n`, 'latin1');

      const upload = await api
        .post(`/api/ops/hcm/candidates/${candidateId}/documents/upload`)
        .set(auth(hrToken))
        .attach('file', pdfBuffer, { filename: 'sarah-nakato-cv.pdf', contentType: 'application/pdf' })
        .field('title', 'Sarah Nakato - CV (uploaded)')
        .field('category', 'CV')
        .field('isResume', 'true');
      expect(upload.status).toBe(201);
      const uploaded = upload.body.data;
      expect(uploaded.mimeType).toBe('application/pdf');
      expect(uploaded.docNo).toMatch(/^CV/);
      expect(uploaded.checksum).toMatch(/^[0-9a-f]{64}$/);
      expect(uploaded.attributes.pdf.pageCount).toBe(1);
      expect(uploaded.attributes.pdf.encrypted).toBe(false);
      expect(uploaded.attributes.pdf.textExcerpt).toContain('Sarah Nakato - Curriculum Vitae');
      expect(uploaded.attributes.pdf.textExcerpt).toContain('Production Supervisor');

      const profileAfterUpload = await api.get(`/api/ops/hcm/candidates/${candidateId}`).set(auth(hrToken));
      const uploadedInProfile = (profileAfterUpload.body.data?.documents ?? []).find(
        (d: any) => Number(d.id) === Number(uploaded.id)
      );
      expect(uploadedInProfile).toBeTruthy();
      expect(uploadedInProfile.isResume).toBe(true);

      const download = await api
        .get(`/api/ops/hcm/candidates/${candidateId}/documents/${uploaded.id}/file`)
        .set(auth(hrToken));
      expect(download.status).toBe(200);
      expect(download.headers['content-type']).toContain('application/pdf');
      expect(download.body.subarray(0, 5).toString('latin1')).toBe('%PDF-');

     const ref = await api
        .post(`/api/ops/hcm/applications/${applicationId}/advance`)
        .set(auth(hrToken))
        .send({ targetStage: 'REFERENCE_CHECK' });
     expect(ref.status).toBe(200);

      // ATS Kanban pipeline: correct columns, application in the right stage, transitions logged.
      const pipeline = await api.get('/api/ops/hcm/applications/pipeline').set(auth(hrToken));
      expect(pipeline.status).toBe(200);
      const columns = pipeline.body.data ?? [];
      expect(columns.map((c: any) => c.stage)).toEqual([
        'APPLIED', 'SCREENING', 'SHORTLISTED', 'INTERVIEW', 'ASSESSMENT',
        'REFERENCE_CHECK', 'OFFER', 'HIRED', 'REJECTED',
      ]);
      const refColumn = columns.find((c: any) => c.stage === 'REFERENCE_CHECK');
      expect(refColumn.applications.some((a: any) => Number(a.id) === applicationId)).toBe(true);
      const audit = await db(
        `SELECT COUNT(*)::int AS n FROM audit_logs
         WHERE resource = 'candidate_applications' AND action = 'advance' AND record_id = $1`,
        [applicationId]
      );
      expect(audit.rows[0].n).toBeGreaterThanOrEqual(3);
     const first = await db(
       `SELECT new_values FROM audit_logs
        WHERE resource = 'candidate_applications' AND action = 'advance' AND record_id = $1
        ORDER BY id LIMIT 1`,
       [applicationId]
     );
      const rawNv = first.rows[0].new_values;
      const nv = typeof rawNv === 'string' ? JSON.parse(rawNv) : rawNv;
     expect(nv.from).toBe('SUBMITTED');
     expect(nv.to).toBe('SCREENING');

     // 6. Offer -> hire (creates employee + onboarding instance)
      const offer = await api.post('/api/ops/hcm/offers').set(auth(hrToken)).send({
        applicationId,
        positionId,
        baseSalary: 1800000,
        startDate: '2026-08-21',
        probationMonths: 0,
        contractType: 'PERMANENT',
      });
      expect(offer.status).toBe(200);
      const offerId = Number(offer.body.data.offerId);
      const offerSend = await api.post(`/api/ops/hcm/offers/${offerId}/send`).set(auth(hrToken)).send({});
      expect(offerSend.status).toBe(200);
      const accepted = await api
        .post(`/api/ops/hcm/offers/${offerId}/accept`)
        .set(auth(hrToken))
        .send({ startDate: '2026-08-21' });
      expect(accepted.status).toBe(200);
      expect(accepted.body.data.status).toBe('ACTIVE');
      const employeeId = Number(accepted.body.data.employeeId);
      const onboardingInstanceId = Number(accepted.body.data.onboardingInstanceId);
      expect(employeeId).toBeGreaterThan(0);
      expect(onboardingInstanceId).toBeGreaterThan(0);

      // 7. Onboarding
      const obStart = await api.post(`/api/ops/hcm/onboarding/${onboardingInstanceId}/start`).set(auth(hrToken));
      expect(obStart.status).toBe(200);
      const tasks = await db(
        `SELECT task_id FROM onboarding_instance_tasks WHERE instance_id = $1 ORDER BY id`,
        [onboardingInstanceId]
      );
      expect(tasks.rows.length).toBeGreaterThan(0);
      for (const t of tasks.rows) {
        const done = await api
          .post(`/api/ops/hcm/onboarding/${onboardingInstanceId}/tasks/${Number(t.task_id)}/complete`)
          .set(auth(hrToken))
          .send({});
        expect(done.status).toBe(200);
      }
      const obComplete = await api.post(`/api/ops/hcm/onboarding/${onboardingInstanceId}/complete`).set(auth(hrToken));
      expect(obComplete.status).toBe(200);
      expect(obComplete.body.data.status).toBe('COMPLETED');

      // 8. Leave accrual - accrued is date-dependent: months elapsed in the
      // current year at the time the test runs (ANNUAL = 18/12 * months).
      const now = new Date();
      const monthsElapsed = now.getUTCFullYear() === 2026 ? Math.min(12, now.getUTCMonth() + 1) : 12;
      const expectedAccrued = Math.round((18 / 12) * monthsElapsed * 100) / 100;
      const accrual = await api.post('/api/ops/hcm/leave/accrual/run').set(auth(hrToken)).send({ year: 2026 });
      expect(accrual.status).toBe(200);
      const balances = await api
        .get(`/api/ops/hcm/leave/balances?employeeId=${employeeId}&year=2026`)
        .set(auth(hrToken));
      expect(balances.status).toBe(200);
      const annual = balances.body.data.find((b: { leaveTypeCode: string }) => b.leaveTypeCode === 'ANNUAL');
      expect(annual).toBeTruthy();
      expect(Number(annual.accrued)).toBe(expectedAccrued);
      expect(Number(annual.available)).toBe(expectedAccrued);

      // 9. Payroll (August 2026; UG PAYE/NSSF from versioned config; hire 2026-08-21 prorated to 11/31 days)
      const payroll = await api.post('/api/ops/hr/payrolls').set(auth(hrToken)).send({
        periodStart: '2026-08-01',
        periodEnd: '2026-08-31',
      });
      expect(payroll.status).toBe(200);
      const payrollId = Number(payroll.body.data.payrollId);
      const detail = await api.get(`/api/ops/hr/payrolls/${payrollId}`).set(auth(hrToken));
      expect(detail.status).toBe(200);
      const items = detail.body.data.items as {
        employeeId: string;
        grossPay: string;
        paye: string;
        nssf: string;
        netPay: string;
      }[];
      const item = items.find((i) => Number(i.employeeId) === employeeId);
      expect(item).toBeTruthy();
      expect(Number(item!.grossPay)).toBe(638709.68);
      expect(Number(item!.paye)).toBe(70282.26);
      expect(Number(item!.nssf)).toBe(31935.48);
      expect(Number(item!.netPay)).toBe(516491.94);

      // 9b. HCM home dashboard: workforce + recruitment + payroll KPIs, tenant/company scoped.
      const dash = await api.get('/api/ops/hcm/dashboard').set(auth(hrToken));
      expect(dash.status).toBe(200);
      const d = dash.body.data;
      expect(typeof d.kpis.headcount).toBe('number');
      expect(d.kpis.headcount).toBeGreaterThanOrEqual(1);
      expect(d.kpis.activePositions).toBeGreaterThanOrEqual(1);
      expect(d.kpis.openRequisitions).toBeGreaterThanOrEqual(1);
      expect(d.kpis.applicationsInPipeline).toBeGreaterThanOrEqual(1);
      expect(d.kpis.pendingLeave).toBeGreaterThanOrEqual(0);
      expect(d.kpis.recentPayrollGross).toBeGreaterThanOrEqual(0);
      expect(d.kpis.recentPayrollNet).toBeGreaterThanOrEqual(0);
      expect(d.kpis.headcountGap).toBeGreaterThanOrEqual(0);
      const acceptedStage = (d.pipeline ?? []).find((s: { stage: string }) => s.stage === 'ACCEPTED');
      expect(acceptedStage).toBeTruthy();
      expect(Number(acceptedStage.count)).toBeGreaterThanOrEqual(1);
      expect(Array.isArray(d.openRequisitions)).toBe(true);
      expect(d.openRequisitions.length).toBeGreaterThanOrEqual(1);
      expect(Array.isArray(d.publishedVacancies)).toBe(true);
      expect(Array.isArray(d.recentOnboarding)).toBe(true);
      expect(Array.isArray(d.recentPayrolls)).toBe(true);
      expect(d.recentPayrolls.length).toBeGreaterThanOrEqual(1);

      // 9c. Promotion movement + versioned salary history (HR -> payroll change control).
      const promotedPosition = await api.post('/api/ops/hcm/positions').set(auth(hrToken)).send({
        title: 'Senior Production Supervisor',
        departmentId,
        costCentreId,
        jobFamilyId,
        jobGradeId,
        approvedHeadcount: 2,
        salaryMin: 1800000,
        salaryMax: 3200000,
      });
      expect(promotedPosition.status).toBe(200);
      const promotedPositionId = Number(promotedPosition.body.data.positionId);
      const movement = await api.post('/api/ops/hcm/movements').set(auth(hrToken)).send({
        employeeId,
        positionId: promotedPositionId,
        movementType: 'PROMOTION',
        effectiveFrom: '2026-09-01',
        salary: 2000000,
        reason: 'Merit promotion after successful probation',
      });
      expect(movement.status).toBe(200);
      const movementId = Number(movement.body.data.movementId);
      expect(movementId).toBeGreaterThan(0);
      const empAfterMove = await db(`SELECT position, base_salary FROM employees WHERE id = $1`, [employeeId]);
      expect(empAfterMove.rows[0].position).toBe('Senior Production Supervisor');
      expect(Number(empAfterMove.rows[0].base_salary)).toBe(2000000);
      const salaryHistory = await db(
        `SELECT old_salary, new_salary, source FROM salary_histories WHERE employee_id = $1`,
        [employeeId]
      );
      expect(salaryHistory.rows.length).toBeGreaterThanOrEqual(1);
      expect(Number(salaryHistory.rows[0].old_salary)).toBe(1800000);
      expect(Number(salaryHistory.rows[0].new_salary)).toBe(2000000);
      expect(salaryHistory.rows[0].source).toBe('HR');

      // 9d. Offboarding: exit clearance checklist -> completed -> alumni fields set.
      const offboarding = await api.post('/api/ops/hcm/offboardings').set(auth(hrToken)).send({
        employeeId,
        offboardingType: 'RESIGNATION',
        effectiveDate: '2026-09-30',
        lastWorkingDate: '2026-09-30',
        reason: 'Pursuing further studies',
      });
      expect(offboarding.status).toBe(200);
      const offboardingInstanceId = Number(offboarding.body.data.instanceId);
      expect(offboardingInstanceId).toBeGreaterThan(0);
      expect(offboarding.body.data.taskCount).toBe(7);
      const offboardStart = await api.post(`/api/ops/hcm/offboardings/${offboardingInstanceId}/start`).set(auth(hrToken));
      expect(offboardStart.status).toBe(200);
      const obDetail = await api.get(`/api/ops/hcm/offboardings/${offboardingInstanceId}`).set(auth(hrToken));
      expect(obDetail.status).toBe(200);
      const obTasks = obDetail.body.data.tasks ?? [];
      expect(obTasks.length).toBe(7);
      for (const t of obTasks) {
        const done = await api
          .post(`/api/ops/hcm/offboardings/${offboardingInstanceId}/tasks/${Number(t.taskId)}/complete`)
          .set(auth(hrToken))
          .send({});
        expect(done.status).toBe(200);
      }
      const offboardComplete = await api
        .post(`/api/ops/hcm/offboardings/${offboardingInstanceId}/complete`)
        .set(auth(hrToken))
        .send({ exitInterviewNotes: 'Positive feedback; recommend alumni engagement.' });
      expect(offboardComplete.status).toBe(200);
      expect(offboardComplete.body.data.status).toBe('COMPLETED');
      expect(offboardComplete.body.data.effectiveDate).toBe('2026-09-30');
      const empAfterExit = await db(
        `SELECT status, alumni_date, offboarding_type, exit_reason, rehire_eligible FROM employees WHERE id = $1`,
        [employeeId]
      );
      expect(empAfterExit.rows[0].status).toBe('TERMINATED');
      const alumniDate = empAfterExit.rows[0].alumni_date;
      const alumniDateStr =
        alumniDate instanceof Date
          ? `${alumniDate.getFullYear()}-${String(alumniDate.getMonth() + 1).padStart(2, '0')}-${String(alumniDate.getDate()).padStart(2, '0')}`
          : String(alumniDate).slice(0, 10);
      expect(alumniDateStr).toBe('2026-09-30');
      expect(empAfterExit.rows[0].offboarding_type).toBe('RESIGNATION');
      expect(empAfterExit.rows[0].rehire_eligible).toBe(true);
      const contractAfterExit = await db(
        `SELECT status FROM employment_contracts WHERE employee_id = $1 AND status = 'TERMINATED'`,
        [employeeId]
      );
      expect(contractAfterExit.rows.length).toBeGreaterThanOrEqual(1);

      // 9e. Employee lifecycle timeline unifies hire -> promotion -> exit events.
      const timeline = await api.get(`/api/ops/hcm/employees/${employeeId}/timeline`).set(auth(hrToken));
      expect(timeline.status).toBe(200);
      const events = timeline.body.data.events ?? [];
      const eventTypes = events.map((ev: { eventType: string }) => ev.eventType);
      expect(eventTypes).toContain('HIRE');
      expect(eventTypes).toContain('PROMOTION');
      expect(eventTypes).toContain('OFFBOARDING_COMPLETED');
      const hireEvent = events.find((ev: { eventType: string }) => ev.eventType === 'HIRE');
      const exitEvent = events.find((ev: { eventType: string }) => ev.eventType === 'OFFBOARDING_COMPLETED');
      expect(String(hireEvent.date) < String(exitEvent.date)).toBe(true);

      // 10. Cleanup (FK-safe order)
      await db(`DELETE FROM payrolls WHERE id = $1`, [payrollId]);
      await db(`DELETE FROM leave_balances WHERE employee_id = $1`, [employeeId]);
      await db(`DELETE FROM onboarding_instance_tasks WHERE instance_id = $1`, [onboardingInstanceId]);
      await db(`DELETE FROM onboarding_instances WHERE employee_id = $1`, [employeeId]);
      await db(`DELETE FROM offboarding_instance_tasks WHERE instance_id = $1`, [offboardingInstanceId]);
      await db(`DELETE FROM offboarding_instances WHERE employee_id = $1`, [employeeId]);
      await db(`DELETE FROM employee_movements WHERE employee_id = $1`, [employeeId]);
      await db(`DELETE FROM salary_histories WHERE employee_id = $1`, [employeeId]);
      await db(`DELETE FROM position_assignments WHERE employee_id = $1`, [employeeId]);
      await deleteEmployees([employeeId]);
      await db(`DELETE FROM positions WHERE id = $1`, [promotedPositionId]);
    },
    60_000
  );
});
