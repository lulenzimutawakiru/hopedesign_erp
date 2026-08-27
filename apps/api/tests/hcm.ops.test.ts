import { describe, it, expect } from 'vitest';
import { api, auth, loginAs, deleteEmployees } from './helpers.js';

describe('HCM operations desks', () => {
  it('lists and runs performance, training, benefits, relations and time', async () => {
    const { token } = await loginAs('hr.hannah');
    const emp = await api.post('/api/ops/hr/employees').set(auth(token)).send({
      firstName: 'Ops',
      lastName: `Desk${Date.now()}`,
      position: 'Clerk',
      baseSalary: 800000,
    });
    expect(emp.status).toBe(200);
    const employeeId = Number(emp.body.data.employeeId);

    const goal = await api.post('/api/ops/hcm/performance/goals').set(auth(token)).send({
      employeeId,
      title: 'On-time deliveries',
      startDate: '2026-01-01',
      dueDate: '2026-12-31',
    });
    expect(goal.status).toBe(200);
    const goals = await api.get('/api/ops/hcm/performance/goals').set(auth(token));
    expect(goals.status).toBe(200);
    expect(goals.body.data.some((r: { employeeId: number }) => Number(r.employeeId) === employeeId)).toBe(true);

    const course = await api.post('/api/ops/hcm/training/catalog').set(auth(token)).send({
      title: 'Safety induction',
      category: 'HSE',
    });
    expect(course.status).toBe(200);
    const trainingId = Number(course.body.data.trainingId);
    const session = await api.post('/api/ops/hcm/training/sessions').set(auth(token)).send({
      trainingId,
      startDate: '2026-09-01',
    });
    expect(session.status).toBe(200);
    const req = await api.post('/api/ops/hcm/training/requests').set(auth(token)).send({
      employeeId,
      trainingId,
    });
    expect(req.status).toBe(200);
    const approved = await api.post(`/api/ops/hcm/training/requests/${req.body.data.requestId}/approve`).set(auth(token)).send({});
    expect(approved.status).toBe(200);

    const plan = await api.post('/api/ops/hcm/benefits/plans').set(auth(token)).send({
      name: 'Outpatient medical',
      category: 'MEDICAL',
      cost: 50000,
    });
    expect(plan.status).toBe(200);
    const enrolled = await api.post('/api/ops/hcm/benefits/enrollments').set(auth(token)).send({
      employeeId,
      planId: Number(plan.body.data.planId),
      effectiveFrom: '2026-08-01',
    });
    expect(enrolled.status).toBe(200);
    const enrollments = await api.get('/api/ops/hcm/benefits/enrollments').set(auth(token));
    expect(enrollments.status).toBe(200);
    expect(enrollments.body.data.some((r: { employeeId: number }) => Number(r.employeeId) === employeeId)).toBe(true);

    const grievance = await api.post('/api/ops/hcm/relations/grievances').set(auth(token)).send({
      employeeId,
      category: 'WORKPLACE',
      subject: 'Shift roster dispute',
    });
    expect(grievance.status).toBe(200);
    const resolved = await api
      .post(`/api/ops/hcm/relations/grievances/${grievance.body.data.grievanceId}/resolve`)
      .set(auth(token))
      .send({ resolution: 'Roster restated with supervisor' });
    expect(resolved.status).toBe(200);

    const sheet = await api.post('/api/ops/hcm/timesheets').set(auth(token)).send({
      employeeId,
      periodStart: '2026-08-01',
      periodEnd: '2026-08-31',
      totalHours: 176,
    });
    expect(sheet.status).toBe(200);
    const submitted = await api.post(`/api/ops/hcm/timesheets/${sheet.body.data.timesheetId}/submit`).set(auth(token)).send({});
    expect(submitted.status).toBe(200);
    const approvedSheet = await api.post(`/api/ops/hcm/timesheets/${sheet.body.data.timesheetId}/approve`).set(auth(token)).send({});
    expect(approvedSheet.status).toBe(200);

    const loans = await api.get('/api/ops/hr/loans?pageSize=5').set(auth(token));
    expect(loans.status).toBe(200);
    expect(Array.isArray(loans.body.data.items)).toBe(true);

    await deleteEmployees([employeeId]);
  }, 30_000);
});
