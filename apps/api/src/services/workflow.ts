import pg from 'pg';
import { createHash } from 'node:crypto';
import { Ctx } from '../db.js';
import { ApprovalStep } from '../types.js';
import { badRequest, forbidden, notFound } from '../utils.js';
import { ENTITIES } from './entities.js';
import { emitEvent } from './events.js';
import { notifyUserAdvanced, notifyRoleAdvanced } from './communication.js';
import { logAudit } from './audit.js';
import * as payrollLifecycle from './payrollLifecycle.js';

interface StartWorkflowInput {
  entityType: string;
  entityId: number;
  entityCode?: string | null;
  amount?: number;
  companyId?: number | null;
  branchId?: number | null;
}

/**
 * Final-authority roles whose submissions self-authorize: the document is
 * approved and posted/released immediately, with no approval chain. Deliberate
 * product policy — these roles are treated as equivalent sign-off authorities.
 * Extend the bypass by adding a role code here; removing one closes it back.
 */
const SELF_AUTHORIZE_ROLES = ['super_administrator', 'managing_director', 'executive_director', 'ceo'];

const WORKFLOW_SQL = `
  SELECT id, code, name, entity_type, config FROM workflows
  WHERE company_id = $1 AND tenant_id = $2 AND entity_type = $3 AND is_active = true
    AND status = 'PUBLISHED'
    AND (effective_from IS NULL OR effective_from <= CURRENT_DATE)
`;

/**
 * Columns that never participate in the material snapshot: identity, tenancy,
 * audit timestamps and every lifecycle/posting field the workflow engine itself
 * owns. Anything else (amounts, parties, dates, quantities, line metadata) is
 * treated as material and invalidates a standing approval when it changes.
 */
const MATERIAL_EXCLUDED = new Set([
  'id', 'created_at', 'updated_at', 'created_by', 'updated_by',
  'company_id', 'tenant_id', 'branch_id',
  'status',
  'approved_by', 'approved_at', 'rejected_by', 'rejected_at',
  'submitted_by', 'submitted_at', 'cancelled_by', 'cancelled_at',
  'voided_by', 'voided_at', 'posted_by', 'posted_at',
  'closed_by', 'closed_at', 'completed_by', 'completed_at',
  'released_by', 'released_at',
  'gl_posted', 'gl_journal_id', 'amount_paid', 'three_way_matched',
]);

/**
 * Run the post-approval side effect configured for an entity type.
 * `post` posts financial/inventory side effects; `release` releases payments.
 * Called inside the caller's transaction so failures roll back atomically.
 */
async function runApprovalSideEffect(client: pg.PoolClient, ctx: Ctx, entityType: string, entityId: number) {
  const entity = ENTITIES[entityType];
  if (!entity || !entity.onApprove || entity.onApprove === 'none') return;
  const finance = await import('./finance.js');
  const inventory = await import('./inventory.js');
  const assets = await import('./assets.js');
  if (entity.onApprove === 'post') {
    switch (entityType) {
      case 'sales.invoices':
        await finance.postSalesInvoice(client, ctx, entityId);
        break;
      case 'sales.credit_notes':
        await finance.postCreditNote(client, ctx, entityId);
        break;
      case 'sales.debit_notes':
        await finance.postDebitNote(client, ctx, entityId);
        break;
      case 'procurement.supplier_invoices':
        await finance.postSupplierInvoice(client, ctx, entityId);
        break;
      case 'inventory.adjustments':
        await inventory.postAdjustment(client, ctx, entityId);
        break;
      case 'inventory.transfers':
        await inventory.completeTransfer(client, ctx, entityId);
        break;
      case 'assets.transfers':
        await assets.approveTransfer(client, ctx, entityId);
        break;
      case 'assets.disposals':
        await assets.approveDisposal(client, ctx, entityId);
        break;
      case 'assets.impairments':
        await assets.approveImpairment(client, ctx, entityId);
        break;
      case 'assets.maintenance':
        await assets.approveMaintenance(client, ctx, entityId);
        break;
      default:
        break;
    }
  } else if (entity.onApprove === 'release') {
    if (entityType === 'procurement.payments') {
      await finance.postSupplierPayment(client, ctx, entityId);
    }
  }
}

/**
 * A stable hash of the fields an approver actually signs off on. Two documents
 * that differ only in identity/tenancy/audit/posting fields hash identically;
 * any material edit changes the hash, which invalidates a standing approval.
 */
export async function computeMaterialHash(
  client: pg.PoolClient,
  ctx: Ctx,
  entityType: string,
  entityId: number
): Promise<string | null> {
  const entity = ENTITIES[entityType];
  if (!entity) return null;
  const res = await client.query(`SELECT * FROM ${entity.table} WHERE id = $1`, [entityId]);
  if (res.rows.length === 0) return null;
  const row = res.rows[0] as Record<string, unknown>;
  const material: Record<string, unknown> = {};
  for (const key of Object.keys(row).sort()) {
    if (!MATERIAL_EXCLUDED.has(key)) material[key] = row[key];
  }
  return createHash('sha256').update(JSON.stringify(material)).digest('hex');
}

/**
 * Cancel every open instance of an entity whose stored material snapshot no
 * longer matches `newHash`, and return the document to its pre-submit status so
 * it can be corrected and resubmitted. Call this after any material edit.
 */
