import { describe, it, expect } from 'vitest';
import { api, auth, loginAs, db, deleteEmployees } from './helpers.js';

const PASSWORD = 'ChangeMe!2026';

/** Create an HR employee for the contract lifecycle (tenant 2 / company 2 / HDG). */
async function createEmployee(hrToken: string, firstName: string, lastName: string, position: string, baseSalary: number) {
  const res = await api
    .post('/api/ops/hr/employees')
    .set(auth(hrToken))
    .send({ firstName, lastName, position, baseSalary });
  expect(res.status).toBe(200);
  const employeeId = Number(res.body.data.employeeId);
  expect(employeeId).toBeGreaterThan(0);
  return employeeId;
}

/** Create an employee self-service user (role 97) for contract signing. */
async function createSigningUser(email: string) {
  const { hashPassword } = await import('../src/auth.js');
  const passwordHash = await hashPassword(PASSWORD);
  const ins = await db(
    `INSERT INTO users (tenant_id, company_id, email, username, password_hash, first_name, last_name)
     VALUES (2, 2, $1, $2, $3, 'Kato', 'Contract') RETURNING id`,
    [email, `kato.contract.${Date.now()}`, passwordHash]
  );
  const userId = Number(ins.rows[0].id);
  await db(`INSERT INTO user_roles (user_id, role_id, company_id) VALUES ($1, 97, 2)`, [userId]);
  return userId;
}

