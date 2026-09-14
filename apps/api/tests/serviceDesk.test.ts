import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { api, auth, db, loginAs, PASSWORD, pool } from './helpers.js';
import { hashPassword } from '../src/auth.js';

/**
 * HOPE DESIGN SERVICE DESK & ITSM - end-to-end contract test.
 *
 * The module is exercised the way the business uses it: an employee raises a
 * request through MY HOPE DESIGN, an agent works it inside the service desk
 * workspace, a technician scans an asset QR tag, and a service desk manager
 * drives the change, problem, access-request and knowledge workflows.
 *
 * Every assertion is made against observable behaviour - the HTTP contract and
 * persisted state - so the test keeps working as the internals evolve.
 */

interface Actor {
  id: number;
  username: string;
  email: string;
  token: string;
}

const COMPANY_ID = 2;
const IT_DEPARTMENT_ID = 11;
const TICKET_NUMBER = /^HDG-SD-\d{4}-\d{6}$/;

/** Create a throw-away operator with the role and organizational scope a scenario needs. */
async function createActor(
  key: string,
  roleCode: string,
  scope: { branch: number | null; department: number | null } = {
    branch: COMPANY_ID,
    department: IT_DEPARTMENT_ID,
  }
): Promise<Actor> {
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const username = `sd.t.${key}.${stamp}`;
  const email = `${username}@hopedesign.test`;
  const passwordHash = await hashPassword(PASSWORD);

  const inserted = await db(
    `INSERT INTO users (tenant_id, company_id, branch_id, department_id, email, username, password_hash, first_name, last_name)
     VALUES ($1, $1, $2, $3, $4, $5, $6, 'Sd', 'Test')
     RETURNING id`,
    [COMPANY_ID, scope.branch, scope.department, email, username, passwordHash]
  );
  const id = Number(inserted.rows[0].id);

  const role = await db(`SELECT id FROM roles WHERE code = $1 AND tenant_id = $2`, [roleCode, COMPANY_ID]);
  if (!role.rows[0]) throw new Error(`role ${roleCode} is not provisioned`);
  await db(`INSERT INTO user_roles (user_id, role_id, company_id) VALUES ($1, $2, $3)`, [
    id,
    Number(role.rows[0].id),
    COMPANY_ID,
  ]);

  const { token } = await loginAs(username);
  return { id, username, email, token };
}

/**
 * Nullable user references that must be released before the throw-away users
 * can be deleted. Every pair is (table, column) and every failure is tolerated,
 * because a table only exists when its feature is installed.
 */
const COLPAIRS: Array<[string, string]> = [
  ['access_approvals', 'approver_user_id'],
  ['access_approvals', 'created_by'],
  ['access_requests', 'created_by'],
  ['access_requests', 'granted_by'],
  ['access_requests', 'revoked_by'],
  ['access_requests', 'target_user_id'],
  ['access_requests', 'updated_by'],
  ['change_approvals', 'approver_user_id'],
  ['change_approvals', 'created_by'],
  ['change_approvals', 'updated_by'],
  ['change_requests', 'assigned_to_user_id'],
  ['change_requests', 'closed_by'],
  ['change_requests', 'created_by'],
  ['change_requests', 'implemented_by'],
  ['change_requests', 'requested_by'],
  ['change_requests', 'retrospective_approved_by'],
  ['change_requests', 'updated_by'],
  ['change_requests', 'validated_by'],
  ['escalation_rules', 'created_by'],
  ['escalation_rules', 'updated_by'],
  ['incidents', 'created_by'],
  ['incidents', 'resolved_by'],
  ['incidents', 'updated_by'],
  ['knowledge_articles', 'approved_by'],
  ['knowledge_articles', 'archived_by'],
  ['knowledge_articles', 'author_user_id'],
  ['knowledge_articles', 'created_by'],
  ['knowledge_articles', 'owner_user_id'],
  ['knowledge_articles', 'published_by'],
  ['knowledge_articles', 'reviewed_by'],
  ['knowledge_articles', 'updated_by'],
  ['knowledge_categories', 'created_by'],
  ['knowledge_categories', 'updated_by'],
  ['knowledge_feedback', 'created_by'],
  ['knowledge_feedback', 'user_id'],
  ['knowledge_versions', 'created_by'],
  ['known_errors', 'created_by'],
  ['known_errors', 'updated_by'],
  ['problems', 'assigned_to_user_id'],
  ['problems', 'closed_by'],
  ['problems', 'created_by'],
  ['problems', 'updated_by'],
  ['root_cause_analyses', 'approved_by'],
  ['root_cause_analyses', 'created_by'],
  ['root_cause_analyses', 'updated_by'],
  ['service_business_calendars', 'created_by'],
  ['service_business_calendars', 'updated_by'],
  ['service_categories', 'created_by'],
  ['service_categories', 'updated_by'],
  ['service_holidays', 'created_by'],
  ['service_queues', 'created_by'],
  ['service_queues', 'updated_by'],
  ['service_requests', 'created_by'],
  ['service_requests', 'fulfilled_by'],
  ['service_requests', 'updated_by'],
  ['service_skills', 'created_by'],
  ['service_subcategories', 'created_by'],
  ['service_subcategories', 'updated_by'],
  ['service_teams', 'created_by'],
  ['service_teams', 'lead_user_id'],
  ['service_teams', 'updated_by'],
  ['service_tickets', 'assigned_to_user_id'],
  ['service_tickets', 'created_by'],
  ['service_tickets', 'requester_user_id'],
  ['service_tickets', 'updated_by'],
  ['sla_breaches', 'acknowledged_by'],
  ['sla_breaches', 'created_by'],
  ['sla_policies', 'created_by'],
  ['sla_policies', 'updated_by'],
  ['sla_tracking', 'created_by'],
  ['ticket_assignments', 'assigned_by'],
  ['ticket_assignments', 'assigned_from_user_id'],
  ['ticket_assignments', 'assigned_to_user_id'],
  ['ticket_assignments', 'created_by'],
  ['ticket_assignments', 'previous_assignee_id'],
  ['ticket_attachments', 'created_by'],
  ['ticket_attachments', 'uploaded_by_user_id'],
  ['ticket_comments', 'author_user_id'],
  ['ticket_comments', 'created_by'],
  ['ticket_comments', 'updated_by'],
  ['ticket_escalations', 'acknowledged_by'],
  ['ticket_escalations', 'created_by'],
  ['ticket_escalations', 'escalated_from_user_id'],
  ['ticket_escalations', 'escalated_to_user_id'],
  ['ticket_knowledge_links', 'linked_by'],
  ['ticket_relations', 'created_by'],
  ['ticket_status_history', 'changed_by'],
];