export async function invalidateStaleApproval(
  client: pg.PoolClient,
  ctx: Ctx,
  entityType: string,
  entityId: number,
  newHash: string | null
): Promise<boolean> {
  if (newHash === null) return false;
  const open = await client.query(
    `SELECT id FROM workflow_instances
     WHERE entity_type = $1 AND entity_id = $2
       AND status IN ('RUNNING', 'ESCALATED', 'EXECUTION_PENDING')
       AND material_hash IS DISTINCT FROM $3
     FOR UPDATE`,
    [entityType, entityId, newHash]
  );
  if (open.rows.length === 0) return false;
  for (const row of open.rows) {
    await client.query(
      `UPDATE workflow_instances SET status = 'CANCELLED', completed_at = now() WHERE id = $1`,
      [row.id]
    );
  }
  const entity = ENTITIES[entityType];
  const draftStatus = entity?.draftStatus ?? 'DRAFT';
  await client.query(
    `UPDATE ${entity.table} SET ${entity.statusColumn} = $2 WHERE id = $1`,
    [entityId, draftStatus]
  );
  await emitEvent(client, ctx, {
    eventType: `${entityType.replace('.', '_')}.approval_invalidated`,
    entityType,
    entityId,
    payload: { reason: 'Document changed after submission' },
  });
  return true;
}

/**
 * A delegate may approve only inside their delegation's authority: an active
 * window, an amount ceiling, and (when the delegation enumerates transaction
 * authorities) a matching can_approve authority for the document type.
 */
async function enforceDelegationLimits(
  client: pg.PoolClient,
  delegation: { id: number; approval_limit: number | null },
  entityType: string,
  amount: number | null
) {
  if (amount != null && delegation.approval_limit != null && amount > Number(delegation.approval_limit)) {
    throw forbidden(`Delegation approval limit ${delegation.approval_limit} is below the document amount ${amount}`);
  }
  const hasAuthorities = await client.query(
    `SELECT 1 FROM delegation_authorities WHERE delegation_id = $1 LIMIT 1`,
    [delegation.id]
  );
  if (hasAuthorities.rows.length === 0) return;
  const covered = await client.query(
    `SELECT 1 FROM delegation_authorities
     WHERE delegation_id = $1 AND can_approve = true
       AND (transaction_type = $2 OR transaction_type = '*')
       AND (max_amount IS NULL OR $3::numeric IS NULL OR $3::numeric <= max_amount)
     LIMIT 1`,
    [delegation.id, entityType, amount]
  );
  if (covered.rows.length === 0) {
    throw forbidden('This delegation does not authorise approving this transaction type or amount');
  }
}

/**
 * Return the self-authorizing role code the submitter holds for this company, or
 * null. Scoped to the document's company so a role held only elsewhere does not
 * authorize this submission. Fails closed: no match means the normal workflow.
 */
async function selfAuthorizeRole(
  client: pg.PoolClient,
  companyId: number | null,
  ctx: Ctx
): Promise<string | null> {
  if (!ctx.userId || !companyId) return null;
  const res = await client.query(
    `SELECT r.code FROM user_roles ur JOIN roles r ON r.id = ur.role_id
     WHERE ur.user_id = $1 AND r.code = ANY($2::text[]) AND r.company_id = $3
     LIMIT 1`,
    [ctx.userId, SELF_AUTHORIZE_ROLES, companyId]
  );
  return res.rows.length ? String(res.rows[0].code) : null;
}

/**
 * Self-authorize a submission by a final-authority role: mark the document
 * approved and run its post/release side effect immediately, with no approval
 * chain. The act is audited and emitted so the bypass is always traceable.
 * Payroll and security printing carry their own lifecycle/dual-control logic,
 * so they are dispatched to their own modules rather than a bare status flip.
 */
async function selfAuthorize(
  client: pg.PoolClient,
  ctx: Ctx,
  input: StartWorkflowInput,
  roleCode: string
): Promise<void> {
  const entity = ENTITIES[input.entityType];
  if (!entity) throw badRequest(`Unknown workflow entity ${input.entityType}`);

  if (input.entityType === 'security_printing.jobs') {
    const sec = await import('./securityPrinting.js');
    await sec.selfAuthorizeSecureJob(client, ctx, input.entityId);
  } else if (input.entityType === 'hr.payrolls') {
    await payrollLifecycle.recordWorkflowDecision(client, ctx, {
      payrollId: input.entityId,
      approved: true,
    });
  } else {
    await client.query(
      `UPDATE ${entity.table} SET ${entity.statusColumn} = $1 WHERE id = $2`,
      [entity.approvedStatus, input.entityId]
    );
    await runApprovalSideEffect(client, ctx, input.entityType, input.entityId);
  }

  await logAudit(client, ctx, {
    action: 'self_authorized',
    resource: 'approvals',
    recordId: input.entityId,
    recordCode: input.entityCode,
    metadata: { entityType: input.entityType, role: roleCode, reason: 'Self-authorized by final authority' },
  });
  await emitEvent(client, ctx, {
    eventType: `${input.entityType.replace('.', '_')}.self_authorized`,
    entityType: input.entityType,
    entityId: input.entityId,
    entityCode: input.entityCode,
    payload: { role: roleCode, reason: 'Self-authorized by final authority' },
  });
}