describe('Uganda HR Contract Builder', () => {
  it(
    'full lifecycle: create -> validate -> submit -> sign -> execute -> verify -> vary -> certificate of service',
    async () => {
      const { token: hrToken } = await loginAs('hr.hannah');
      const employeeId = await createEmployee(hrToken, 'Kato', 'Contract', 'Finance Assistant', 2500000);

      // Employee self-service signer (tenant 2 / company 2 / role 97).
      const email = `kato.contract.${Date.now()}@hopedesign.test`;
      const userId = await createSigningUser(email);
      await db(`UPDATE employees SET user_id = $1 WHERE id = $2`, [userId, employeeId]);
      const empLogin = await api.post('/api/auth/login').send({ identifier: email, password: PASSWORD });
      expect(empLogin.status).toBe(200);
      const empToken = String(empLogin.body.accessToken);

      // 1. Create a permanent contract.
      const create = await api.post('/api/ops/hr/contracts').set(auth(hrToken)).send({
        employeeId,
        contractType: 'PERMANENT',
        startDate: '2026-09-01',
        jobTitle: 'Finance Assistant',
        noticePeriodDays: 60,
        employerRepName: 'Grace Namukwaya',
        employerRepTitle: 'HR Manager',
        salary: { basic: 2500000, gross: 2500000 },
      });
      expect(create.status).toBe(200);
      const contractId = Number(create.body.data.contractId);
      const contractNo = String(create.body.data.contractNo);
      expect(contractNo.startsWith('EMP/')).toBe(true);
      expect(create.body.data.status).toBe('DRAFT');

      // 2. Compliance validation must be GREEN before submission.
      const validation = await api.post(`/api/ops/hr/contracts/${contractId}/validate`).set(auth(hrToken));
      expect(validation.status).toBe(200);
      expect(validation.body.data.result).toBe('GREEN');
      expect(Number(validation.body.data.summary.failed)).toBe(0);

      // 3. Submit auto-approves (no hr.contracts workflow configured) -> ready for signature.
      const submit = await api.post(`/api/ops/hr/contracts/${contractId}/submit`).set(auth(hrToken));
      expect(submit.status).toBe(200);
      expect(submit.body.data.status).toBe('SENT_FOR_SIGNATURE');
      expect(submit.body.data.readyForSignature).toBe(true);

      // 4. Send to signatories.
      const sent = await api
        .post(`/api/ops/hr/contracts/${contractId}/request-signature`)
        .set(auth(hrToken))
        .send({ signerType: 'ALL' });
      expect(sent.status).toBe(200);
      expect((sent.body.data ?? []).length).toBeGreaterThanOrEqual(2);

      // 5. Ownership check: HR cannot sign as the employee.
      const wrongSign = await api
        .post(`/api/ops/hr/contracts/${contractId}/sign`)
        .set(auth(hrToken))
        .send({ signerType: 'EMPLOYEE' });
      expect(wrongSign.status).toBe(403);
      expect(wrongSign.body.error.message).toBe('You may only sign your own contract');

      // 6. Employee signs -> partially signed.
      const sigPng = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
        'base64'
      );
      const empSigUpload = await api
        .post(`/api/ops/hr/contracts/${contractId}/signature-image`)
        .set(auth(empToken))
        .attach('file', sigPng, { filename: 'sig.png', contentType: 'image/png' })
        .field('signerType', 'EMPLOYEE');
      expect(empSigUpload.status).toBe(200);
      const employeeSignatureUrl = String(empSigUpload.body.data.url);
      expect(employeeSignatureUrl).toContain('contract-signature');
      const empSign = await api
        .post(`/api/ops/hr/contracts/${contractId}/sign`)
        .set(auth(empToken))
        .send({ signerType: 'EMPLOYEE', signature: 'Kato Contract', signatureUrl: employeeSignatureUrl });
      expect(empSign.status).toBe(200);
      expect(empSign.body.data.status).toBe('PARTIALLY_SIGNED');
      expect(empSign.body.data.executed).toBe(false);

      // 7. Employer representative signs -> executed + verification payload.
      const hrSigUpload = await api
        .post(`/api/ops/hr/contracts/${contractId}/signature-image`)
        .set(auth(hrToken))
        .attach('file', sigPng, { filename: 'sig.png', contentType: 'image/png' })
        .field('signerType', 'EMPLOYER_REPRESENTATIVE');
      expect(hrSigUpload.status).toBe(200);
      const employerSignatureUrl = String(hrSigUpload.body.data.url);
      const hrSign = await api
        .post(`/api/ops/hr/contracts/${contractId}/sign`)
        .set(auth(hrToken))
        .send({ signerType: 'EMPLOYER_REPRESENTATIVE', signature: 'Grace Namukwaya', signatureUrl: employerSignatureUrl });
      expect(hrSign.status).toBe(200);
      expect(hrSign.body.data.status).toBe('EXECUTED');
      expect(hrSign.body.data.executed).toBe(true);
      const secret = String(hrSign.body.data.secret);
      const verificationCode = String(hrSign.body.data.verificationCode);
      expect(secret.length).toBeGreaterThan(0);
      expect(verificationCode.length).toBeGreaterThan(0);

      // 8. Public QR-style verification (no auth) resolves the executed document.
      const verify = await api.post('/api/public/verify-contract').send({ code: verificationCode, secret });
      expect(verify.status).toBe(200);
      expect(verify.body.data.valid).toBe(true);
      expect(verify.body.data.document_no).toBe(contractNo);

      // 9. Employee self-service can view the executed contract (role 97).
      const detail = await api.get(`/api/ops/hr/contracts/${contractId}`).set(auth(empToken));
      expect(detail.status).toBe(200);
      expect(detail.body.data.contract.status).toBe('EXECUTED');
      expect(String(detail.body.data.contract.docHash ?? '').length).toBeGreaterThan(10);
      expect(Array.isArray(detail.body.data.signatures)).toBe(true);
      expect(
        detail.body.data.signatures.some((s: any) => String(s.signatureUrl ?? '').includes('contract-signature'))
      ).toBe(true);
      expect(Array.isArray(detail.body.data.audit)).toBe(true);      // 10. Promotion variation creates a derived contract; the executed original is never overwritten.
      const variation = await api.post(`/api/ops/hr/contracts/${contractId}/variations`).set(auth(hrToken)).send({
        variationType: 'PROMOTION',
        reason: 'Merit promotion',
        changes: [
          { field: 'jobTitle', label: 'Job title', oldValue: 'Finance Assistant', newValue: 'Senior Finance Assistant' },
        ],
        newValues: { jobTitle: 'Senior Finance Assistant', basic: 3000000, gross: 3000000 },
        effectiveDate: '2026-10-01',
      });
      expect(variation.status).toBe(200);
      const variationId = Number(variation.body.data.id);
      expect(String(variation.body.data.variationNo).startsWith('VAR/')).toBe(true);
      const applied = await api.post(`/api/ops/hr/contracts/variations/${variationId}/apply`).set(auth(hrToken));
      expect(applied.status).toBe(200);
      expect(applied.body.data.status).toBe('APPLIED');
      const newContractId = Number(applied.body.data.newContractId);
      expect(newContractId).toBeGreaterThan(0);

      const oldDetail = await api.get(`/api/ops/hr/contracts/${contractId}`).set(auth(hrToken));
      expect(oldDetail.status).toBe(200);
      expect(oldDetail.body.data.contract.status).toBe('VARIED');
      const newDetail = await api.get(`/api/ops/hr/contracts/${newContractId}`).set(auth(hrToken));
      expect(newDetail.status).toBe(200);
      expect(newDetail.body.data.contract.contractType).toBe('VARIATION');
      expect(Number(newDetail.body.data.contract.version)).toBeGreaterThan(1);
      expect(Number(newDetail.body.data.contract.previousContractId)).toBe(contractId);

      // 11. Certificate of service after termination.
      await db(`UPDATE employees SET status = 'TERMINATED' WHERE id = $1`, [employeeId]);
      const cert = await api.post('/api/ops/hr/contracts/certificates').set(auth(hrToken)).send({
        employeeId,
        contractId: newContractId,
        periodStart: '2026-09-01',
        periodEnd: '2026-10-01',
        natureOfBusiness: 'Manufacturing',
        position: 'Senior Finance Assistant',
        wagesAtTermination: 3000000,
        reasonForTermination: 'End of service',
      });
      expect(cert.status).toBe(200);
      const certId = Number(cert.body.data.id);
      expect(String(cert.body.data.certNo).startsWith('COS/')).toBe(true);
      const issued = await api.post(`/api/ops/hr/contracts/certificates/${certId}/issue`).set(auth(hrToken));
      expect(issued.status).toBe(200);
      expect(issued.body.data.status).toBe('ISSUED');
      expect(String(issued.body.data.docHash ?? '').length).toBeGreaterThan(10);

      // 12. Cleanup (FK-safe order).
      await db(`DELETE FROM certificate_of_service WHERE employee_id = $1`, [employeeId]);
      await db(
        `DELETE FROM contract_variations
         WHERE contract_id IN (SELECT id FROM employment_contracts WHERE employee_id = $1)
            OR new_contract_id IN (SELECT id FROM employment_contracts WHERE employee_id = $1)`,
        [employeeId]
      );
      await db(
        `DELETE FROM contract_renewals
         WHERE contract_id IN (SELECT id FROM employment_contracts WHERE employee_id = $1)
            OR new_contract_id IN (SELECT id FROM employment_contracts WHERE employee_id = $1)`,
        [employeeId]
      );
      await db(
        `DELETE FROM document_verification
         WHERE document_no IN (SELECT contract_no FROM employment_contracts WHERE employee_id = $1)`,
        [employeeId]
      );
      await db(`UPDATE employment_contracts SET previous_contract_id = NULL WHERE employee_id = $1`, [employeeId]);
      await db(`DELETE FROM employment_contracts WHERE employee_id = $1`, [employeeId]);
      await deleteEmployees([employeeId]);
      await db(`DELETE FROM sessions WHERE user_id = $1`, [userId]);
      await db(`DELETE FROM users WHERE id = $1`, [userId]);
    },
    60_000
  );

  it(
    'blocks submission when mandatory particulars fail compliance (RED)',
    async () => {
      const { token: hrToken } = await loginAs('hr.hannah');
      const employeeId = await createEmployee(hrToken, 'Comply', 'Gate', '', 0);

      // Defaults leave salary 0 and job title empty -> COMPENSATION + JOB_TITLE fail.
      const create = await api.post('/api/ops/hr/contracts').set(auth(hrToken)).send({
        employeeId,
        contractType: 'PERMANENT',
      });
      expect(create.status).toBe(200);
      const contractId = Number(create.body.data.contractId);

      const validation = await api.post(`/api/ops/hr/contracts/${contractId}/validate`).set(auth(hrToken));
      expect(validation.status).toBe(200);
      expect(validation.body.data.result).toBe('RED');
      expect(Number(validation.body.data.summary.failed)).toBeGreaterThanOrEqual(1);
      const failCodes = (validation.body.data.issues as Array<{ code: string }>)
        .filter((i) => i.code === 'JOB_TITLE' || i.code === 'COMPENSATION')
        .map((i) => i.code);
      expect(failCodes.length).toBeGreaterThanOrEqual(1);

      const submit = await api.post(`/api/ops/hr/contracts/${contractId}/submit`).set(auth(hrToken));
      expect(submit.status).toBe(400);
      expect(String(submit.body.error.message)).toContain('Compliance check is RED');

      await db(`DELETE FROM employment_contracts WHERE employee_id = $1`, [employeeId]);
      await deleteEmployees([employeeId]);
    },
    60_000
  );

  it(
    'attaches extra and required clauses and prints them in full',
    async () => {
      const { token: hrToken } = await loginAs('hr.hannah');
      const employeeId = await createEmployee(hrToken, 'Print', 'Clauses', 'Analyst', 1800000);
      try {
        const create = await api.post('/api/ops/hr/contracts').set(auth(hrToken)).send({
          employeeId,
          contractType: 'PERMANENT',
          startDate: '2026-09-01',
          jobTitle: 'Analyst',
          noticePeriodDays: 30,
          employerRepName: 'Grace Namukwaya',
          employerRepTitle: 'HR Manager',
          salary: { basic: 1800000, gross: 1800000 },
          clauseCodes: ['ANTI_BRIBERY', 'ANTI_FRAUD'],
        });
        expect(create.status).toBe(200);
        const contractId = Number(create.body.data.contractId);

        const detail = await api.get(`/api/ops/hr/contracts/${contractId}`).set(auth(hrToken));
        expect(detail.status).toBe(200);
        const terms = (detail.body.data.terms ?? []) as Array<{ title?: string; value?: { clauseCode?: string } | string }>;
        const codes = terms.map((t) => {
          const v = t.value;
          if (v && typeof v === 'object') return String(v.clauseCode ?? '');
          try {
            return String((JSON.parse(String(v ?? '{}')) as { clauseCode?: string }).clauseCode ?? '');
          } catch {
            return '';
          }
        });
        expect(codes).toContain('ANTI_BRIBERY');
        expect(codes).toContain('ANTI_FRAUD');
        expect(codes).toContain('GOVERNING_LAW');
        expect(codes).toContain('APPOINTMENT');

        const printed = await api.get(`/api/documents/employment-contract/${contractId}?format=print`).set(auth(hrToken));
        expect(printed.status).toBe(200);
        expect(String(printed.headers['content-type'])).toContain('text/html');
        expect(printed.text).toContain('Terms and Conditions of Employment');
        expect(printed.text).toContain('Anti-Bribery');
        expect(printed.text).toContain('Anti-Fraud');
        expect(printed.text).toContain('Governing Law');
        expect(printed.text).toContain('Appointment');
        expect(printed.text).toContain('window.print()');

        const pdf = await api.get(`/api/documents/employment-contract/${contractId}?format=pdf`).set(auth(hrToken));
        expect(pdf.status).toBe(200);
        const buf = Buffer.isBuffer(pdf.body) ? pdf.body : Buffer.from(pdf.body);
        const text = buf.toString('latin1');
        expect(text).toContain('Anti-Bribery');
        expect(text).toContain('Governing Law');
      } finally {
        await db(`DELETE FROM employment_contracts WHERE employee_id = $1`, [employeeId]);
        await deleteEmployees([employeeId]);
      }
    },
    60_000
  );

  it(
    'prints the employee passport photograph on the contract',
    async () => {
      const { token: hrToken } = await loginAs('hr.hannah');
      const employeeId = await createEmployee(hrToken, 'Photo', 'Holder', 'Clerk', 1500000);
      const png = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
        'base64'
      );
      try {
        const up = await api
          .post(`/api/ops/hr/employees/${employeeId}/photo`)
          .set(auth(hrToken))
          .attach('file', png, { filename: 'passport.png', contentType: 'image/png' });
        expect(up.status).toBe(200);
        expect(up.body.data.hasPhoto).toBe(true);

        const create = await api.post('/api/ops/hr/contracts').set(auth(hrToken)).send({
          employeeId,
          contractType: 'PERMANENT',
          startDate: '2026-09-01',
          jobTitle: 'Clerk',
          noticePeriodDays: 30,
          salary: { basic: 1500000, gross: 1500000 },
        });
        expect(create.status).toBe(200);
        const contractId = Number(create.body.data.contractId);

        const printed = await api.get(`/api/documents/employment-contract/${contractId}?format=print`).set(auth(hrToken));
        expect(printed.status).toBe(200);
        expect(printed.text).toContain('passport-photo');
        expect(printed.text).toContain('data:image/');

        const pdf = await api.get(`/api/documents/employment-contract/${contractId}?format=pdf`).set(auth(hrToken));
        expect(pdf.status).toBe(200);
        const buf = Buffer.isBuffer(pdf.body) ? pdf.body : Buffer.from(pdf.body);
        const text = buf.toString('latin1');
        expect(text).toContain('/XObject');
        expect(text).toContain('/Im1');
        expect(text).toContain('PHOTOGRAPH');
      } finally {
        await db(`DELETE FROM employment_contracts WHERE employee_id = $1`, [employeeId]);
        await deleteEmployees([employeeId]);
      }
    },
    60_000
  );

  it(
    'exposes Uganda statutory legal rules and clauses and gates excess working hours',
    async () => {
      const { token: hrToken } = await loginAs('hr.hannah');

      // New statutory legal rules are seeded and queryable.
      const rulesRes = await api.get('/api/ops/hr/contracts/legal-rules').set(auth(hrToken));
      expect(rulesRes.status).toBe(200);
      const rules = (rulesRes.body.data ?? []) as Array<{ code?: string; section?: string | null }>;
      const ruleCodes = rules.map((r) => String(r.code ?? ''));
      for (const code of [
        'WORKING_TIME', 'WEEKLY_REST', 'PUBLIC_HOLIDAYS', 'OVERTIME_RATE', 'PAYMENT_OF_WAGES',
        'DEDUCTIONS', 'NON_DISCRIMINATION', 'EQUAL_PAY', 'FORCED_LABOUR', 'CHILD_LABOUR',
        'CASUAL_EMPLOYMENT', 'UNFAIR_TERMINATION', 'PREGNANCY_PROTECTION', 'SEXUAL_HARASSMENT',
        'EMPLOYMENT_RECORDS',
      ]) {
        expect(ruleCodes).toContain(code);
      }
      expect(rules.find((r) => r.code === 'WORKING_TIME')?.section).toBe('s.52');

      // New statutory clauses are seeded and queryable.
      const clausesRes = await api.get('/api/ops/hr/contracts/clauses').set(auth(hrToken));
      expect(clausesRes.status).toBe(200);
      const clauseCodes = (clausesRes.body.data ?? []).map((c: { clauseCode?: string }) => String(c.clauseCode ?? ''));
      for (const code of [
        'WORKING_TIME', 'WEEKLY_REST', 'REST_BREAKS', 'PUBLIC_HOLIDAYS', 'WAGES_PAYMENT', 'PAY_SLIPS',
        'DEDUCTIONS', 'COMPASSIONATE_LEAVE', 'NON_DISCRIMINATION', 'EQUAL_PAY', 'FORCED_LABOUR_PROHIBITION',
        'PREGNANCY_PROTECTION', 'SEXUAL_HARASSMENT', 'CHILD_LABOUR_PROHIBITION', 'YOUNG_PERSONS_EMPLOYMENT',
        'EMPLOYMENT_RECORDS', 'SUMMARY_DISMISSAL', 'UNFAIR_TERMINATION', 'TERMINAL_BENEFITS',
        'REDUNDANCY_NOTICE', 'NON_COMPETE_CAUTION',
      ]) {
        expect(clauseCodes).toContain(code);
      }

      const employeeId = await createEmployee(hrToken, 'Hours', 'Gate', 'Payroll Officer', 2000000);
      try {
        // Over-limit working week -> RED with WORKING_TIME / WEEKLY_REST failures.
        const over = await api.post('/api/ops/hr/contracts').set(auth(hrToken)).send({
          employeeId,
          contractType: 'PERMANENT',
          startDate: '2026-09-01',
          jobTitle: 'Payroll Officer',
          noticePeriodDays: 30,
          employerRepName: 'Grace Namukwaya',
          employerRepTitle: 'HR Manager',
          salary: { basic: 2000000, gross: 2000000 },
          workingHoursPerWeek: 55,
          workingDays: ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'],
        });
        expect(over.status).toBe(200);
        const overContractId = Number(over.body.data.contractId);
        const overVal = await api.post(`/api/ops/hr/contracts/${overContractId}/validate`).set(auth(hrToken));
        expect(overVal.status).toBe(200);
        expect(overVal.body.data.result).toBe('RED');
        const overIssues = (overVal.body.data.issues ?? []) as Array<{ code?: string; status?: string }>;
        const workTime = overIssues.find((i) => i.code === 'WORKING_TIME');
        expect(workTime).toBeTruthy();
        expect(workTime?.status).toBe('FAIL');
        const weeklyRest = overIssues.find((i) => i.code === 'WEEKLY_REST');
        expect(weeklyRest).toBeTruthy();
        expect(weeklyRest?.status).toBe('FAIL');

        // Statutory-compliant 48h / 6-day week validates cleanly.
        const ok = await api.post('/api/ops/hr/contracts').set(auth(hrToken)).send({
          employeeId,
          contractType: 'PERMANENT',
          startDate: '2026-09-01',
          jobTitle: 'Payroll Officer',
          noticePeriodDays: 30,
          employerRepName: 'Grace Namukwaya',
          employerRepTitle: 'HR Manager',
          salary: { basic: 2000000, gross: 2000000 },
          workingHoursPerWeek: 48,
          workingDays: ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'],
        });
        expect(ok.status).toBe(200);
        const okContractId = Number(ok.body.data.contractId);
        const okVal = await api.post(`/api/ops/hr/contracts/${okContractId}/validate`).set(auth(hrToken));
        expect(okVal.status).toBe(200);
        expect(okVal.body.data.result).toBe('GREEN');
        const okIssues = (okVal.body.data.issues ?? []) as Array<{ code?: string; status?: string }>;
        expect(okIssues.some((i) => i.code === 'WORKING_TIME' && i.status === 'FAIL')).toBe(false);
        expect(okIssues.some((i) => i.code === 'WEEKLY_REST' && i.status === 'FAIL')).toBe(false);
      } finally {
        await db(`DELETE FROM employment_contracts WHERE employee_id = $1`, [employeeId]);
        await deleteEmployees([employeeId]);
      }
    },
    60_000
  );

  it(
    'clause governance: statutory clauses carry legal metadata and are frozen; tenants version their own clauses',
    async () => {
      const { token: hrToken } = await loginAs('hr.hannah');

      // Every statutory clause must carry its legal source, reference, effective
      // window and validation status - sourced from the linked legal rule.
      const clausesRes = await api.get('/api/ops/hr/contracts/clauses').set(auth(hrToken));
      expect(clausesRes.status).toBe(200);
      const clauses = (clausesRes.body.data ?? []) as Array<{
        id?: number;
        clauseCode?: string;
        legalRuleId?: number | null;
        law?: string | null;
        lawChapter?: string | null;
        section?: string | null;
        lawSource?: string | null;
        effectiveFrom?: string | null;
        validationStatus?: string | null;
      }>;
      const statutory = clauses.filter((c) => c.legalRuleId != null);
      expect(statutory.length).toBeGreaterThan(0);
      for (const c of statutory) {
        expect(c.law).toBeTruthy();
        expect(c.lawChapter).toBeTruthy();
        expect(c.lawSource).toBeTruthy();
        expect(c.effectiveFrom).toBeTruthy();
        expect(c.validationStatus).toBe('VALIDATED');
      }
      const workingTime = statutory.find((c) => c.clauseCode === 'WORKING_TIME');
      expect(workingTime).toBeTruthy();
      expect(workingTime?.section).toBeTruthy();

      // Tenants may create custom clauses; they start unlinked and pending review.
      const code = `TEST_CUSTOM_${Date.now()}`;
      const create = await api.post('/api/ops/hr/contracts/clauses').set(auth(hrToken)).send({
        clauseCode: code,
        name: 'Test Custom Clause',
        category: 'General',
        text: 'This clause is tenant-authored content for testing.',
        requiredFlag: 'OPTIONAL',
      });
      expect(create.status).toBe(200);
      const created = create.body.data as {
        id?: number;
        clauseCode?: string;
        validationStatus?: string;
        legalRuleId?: number | null;
        createdBy?: number | null;
        version?: number;
      };
      expect(Number(created.id)).toBeGreaterThan(0);
      expect(created.clauseCode).toBe(code);
      expect(created.validationStatus).toBe('PENDING_REVIEW');
      expect(created.legalRuleId).toBeNull();
      expect(created.createdBy).toBeTruthy();
      expect(created.version).toBe(1);
      const clauseId = Number(created.id);

      try {
        // Statutory clauses are centrally controlled and frozen for tenants.
        const frozen = await api
          .post(`/api/ops/hr/contracts/clauses/${workingTime?.id}/versions`)
          .set(auth(hrToken))
          .send({ text: 'Tampered statutory clause.' });
        expect(frozen.status).toBe(403);
        expect(JSON.stringify(frozen.body)).toMatch(/Centrally controlled/i);

        // Tenant-owned clauses can be versioned; the new version is pending review.
        const version = await api
          .post(`/api/ops/hr/contracts/clauses/${clauseId}/versions`)
          .set(auth(hrToken))
          .send({ text: 'Updated tenant-authored text for version two.', status: 'ACTIVE' });
        expect(version.status).toBe(200);
        expect(version.body.data.version).toBe(2);
        expect(version.body.data.validationStatus).toBe('PENDING_REVIEW');
        expect(String(version.body.data.text)).toContain('version two');

        // The superseded version is snapshotted into the history table.
        const hist = await db(
          `SELECT version, text FROM contract_clause_versions WHERE clause_id = $1 ORDER BY version`,
          [clauseId]
        );
        expect(hist.rows.length).toBe(2);
        expect(Number(hist.rows[0].version)).toBe(1);
        expect(Number(hist.rows[1].version)).toBe(2);
        expect(String(hist.rows[0].text)).toContain('tenant-authored content');
      } finally {
        // Hard delete cascades to contract_clause_versions.
        await db(`DELETE FROM contract_clauses WHERE id = $1`, [clauseId]);
      }
    },
    60_000
  );
});