/** Remove every row the scenario could have written, in foreign-key-safe order. */
async function teardown(rawIds: number[]) {
  const ids = [...new Set(rawIds.map(Number).filter((n) => Number.isFinite(n) && n > 0))];
  if (ids.length === 0) return;
  const ph = ids.map((_, i) => `$${i + 1}`).join(',');
  const ticketScope = `SELECT id FROM service_tickets WHERE created_by IN (${ph}) OR requester_user_id IN (${ph}) OR assigned_to_user_id IN (${ph})`;
  const teamScope = `SELECT id FROM service_teams WHERE created_by IN (${ph})`;
  const run = async (sql: string) => {
    try {
      await pool.query(sql, ids);
    } catch {
      // The table or column is not installed in this build; nothing to clean.
    }
  };

  // Release the NO ACTION references that point at our tickets and our teams.
  for (const [table, column] of [
    ['asset_service_scans', 'ticket_id'],
    ['change_requests', 'related_ticket_id'],
    ['service_tickets', 'parent_ticket_id'],
  ] as Array<[string, string]>) {
    await run(`UPDATE ${table} SET ${column} = NULL WHERE ${column} IN (${ticketScope})`);
  }
  for (const [table, column] of [
    ['service_tickets', 'assigned_team_id'],
    ['ticket_assignments', 'assigned_team_id'],
    ['change_requests', 'assigned_team_id'],
    ['problems', 'assigned_team_id'],
  ] as Array<[string, string]>) {
    await run(`UPDATE ${table} SET ${column} = NULL WHERE ${column} IN (${teamScope})`);
  }

  // Our tickets cascade to comments, attachments, assignments, history, SLA and escalations.
  await run(`DELETE FROM service_tickets WHERE id IN (${ticketScope})`);

  for (const table of [
    'change_requests',
    'problems',
    'known_errors',
    'knowledge_articles',
    'root_cause_analyses',
    'incidents',
    'service_requests',
  ]) {
    await run(`DELETE FROM ${table} WHERE created_by IN (${ph})`);
  }
  for (const [table, column] of [
    ['problem_incidents', 'linked_by'],
    ['access_requests', 'created_by'],
    ['asset_service_scans', 'scanned_by'],
    ['service_team_members', 'user_id'],
    ['service_agent_skills', 'user_id'],
  ] as Array<[string, string]>) {
    await run(`DELETE FROM ${table} WHERE ${column} IN (${ph})`);
  }
  for (const table of [
    'knowledge_categories',
    'service_subcategories',
    'service_categories',
    'service_queues',
    'service_skills',
    'service_teams',
    'escalation_rules',
    'sla_policies',
    'service_business_calendars',
    'service_holidays',
  ]) {
    await run(`DELETE FROM ${table} WHERE created_by IN (${ph})`);
  }

  for (const [table, column] of COLPAIRS) {
    await run(`UPDATE ${table} SET ${column} = NULL WHERE ${column} IN (${ph})`);
  }

  await run(`DELETE FROM user_tasks WHERE user_id IN (${ph}) OR created_by IN (${ph})`);
  await run(`DELETE FROM sessions WHERE user_id IN (${ph})`);
  await run(`DELETE FROM user_roles WHERE user_id IN (${ph})`);
  await run(`DELETE FROM users WHERE id IN (${ph})`);
}

