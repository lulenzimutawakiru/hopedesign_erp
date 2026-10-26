import { afterAll, describe, expect, it } from 'vitest';
import { api, auth, db, loginAs, pool } from './helpers.js';

function message(body: { error?: { message?: string } }): string {
  return body.error?.message ?? '';
}

describe('ISO operating controls', () => {
  const policyIds: number[] = [];

  afterAll(async () => {
    if (policyIds.length === 0) return;
    await db(
      `UPDATE iso_policies SET status = 'RETIRED' WHERE id = ANY($1::bigint[]) AND status = 'APPROVED'`,
      [policyIds],
    );
  });

  it('refuses a policy the author approves, and a policy with no review date', async () => {
    const { token: admin } = await loginAs('admin');
    const { token: hr } = await loginAs('hr.hannah');
    const version = `isms-${Date.now()}`;
    const draft = await api.post('/api/ops/compliance/policies').set(auth(admin)).send({
      kind: 'ISMS_POLICY',
      title: 'Information security policy',
      version,
      body: 'Protect company information. Review this policy every year.',
      ownerRole: 'Security administrator',
    });
    expect(draft.status).toBe(200);
    const policyId = Number(draft.body.data.id);
    policyIds.push(policyId);

    const self = await api
      .post(`/api/ops/compliance/policies/${policyId}/approve`)
      .set(auth(admin))
      .send({ nextReviewOn: '2027-10-26' });
    expect(self.status).toBe(400);
    expect(message(self.body)).toMatch(/author/i);

    const undated = await api.post(`/api/ops/compliance/policies/${policyId}/approve`).set(auth(hr)).send({});
    expect(undated.status).toBe(400);
    expect(message(undated.body)).toMatch(/nextReviewOn/);

    const approved = await api
      .post(`/api/ops/compliance/policies/${policyId}/approve`)
      .set(auth(hr))
      .send({ nextReviewOn: '2027-10-26' });
    expect(approved.status).toBe(200);
    expect(approved.body.data.status).toBe('APPROVED');
  });

  it('blocks only the named user until that user accepts the policy', async () => {
    const subject = await db(`SELECT id FROM users WHERE username = 'qa.auditor'`);
    const subjectId = Number(subject.rows[0].id);
    await db(
      `UPDATE iso_policies SET status = 'RETIRED'
        WHERE subject_user_id = $1 AND status = 'APPROVED'
          AND kind IN ('ACCEPTABLE_USE', 'AWARENESS', 'CLEAR_DESK')`,
      [subjectId],
    );
    const { token: admin } = await loginAs('admin');
    const { token: hr } = await loginAs('hr.hannah');
    const draft = await api.post('/api/ops/compliance/policies').set(auth(admin)).send({
      kind: 'ACCEPTABLE_USE',
      title: 'Acceptable use for the auditor account',
      version: `aup-${Date.now()}`,
      body: 'Use this account only for audit work.',
      ownerRole: 'HR director',
      subjectUserId: subjectId,
    });
    expect(draft.status).toBe(200);
    const policyId = Number(draft.body.data.id);
    policyIds.push(policyId);
    try {
      const approved = await api
        .post(`/api/ops/compliance/policies/${policyId}/approve`)
        .set(auth(hr))
        .send({ nextReviewOn: '2027-10-26' });
      expect(approved.status).toBe(200);

      const { token: auditor } = await loginAs('qa.auditor');
      const blocked = await api.get('/api/ops/compliance/entries').set(auth(auditor));
      expect(blocked.status).toBe(403);
      expect(message(blocked.body)).toMatch(/Accept the policy/);

      const others = await api.get('/api/ops/compliance/entries').set(auth(admin));
      expect(others.status).toBe(200);

      const ack = await api.post('/api/ops/compliance/acknowledgements').set(auth(auditor)).send({ policyId });
      expect(ack.status).toBe(200);
      const open = await api.get('/api/ops/compliance/entries').set(auth(auditor));
      expect(open.status).toBe(200);
    } finally {
      await db(`UPDATE iso_policies SET status = 'RETIRED' WHERE id = $1`, [policyId]);
    }
  });

  it('reports a company-wide acknowledgement only inside a transaction that rolls back', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const people = await client.query<{ id: string; company_id: string; tenant_id: string; username: string }>(
        `SELECT id, company_id, tenant_id, username FROM users WHERE username IN ('admin', 'hr.hannah')`,
      );
      const admin = people.rows.find((row) => row.username === 'admin');
      const hr = people.rows.find((row) => row.username === 'hr.hannah');
      expect(admin).toBeTruthy();
      expect(hr).toBeTruthy();
      await client.query(
        `INSERT INTO iso_policies
           (company_id, tenant_id, code, kind, title, version, body, status, owner_role,
            next_review_on, approved_by, approved_at, created_by)
         VALUES ($1,$2,$3,'ACCEPTABLE_USE','Company acceptable use',$4,
                 'Use the system only for company work.','APPROVED','HR director',
                 CURRENT_DATE + 30, $5, now(), $6)`,
        [admin!.company_id, admin!.tenant_id, `AUP-SQL-${Date.now()}`, `sql-${Date.now()}`, hr!.id, admin!.id],
      );
      const pending = await client.query<{ title: string }>(
        `SELECT iso_pending_acknowledgement($1, $2) AS title`,
        [admin!.id, admin!.company_id],
      );
      expect(pending.rows[0].title).toBe('Company acceptable use');
      const pendingHr = await client.query<{ title: string }>(
        `SELECT iso_pending_acknowledgement($1, $2) AS title`,
        [hr!.id, admin!.company_id],
      );
      expect(pendingHr.rows[0].title).toBe('Company acceptable use');
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
    const left = await db(
      `SELECT count(*)::int AS n FROM iso_policies WHERE title = 'Company acceptable use' AND status = 'APPROVED'`,
    );
    expect(left.rows[0].n).toBe(0);
  });

  it('refuses a purchase from a new supplier until the review and the clause are approved', async () => {
    const { token } = await loginAs('admin');
    const products = await api.get('/api/inventory/items?pageSize=5').set(auth(token));
    expect(products.status).toBe(200);
    const productId = Number(products.body.data[0].id);
    const supplier = await api.post('/api/ops/procurement/suppliers').set(auth(token)).send({
      name: `ISO Fibre ${Date.now()}`,
      supplierType: 'RAW_MATERIAL',
      paymentTermsDays: 30,
    });
    expect(supplier.status).toBe(200);
    const supplierId = Number(supplier.body.data.supplierId);

    const blocked = await api.post('/api/ops/procurement/orders').set(auth(token)).send({
      supplierId,
      items: [{ productId, quantity: 1, unitPrice: 1000 }],
    });
    expect(blocked.status).toBe(400);
    expect(message(blocked.body)).toMatch(/no current quality and security approval/);

    const review = await api.post('/api/ops/compliance/entries').set(auth(token)).send({
      entryType: 'supplier_review',
      status: 'CURRENT',
      title: 'Supplier security review',
      ownerRole: 'Procurement',
      subjectTable: 'suppliers',
      subjectId: supplierId,
      payload: { result: 'APPROVED' },
    });
    expect(review.status).toBe(200);
    const clause = await api.post('/api/ops/compliance/entries').set(auth(token)).send({
      entryType: 'supplier_clause',
      status: 'CURRENT',
      title: 'Supplier security clause',
      ownerRole: 'Procurement',
      subjectTable: 'suppliers',
      subjectId: supplierId,
      payload: { clause: 'The supplier protects Hope Design information and reports incidents.' },
    });
    expect(clause.status).toBe(200);
    const approved = await api.post(`/api/ops/compliance/suppliers/${supplierId}/approve`).set(auth(token)).send({});
    expect(approved.status).toBe(200);
    expect(approved.body.data.isoReviewStatus).toBe('APPROVED');

    const order = await api.post('/api/ops/procurement/orders').set(auth(token)).send({
      supplierId,
      items: [{ productId, quantity: 1, unitPrice: 1000 }],
    });
    expect(order.status).toBe(200);
    expect(Number(order.body.data.orderId)).toBeGreaterThan(0);
  });

  it('refuses to start a work order until the quality plan, gate and measurement plan exist', async () => {
    const { token } = await loginAs('admin');
    const products = await api.get('/api/inventory/items?pageSize=20').set(auth(token));
    const product = products.body.data.find((row: { code: string }) => row.code === 'NATEX-A4') ?? products.body.data[0];
    const created = await api.post('/api/ops/production/work-orders').set(auth(token)).send({
      productId: product.id,
      quantity: 5,
      priority: 'LOW',
    });
    expect(created.status).toBe(200);
    const id = Number(created.body.data.workOrderId);
    const released = await api.post(`/api/ops/production/work-orders/${id}/release`).set(auth(token)).send({});
    expect(released.status).toBe(200);

    const blocked = await api.post(`/api/ops/production/work-orders/${id}/start`).set(auth(token)).send({});
    expect(blocked.status).toBe(400);
    expect(message(blocked.body)).toMatch(/quality_plan, project_gate, measurement_plan/);

    for (const [entryType, payload] of [
      ['quality_plan', { criteria: 'Basis weight within specification' }],
      ['project_gate', { decision: 'PASS' }],
      ['measurement_plan', { measure: 'Good quantity', frequency: 'each order' }],
    ] as const) {
      const recorded = await api.post('/api/ops/compliance/entries').set(auth(token)).send({
        entryType,
        status: 'CURRENT',
        title: entryType,
        ownerRole: 'Quality manager',
        subjectTable: 'work_orders',
        subjectId: id,
        payload,
      });
      expect(recorded.status).toBe(200);
    }
    const started = await api.post(`/api/ops/production/work-orders/${id}/start`).set(auth(token)).send({});
    expect(started.status).toBe(200);
  });

  it('refuses to convert a quotation until the customer requirements are accepted', async () => {
    const { token } = await loginAs('sarah.sales');
    const { token: admin } = await loginAs('admin');
    const quoted = await api.post('/api/ops/sales/quotations').set(auth(token)).send({
      customerId: 1,
      items: [{ productId: 3, quantity: 1, unitPrice: 1000 }],
    });
    expect(quoted.status).toBe(200);
    const quotationId = Number(quoted.body.data.quotationId);
    await api.post(`/api/ops/sales/quotations/${quotationId}/submit`).set(auth(token)).send({});

    const blocked = await api.post(`/api/ops/sales/quotations/${quotationId}/convert`).set(auth(token)).send({});
    expect(blocked.status).toBe(400);
    expect(message(blocked.body)).toMatch(/customer requirements/);

    const review = await api.post('/api/ops/compliance/entries').set(auth(admin)).send({
      entryType: 'requirement_review',
      status: 'CURRENT',
      title: 'Requirements accepted',
      ownerRole: 'Sales director',
      subjectTable: 'sales_quotations',
      subjectId: quotationId,
      payload: { accepted: true },
    });
    expect(review.status).toBe(200);
    const converted = await api.post(`/api/ops/sales/quotations/${quotationId}/convert`).set(auth(token)).send({});
    expect(converted.status).toBe(200);
  });

  it('lets a user without operating access report an event, and refuses to close it without a decision', async () => {
    const { token: reporter } = await loginAs('sso.demo');
    const { token: admin } = await loginAs('admin');
    const reported = await api.post('/api/ops/compliance/security-events').set(auth(reporter)).send({
      title: `Server-room door ${Date.now()}`,
      description: 'Seen during the evening round.',
    });
    expect(reported.status).toBe(200);
    const id = Number(reported.body.data.id);

    const closed = await api.patch(`/api/ops/compliance/entries/${id}`).set(auth(admin)).send({ status: 'CLOSED' });
    expect(closed.status).toBe(400);
    expect(message(closed.body)).toMatch(/decision/);

    const decided = await api.patch(`/api/ops/compliance/entries/${id}`).set(auth(admin)).send({
      status: 'CLOSED',
      payload: { decision: 'NOT_AN_INCIDENT', decidedBy: 'Security administrator' },
    });
    expect(decided.status).toBe(200);
    expect(decided.body.data.status).toBe('CLOSED');
  });

  it('refuses to complete an erasure until backups and files are recorded as wiped', async () => {
    const { token } = await loginAs('admin');
    const made = await api.post('/api/ops/compliance/subject-requests').set(auth(token)).send({
      requestType: 'ERASURE',
      subjectReference: `ISO-ERASE-${Date.now()}`,
      subjectType: 'CUSTOMER',
    });
    expect(made.status).toBe(200);
    const id = Number(made.body.data.id);
    const blocked = await api.post(`/api/ops/compliance/subject-requests/${id}/complete`).set(auth(token)).send({
      outcomeSummary: 'Personal data was removed from the live register.',
    });
    expect(blocked.status).toBe(400);
    expect(message(blocked.body)).toMatch(/backups and stored files/);

    const proof = await api.post('/api/ops/compliance/entries').set(auth(token)).send({
      entryType: 'deletion_proof',
      status: 'CURRENT',
      title: 'Erasure proof',
      ownerRole: 'Data protection officer',
      payload: { subjectRequestId: id, backupsWiped: true, filesWiped: true },
    });
    expect(proof.status).toBe(200);
    const completed = await api.post(`/api/ops/compliance/subject-requests/${id}/complete`).set(auth(token)).send({
      outcomeSummary: 'Personal data was removed from the live register, the backups and the files.',
    });
    expect(completed.status).toBe(200);
    expect(completed.body.data.status).toBe('COMPLETED');
  });

  it('blocks dispatch of a product that is on quality hold', async () => {
    const { token } = await loginAs('admin');
    const owner = await db(
      `SELECT id, company_id, tenant_id FROM users WHERE username = 'admin'`,
    );
    const code = `ISO-HOLD-${Date.now()}`;
    const product = await db(
      `INSERT INTO products (company_id, tenant_id, code, name)
       VALUES ($1,$2,$3,'ISO quality hold sample')
       RETURNING id`,
      [owner.rows[0].company_id, owner.rows[0].tenant_id, code],
    );
    const productId = Number(product.rows[0].id);
    const hold = await db(
      `INSERT INTO quality_holds
         (company_id, tenant_id, hold_no, product_id, quantity, reason, status, held_by)
       VALUES ($1,$2,$3,$4,1,'ISO dispatch gate','HELD',$5)
       RETURNING id`,
      [owner.rows[0].company_id, owner.rows[0].tenant_id, code, productId, owner.rows[0].id],
    );
    try {
      const moved = await api.post('/api/ops/inventory/moves').set(auth(token)).send({
        movementType: 'DISPTACH',
        product: productId,
        quantity: 1,
      });
      expect(moved.status).toBe(400);
      expect(message(moved.body)).toMatch(/blocks dispatch/);
    } finally {
      await db(`DELETE FROM quality_holds WHERE id = $1`, [hold.rows[0].id]);
      await db(`DELETE FROM products WHERE id = $1`, [productId]);
    }
  });
});