/** Start the configured workflow for an entity and create the first approval task. */
export async function startWorkflow(client: pg.PoolClient, ctx: Ctx, input: StartWorkflowInput) {
  const companyId = input.companyId ?? ctx.companyId ?? null;
  if (!companyId) throw badRequest('Company is required to start a workflow');

  // Approval-free by explicit policy: skip the workflow engine entirely. This is
  // a deliberate per-entity configuration, not the accidental outcome of a
  // missing workflow row.
  const policyEntity = ENTITIES[input.entityType];
  if (policyEntity && policyEntity.requiresApproval === false) {
    await client.query(
      `UPDATE ${policyEntity.table} SET ${policyEntity.statusColumn} = $1 WHERE id = $2`,
      [policyEntity.approvedStatus, input.entityId]
    );
    await runApprovalSideEffect(client, ctx, input.entityType, input.entityId);
    await emitEvent(client, ctx, {
      eventType: `${input.entityType.replace('.', '_')}.auto_approved`,
      entityType: input.entityType,
      entityId: input.entityId,
      entityCode: input.entityCode,
      payload: { reason: 'Approval-free by policy' },
    });
    return null;
  }

  // Role-based self-authorization: a final-authority role signs and posts its
  // own submission immediately, so no workflow — nor even a configured one — is
  // consulted. Evaluated after the entity-policy skip so quotations keep their
  // existing approval-free behavior for everyone.
  const selfRole = await selfAuthorizeRole(client, companyId, ctx);
  if (selfRole) {
    await selfAuthorize(client, ctx, input, selfRole);
    return null;
  }

  const wfRes = await client.query(WORKFLOW_SQL, [companyId, ctx.tenantId, input.entityType]);
  const wf = wfRes.rows[0];
  if (!wf) {
    // Fail closed: a missing workflow is a configuration error, not an
    // auto-approval. The only sanctioned exemption — requiresApproval === false —
    // is handled above, so reaching here always means the administrator must
    // configure a workflow before this document can be submitted.
    throw badRequest(
      `No approval workflow is configured for ${input.entityType}; an administrator must configure one before this document can be submitted`
    );
  }

  const steps: ApprovalStep[] = (wf.config as unknown as ApprovalStep[]) ?? [];
  const applicable = steps.filter((s) => {
    if (s.amount_min !== undefined && (input.amount ?? 0) < s.amount_min) return false;
    if (s.amount_max !== undefined && s.amount_max > 0 && (input.amount ?? 0) > s.amount_max) return false;
    return true;
  });
  if (applicable.length === 0) {
    // A workflow exists but no step covers this amount. Auto-approving here would
    // let documents silently skip approval whenever the config band is wrong, so
    // fail closed and surface the misconfiguration to an administrator instead.
    throw badRequest(
      `No approval step covers amount ${input.amount ?? 0} for ${input.entityType}; an administrator must fix the workflow configuration`
    );
  }

  const materialHash = await computeMaterialHash(client, ctx, input.entityType, input.entityId);
  const instanceRes = await client.query(
    `INSERT INTO workflow_instances
       (company_id, tenant_id, workflow_id, entity_type, entity_id, entity_code, current_step, created_by, amount, material_hash)
     VALUES ($1,$2,$3,$4,$5,$6,1,$7,$8,$9) RETURNING id`,
    [companyId, ctx.tenantId, wf.id, input.entityType, input.entityId, input.entityCode ?? null, ctx.userId ?? null, input.amount ?? null, materialHash]
  );
  const instanceId = Number(instanceRes.rows[0].id);

  const roleIds = new Map<string, number>();
  const roleRes = await client.query(`SELECT id, code FROM roles WHERE company_id = $1`, [companyId]);
  for (const r of roleRes.rows) roleIds.set(String(r.code), Number(r.id));

  const slaHours = applicable[0].sla_hours ?? 48;
  for (const step of applicable) {
    const roleCodes = step.approver_roles?.length
      ? step.approver_roles
      : step.approver_role
        ? [step.approver_role]
        : [];
    const approverRoleId = roleCodes[0] ? (roleIds.get(roleCodes[0]) ?? null) : null;
    const alternativeRoleId = roleCodes[1] ? (roleIds.get(roleCodes[1]) ?? null) : null;
    // Fail closed: a step that names a role which does not exist for this
    // company would otherwise create an unassigned task that any approver could
    // decide. Surface the misconfiguration instead.
    if (roleCodes.length && approverRoleId === null && alternativeRoleId === null) {
      throw badRequest(
        `Approval step "${step.name}" references role(s) ${roleCodes.join(', ')} that do not exist for this company`
      );
    }
    await client.query(
      `INSERT INTO approval_tasks
         (instance_id, step_seq, step_name, approver_role_id, alternative_role_id, approver_user_id, status, due_at)
       VALUES ($1,$2,$3,$4,$5,$6,'PENDING', now() + ($7 || ' hours')::interval)`,
      [instanceId, step.seq, step.name, approverRoleId, alternativeRoleId, step.approver_user ?? null, slaHours]
    );
  }

  await emitEvent(client, ctx, {
    eventType: `${input.entityType.replace('.', '_')}.submitted`,
    entityType: input.entityType,
    entityId: input.entityId,
    entityCode: input.entityCode,
    payload: { instanceId, workflow: wf.code, steps: applicable.map((s) => s.name) },
  });

  const approverRoles = applicable
    .flatMap((s) => (s.approver_roles?.length ? s.approver_roles : s.approver_role ? [s.approver_role] : []))
    .filter(Boolean) as string[];
  if (approverRoles.length) {
    await notifyRoleAdvanced(client, ctx, approverRoles, {
      type: 'APPROVAL_REQUEST',
      title: `Approval required: ${wf.name}`,
      body: `${input.entityCode ?? `#${input.entityId}`} is awaiting ${applicable[0].name}`,
      link: `/${input.entityType}/${input.entityId}`,
      entityType: input.entityType,
      entityId: input.entityId,
      severity: 'WARN',
      actionRequired: true,
    });
  }

  return instanceId;
}