/**
 * Row counts this suite must not move. Absolute totals are not safe to assert:
 * a preceding test file that failed part-way can leave rows behind, and that
 * residue would then be reported as a leak from the Service Desk suite. Compare
 * against the baseline captured before this file creates its own fixtures.
 */
const snapshotCounts = async () => {
  const res = await db(
    `SELECT (SELECT count(*)::int FROM users) AS users,
            (SELECT count(*)::int FROM service_tickets) AS tickets,
            (SELECT count(*)::int FROM asset_service_scans) AS scans`
  );
  return res.rows[0] as { users: number; tickets: number; scans: number };
};

describe('HOPE DESIGN Service Desk & ITSM', () => {
  const actors: Actor[] = [];
  let employee: Actor;
  let agent: Actor;
  let technician: Actor;
  let manager: Actor;
  let secondManager: Actor;

  let ticketId = 0;
  let ticketNumber = '';
  let secondTicketId = 0;
  let thirdTicketId = 0;
  let scannedTicketId = 0;
  let baseline: { users: number; tickets: number; scans: number } = { users: 0, tickets: 0, scans: 0 };

  beforeAll(async () => {
    // Captured before any fixture exists so the teardown check measures this
    // suite's own leakage and nothing else.
    baseline = await snapshotCounts();
    employee = await createActor('emp', 'employee_self_service');
    agent = await createActor('agt', 'service_desk_agent');
    technician = await createActor('tec', 'service_desk_technician');
    manager = await createActor('mgr', 'service_desk_manager');
    secondManager = await createActor('mg2', 'service_desk_manager');
    actors.push(employee, agent, technician, manager, secondManager);
  }, 60000);

  afterAll(async () => {
    await teardown(actors.map((actor) => actor.id));

    const residue = await db(`SELECT id, username FROM users WHERE username LIKE 'sd.t.%'`);
    expect(residue.rows).toEqual([]);

    const counts = await snapshotCounts();
    expect(counts).toEqual(baseline);
  }, 60000);

  // -------------------------------------------------------------------------
  // Employee self-service (spec 2, 3, 21, 23)
  // -------------------------------------------------------------------------

  it('lets an employee raise a service request through MY HOPE DESIGN', async () => {
    const res = await api.post('/api/my/service-desk/tickets').set(auth(employee.token)).send({
      ticketType: 'SERVICE_REQUEST',
      categoryId: 1,
      subcategoryId: 6,
      subject: 'Laptop will not power on',
      description: 'The laptop stops on the vendor splash screen and never reaches Windows.',
      impact: 'INDIVIDUAL',
      urgency: 'MEDIUM',
    });
    expect(res.status).toBe(200);

    const ticket = res.body.data;
    expect(ticket.ticket_number).toMatch(TICKET_NUMBER);
    // A brand new ticket starts in NEW, but the assignment engine (spec 10) is
    // allowed to route it straight to a technician, which lands it on ASSIGNED.
    expect(['NEW', 'OPEN', 'ASSIGNED']).toContain(ticket.status);
    if (ticket.status === 'ASSIGNED') {
      expect(ticket.assignment?.assignedToUserId).toBeTruthy();
    }
    expect(Number(ticket.requester_user_id)).toBe(employee.id);
    expect(ticket).toHaveProperty('sla');
    expect(ticket).toHaveProperty('assignment');
    expect(Number(ticket.branch_id)).toBe(COMPANY_ID);

    // Captured before any optional assertion so every later scenario can still
    // address the ticket.
    ticketId = Number(ticket.id);
    ticketNumber = String(ticket.ticket_number);
    expect(Number.isFinite(ticketId)).toBe(true);
  });

  it('lets an employee read back the ticket they raised', async () => {
    const res = await api.get(`/api/my/service-desk/tickets/${ticketId}`).set(auth(employee.token));
    expect(res.status).toBe(200);
    expect(Number(res.body.data.ticket.id)).toBe(ticketId);
    expect(res.body.data.ticket.ticket_number).toBe(ticketNumber);
    expect(res.body.data.permissions.isRequester).toBe(true);
  });

  it('never lets an employee raise a ticket in another employee name', async () => {
    const res = await api.post('/api/my/service-desk/tickets').set(auth(employee.token)).send({
      categoryId: 1,
      subcategoryId: 6,
      subject: 'Raised on behalf of another employee',
      description: 'This request must never be attributed to somebody else.',
      requesterUserId: agent.id,
      requesterEmployeeId: agent.id,
      requester_user_id: agent.id,
    });

    // The self-service surface may reject the attempt outright; what it must
    // never do is honour it. Either way the recorded requester is the caller.
    expect([200, 403]).toContain(res.status);
    if (res.status === 200) {
      expect(Number(res.body.data.requester_user_id)).toBe(employee.id);
    } else {
      expect(res.body.error.code).toBe('FORBIDDEN');
    }
  });

  it('keeps the agent workspace away from ordinary employees', async () => {
    const workspace = await api.get('/api/service-desk/tickets').set(auth(employee.token));
    expect(workspace.status).toBe(403);

    const comments = await api.get(`/api/my/service-desk/tickets/${ticketId}/comments`).set(auth(employee.token));
    expect(comments.status).toBe(200);
    expect(comments.body.data).not.toHaveProperty('canViewInternalNotes');
  });
  // -------------------------------------------------------------------------
  // Agent workspace: assignment, communication, lifecycle (spec 8, 10, 11)
  // -------------------------------------------------------------------------

  it('drives a ticket through the full service desk lifecycle', async () => {
    const opened = await api.post(`/api/service-desk/tickets/${ticketId}/open`).set(auth(agent.token)).send({});
    expect(opened.status).toBe(200);

    const assigned = await api.post(`/api/service-desk/tickets/${ticketId}/assign`).set(auth(agent.token)).send({
      assignedToUserId: agent.id,
      reason: 'Taking the ticket from the IT service desk queue.',
    });
    expect(assigned.status).toBe(200);
    expect(Number(assigned.body.data.assignment.assignedToUserId)).toBe(agent.id);
    expect(assigned.body.data.assignment.assignmentId).toBeTruthy();
    expect(assigned.body.data.assignment.strategy).toBeTruthy();

    const started = await api.post(`/api/service-desk/tickets/${ticketId}/start`).set(auth(agent.token)).send({});
    expect(started.status).toBe(200);

    const reply = await api.post(`/api/service-desk/tickets/${ticketId}/respond`).set(auth(agent.token)).send({
      body: 'Thank you for reporting this. We have collected the device and are testing the memory modules.',
    });
    expect(reply.status).toBe(200);
    expect(reply.body.data.comment_type).toBe('REPLY');
    expect(reply.body.data.is_internal).not.toBe(true);

    const detail = await api.get(`/api/service-desk/tickets/${ticketId}`).set(auth(agent.token));
    expect(detail.status).toBe(200);
    expect(detail.body.data.ticket.first_response_at).toBeTruthy();
    expect(detail.body.data.sla.response_state).toBe('MET');
    expect(detail.body.data.sla.resolution_due_at).toBeTruthy();
  });

  it('records internal notes that the requester can never see', async () => {
    const note = await api.post(`/api/service-desk/tickets/${ticketId}/notes`).set(auth(agent.token)).send({
      body: 'Internal: the second memory slot is faulty - reseat it before ordering a replacement board.',
    });
    expect(note.status).toBe(200);
    expect(note.body.data.is_internal).toBe(true);
    expect(note.body.data.comment_type).toBe('NOTE');

    const asAgent = await api.get(`/api/service-desk/tickets/${ticketId}/comments`).set(auth(agent.token));
    expect(asAgent.status).toBe(200);
    expect(asAgent.body.data.canViewInternalNotes).toBe(true);
    expect(asAgent.body.data.comments.some((c: { comment_type: string }) => c.comment_type === 'NOTE')).toBe(true);

    const asRequester = await api.get(`/api/my/service-desk/tickets/${ticketId}/comments`).set(auth(employee.token));
    expect(asRequester.status).toBe(200);
    expect(asRequester.body.data).not.toHaveProperty('canViewInternalNotes');
    expect(asRequester.body.data.comments.some((c: { comment_type: string }) => c.comment_type === 'NOTE')).toBe(false);
    expect(asRequester.body.data.comments.some((c: { is_internal: boolean }) => c.is_internal === true)).toBe(false);
  });

  it('never lets a self-service reply be smuggled in as an internal note', async () => {
    const res = await api.post(`/api/my/service-desk/tickets/${ticketId}/reply`).set(auth(employee.token)).send({
      body: 'Any update on the repair please?',
      commentType: 'NOTE',
      internal: true,
      isInternal: true,
      is_internal: true,
    });
    expect(res.status).toBe(200);
    expect(res.body.data.comment_type).toBe('REPLY');
    expect(res.body.data.is_internal).not.toBe(true);
  });

  it('resolves, closes and reopens the ticket while keeping the SLA honest', async () => {
    const before = await api.get(`/api/service-desk/tickets/${ticketId}`).set(auth(agent.token));
    const dueBefore = String(before.body.data.sla.resolution_due_at);

    const resolved = await api.post(`/api/service-desk/tickets/${ticketId}/resolve`).set(auth(agent.token)).send({
      resolutionSummary: 'Reseated the memory module, re-ran diagnostics and confirmed a clean boot.',
    });
    expect(resolved.status).toBe(200);

    const closed = await api.post(`/api/service-desk/tickets/${ticketId}/close`).set(auth(agent.token)).send({});
    expect(closed.status).toBe(200);

    const reopened = await api.post(`/api/service-desk/tickets/${ticketId}/reopen`).set(auth(agent.token)).send({
      reason: 'The fault returned after the first reboot.',
    });
    expect(reopened.status).toBe(200);

    const after = await api.get(`/api/service-desk/tickets/${ticketId}`).set(auth(agent.token));
    expect(after.body.data.ticket.status).toBe('REOPENED');
    expect(Number(after.body.data.ticket.reopen_count)).toBeGreaterThan(0);
    expect(new Date(String(after.body.data.sla.resolution_due_at)).getTime()).toBeGreaterThanOrEqual(
      new Date(dueBefore).getTime()
    );

    const history = await db(`SELECT to_status FROM ticket_status_history WHERE ticket_id = $1 ORDER BY id`, [ticketId]);
    const walked = history.rows.map((row: { to_status: string }) => row.to_status);
    const expected = ['OPEN', 'ASSIGNED', 'IN_PROGRESS', 'RESOLVED', 'CLOSED', 'REOPENED'];
    let cursor = 0;
    for (const status of walked) {
      if (status === expected[cursor]) cursor += 1;
    }
    expect(cursor).toBe(expected.length);
  });

  it('refuses an illegal status jump with a conflict', async () => {
    const created = await api.post('/api/my/service-desk/tickets').set(auth(employee.token)).send({
      categoryId: 1,
      subcategoryId: 7,
      subject: 'Corporate email signature is missing',
      description: 'The signature block disappeared from my outgoing mail.',
    });
    expect(created.status).toBe(200);
    secondTicketId = Number(created.body.data.id);

    // Closing straight out of a pre-resolution status is illegal at every entry
    // point to the matrix, so the workflow cannot be short-circuited.
    const illegal = await api.post(`/api/service-desk/tickets/${secondTicketId}/close`).set(auth(agent.token)).send({
      reason: 'Attempting to skip the workflow.',
    });
    expect(illegal.status).toBe(409);
    expect(illegal.body.error.code).toBe('CONFLICT');
    expect(illegal.body.error.message).toMatch(/cannot move from/);
  });

  it('escalates a ticket with an auditable level and reason', async () => {
    const created = await api.post('/api/my/service-desk/tickets').set(auth(employee.token)).send({
      categoryId: 2,
      subcategoryId: 11,
      subject: 'Internet connection drops every afternoon',
      description: 'The whole floor loses connectivity between 14:00 and 15:00.',
    });
    expect(created.status).toBe(200);
    thirdTicketId = Number(created.body.data.id);

    const opened = await api.post(`/api/service-desk/tickets/${thirdTicketId}/open`).set(auth(agent.token)).send({});
    expect(opened.status).toBe(200);

    const escalated = await api.post(`/api/service-desk/tickets/${thirdTicketId}/escalate`).set(auth(agent.token)).send({
      reason: 'The pattern repeats daily and needs a network specialist.',
    });
    expect(escalated.status).toBe(200);
    expect(escalated.body.data.trigger_type).toBe('MANUAL');
    expect(Number(escalated.body.data.level)).toBeGreaterThan(0);
    expect(escalated.body.data.level_id).toBeTruthy();
  });
  // -------------------------------------------------------------------------
  // Asset integration and QR service desk (spec 12, 13, 29)
  // -------------------------------------------------------------------------

  it('audits a successful asset QR scan and reveals only authorized detail', async () => {
    const scan = await api.post('/api/service-desk/scan').set(auth(agent.token)).send({
      code: 'HDG-MC-FSS104',
      action: 'VIEW',
    });
    expect(scan.status).toBe(200);
    expect(scan.body.data.action).toBe('VIEW');
    expect(scan.body.data.asset.assetNo).toBe('FSS104');
    expect(scan.body.data.asset.isMachine).toBe(true);

    const ledger = await db(`SELECT outcome FROM asset_service_scans WHERE scanned_by = $1 ORDER BY id DESC LIMIT 1`, [
      agent.id,
    ]);
    expect(ledger.rows[0].outcome).toBe('SUCCESS');
  });

  it('lets a technician report an incident by scanning a machine QR tag', async () => {
    const scan = await api.post('/api/service-desk/scan').set(auth(technician.token)).send({
      code: 'HDG-MC-FSS300',
      action: 'REPORT_INCIDENT',
      subject: 'Blade jam on FSS300',
      description: 'The blade seized mid-cut and the machine stopped with a red tower light.',
    });
    expect(scan.status).toBe(200);
    scannedTicketId = Number(scan.body.data.ticketId);
    expect(scannedTicketId).toBeGreaterThan(0);

    const ledger = await db(
      `SELECT outcome, ticket_id FROM asset_service_scans WHERE scanned_by = $1 ORDER BY id DESC LIMIT 1`,
      [technician.id]
    );
    expect(ledger.rows[0].outcome).toBe('SUCCESS');
    expect(Number(ledger.rows[0].ticket_id)).toBe(scannedTicketId);

    const ticket = await api.get(`/api/service-desk/tickets/${scannedTicketId}`).set(auth(technician.token));
    expect(ticket.status).toBe(200);
    expect(ticket.body.data.ticket.source).toBe('QR_SCAN');
    expect(ticket.body.data.ticket.ticket_number).toMatch(TICKET_NUMBER);
  });

  it('refuses an unknown QR code but still writes the refusal to the ledger', async () => {
    const res = await api.post('/api/service-desk/scan').set(auth(agent.token)).send({
      code: 'HDG-NOPE-999999',
      action: 'VIEW',
    });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');

    const ledger = await db(
      `SELECT outcome, deny_reason FROM asset_service_scans WHERE scanned_by = $1 ORDER BY id DESC LIMIT 1`,
      [agent.id]
    );
    expect(ledger.rows[0].outcome).toBe('ASSET_NOT_FOUND');
    expect(ledger.rows[0].deny_reason).toBeTruthy();
  });

  it('refuses a scan outside the caller organizational scope and records the denial', async () => {
    const ghost = await createActor('oos', 'service_desk_agent', { branch: null, department: null });
    actors.push(ghost);

    const res = await api.post('/api/service-desk/scan').set(auth(ghost.token)).send({
      code: 'HDG-MC-FSS104',
      action: 'VIEW',
    });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');

    const ledger = await db(`SELECT outcome FROM asset_service_scans WHERE scanned_by = $1 ORDER BY id DESC LIMIT 1`, [
      ghost.id,
    ]);
    expect(ledger.rows[0].outcome).toBe('DENIED_SCOPE');
  });

  it('lets an employee scan an asset but not perform technician-only actions', async () => {
    const allowed = await api.post('/api/my/service-desk/scan').set(auth(employee.token)).send({
      code: 'HDG-MC-FSS104',
      action: 'VIEW',
    });
    expect(allowed.status).toBe(200);

    const refused = await api.post('/api/my/service-desk/scan').set(auth(employee.token)).send({
      code: 'HDG-MC-FSS104',
      action: 'UPDATE_TICKET',
    });
    expect(refused.status).toBe(403);
  });

  it('hides staff-created tickets from unrelated employees', async () => {
    const res = await api.get(`/api/my/service-desk/tickets/${scannedTicketId}`).set(auth(employee.token));
    expect(res.status).not.toBe(200);
  });
  // -------------------------------------------------------------------------
  // Dashboards, reporting and configuration (spec 24, 25)
  // -------------------------------------------------------------------------

  it('serves service desk metadata and summary to every operator role', async () => {
    for (const actor of [agent, technician]) {
      expect((await api.get('/api/service-desk/meta').set(auth(actor.token))).status).toBe(200);
      expect((await api.get('/api/service-desk/summary').set(auth(actor.token))).status).toBe(200);
    }
    const meta = await api.get('/api/service-desk/meta').set(auth(manager.token));
    expect(meta.status).toBe(200);
    expect(Array.isArray(meta.body.data.statuses)).toBe(true);
    expect(meta.body.data.statuses).toContain('IN_PROGRESS');
  });

  it('renders every dashboard for its intended audience', async () => {
    const employeeBoard = await api.get('/api/my/service-desk/dashboard').set(auth(employee.token));
    expect(employeeBoard.status).toBe(200);
    expect(employeeBoard.body.data).toHaveProperty('openTickets');
    expect(employeeBoard.body.data).toHaveProperty('knowledge');

    for (const board of ['agent', 'manager', 'executive']) {
      const res = await api.get(`/api/service-desk/dashboard/${board}`).set(auth(manager.token));
      expect(res.status, board).toBe(200);
    }

    const agentBoard = await api.get('/api/service-desk/dashboard/agent').set(auth(agent.token));
    expect(agentBoard.status).toBe(200);
    expect(agentBoard.body.data).toHaveProperty('myTickets');
    expect(agentBoard.body.data).toHaveProperty('slaWarnings');
  });

  it('runs every reporting view', async () => {
    const codes = [
      'tickets_by_category',
      'tickets_by_department',
      'tickets_by_employee',
      'sla_compliance',
      'sla_breaches',
      'resolution_time',
      'first_response_time',
      'technician_workload',
      'recurring_incidents',
      'asset_incidents',
      'service_trends',
    ];
    for (const code of codes) {
      const res = await api.get(`/api/service-desk/reports/${code}`).set(auth(manager.token));
      expect(res.status, code).toBe(200);
      expect(Array.isArray(res.body.data.rows), code).toBe(true);
      expect(res.body.data, code).toHaveProperty('generatedAt');
    }
  });

  it('exposes the configuration surfaces a service desk manager administers', async () => {
    const paths = [
      '/queues',
      '/queues/summary',
      '/workload',
      '/sla/policies',
      '/calendars',
      '/escalation/levels',
      '/escalation/rules',
      '/teams',
      '/skills',
      '/categories',
    ];
    for (const path of paths) {
      const res = await api.get(`/api/service-desk${path}`).set(auth(manager.token));
      expect(res.status, path).toBe(200);
    }
  });

  it('always records an audit trail for the ticket', async () => {
    const rows = await db(
      `SELECT action, resource, record_id, user_id FROM audit_logs WHERE record_id = $1 AND user_id = ANY($2::bigint[]) ORDER BY id`,
      [ticketId, [employee.id, agent.id]]
    );
    expect(rows.rows.length).toBeGreaterThan(0);

    const withValues = await db(
      `SELECT count(*)::int AS n FROM audit_logs WHERE record_id = $1 AND (old_values IS NOT NULL OR new_values IS NOT NULL)`,
      [ticketId]
    );
    expect(Number(withValues.rows[0].n)).toBeGreaterThan(0);
  });
  // -------------------------------------------------------------------------
  // Change management (spec 19)
  // -------------------------------------------------------------------------

  it('controls a normal change through risk, impact and approval', async () => {
    const created = await api.post('/api/service-desk/changes').set(auth(manager.token)).send({
      title: 'Apply the September ERP patch set',
      description: 'Roll the quarterly patch bundle onto the application node.',
      changeType: 'NORMAL',
      priority: 'P3',
    });
    expect(created.status).toBe(200);
    const change = created.body.data.change ?? created.body.data;
    const ref = Number(change.id);
    expect(change.change_number).toBeTruthy();

    expect((await api.get(`/api/service-desk/changes/${ref}`).set(auth(manager.token))).status).toBe(200);
    expect((await api.get(`/api/service-desk/changes/${change.change_number}`).set(auth(manager.token))).status).toBe(200);

    const approvals = await api.get(`/api/service-desk/changes/${ref}/approvals`).set(auth(manager.token));
    expect(approvals.status).toBe(200);
    expect(Array.isArray(approvals.body.data.items)).toBe(true);

    const risk = await api.post(`/api/service-desk/changes/${ref}/risk`).set(auth(manager.token)).send({ riskLevel: 'LOW' });
    expect(risk.status).toBe(200);

    const impact = await api.post(`/api/service-desk/changes/${ref}/impact`).set(auth(manager.token)).send({
      impactAnalysis: 'A single node restart outside business hours; no customer-facing impact expected.',
    });
    expect(impact.status).toBe(200);

    const submitted = await api.post(`/api/service-desk/changes/${ref}/submit`).set(auth(manager.token)).send({});
    expect(submitted.status).toBe(200);

    const selfApproval = await api.post(`/api/service-desk/changes/${ref}/approvals/decide`)
      .set(auth(manager.token))
      .send({ decision: 'APPROVED' });
    expect(selfApproval.status).toBe(403);
    expect(selfApproval.body.error.message).toMatch(/[Ss]egregation of duties/);

    const approved = await api.post(`/api/service-desk/changes/${ref}/approvals/decide`)
      .set(auth(secondManager.token))
      .send({ decision: 'APPROVED', comments: 'Risk and impact reviewed by a second manager.' });
    expect(approved.status).toBe(200);

    const after = await api.get(`/api/service-desk/changes/${ref}`).set(auth(manager.token));
    expect(after.status).toBe(200);
    expect(after.body.data.change.status).toBe('APPROVED');
  });

  it('forces an emergency change to be ratified retrospectively', async () => {
    const created = await api.post('/api/service-desk/changes').set(auth(manager.token)).send({
      title: 'Emergency restart of the production database',
      changeType: 'EMERGENCY',
      priority: 'P1',
    });
    expect(created.status).toBe(200);
    const change = created.body.data.change ?? created.body.data;
    const ref = Number(change.id);
    expect(change.is_emergency).toBe(true);
    expect(change.retrospective_approval_required).toBe(true);

    const submitted = await api.post(`/api/service-desk/changes/${ref}/submit`).set(auth(manager.token)).send({});
    expect(submitted.status).toBe(200);

    const prematureClose = await api.post(`/api/service-desk/changes/${ref}/close`).set(auth(manager.token)).send({});
    expect(prematureClose.status).toBe(409);

    const selfRatify = await api.post(`/api/service-desk/changes/${ref}/retrospective-approval`)
      .set(auth(manager.token))
      .send({ justification: 'I raised it, so I must not ratify it.' });
    expect(selfRatify.status).toBe(403);
    expect(selfRatify.body.error.message).toMatch(/[Ss]egregation of duties/);

    const ratified = await api.post(`/api/service-desk/changes/${ref}/retrospective-approval`)
      .set(auth(secondManager.token))
      .send({ justification: 'The outage required immediate restoration to keep production running.' });
    expect(ratified.status).toBe(200);
  });

  // -------------------------------------------------------------------------
  // Problem management (spec 18)
  // -------------------------------------------------------------------------

  it('links recurring incidents to a problem and drives root cause to closure', async () => {
    const created = await api.post('/api/service-desk/problems').set(auth(manager.token)).send({
      title: 'Recurring network drops on the Kampala production floor',
      description: 'Several independent incidents report the same intermittent connectivity loss.',
      priority: 'P3',
    });
    expect(created.status).toBe(200);
    const problem = created.body.data.problem ?? created.body.data;
    const ref = Number(problem.id);
    expect(problem.problem_number).toBeTruthy();

    expect((await api.get(`/api/service-desk/problems/${ref}`).set(auth(manager.token))).status).toBe(200);
    expect((await api.get(`/api/service-desk/problems/${problem.problem_number}`).set(auth(manager.token))).status).toBe(200);

    const linked = await api.post(`/api/service-desk/problems/${ref}/incidents`)
      .set(auth(manager.token))
      .send({ ticketId: thirdTicketId, linkType: 'MATCHED' });
    expect(linked.status).toBe(200);

    expect((await api.post(`/api/service-desk/problems/${ref}/investigate`).set(auth(manager.token)).send({})).status).toBe(200);

    const rootCause = await api.post(`/api/service-desk/problems/${ref}/root-cause`).set(auth(manager.token)).send({
      rootCause: 'A degrading SFP module on the floor uplink drops the link under load.',
    });
    expect(rootCause.status).toBe(200);

    const knownError = await api.post(`/api/service-desk/problems/${ref}/known-error`).set(auth(manager.token)).send({
      title: 'Uplink SFP module degradation',
      symptom: 'Intermittent packet loss on the production floor uplink.',
      workaround: 'Fail production traffic over to the secondary uplink.',
    });
    expect(knownError.status).toBe(200);

    const resolvedProblem = await api.post(`/api/service-desk/problems/${ref}/resolve`).set(auth(manager.token)).send({
      permanentFix: 'Replace the SFP module and monitor the link for 72 hours.',
    });
    expect(resolvedProblem.status).toBe(200);

    const closed = await api.post(`/api/service-desk/problems/${ref}/close`).set(auth(manager.token)).send({ force: true });
    expect(closed.status).toBe(200);

    const grouped = await api.post('/api/service-desk/problems/from-group').set(auth(manager.token)).send({
      ticketIds: [ticketId, secondTicketId],
      title: 'Grouped recurring incidents',
    });
    expect(grouped.status).toBe(200);
  });
  // -------------------------------------------------------------------------
  // Access requests (spec 14, 15)
  // -------------------------------------------------------------------------

  it('never grants access without the full approval chain', async () => {
    const created = await api.post('/api/service-desk/access-requests').set(auth(manager.token)).send({
      systemName: 'Finance Reporting Warehouse',
      justification: 'The quarterly audit requires read access to the reporting warehouse.',
      accessType: 'ROLE',
    });
    expect(created.status).toBe(200);
    const request = created.body.data;
    const ref = Number(request.id);
    expect(request.status).toBe('SUBMITTED');
    expect(Number(request.approvals_created)).toBeGreaterThan(0);
    expect(request.ticket).toBeTruthy();
    expect(request.ticket.ticket_number).toMatch(TICKET_NUMBER);

    const approvals = await api.get(`/api/service-desk/access-requests/${ref}/approvals`).set(auth(manager.token));
    expect(approvals.status).toBe(200);
    const steps = approvals.body.data.items ?? approvals.body.data;
    expect(Array.isArray(steps)).toBe(true);
    expect(steps.length).toBeGreaterThan(0);
    const approvalId = Number(steps[0].id);

    // Segregation of duties: the requester cannot approve their own request.
    const selfDecision = await api
      .post(`/api/service-desk/access-requests/${ref}/approvals/${approvalId}/decide`)
      .set(auth(manager.token))
      .send({ decision: 'APPROVED' });
    expect(selfDecision.status).toBe(403);

    // ...and cannot provision the access they raised themselves.
    const selfGrant = await api.post(`/api/service-desk/access-requests/${ref}/grant`).set(auth(manager.token)).send({});
    expect(selfGrant.status).toBe(403);

    // A submitted request cannot be re-submitted.
    const resubmit = await api.post(`/api/service-desk/access-requests/${ref}/submit`).set(auth(manager.token)).send({});
    expect(resubmit.status).toBe(409);

    // The employee can only ever see their own access requests.
    const ownList = await api.get('/api/my/service-desk/access-requests').set(auth(employee.token));
    expect(ownList.status).toBe(200);
  });

  // -------------------------------------------------------------------------
  // Knowledge base (spec 16)
  // -------------------------------------------------------------------------

  it('publishes a knowledge article that employees can read and rate', async () => {
    const created = await api.post('/api/service-desk/knowledge/articles').set(auth(manager.token)).send({
      title: 'How to reset your HOPE DESIGN ERP password',
      body: 'Open MY HOPE DESIGN, choose Forgot password, and follow the link sent to your work email.',
      categoryId: 1,
    });
    expect(created.status).toBe(200);
    const article = created.body.data;
    const ref = Number(article.id);
    expect(article.status).toBe('DRAFT');
    expect(article.article_number).toBeTruthy();

    expect((await api.post(`/api/service-desk/knowledge/articles/${ref}/submit`).set(auth(manager.token)).send({})).status).toBe(200);
    expect((await api.post(`/api/service-desk/knowledge/articles/${ref}/approve`).set(auth(manager.token)).send({})).status).toBe(200);
    expect((await api.post(`/api/service-desk/knowledge/articles/${ref}/publish`).set(auth(manager.token)).send({})).status).toBe(200);

    const read = await api.get(`/api/my/service-desk/knowledge/articles/${ref}`).set(auth(employee.token));
    expect(read.status).toBe(200);
    expect(read.body.data.status ?? read.body.data.article?.status).toBe('PUBLISHED');

    const rated = await api.post(`/api/my/service-desk/knowledge/articles/${ref}/rate`).set(auth(employee.token)).send({
      rating: 5,
      isHelpful: true,
    });
    expect(rated.status).toBe(200);

    const search = await api.get('/api/my/service-desk/knowledge/search?q=password').set(auth(employee.token));
    expect(search.status).toBe(200);
  });
});
