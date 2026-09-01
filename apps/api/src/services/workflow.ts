import pg from 'pg';
import { Ctx } from '../db.js';
import { ApprovalStep } from '../types.js';
import { badRequest, forbidden, notFound } from '../utils.js';
import { ENTITIES } from './entities.js';
import { emitEvent } from './events.js';
import { notifyUserAdvanced, notifyRoleAdvanced } from './communication.js';
import { logAudit } from './audit.js';

interface StartWorkflowInput {
  entityType: string;
  entityId: number;
  entityCode?: string | null;
  amount?: number;
  companyId?: number | null;
  branchId?: number | null;
}

const WORKFLOW_SQL = `
  SELECT id, code, name, entity_type, config FROM workflows
  WHERE company_id = $1 AND tenant_id = $2 AND entity_type = $3 AND is_active = true
`;

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

/** Start the configured workflow for an entity and create the first approval task. */
export async function startWorkflow(client: pg.PoolClient, ctx: Ctx, input: StartWorkflowInput) {
  const companyId = input.companyId ?? ctx.companyId ?? null;
  if (!companyId) throw badRequest('Company is required to start a workflow');
  const wfRes = await client.query(WORKFLOW_SQL, [companyId, ctx.tenantId, input.entityType]);
  const wf = wfRes.rows[0];
  if (!wf) {
    // No workflow configured ? auto-approve
    const entity = ENTITIES[input.entityType];
    if (entity) {
      await client.query(
        `UPDATE ${entity.table} SET ${entity.statusColumn} = $1 WHERE id = $2`,
        [entity.approvedStatus, input.entityId]
      );
      await runApprovalSideEffect(client, ctx, input.entityType, input.entityId);
    }
    await emitEvent(client, ctx, {
      eventType: `${input.entityType.replace('.', '_')}.auto_approved`,
      entityType: input.entityType,
      entityId: input.entityId,
      entityCode: input.entityCode,
      payload: { reason: 'No workflow configured' },
    });
    return null;
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

  const instanceRes = await client.query(
    `INSERT INTO workflow_instances
       (company_id, tenant_id, workflow_id, entity_type, entity_id, entity_code, current_step, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,1,$7) RETURNING id`,
    [companyId, ctx.tenantId, wf.id, input.entityType, input.entityId, input.entityCode ?? null, ctx.userId ?? null]
  );
  const instanceId = Number(instanceRes.rows[0].id);

  const roleIds = new Map<string, number>();
  const roleRes = await client.query(`SELECT id, code FROM roles WHERE company_id = $1`, [companyId]);
  for (const r of roleRes.rows) roleIds.set(String(r.code), Number(r.id));

  const slaHours = applicable[0].sla_hours ?? 48;
  for (const step of applicable) {
    const approverRoleId = step.approver_role ? (roleIds.get(step.approver_role) ?? null) : null;
    await client.query(
      `INSERT INTO approval_tasks
         (instance_id, step_seq, step_name, approver_role_id, approver_user_id, status, due_at)
       VALUES ($1,$2,$3,$4,$5,'PENDING', now() + ($6 || ' hours')::interval)`,
      [instanceId, step.seq, step.name, approverRoleId, step.approver_user ?? null, slaHours]
    );
  }

  await emitEvent(client, ctx, {
    eventType: `${input.entityType.replace('.', '_')}.submitted`,
    entityType: input.entityType,
    entityId: input.entityId,
    entityCode: input.entityCode,
    payload: { instanceId, workflow: wf.code, steps: applicable.map((s) => s.name) },
  });

  const approverRoles = applicable.map((s) => s.approver_role).filter(Boolean) as string[];
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
     JOIN workflows w ON w.id = i.workflow_id WHERE i.id = $1`,
    [instanceId]
  );
  const inst = instRes.rows[0];
  if (!inst) throw notFound('Workflow instance not found');
  await client.query(
    `UPDATE workflow_instances SET status = 'APPROVED', current_step = current_step, completed_at = now() WHERE id = $1`,
    [instanceId]
  );
  const entity = ENTITIES[String(inst.entity_type)];
  // Security jobs drive their own stepwise status transitions inside the
  // securityPrinting service (approval vs materials authorization), so the
  // generic status update + side effect must be skipped for them.
  if (entity && String(inst.entity_type) !== 'security_printing.jobs') {
    await client.query(
      `UPDATE ${entity.table} SET ${entity.statusColumn} = $1 WHERE id = $2`,
      [entity.approvedStatus, Number(inst.entity_id)]
    );
    await runApprovalSideEffect(client, ctx, String(inst.entity_type), Number(inst.entity_id));
  }
  await emitEvent(client, ctx, {
    eventType: `${String(inst.entity_type).replace('.', '_')}.approved`,
    entityType: inst.entity_type,
    entityId: inst.entity_id,
    entityCode: inst.entity_code,
    payload: { instanceId, workflow: inst.workflow_code },
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
     WHERE instance_id = $1 AND status = 'PENDING'`,
    [instanceId, comment ?? null]
  );
  const entity = ENTITIES[String(inst.entity_type)];
  if (entity) {
    await client.query(
      `UPDATE ${entity.table} SET ${entity.statusColumn} = $1 WHERE id = $2`,
      [entity.rejectedStatus, Number(inst.entity_id)]
    );
  }
  await emitEvent(client, ctx, {
    eventType: `${String(inst.entity_type).replace('.', '_')}.rejected`,
    entityType: inst.entity_type,
    entityId: inst.entity_id,
    entityCode: inst.entity_code,
    payload: { instanceId, comment },
    severity: 'WARN',
  });
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
  const taskRes = await client.query(
    `SELECT t.*, i.entity_type, i.entity_id, i.entity_code, i.current_step, i.workflow_id,
            r.code AS role_code
     FROM approval_tasks t
     JOIN workflow_instances i ON i.id = t.instance_id
     LEFT JOIN roles r ON r.id = t.approver_role_id
     WHERE t.id = $1 FOR UPDATE OF t`,
    [taskId]
  );
  const task = taskRes.rows[0];
  if (!task) throw notFound('Approval task not found');
  if (task.status !== 'PENDING') throw badRequest(`Task is already ${task.status}`);

  // Verify the deciding user is an authorized approver (role or direct assignee)
  if (task.approver_user_id && Number(task.approver_user_id) !== user) throw forbidden('Not your approval task');
  if (task.approver_role_id && !task.role_code) throw forbidden('Approver role not found');
  if (task.role_code) {
    const roleCheck = await client.query(
      `SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id
       WHERE ur.user_id = $1 AND r.code = $2 LIMIT 1`,
      [user, task.role_code]
    );
    if (roleCheck.rows.length === 0) throw forbidden(`Requires role ${task.role_code}`);
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
    `UPDATE approval_tasks SET status = $2, comment = $3, decided_by = $4, decided_at = now()
     WHERE id = $1`,
    [taskId, decision, comment ?? null, user]
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
     WHERE instance_id = $1 AND status = 'PENDING'`,
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
  return { status: 'APPROVED', completed: false };
}

export async function getApprovalsQueue(ctx: Ctx, userId: number) {
  const { query } = await import('../db.js');
  const res = await query(
    `SELECT v.*, t.approver_user_id
     FROM v_approvals_pending v
     JOIN approval_tasks t ON t.id = v.task_id
     WHERE t.approver_user_id = $1
        OR EXISTS (
           SELECT 1 FROM user_roles ur
           JOIN roles r ON r.id = ur.role_id
           WHERE ur.user_id = $1 AND r.id = t.approver_role_id
        )
     ORDER BY v.submitted_at`,
    [userId],
    { tenantId: ctx.tenantId, userId }
  );
  return res.rows;
}