/** Complete the workflow (all steps approved) and run entity side-effects. */
export async function completeWorkflow(client: pg.PoolClient, ctx: Ctx, instanceId: number) {
  const instRes = await client.query(
    `SELECT i.*, w.code AS workflow_code FROM workflow_instances i
     JOIN workflows w ON w.id = i.workflow_id WHERE i.id = $1 FOR UPDATE OF i`,
    [instanceId]
  );
  const inst = instRes.rows[0];
  if (!inst) throw notFound('Workflow instance not found');
  const entity = ENTITIES[String(inst.entity_type)];
  const isSecurity = String(inst.entity_type) === 'security_printing.jobs';
  const isPayroll = String(inst.entity_type) === 'hr.payrolls';
  // Approval is separated from execution for documents whose approval side
  // effect moves money or stock. Those are left EXECUTION_PENDING after every
  // step signs, and a separate permissioned execute step posts/releases them.
  const needsExecution =
    !!entity && (entity.onApprove === 'post' || entity.onApprove === 'release') && !isSecurity && !isPayroll;

  if (needsExecution) {
    await client.query(
      `UPDATE workflow_instances SET status = 'EXECUTION_PENDING' WHERE id = $1`,
      [instanceId]
    );
    await client.query(
      `UPDATE ${entity!.table} SET ${entity!.statusColumn} = $1 WHERE id = $2`,
      [entity!.approvedStatus, Number(inst.entity_id)]
    );
  } else {
    await client.query(
      `UPDATE workflow_instances SET status = 'APPROVED', completed_at = now() WHERE id = $1`,
      [instanceId]
    );
    // Security jobs drive their own stepwise status transitions inside the
    // securityPrinting service (approval vs materials authorization), so the
    // generic status update + side effect must be skipped for them.
    if (entity && !isSecurity) {
      if (isPayroll) {
        // Payroll approvals carry the full lifecycle evidence (status history,
        // decision, lock, audit) through the payroll lifecycle service instead of
        // the bare status update used by document-style entities.
        await payrollLifecycle.recordWorkflowDecision(client, ctx, {
          payrollId: Number(inst.entity_id),
          approved: true,
        });
      } else {
        await client.query(
          `UPDATE ${entity.table} SET ${entity.statusColumn} = $1 WHERE id = $2`,
          [entity.approvedStatus, Number(inst.entity_id)]
        );
        await runApprovalSideEffect(client, ctx, String(inst.entity_type), Number(inst.entity_id));
      }
    }
  }
  await emitEvent(client, ctx, {
    eventType: `${String(inst.entity_type).replace('.', '_')}.approved`,
    entityType: inst.entity_type,
    entityId: inst.entity_id,
    entityCode: inst.entity_code,
    payload: { instanceId, workflow: inst.workflow_code, executionPending: needsExecution },
  });
  await notifyRoleAdvanced(client, ctx, ['system_administrator'], {
    type: 'APPROVAL_RESULT',
    title: 'Workflow approved',
    body: `${inst.entity_code ?? `#${inst.entity_id}`} was approved`,
    link: `/${inst.entity_type}/${inst.entity_id}`,
    entityType: inst.entity_type,
    entityId: inst.entity_id,
    severity: 'SUCCESS',
  });
  const submitterId = Number(inst.created_by);
  if (submitterId > 0) {
    await notifyUserAdvanced(client, ctx, submitterId, {
      type: 'APPROVAL_RESULT',
      title: 'Your request was approved',
      body: `${inst.entity_code ?? `#${inst.entity_id}`} was approved`,
      entityType: inst.entity_type,
      entityId: inst.entity_id,
      severity: 'SUCCESS',
    });
  }
}

/**
 * Execute a fully approved workflow: run the post/release side effect that
 * approval deliberately deferred, and mark the instance EXECUTED. Segregation
 * of duties is enforced here - whoever approved the document may not execute it.
 */
export async function executeWorkflow(client: pg.PoolClient, ctx: Ctx, instanceId: number) {
  const user = ctx.userId;
  if (!user) throw forbidden();
  const instRes = await client.query(
    `SELECT i.*, w.code AS workflow_code FROM workflow_instances i
     JOIN workflows w ON w.id = i.workflow_id WHERE i.id = $1 FOR UPDATE OF i`,
    [instanceId]
  );
  const inst = instRes.rows[0];
  if (!inst) throw notFound('Workflow instance not found');
  if (inst.status !== 'EXECUTION_PENDING') {
    throw badRequest(`Workflow is ${inst.status}, not awaiting execution`);
  }
  const entity = ENTITIES[String(inst.entity_type)];
  if (!entity || (entity.onApprove !== 'post' && entity.onApprove !== 'release')) {
    throw badRequest('This workflow has no execution side effect');
  }
  const decided = await client.query(
    `SELECT 1 FROM approval_tasks WHERE instance_id = $1 AND decided_by = $2 LIMIT 1`,
    [instanceId, user]
  );
  if (decided.rows.length > 0) {
    throw forbidden('Segregation of duties: you approved this document and may not execute it');
  }
  await runApprovalSideEffect(client, ctx, String(inst.entity_type), Number(inst.entity_id));
  await client.query(
    `UPDATE workflow_instances SET status = 'EXECUTED', completed_at = now(), executed_by = $2, executed_at = now()
     WHERE id = $1`,
    [instanceId, user]
  );
  await emitEvent(client, ctx, {
    eventType: `${String(inst.entity_type).replace('.', '_')}.executed`,
    entityType: inst.entity_type,
    entityId: inst.entity_id,
    entityCode: inst.entity_code,
    payload: { instanceId, workflow: inst.workflow_code },
  });
  const submitterId = Number(inst.created_by);
  if (submitterId > 0) {
    await notifyUserAdvanced(client, ctx, submitterId, {
      type: 'APPROVAL_RESULT',
      title: 'Your request was executed',
      body: `${inst.entity_code ?? `#${inst.entity_id}`} was executed`,
      entityType: inst.entity_type,
      entityId: inst.entity_id,
      severity: 'SUCCESS',
    });
  }
  return { status: 'EXECUTED' };
}

export async function rejectWorkflow(client: pg.PoolClient, ctx: Ctx, instanceId: number, comment?: string) {
  const instRes = await client.query(
    `SELECT i.*, w.code AS workflow_code FROM workflow_instances i
     JOIN workflows w ON w.id = i.workflow_id WHERE i.id = $1`,
    [instanceId]
  );
  const inst = instRes.rows[0];
  if (!inst) throw notFound('Workflow instance not found');
  await client.query(
    `UPDATE workflow_instances SET status = 'REJECTED', completed_at = now() WHERE id = $1`,
    [instanceId]
  );
  await client.query(
    `UPDATE approval_tasks SET status = 'REJECTED', comment = $2, decided_at = now()
     WHERE instance_id = $1 AND status IN ('PENDING','ESCALATED')`,
    [instanceId, comment ?? null]
  );
  const entity = ENTITIES[String(inst.entity_type)];
  if (entity) {
    if (String(inst.entity_type) === 'hr.payrolls') {
      const recorded = await payrollLifecycle.recordWorkflowDecision(client, ctx, {
        payrollId: Number(inst.entity_id),
        approved: false,
        comment: comment ?? null,
      });
      if (!recorded) {
        await client.query(
          `UPDATE ${entity.table} SET ${entity.statusColumn} = $1 WHERE id = $2`,
          [entity.rejectedStatus, Number(inst.entity_id)]
        );
      }
    } else {
      await client.query(
        `UPDATE ${entity.table} SET ${entity.statusColumn} = $1 WHERE id = $2`,
        [entity.rejectedStatus, Number(inst.entity_id)]
      );
    }
  }
  await emitEvent(client, ctx, {
    eventType: `${String(inst.entity_type).replace('.', '_')}.rejected`,
    entityType: inst.entity_type,
    entityId: inst.entity_id,
    entityCode: inst.entity_code,
    payload: { instanceId, comment },
    severity: 'WARN',
  });
  const submitterId = Number(inst.created_by);
  if (submitterId > 0) {
    await notifyUserAdvanced(client, ctx, submitterId, {
      type: 'APPROVAL_RESULT',
      title: 'Your request was rejected',
      body: `${inst.entity_code ?? `#${inst.entity_id}`} was rejected${comment ? `: ${comment}` : ''}`,
      entityType: inst.entity_type,
      entityId: inst.entity_id,
      severity: 'ERROR',
    });
  }
}

/** Decide on a single approval task. */
export async function decideTask(
  client: pg.PoolClient,
  ctx: Ctx,
  taskId: number,
  decision: 'APPROVED' | 'REJECTED' | 'RETURNED' | 'DELEGATED',
  comment?: string,
  delegateToUserId?: number
) {
  const user = ctx.userId;
  if (!user) throw forbidden();
  if ((decision === 'REJECTED' || decision === 'RETURNED') && !comment?.trim()) {
    throw badRequest('A reason is required when rejecting or returning a request');
  }
  // Lock the task AND its instance: the completion check ("no PENDING left") and
  // the status flip must be atomic with the decision, otherwise two concurrent
  // decisions can each see the other task still PENDING and neither completes.
  const taskRes = await client.query(
    `SELECT t.*, i.entity_type, i.entity_id, i.entity_code, i.current_step, i.workflow_id, i.amount,
            r.code AS role_code, ar.code AS alternative_role_code
     FROM approval_tasks t
     JOIN workflow_instances i ON i.id = t.instance_id
     LEFT JOIN roles r ON r.id = t.approver_role_id
     LEFT JOIN roles ar ON ar.id = t.alternative_role_id
     WHERE t.id = $1 AND i.tenant_id = $2 AND ($3::bigint IS NULL OR i.company_id = $3)
     FOR UPDATE OF t, i`,
    [taskId, ctx.tenantId, ctx.companyId ?? null]
  );
  const task = taskRes.rows[0];
  if (!task) throw notFound('Approval task not found');
  // ESCALATED is still an open, awaiting-decision state (a task the escalation
  // cron flagged for senior review), so it remains decidable here.
  if (task.status !== 'PENDING' && task.status !== 'ESCALATED') throw badRequest(`Task is already ${task.status}`);

  // Verify the deciding user is an authorized approver (role or direct assignee)
  if (task.approver_user_id && Number(task.approver_user_id) !== user) throw forbidden('Not your approval task');
  const roleCodes = [task.role_code, task.alternative_role_code].filter(
    (c: unknown): c is string => typeof c === 'string' && c.length > 0
  );
  // Fail closed on a dangling task: no direct assignee and no resolvable role
  // would otherwise be decidable by any holder of the generic approve permission.
  if (task.approver_user_id == null && task.approver_role_id == null && task.alternative_role_id == null) {
    throw forbidden('Approval task has no assignee; an administrator must fix the workflow configuration');
  }
  let delegationId: number | null = null;
  if (roleCodes.length) {
    const roleCheck = await client.query(
      `SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id
       WHERE ur.user_id = $1 AND r.code = ANY($2::text[]) LIMIT 1`,
      [user, roleCodes]
    );
    if (roleCheck.rows.length === 0) {
      // Not a permanent holder of the approver role: the user may be acting
      // under an active delegation. Resolve it here (re-checking ACTIVE + window
      // at decision time) and enforce that delegation's amount/type authority.
      const del = await client.query(
        `SELECT d.id, d.approval_limit FROM delegations d
         JOIN roles r ON r.id = d.temporary_role_id
         WHERE d.delegate_user_id = $1 AND d.tenant_id = $2 AND d.status = 'ACTIVE'
           AND d.starts_at <= now() AND d.expires_at > now()
           AND r.code = ANY($3::text[])
         LIMIT 1`,
        [user, ctx.tenantId, roleCodes]
      );
      if (del.rows.length === 0) throw forbidden(`Requires role ${roleCodes.join(' or ')}`);
      delegationId = Number(del.rows[0].id);
      await enforceDelegationLimits(
        client,
        { id: delegationId, approval_limit: del.rows[0].approval_limit as number | null },
        String(task.entity_type),
        task.amount == null ? null : Number(task.amount)
      );
    }
  }

  // Segregation of duties: the creator/requester of an entity may not decide on
  // their own submission. Delegation is exempt so an owner-approver can hand the
  // task to someone else instead of being deadlocked.
  if (decision !== 'DELEGATED') {
    const entity = ENTITIES[String(task.entity_type)];
    if (entity?.ownerColumn) {
      const ownerRes = await client.query(
        `SELECT ${entity.ownerColumn} AS owner_id FROM ${entity.table} WHERE id = $1`,
        [Number(task.entity_id)]
      );
      const ownerId = ownerRes.rows[0] ? Number(ownerRes.rows[0].owner_id) : null;
      if (ownerId && ownerId === user) {
        throw forbidden('Segregation of duties: you cannot decide on your own submission');
      }
    }
  }

  if (decision === 'DELEGATED') {
    if (!delegateToUserId) throw badRequest('delegateToUserId is required');
    await client.query(
      `UPDATE approval_tasks SET status = 'DELEGATED', comment = $2, decided_by = $3, decided_at = now(), delegated_from = $3
       WHERE id = $1`,
      [taskId, comment ?? null, user]
    );
    await client.query(
      `INSERT INTO approval_tasks
         (instance_id, step_seq, step_name, approver_role_id, approver_user_id, status, due_at, delegated_from)
       VALUES ($1,$2,$3,NULL,$4,'PENDING', now() + interval '48 hours', $5)`,
      [task.instance_id, task.step_seq, task.step_name, delegateToUserId, user]
    );
    await notifyUserAdvanced(client, ctx, delegateToUserId, {
      type: 'APPROVAL_REQUEST',
      title: `Delegated approval: ${task.step_name}`,
      body: `Task delegated to you for ${task.entity_code ?? `#${task.entity_id}`}`,
      entityType: task.entity_type,
      entityId: task.entity_id,
      actionRequired: true,
      severity: 'WARN',
    });
    return { status: 'DELEGATED' };
  }

  await client.query(
    `UPDATE approval_tasks SET status = $2, comment = $3, decided_by = $4, decided_at = now(), delegation_id = $5
     WHERE id = $1`,
    [taskId, decision, comment ?? null, user, delegationId]
  );
  await logAudit(client, ctx, {
    action: decision.toLowerCase(),
    resource: 'approvals',
    recordId: taskId,
    recordCode: task.entity_code,
    newValues: { decision, comment },
    metadata: { entityType: task.entity_type, entityId: task.entity_id },
  });

  // Security printing: step 1 = job approval, step 2 = materials authorization.
  // The service applies the exact status transition + custody event atomically.
  if (String(task.entity_type) === 'security_printing.jobs' && decision === 'APPROVED') {
    const sec = await import('./securityPrinting.js');
    await sec.handleSecureJobTaskApproved(client, ctx, Number(task.entity_id), Number(task.step_seq));
  }

  // Approval stages are sequential: a later stage may not be decided while an
  // earlier stage of the same chain is still awaiting a decision. Without this
  // an approver could clear the final stage first, which would complete the
  // chain and release the document with the earlier sign-offs never given.
  // Evaluated after the security-printing hook so the more specific
  // dual-control rule still reports first for security_printing.jobs.
  const earlierPendingRes = await client.query(
    `SELECT 1 FROM approval_tasks
     WHERE instance_id = $1 AND step_seq < $2 AND status IN ('PENDING','ESCALATED')
     LIMIT 1`,
    [task.instance_id, task.step_seq]
  );
  if (earlierPendingRes.rows.length > 0) {
    throw forbidden('Approval out of order: an earlier step on this approval chain has not been decided');
  }

  // Segregation of duties: one person may not carry the same approval chain
  // through more than one stage. A user holding two role codes that appear on
  // different steps (for example managing_director and operations_manager)
  // would otherwise be able to clear both the verification and the final
  // approval on the same document. Delegating to another user remains the
  // documented escape hatch when a stage's approver pool is exhausted.
  //
  // Evaluated after the security-printing hook so the more specific
  // dual-control rule reports first for security_printing.jobs; a throw here
  // still rolls the whole decision back because the caller wraps decideTask
  // in a single transaction.
  const priorStepRes = await client.query(
    `SELECT 1 FROM approval_tasks
     WHERE instance_id = $1 AND decided_by = $2 AND step_seq < $3
        AND status IN ('APPROVED', 'REJECTED', 'RETURNED')
     LIMIT 1`,
    [task.instance_id, user, task.step_seq]
  );
  if (priorStepRes.rows.length > 0) {
    throw forbidden('Segregation of duties: you have already decided an earlier step on this approval chain');
  }

  if (decision === 'REJECTED' || decision === 'RETURNED') {
    await rejectWorkflow(client, ctx, task.instance_id, comment);
    await notifyRoleAdvanced(client, ctx, ['system_administrator'], {
      type: 'APPROVAL_RESULT',
      title: `Workflow ${decision.toLowerCase()}`,
      body: `${task.entity_code ?? `#${task.entity_id}`} was ${decision.toLowerCase()}${comment ? `: ${comment}` : ''}`,
      entityType: task.entity_type,
      entityId: task.entity_id,
      severity: 'ERROR',
    });
    return { status: decision };
  }

  // Approved: check whether all steps are done
  const remaining = await client.query(
    `SELECT count(*)::int AS n FROM approval_tasks
     WHERE instance_id = $1 AND status IN ('PENDING','ESCALATED')`,
    [task.instance_id]
  );
  if (Number(remaining.rows[0].n) === 0) {
    await completeWorkflow(client, ctx, Number(task.instance_id));
    return { status: 'APPROVED', completed: true };
  }
  await client.query(
    `UPDATE workflow_instances SET current_step = current_step + 1 WHERE id = $1`,
    [task.instance_id]
  );
  const next = await client.query(
    `SELECT t.approver_user_id, r.code AS role_code, ar.code AS alternative_role_code, t.step_name
       FROM approval_tasks t
       LEFT JOIN roles r ON r.id = t.approver_role_id
       LEFT JOIN roles ar ON ar.id = t.alternative_role_id
      WHERE t.instance_id = $1 AND t.status IN ('PENDING','ESCALATED')
      ORDER BY t.step_seq
      LIMIT 1`,
    [task.instance_id]
  );
  if (next.rows[0]) {
    const n = next.rows[0];
    const payload = {
      type: 'APPROVAL_REQUEST' as const,
      title: `Approval required: ${n.step_name}`,
      body: `${task.entity_code ?? `#${task.entity_id}`} is awaiting ${n.step_name}`,
      entityType: String(task.entity_type),
      entityId: Number(task.entity_id),
      actionRequired: true,
      severity: 'WARN' as const,
    };
    if (n.approver_user_id) {
      await notifyUserAdvanced(client, ctx, Number(n.approver_user_id), payload);
    } else {
      const codes = [n.role_code, n.alternative_role_code].filter(
        (c: unknown): c is string => typeof c === 'string' && c.length > 0
      );
      if (codes.length) await notifyRoleAdvanced(client, ctx, codes, payload);
    }
  }
  return { status: 'APPROVED', completed: false };
}

/** Why a visible approval row cannot be decided by the caller right now. */
export type ApprovalBlockedReason = 'EARLIER_STEP_PENDING' | 'ALREADY_DECIDED_EARLIER_STEP';

/**
 * One row of the approval queue. The query below selects the same columns as
 * `v_approvals_pending`, and it also includes ESCALATED tasks, which that view
 * omits. The actionability annotation is added in process.
 *
 * The pg index signature is kept deliberately. The column list lives in SQL,
 * and a bare object spread drops that signature, which would silently narrow
 * every consumer down to just the two annotated fields.
 */
export interface ApprovalQueueRow extends pg.QueryResultRow {
  actionable: boolean;
  blocked_reason: ApprovalBlockedReason | null;
}

/**
 * Approval tasks visible to a user, annotated with whether that user may decide
 * them *now*.
 *
 * startWorkflow seeds every applicable stage as PENDING at submission time, so a
 * holder of a later stage can see a row that decideTask will refuse: either an
 * earlier stage of the same chain is still open, or the holder has already
 * decided an earlier stage (the segregation-of-duties rule). Rows stay visible
 * so the holder knows the document is coming, but the caller needs to be able to
 * explain why no decision is available yet rather than offering a button that
 * returns 403.
 *
 * `actionable` is the single derived flag the UI should act on; `blocked_reason`
 * says why. Neither is an authorization decision - decideTask re-checks both
 * rules inside its own transaction.
 *
 * The queue also includes tasks the caller may decide *under an active
 * delegation*. A delegate holds the temporary role only transiently (it is never
 * written to user_roles), so the direct-role EXISTS misses those tasks even
 * though decideTask authorizes them through its delegation fallback. Rows
 * decidable only by delegation carry `acting_role_name` / `delegator_name` /
 * `delegation_code` so the UI can show whose authority is being exercised.
 */
export async function getApprovalsQueue(ctx: Ctx, userId: number): Promise<ApprovalQueueRow[]> {
  const { query } = await import('../db.js');
  const res = await query(
    `SELECT t.id AS task_id,
            i.id AS instance_id,
            i.entity_type, i.entity_id, i.entity_code, i.workflow_id,
            w.name AS workflow_name,
            t.step_seq, t.step_name, t.status, t.due_at,
            i.company_id, i.tenant_id, i.created_by, i.submitted_at, i.amount,
            t.approver_user_id,
            NOT EXISTS (
              SELECT 1 FROM approval_tasks e
               WHERE e.instance_id = t.instance_id
                 AND e.step_seq < t.step_seq
                 AND e.status IN ('PENDING','ESCALATED')
            ) AS stage_ready,
            EXISTS (
              SELECT 1 FROM approval_tasks p
               WHERE p.instance_id = t.instance_id
                 AND p.decided_by = $1
                 AND p.step_seq < t.step_seq
                 AND p.status IN ('APPROVED', 'REJECTED', 'RETURNED')
            ) AS prior_decided_by_me,
            dr.has_direct_role,
            acting.delegation_id, acting.delegation_code,
            acting.acting_role_code, acting.acting_role_name, acting.delegator_name
     FROM approval_tasks t
     JOIN workflow_instances i ON i.id = t.instance_id
     JOIN workflows w ON w.id = i.workflow_id
     LEFT JOIN LATERAL (
       SELECT EXISTS (
         SELECT 1 FROM user_roles ur
         JOIN roles r ON r.id = ur.role_id
         WHERE ur.user_id = $1 AND (r.id = t.approver_role_id OR r.id = t.alternative_role_id)
       ) AS has_direct_role
     ) dr ON true
     LEFT JOIN LATERAL (
       SELECT d.id AS delegation_id, d.code AS delegation_code,
              r.code AS acting_role_code, r.name AS acting_role_name,
              du.first_name || ' ' || du.last_name AS delegator_name
         FROM delegations d
         JOIN roles r ON r.id = d.temporary_role_id
         JOIN users du ON du.id = d.delegator_user_id
        WHERE d.delegate_user_id = $1 AND d.tenant_id = i.tenant_id
          AND d.status = 'ACTIVE' AND d.starts_at <= now() AND d.expires_at > now()
          AND (r.id = t.approver_role_id OR r.id = t.alternative_role_id)
        ORDER BY d.expires_at ASC
        LIMIT 1
     ) acting ON true
     WHERE t.status IN ('PENDING','ESCALATED')
       AND (t.approver_user_id = $1
        OR dr.has_direct_role
        OR acting.delegation_id IS NOT NULL
     )
     ORDER BY i.submitted_at`,
    [userId],
    { tenantId: ctx.tenantId, userId }
  );
  return res.rows.map((row) => {
    const blockedReason: ApprovalBlockedReason | null =
      row.stage_ready !== true
        ? 'EARLIER_STEP_PENDING'
        : row.prior_decided_by_me === true
          ? 'ALREADY_DECIDED_EARLIER_STEP'
          : null;
    // A row is "acting under a delegation" only when the user is neither the
    // task's direct assignee nor a permanent holder of the approver role: in
    // both of those cases decideTask authorizes through the assignee/role path,
    // not the delegation fallback, so labelling the row "acting" would mislead.
    const acting =
      row.delegation_id != null &&
      row.acting_role_name != null &&
      row.has_direct_role !== true &&
      (row.approver_user_id == null || Number(row.approver_user_id) !== userId);
    return {
      ...row,
      delegation_id: acting ? row.delegation_id : null,
      delegation_code: acting ? row.delegation_code : null,
      acting_role_code: acting ? row.acting_role_code : null,
      acting_role_name: acting ? row.acting_role_name : null,
      delegator_name: acting ? row.delegator_name : null,
      actionable: blockedReason === null,
      blocked_reason: blockedReason,
    };
  });
}

/**
 * Approval decisions the user has already recorded (the inbox's history tab),
 * newest first. Read-only: every row is a past decision, so there is nothing to
 * act on here. Filterable by decision status; the instance status is included
 * so the reader can see what happened to the document afterwards (still in
 * flight, executed, rejected, …).
 */
export async function getApprovalHistory(
  ctx: Ctx,
  userId: number,
  opts: { status?: string | null } = {}
): Promise<Record<string, unknown>[]> {
  const { query } = await import('../db.js');
  const params: unknown[] = [userId];
  const conds = [
    't.decided_by = $1',
    "t.status IN ('APPROVED','REJECTED','RETURNED','DELEGATED')",
  ];
  let i = 2;
  if (opts.status && opts.status !== 'ALL') {
    conds.push('t.status = $' + i);
    params.push(opts.status);
    i += 1;
  }
  const res = await query(
    `SELECT t.id AS task_id,
            i.id AS instance_id,
            i.entity_type, i.entity_id, i.entity_code, i.amount, i.status AS instance_status,
            w.name AS workflow_name,
            t.step_seq, t.step_name, t.status, t.comment, t.decided_at,
            i.submitted_at, i.created_by AS submitted_by,
            du.first_name || ' ' || du.last_name AS decided_by_name,
            su.first_name || ' ' || su.last_name AS submitted_by_name
     FROM approval_tasks t
     JOIN workflow_instances i ON i.id = t.instance_id
     JOIN workflows w ON w.id = i.workflow_id
     LEFT JOIN users du ON du.id = t.decided_by
     LEFT JOIN users su ON su.id = i.created_by
     WHERE ${conds.join(' AND ')}
     ORDER BY t.decided_at DESC
     LIMIT 200`,
    params,
    { tenantId: ctx.tenantId, userId }
  );
  return res.rows as unknown as Record<string, unknown>[];
}
