import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { api, fmtDate, fmtNum } from '../api';
import { can, useAuth } from '../auth';
import EntityPicker, { defaultMapRow, type EntityOption } from '../components/EntityPicker';
import { ConfirmDialog, Drawer, EmptyState, Meter } from '../components/os';
import { ErrorState } from '../components/states';
import { toast } from '../components/toast';
import { Badge, ErrorBanner, Modal, PageLoader } from '../components/ui';
import { pick, titleCase } from '../helpers';

type Rec = Record<string, unknown>;

interface SecJob {
  id: number;
  [key: string]: unknown;
}

interface SecDetail {
  job?: Rec;
  requirements?: Rec[];
  operators?: Rec[];
  machines?: Rec[];
  batches?: Rec[];
  custody?: Rec[];
  reconciliations?: Rec[];
}

interface ReqRow {
  key: string;
  productId: string;
  qty: string;
  unitCost: string;
}

/**
 * Lifecycle phases in order. APPROVED and MATERIALS_AUTHORIZED are owned by the
 * workflow engine: this screen displays them but never drives them.
 */
const LIFECYCLE_PHASES: { label: string; statuses: string[] }[] = [
  { label: 'Preparation', statuses: ['DRAFT'] },
  { label: 'Approval', statuses: ['SUBMITTED', 'APPROVED', 'MATERIALS_AUTHORIZED'] },
  { label: 'Materials', statuses: ['MATERIALS_ISSUED'] },
  { label: 'Production', statuses: ['IN_PRODUCTION'] },
  { label: 'Quality', statuses: ['QC'] },
  { label: 'Reconciliation', statuses: ['RECONCILIATION'] },
  { label: 'Release', statuses: ['PACKAGING', 'IN_SECURE_STORAGE'] },
  { label: 'Dispatch', statuses: ['DISPATCHED', 'DELIVERED'] },
];

const LIFECYCLE = LIFECYCLE_PHASES.flatMap((p) => p.statuses);
const HOLDABLE = ['APPROVED', 'MATERIALS_AUTHORIZED', 'MATERIALS_ISSUED', 'IN_PRODUCTION', 'QC', 'RECONCILIATION', 'PACKAGING', 'IN_SECURE_STORAGE'];
const ASSIGNABLE = ['APPROVED', 'MATERIALS_AUTHORIZED', 'MATERIALS_ISSUED'];
const CANCELLABLE = ['DRAFT', 'SUBMITTED', 'ON_HOLD'];
const CLASSIFICATIONS = ['RESTRICTED', 'CONFIDENTIAL', 'SECRET'];
const QC_RESULTS = ['PASSED', 'FAILED', 'QUARANTINED'];

const OFF_LADDER: Record<string, string> = {
  ON_HOLD: 'This job is on hold. Resume it to a lifecycle stage before continuing.',
  REJECTED: 'This job was rejected during approval and cannot progress.',
  CANCELLED: 'This job was cancelled and is read-only.',
};

const CONFIRM_COPY: Record<string, { title: string; body: string; confirmLabel: string; danger?: boolean; useReason?: boolean; action: string }> = {
  submit: {
    title: 'Submit for approval',
    body: 'The job enters the approval workflow. The creator cannot approve it - segregation of duties requires a different approver.',
    confirmLabel: 'Submit',
    action: 'submit',
  },
  start: {
    title: 'Start production',
    body: 'Production starts against the issued materials and the assigned machine. Custody records the change of hands.',
    confirmLabel: 'Start production',
    action: 'start',
  },
  package: {
    title: 'Move to packaging',
    body: 'Every material variance is resolved. The job moves to packaging.',
    confirmLabel: 'Move to packaging',
    action: 'package',
  },
  storage: {
    title: 'Move to secure storage',
    body: 'The packaged job is placed in secure storage and stays under custody control.',
    confirmLabel: 'Move to secure storage',
    action: 'storage',
  },
  dispatch: {
    title: 'Dispatch job',
    body: 'The job leaves secure storage. At least one QC-passed batch is required before dispatch.',
    confirmLabel: 'Dispatch',
    action: 'dispatch',
  },
  deliver: {
    title: 'Record delivery',
    body: 'The job is recorded as delivered to the customer. Custody closes.',
    confirmLabel: 'Record delivery',
    action: 'deliver',
  },
  hold: {
    title: 'Place job on hold',
    body: 'Production stops and the job moves to ON_HOLD. The reason is written to the audit trail.',
    confirmLabel: 'Place on hold',
    danger: true,
    useReason: true,
    action: 'hold',
  },
  cancel: {
    title: 'Cancel job',
    body: 'The job is cancelled and becomes read-only. This cannot be undone.',
    confirmLabel: 'Cancel job',
    danger: true,
    useReason: true,
    action: 'cancel',
  },
};

const FORMS: Record<string, string> = {
  'issue-materials': 'Issue materials',
  'assign-machine': 'Assign secure machine',
  'assign-operator': 'Assign operator',
  complete: 'Record production output',
  qc: 'Record quality inspection',
  reconcile: 'Reconcile materials',
  resume: 'Resume job',
};
let rowSeq = 0;
const newReqRow = (): ReqRow => ({ key: `req-${(rowSeq += 1)}`, productId: '', qty: '1', unitCost: '' });

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const statusLabel = (s: string): string => (s ? titleCase(s.toLowerCase()) : 'Unknown');

function blockedBy(checks: [boolean, string][]): string {
  for (const [ok, why] of checks) if (!ok) return why;
  return '';
}

const productOptions = (rows: Rec[]): EntityOption[] =>
  rows
    .map((r) => {
      const pid = pick(r, 'productId', 'product_id');
      const code = pick<string>(r, 'productCode', 'product_code');
      const name = pick<string>(r, 'productName', 'product_name');
      return {
        value: pid == null ? '' : String(pid),
        label: [code, name].filter(Boolean).join(' | ') || `Product ${String(pid)}`,
      };
    })
    .filter((o) => o.value);

const batchOptions = (rows: Rec[]): EntityOption[] =>
  rows
    .map((b) => {
      const id = pick(b, 'id');
      const no = pick<string>(b, 'batchNo', 'batch_no');
      const qc = pick<string>(b, 'qcResult', 'qc_result');
      return { value: id == null ? '' : String(id), label: no || `Batch ${String(id)}`, hint: qc };
    })
    .filter((o) => o.value);

const mapUser = (row: Rec): EntityOption => {
  const id = pick(row, 'id');
  const first = pick<string>(row, 'firstName', 'first_name');
  const last = pick<string>(row, 'lastName', 'last_name');
  const email = pick<string>(row, 'email');
  const empNo = pick<string>(row, 'employeeNo', 'employee_no');
  const name = [first, last].filter(Boolean).join(' ');
  const label = name || email || pick<string>(row, 'username') || `User ${String(id)}`;
  return {
    value: id == null ? '' : String(id),
    label: empNo ? `${label} (${empNo})` : label,
    hint: email && email !== label ? email : undefined,
  };
};

function remainingIssuedForReconcile(rows: Rec[]): number {
  return rows.reduce((sum, r) => sum + num(pick(r, 'quantityIssued', 'quantity_issued')), 0);
}

function DetailSection({ title, count, children }: { title: string; count?: number; children: ReactNode }) {
  return (
    <section className="card card-pad">
      <h3 className="section-title">
        {title}
        {count !== undefined ? <span className="muted"> {fmtNum(count)}</span> : null}
      </h3>
      {children}
    </section>
  );
}
export default function SecurityJobs() {
  const { user } = useAuth();

  const [jobs, setJobs] = useState<SecJob[]>([]);
  const [listBusy, setListBusy] = useState(true);
  const [listError, setListError] = useState<unknown>(null);

  const [openJob, setOpenJob] = useState<SecJob | null>(null);
  const [detail, setDetail] = useState<SecDetail | null>(null);
  const [detailBusy, setDetailBusy] = useState(false);
  const [detailError, setDetailError] = useState<unknown>(null);

  const [busy, setBusy] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [formKind, setFormKind] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ kind: string; recId?: number } | null>(null);

  const [fields, setFields] = useState<Record<string, string>>({});
  const [reqRows, setReqRows] = useState<ReqRow[]>([]);
  const [formError, setFormError] = useState('');

  const loadJobs = useCallback(async () => {
    setListError(null);
    try {
      const r = await api<{ data: SecJob[] }>('/api/ops/security/jobs');
      setJobs(r.data ?? []);
    } catch (e) {
      setListError(e);
    } finally {
      setListBusy(false);
    }
  }, []);

  const loadDetail = useCallback(async (id: number) => {
    setDetailBusy(true);
    setDetailError(null);
    try {
      const r = await api<{ data: SecDetail }>(`/api/ops/security/jobs/${id}/detail`);
      setDetail(r.data);
    } catch (e) {
      setDetail(null);
      setDetailError(e);
    } finally {
      setDetailBusy(false);
    }
  }, []);

  useEffect(() => {
    void loadJobs();
  }, [loadJobs]);

  useEffect(() => {
    if (!openJob) {
      setDetail(null);
      setDetailError(null);
      return;
    }
    void loadDetail(openJob.id);
  }, [openJob, loadDetail]);

  const jobId = openJob?.id ?? null;

  const setField = (k: string, v: string) => setFields((p) => ({ ...p, [k]: v }));

  /** Every action re-reads the job detail: action responses are receipts, not job records. */
  const runAction = useCallback(
    async (action: string, payload?: Record<string, unknown>, successTitle?: string) => {
      if (jobId === null) return;
      setBusy(true);
      try {
        await api(`/api/ops/security/jobs/${jobId}/${action}`, {
          method: 'POST',
          body: JSON.stringify(payload ?? {}),
        });
        toast.success(successTitle ?? 'Security job updated');
        await loadJobs();
        await loadDetail(jobId);
      } catch (e) {
        toast.fromError('Action could not be completed', e);
      } finally {
        setBusy(false);
      }
    },
    [jobId, loadJobs, loadDetail]
  );

  const jobRow: Rec = detail?.job ?? openJob ?? {};
  const status = String(pick(jobRow, 'status') ?? '');
  const classification = String(pick(jobRow, 'securityClassification', 'security_classification') ?? '');
  const jobNo = pick<string>(jobRow, 'jobNo', 'job_no') ?? (jobId === null ? '' : `#${jobId}`);

  const requirements = detail?.requirements ?? [];
  const operators = detail?.operators ?? [];
  const machines = detail?.machines ?? [];
  const batches = detail?.batches ?? [];
  const custody = detail?.custody ?? [];
  const reconciliations = detail?.reconciliations ?? [];

  const phaseIndex = LIFECYCLE.indexOf(status);
  const planned = num(pick(jobRow, 'quantityPlanned', 'quantity_planned'));
  const produced = num(pick(jobRow, 'quantityProduced', 'quantity_produced'));
  const openRecs = reconciliations.filter((r) => ['OPEN', 'IN_VESTIGATION'].includes(String(pick(r, 'status') ?? '')));
  const passedBatches = batches.filter((b) => String(pick(b, 'qcResult', 'qc_result') ?? '') === 'PASSED');
  const unauthorized = requirements.filter(
    (r) => num(pick(r, 'quantityAuthorized', 'quantity_authorized')) < num(pick(r, 'quantityRequired', 'quantity_required'))
  );
  const issuable = requirements.filter(
    (r) => num(pick(r, 'quantityAuthorized', 'quantity_authorized')) - num(pick(r, 'quantityIssued', 'quantity_issued')) > 0
  );
  const actions: { key: string; label: string; reason: string; run: () => void }[] = [
    {
      key: 'submit',
      label: 'Submit for approval',
      reason: blockedBy([
        [can(user, 'security_printing.jobs.submit'), 'You do not have permission to submit secure jobs.'],
        [status === 'DRAFT', `Only draft jobs can be submitted (current: ${statusLabel(status)}).`],
        [requirements.length > 0, 'Add at least one material requirement before submitting.'],
      ]),
      run: () => setConfirm({ kind: 'submit' }),
    },
    {
      key: 'issue-materials',
      label: 'Issue materials',
      reason: blockedBy([
        [can(user, 'security_printing.jobs.issue_materials'), 'You do not have permission to issue secure materials.'],
        [status === 'MATERIALS_AUTHORIZED', `Materials can only be issued when MATERIALS_AUTHORIZED (current: ${statusLabel(status)}).`],
        [requirements.length > 0, 'This job has no material requirements recorded.'],
        [unauthorized.length === 0, `${unauthorized.length} requirement(s) are authorized for less than the required quantity.`],
        [issuable.length > 0, 'All authorized quantities have already been issued.'],
      ]),
      run: () => openForm('issue-materials'),
    },
    {
      key: 'assign-machine',
      label: 'Assign secure machine',
      reason: blockedBy([
        [can(user, 'security_printing.machines.assign'), 'You do not have permission to assign secure machines.'],
        [ASSIGNABLE.includes(status), `Machines can only be assigned when ${ASSIGNABLE.join(', ')} (current: ${statusLabel(status)}).`],
      ]),
      run: () => openForm('assign-machine'),
    },
    {
      key: 'assign-operator',
      label: 'Assign operator',
      reason: blockedBy([
        [can(user, 'security_printing.operators.assign'), 'You do not have permission to assign operators.'],
        [ASSIGNABLE.includes(status), `Operators can only be assigned when ${ASSIGNABLE.join(', ')} (current: ${statusLabel(status)}).`],
        [operators.length > 0, 'No operators are pre-authorized on this job. Add them when the job is created.'],
      ]),
      run: () => openForm('assign-operator'),
    },
    {
      key: 'start',
      label: 'Start production',
      reason: blockedBy([
        [can(user, 'security_printing.jobs.update'), 'You do not have permission to run secure production.'],
        [status === 'MATERIALS_ISSUED', `Production can only start after materials are issued (current: ${statusLabel(status)}).`],
        [machines.length > 0, 'Assign at least one secure machine before starting production.'],
        [operators.length > 0, 'Assign at least one authorized operator before starting production.'],
      ]),
      run: () => setConfirm({ kind: 'start' }),
    },
    {
      key: 'complete',
      label: 'Record production output',
      reason: blockedBy([
        [can(user, 'security_printing.jobs.update'), 'You do not have permission to record production output.'],
        [status === 'IN_PRODUCTION', `Output can only be recorded while in production (current: ${statusLabel(status)}).`],
      ]),
      run: () => openForm('complete'),
    },    {
      key: 'qc',
      label: 'Record quality inspection',
      reason: blockedBy([
        [can(user, 'security_printing.jobs.update'), 'You do not have permission to record quality results.'],
        [status === 'QC', `Quality can only be recorded while the job is in QC (current: ${statusLabel(status)}).`],
      ]),
      run: () => openForm('qc'),
    },
    {
      key: 'reconcile',
      label: 'Reconcile materials',
      reason: blockedBy([
        [can(user, 'security_printing.jobs.reconcile'), 'You do not have permission to reconcile secure materials.'],
        [status === 'RECONCILIATION', `Reconciliation is available after QC passes (current: ${statusLabel(status)}).`],
      ]),
      run: () => openForm('reconcile'),
    },
    {
      key: 'package',
      label: 'Move to packaging',
      reason: blockedBy([
        [can(user, 'security_printing.jobs.update'), 'You do not have permission to move this job to packaging.'],
        [status === 'RECONCILIATION', `Packaging follows reconciliation (current: ${statusLabel(status)}).`],
        [openRecs.length === 0, `${openRecs.length} material variance(s) must be resolved before packaging.`],
      ]),
      run: () => setConfirm({ kind: 'package' }),
    },
    {
      key: 'storage',
      label: 'Move to secure storage',
      reason: blockedBy([
        [can(user, 'security_printing.jobs.update'), 'You do not have permission to move this job to secure storage.'],
        [status === 'PACKAGING', `Secure storage follows packaging (current: ${statusLabel(status)}).`],
      ]),
      run: () => setConfirm({ kind: 'storage' }),
    },
    {
      key: 'dispatch',
      label: 'Dispatch',
      reason: blockedBy([
        [can(user, 'security_printing.jobs.dispatch'), 'You do not have permission to dispatch secure jobs.'],
        [status === 'IN_SECURE_STORAGE', `Dispatch is available from secure storage (current: ${statusLabel(status)}).`],
        [passedBatches.length > 0, 'At least one QC-passed batch is required for dispatch.'],
      ]),
      run: () => setConfirm({ kind: 'dispatch' }),
    },
    {
      key: 'deliver',
      label: 'Record delivery',
      reason: blockedBy([
        [can(user, 'security_printing.jobs.update'), 'You do not have permission to record delivery.'],
        [status === 'DISPATCHED', `Delivery can only be recorded after dispatch (current: ${statusLabel(status)}).`],
      ]),
      run: () => setConfirm({ kind: 'deliver' }),
    },
    {
      key: 'hold',
      label: 'Place on hold',
      reason: blockedBy([
        [can(user, 'security_printing.jobs.hold'), 'You do not have permission to place secure jobs on hold.'],
        [HOLDABLE.includes(status), `A job cannot be held from ${statusLabel(status)}.`],
      ]),
      run: () => setConfirm({ kind: 'hold' }),
    },
    {
      key: 'resume',
      label: 'Resume job',
      reason: blockedBy([
        [can(user, 'security_printing.jobs.resume'), 'You do not have permission to resume secure jobs.'],
        [status === 'ON_HOLD', `Only jobs on hold can be resumed (current: ${statusLabel(status)}).`],
      ]),
      run: () => openForm('resume'),
    },
    {
      key: 'cancel',
      label: 'Cancel job',
      reason: blockedBy([
        [can(user, 'security_printing.jobs.update'), 'You do not have permission to cancel secure jobs.'],
        [CANCELLABLE.includes(status), `A job cannot be cancelled from ${statusLabel(status)}.`],
      ]),
      run: () => setConfirm({ kind: 'cancel' }),
    },
  ];

  const available = actions.filter((a) => !a.reason);
  const unavailable = actions.filter((a) => a.reason);

  function openForm(kind: string) {
    setFormError('');
    if (kind === 'complete') {
      setFields({ productId: '', quantityGood: String(Math.max(0, planned - produced)) });
    } else if (kind === 'resume') {
      setFields({ toStatus: 'IN_PRODUCTION' });
    } else if (kind === 'qc') {
      setFields({ qcResult: 'PASSED' });
    } else if (kind === 'reconcile') {
      setFields({
        materialProductId: productOptions(requirements)[0]?.value ?? '',
        quantityIssued: String(remainingIssuedForReconcile(requirements)),
      });
    } else {
      setFields({});
    }
    setFormKind(kind);
  }

  function openCreate() {
    setFormError('');
    setFields({ classification: 'RESTRICTED', quantityPlanned: '', dueDate: '' });
    setReqRows([newReqRow()]);
    setShowCreate(true);
  }

  function setReqRow(key: string, field: 'productId' | 'qty' | 'unitCost', value: string) {
    setReqRows((prev) => prev.map((r) => (r.key === key ? { ...r, [field]: value } : r)));
  }

  function removeReqRow(key: string) {
    setReqRows((prev) => (prev.length > 1 ? prev.filter((r) => r.key !== key) : prev));
  }

  const createJob = async () => {
    setFormError('');
    const customerId = num(fields.customerId);
    const description = (fields.description ?? '').trim();
    const classificationValue = fields.classification ?? '';
    const quantityPlanned = num(fields.quantityPlanned);
    const reqs = reqRows.filter((r) => r.productId !== '');

    if (!customerId) return setFormError('Select a customer.');
    if (!description) return setFormError('Description is required.');
    if (!CLASSIFICATIONS.includes(classificationValue)) return setFormError('Select a security classification.');
    if (!(quantityPlanned > 0)) return setFormError('Planned quantity must be greater than zero.');
    if (reqs.length === 0) return setFormError('Add at least one material requirement.');
    const badQty = reqs.find((r) => !(num(r.qty) > 0));
    if (badQty) return setFormError('Every material requirement needs a quantity greater than zero.');

    setBusy(true);
    try {
      const r = await api<{ data: { jobId: number; jobNo: string } }>('/api/ops/security/jobs', {
        method: 'POST',
        body: JSON.stringify({
          customerId,
          description,
          securityClassification: classificationValue,
          quantityPlanned,
          dueDate: fields.dueDate ? fields.dueDate : undefined,
          notes: fields.notes ? fields.notes : undefined,
          requirements: reqs.map((x) => ({
            productId: num(x.productId),
            quantityRequired: num(x.qty),
            unitCost: x.unitCost ? num(x.unitCost) : undefined,
          })),
        }),
      });
      toast.success(`Secure job ${r.data.jobNo} created`);
      setShowCreate(false);
      setReqRows([]);
      await loadJobs();
      setOpenJob({ id: r.data.jobId });
    } catch (e) {
      setFormError(e instanceof Error ? e.message : 'The job could not be created.');
    } finally {
      setBusy(false);
    }
  };

  const submitForm = async () => {
    setFormError('');
    const kind = formKind;
    if (!kind) return;

    if (kind === 'issue-materials') {
      if (!fields.verifiedBy) return setFormError('Select a verifier. Dual control requires a second user.');
      if (num(fields.verifiedBy) === user?.id) return setFormError('The verifier must be a different user from the issuer.');
      setFormKind(null);
      await runAction(
        'issue-materials',
        {
          toLocation: fields.toLocation ? fields.toLocation : undefined,
          verifiedBy: num(fields.verifiedBy),
          requirements: issuable.map((r) => ({
            requirementId: num(pick(r, 'id')),
            productId: num(pick(r, 'productId', 'product_id')),
            quantity: num(pick(r, 'quantityAuthorized', 'quantity_authorized')) - num(pick(r, 'quantityIssued', 'quantity_issued')),
          })),
        },
        'Materials issued'
      );
      return;
    }

    if (kind === 'assign-machine') {
      if (!fields.machineId) return setFormError('Select a secure machine.');
      setFormKind(null);
      await runAction('assign-machine', { machineId: num(fields.machineId) }, 'Machine assigned');
      return;
    }

    if (kind === 'assign-operator') {
      if (!fields.operatorUserId) return setFormError('Select an operator.');
      setFormKind(null);
      await runAction('assign-operator', { operatorUserId: num(fields.operatorUserId) }, 'Operator assigned');
      return;
    }

    if (kind === 'complete') {
      const good = num(fields.quantityGood);
      const spoiled = num(fields.quantitySpoiled);
      if (!fields.productId) return setFormError('Select the finished product.');
      if (good <= 0) return setFormError('Good quantity must be greater than zero.');
      if (good + spoiled > planned) {
        return setFormError(`Good + spoiled (${fmtNum(good + spoiled)}) cannot exceed the planned quantity (${fmtNum(planned)}).`);
      }
      setFormKind(null);
      await runAction(
        'complete',
        {
          productId: num(fields.productId),
          quantityGood: good,
          quantitySpoiled: spoiled,
          quantityWaste: num(fields.quantityWaste),
          quantityRework: num(fields.quantityRework),
        },
        'Production output recorded'
      );
      return;
    }    if (kind === 'qc') {
      const result = fields.qcResult ?? '';
      if (!QC_RESULTS.includes(result)) return setFormError('Select a quality result.');
      setFormKind(null);
      await runAction(
        'qc',
        { result, batchId: fields.batchId ? num(fields.batchId) : null, notes: fields.notes ? fields.notes : undefined },
        'Quality result recorded'
      );
      return;
    }

    if (kind === 'reconcile') {
      if (!fields.materialProductId) return setFormError('Select the material being reconciled.');
      if (!fields.secondCheckerId) return setFormError('Select a second checker. Dual control requires a second user.');
      if (num(fields.secondCheckerId) === user?.id) return setFormError('The second checker must be a different user from the reconciler.');
      setFormKind(null);
      await runAction(
        'reconcile',
        {
          materialProductId: num(fields.materialProductId),
          quantityIssued: num(fields.quantityIssued),
          quantityOutput: num(fields.quantityOutput),
          quantitySpoiled: num(fields.quantitySpoiled),
          quantityWaste: num(fields.quantityWaste),
          quantityReturned: num(fields.quantityReturned),
          secondCheckerId: num(fields.secondCheckerId),
          notes: fields.notes ? fields.notes : undefined,
        },
        'Reconciliation recorded'
      );
      return;
    }

    if (kind === 'resume') {
      const toStatus = fields.toStatus ?? '';
      if (!HOLDABLE.includes(toStatus)) return setFormError('Select the stage to resume to.');
      setFormKind(null);
      await runAction('resume', { toStatus }, 'Job resumed');
    }
  };

  const resolveRec = async (recId: number, notes: string) => {
    if (jobId === null) return;
    if (!fields.secondCheckerId) {
      toast.error('Select a second checker before closing a variance');
      return;
    }
    setBusy(true);
    try {
      await api(`/api/ops/security/jobs/${jobId}/reconcile/${recId}/resolve`, {
        method: 'POST',
        body: JSON.stringify({ resolved: true, secondCheckerId: num(fields.secondCheckerId), notes: notes || undefined }),
      });
      toast.success('Reconciliation closed');
      await loadJobs();
      await loadDetail(jobId);
    } catch (e) {
      toast.fromError('Reconciliation could not be closed', e);
    } finally {
      setBusy(false);
    }
  };

  const confirmCopy = confirm && confirm.kind !== 'resolve' ? CONFIRM_COPY[confirm.kind] : undefined;
  const formTitle = formKind ? FORMS[formKind] : '';
  const reconcileVariance =
    num(fields.quantityIssued) - num(fields.quantityOutput) - num(fields.quantitySpoiled) - num(fields.quantityWaste) - num(fields.quantityReturned);

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="mod-kicker" data-mod="sec">Secure print</p>
          <h1>Security control room</h1>
          <p className="muted">Custody, dual control, spoilage and reconciliation. Sensitive actions always confirm.</p>
        </div>
        <button className="btn btn-primary" onClick={openCreate} disabled={!can(user, 'security_printing.jobs.create')}>
          + New Secure Job
        </button>
      </header>
      {listError && jobs.length === 0 ? (
        <ErrorState
          title="Secure jobs could not be loaded"
          message="The security job register is unavailable right now."
          onRetry={() => { setListBusy(true); void loadJobs(); }}
        />
      ) : listBusy ? (
        <PageLoader label="Loading secure jobs..." />
      ) : jobs.length === 0 ? (
        <EmptyState
          title="No secure jobs"
          body="No security printing jobs have been raised yet."
          action={can(user, 'security_printing.jobs.create') ? 'New secure job' : undefined}
          onAction={can(user, 'security_printing.jobs.create') ? openCreate : undefined}
        />
      ) : (
        <div className="table-wrap">
          <table className="data">
            <caption className="visually-hidden">Security printing jobs</caption>
            <thead>
              <tr>
                <th scope="col">Job no</th>
                <th scope="col">Customer</th>
                <th scope="col">Classification</th>
                <th scope="col">Planned</th>
                <th scope="col">Produced</th>
                <th scope="col">Due</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((j) => (
                <tr key={j.id}>
                  <td className="cell-mono">
                    <button type="button" className="link-btn" onClick={() => setOpenJob(j)}>
                      {pick<string>(j, 'jobNo', 'job_no') ?? `#${j.id}`}
                    </button>
                  </td>
                  <td>{pick<string>(j, 'customerName', 'customer_name') ?? '-'}</td>
                  <td><Badge value={pick(j, 'securityClassification', 'security_classification')} /></td>
                  <td>{fmtNum(num(pick(j, 'quantityPlanned', 'quantity_planned')))}</td>
                  <td>{fmtNum(num(pick(j, 'quantityProduced', 'quantity_produced')))}</td>
                  <td>{fmtDate(pick(j, 'dueDate', 'due_date'))}</td>
                  <td><Badge value={pick(j, 'status')} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {openJob && (
        <Drawer title={`Secure job ${jobNo}`} onClose={() => setOpenJob(null)}>
          {detailError ? <ErrorBanner error={detailError} /> : null}
          {detailBusy && !detail ? <PageLoader label="Loading job detail..." /> : null}

          {detail && (
            <>
              <div className="list-meta">
                <Badge value={classification} />
                <Badge value={status} />
                <span className="muted">{pick<string>(jobRow, 'customerName', 'customer_name') ?? '-'}</span>
              </div>

              <nav className="steps" aria-label="Job lifecycle">
                {LIFECYCLE_PHASES.map((phase, i) => {
                  const active = phaseIndex >= 0 && phase.statuses.includes(status);
                  const done = phaseIndex >= 0 && LIFECYCLE.indexOf(phase.statuses[phase.statuses.length - 1]) < phaseIndex;
                  const phaseState = done ? 'Done' : active ? 'In progress' : 'Pending';
                  return (
                    <div
                      key={phase.label}
                      className={'step' + (active ? ' is-active' : '') + (done ? ' is-done' : '')}
                      aria-current={active ? 'step' : undefined}
                    >
                      <span className="step-num">{done ? '\u2713' : i + 1}</span>
                      <span className="step-label">
                        <span>{phase.label}</span>
                        <span className="step-status">{phaseState}</span>
                      </span>
                    </div>
                  );
                })}
              </nav>

              {OFF_LADDER[status] ? <div className="alert alert-warn">{OFF_LADDER[status]}</div> : null}

              <div className="flow-actions">
                {available.map((a, i) => (
                  <button key={a.key} className={'btn btn-block' + (i === 0 ? ' btn-primary' : '')} disabled={busy} onClick={a.run}>
                    {a.label}
                  </button>
                ))}
              </div>

              {unavailable.length > 0 && (
                <details className="card card-pad">
                  <summary className="muted">{unavailable.length} actions unavailable</summary>
                  <dl className="detail-list">
                    {unavailable.map((a) => (
                      <div className="detail-row" key={a.key}>
                        <dt>{a.label}</dt>
                        <dd className="muted">{a.reason}</dd>
                      </div>
                    ))}
                  </dl>
                </details>
              )}              <DetailSection title="Summary">
                <div className="kv-grid">
                  <div>
                    <span className="kv-k">Customer</span>
                    <span className="kv-v">{pick<string>(jobRow, 'customerName', 'customer_name') ?? '-'}</span>
                  </div>
                  <div>
                    <span className="kv-k">Classification</span>
                    <span className="kv-v"><Badge value={classification} /></span>
                  </div>
                  <div>
                    <span className="kv-k">Planned quantity</span>
                    <span className="kv-v">{fmtNum(planned)}</span>
                  </div>
                  <div>
                    <span className="kv-k">Produced</span>
                    <span className="kv-v">{fmtNum(produced)}</span>
                  </div>
                  <div>
                    <span className="kv-k">Start date</span>
                    <span className="kv-v">{fmtDate(pick(jobRow, 'startDate', 'start_date'))}</span>
                  </div>
                  <div>
                    <span className="kv-k">Due date</span>
                    <span className="kv-v">{fmtDate(pick(jobRow, 'dueDate', 'due_date'))}</span>
                  </div>
                  <div>
                    <span className="kv-k">Requested by</span>
                    <span className="kv-v">{pick<string>(jobRow, 'requestedByEmail', 'requested_by_email') ?? '-'}</span>
                  </div>
                  <div>
                    <span className="kv-k">Raised</span>
                    <span className="kv-v">{fmtDate(pick(jobRow, 'createdAt', 'created_at'))}</span>
                  </div>
                </div>
                {pick<string>(jobRow, 'description') ? (
                  <p className="muted">{pick<string>(jobRow, 'description')}</p>
                ) : null}
                {pick<string>(jobRow, 'notes') ? <p className="muted">{pick<string>(jobRow, 'notes')}</p> : null}
              </DetailSection>

              <DetailSection title="Material readiness" count={requirements.length}>
                {requirements.length === 0 ? (
                  <p className="muted">No material requirements recorded on this job.</p>
                ) : (
                  requirements.map((r) => {
                    const required = num(pick(r, 'quantityRequired', 'quantity_required'));
                    const authorized = num(pick(r, 'quantityAuthorized', 'quantity_authorized'));
                    const issued = num(pick(r, 'quantityIssued', 'quantity_issued'));
                    const code = pick<string>(r, 'productCode', 'product_code');
                    const name = pick<string>(r, 'productName', 'product_name');
                    const label = [code, name].filter(Boolean).join(' | ') || `Product ${String(pick(r, 'productId', 'product_id'))}`;
                    const ready = required > 0 && issued >= required;
                    return (
                      <div key={String(pick(r, 'id') ?? label)}>
                        <div className="timeline-title">
                          <span>{label}</span>
                          <Badge value={ready ? 'AUTHORIZED' : 'NOT_RECEIVED'} />
                        </div>
                        <Meter
                          label={`${fmtNum(issued)} issued / ${fmtNum(authorized)} authorized / ${fmtNum(required)} required`}
                          value={required > 0 ? Math.min(required, authorized) : 0}
                          max={required > 0 ? required : 1}
                        />
                      </div>
                    );
                  })
                )}
                {unauthorized.length > 0 ? (
                  <div className="alert alert-warn">
                    {unauthorized.length} requirement(s) are authorized for less than the required quantity. Materials cannot be
                    issued in full until the workflow authorizes them.
                  </div>
                ) : null}
              </DetailSection>              <DetailSection title="Authorized operators" count={operators.length}>
                {operators.length === 0 ? (
                  <p className="muted">No operators are pre-authorized on this job. Operators are added when the job is created.</p>
                ) : (
                  <div className="timeline">
                    {operators.map((o) => (
                      <div key={String(pick(o, 'id') ?? pick(o, 'userId', 'user_id'))} className="timeline-item">
                        <div className="timeline-dot" />
                        <div className="timeline-body">
                          <div className="timeline-title">
                            <strong>
                              {pick<string>(o, 'operatorName', 'operator_name') ?? `User ${String(pick(o, 'userId', 'user_id'))}`}
                            </strong>
                          </div>
                          <div className="timeline-meta">{pick<string>(o, 'operatorEmail', 'operator_email') ?? ''}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </DetailSection>

              <DetailSection title="Secure machines" count={machines.length}>
                {machines.length === 0 ? (
                  <p className="muted">No secure machine is assigned. Only machines flagged as secure can run this job.</p>
                ) : (
                  <div className="timeline">
                    {machines.map((m) => (
                      <div key={String(pick(m, 'id') ?? pick(m, 'machineId', 'machine_id'))} className="timeline-item">
                        <div className="timeline-dot" />
                        <div className="timeline-body">
                          <div className="timeline-title">
                            <span className="cell-mono">{pick<string>(m, 'machineCode', 'machine_code') ?? '-'}</span>
                            <span>{pick<string>(m, 'machineName', 'machine_name') ?? ''}</span>
                            <Badge value={pick(m, 'machineStatus', 'machine_status')} />
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </DetailSection>

              <DetailSection title="Batches" count={batches.length}>
                {batches.length === 0 ? (
                  <p className="muted">No batches have been produced yet.</p>
                ) : (
                  <div className="table-wrap">
                    <table className="mini-table">
                      <caption className="visually-hidden">Produced batches</caption>
                      <thead>
                        <tr>
                          <th scope="col">Batch</th>
                          <th scope="col">Product</th>
                          <th scope="col">Good</th>
                          <th scope="col">Spoiled</th>
                          <th scope="col">QC</th>
                          <th scope="col">QR</th>
                        </tr>
                      </thead>
                      <tbody>
                        {batches.map((b) => {
                          const qr = pick<string>(b, 'qrCode', 'qr_code');
                          return (
                            <tr key={String(pick(b, 'id'))}>
                              <td className="cell-mono">{pick<string>(b, 'batchNo', 'batch_no') ?? '-'}</td>
                              <td>
                                {[pick<string>(b, 'productCode', 'product_code'), pick<string>(b, 'productName', 'product_name')]
                                  .filter(Boolean)
                                  .join(' | ') || '-'}
                              </td>
                              <td>{fmtNum(num(pick(b, 'quantityGood', 'quantity_good')))}</td>
                              <td>{fmtNum(num(pick(b, 'quantitySpoiled', 'quantity_spoiled')))}</td>
                              <td><Badge value={pick(b, 'qcResult', 'qc_result')} /></td>
                              <td>
                                {qr ? (
                                  <a className="link-btn" href={`#/qr/${encodeURIComponent(qr)}`}>
                                    Trace
                                  </a>
                                ) : (
                                  <span className="muted">-</span>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </DetailSection>              <DetailSection title="Reconciliation" count={reconciliations.length}>
                {reconciliations.length === 0 ? (
                  <p className="muted">No material reconciliation has been recorded yet.</p>
                ) : (
                  reconciliations.map((r) => {
                    const recStatus = String(pick(r, 'status') ?? '');
                    const recId = num(pick(r, 'id'));
                    const reconciledBy = num(pick(r, 'reconciledBy', 'reconciled_by'));
                    const secondChecker = num(pick(r, 'secondCheckerId', 'second_checker_id'));
                    const mayClose = can(user, 'security_printing.jobs.reconcile') && (reconciledBy === user?.id || secondChecker === user?.id);
                    const why = blockedBy([
                      [can(user, 'security_printing.jobs.reconcile'), 'You do not have permission to reconcile secure jobs.'],
                      [recStatus === 'IN_VESTIGATION', `Only a variance under investigation can be closed (current: ${statusLabel(recStatus)}).`],
                      [reconciledBy === user?.id || secondChecker === user?.id, 'Only the reconciler or the second checker may resolve this variance.'],
                    ]);
                    const variance = num(pick(r, 'variance'));
                    return (
                      <div className={'card card-pad' + (variance !== 0 ? ' card-warn' : '')} key={String(pick(r, 'id'))}>
                        <div className="list-meta">
                          <strong>
                            {[pick<string>(r, 'productCode', 'product_code'), pick<string>(r, 'productName', 'product_name')]
                              .filter(Boolean)
                              .join(' | ') || `Product ${String(pick(r, 'materialProductId', 'material_product_id'))}`}
                          </strong>
                          <Badge value={recStatus} />
                          <span className="muted">Variance {fmtNum(variance)}</span>
                        </div>
                        <dl className="detail-list">
                          <div className="detail-row">
                            <dt>Issued</dt>
                            <dd>{fmtNum(num(pick(r, 'quantityIssued', 'quantity_issued')))}</dd>
                          </div>
                          <div className="detail-row">
                            <dt>Output</dt>
                            <dd>{fmtNum(num(pick(r, 'quantityOutput', 'quantity_output')))}</dd>
                          </div>
                          <div className="detail-row">
                            <dt>Spoiled / waste / returned</dt>
                            <dd>
                              {fmtNum(num(pick(r, 'quantitySpoiled', 'quantity_spoiled')))} /{' '}
                              {fmtNum(num(pick(r, 'quantityWaste', 'quantity_waste')))} /{' '}
                              {fmtNum(num(pick(r, 'quantityReturned', 'quantity_returned')))}
                            </dd>
                          </div>
                          <div className="detail-row">
                            <dt>Reconciled</dt>
                            <dd>{fmtDate(pick(r, 'reconciledAt', 'reconciled_at'))}</dd>
                          </div>
                          {pick<string>(r, 'notes') ? (
                            <div className="detail-row">
                              <dt>Notes</dt>
                              <dd>{pick<string>(r, 'notes')}</dd>
                            </div>
                          ) : null}
                        </dl>
                        {mayClose ? (
                          <div className="flow-actions">
                            <button
                              type="button"
                              className="btn btn-block btn-primary"
                              disabled={busy}
                              onClick={() => setConfirm({ kind: 'resolve', recId })}
                            >
                              Close variance
                            </button>
                          </div>
                        ) : (
                          <p className="muted">{why}</p>
                        )}
                      </div>
                    );
                  })
                )}
              </DetailSection>

              <DetailSection title="Custody" count={custody.length}>
                {custody.length === 0 ? (
                  <p className="muted">No custody events recorded.</p>
                ) : (
                  <div className="timeline">
                    {custody.map((c) => (
                      <div key={String(pick(c, 'id'))} className="timeline-item">
                        <div className="timeline-dot" />
                        <div className="timeline-body">
                          <div className="timeline-title">
                            <strong>{titleCase(String(pick(c, 'eventType', 'event_type') ?? '').toLowerCase())}</strong>
                            <span className="muted">{pick<string>(c, 'actorName', 'actor_name') ?? ''}</span>
                          </div>
                          <div className="timeline-meta">
                            {fmtDate(pick(c, 'occurredAt', 'occurred_at'))}
                            {pick<string>(c, 'toLocation', 'to_location') ? ` - ${pick<string>(c, 'toLocation', 'to_location')}` : ''}
                          </div>
                          {pick<string>(c, 'notes') ? <div>{pick<string>(c, 'notes')}</div> : null}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </DetailSection>
            </>
          )}
        </Drawer>
      )}

      {showCreate && (
        <Modal title="New secure job" wide onClose={() => setShowCreate(false)}>
          <div className="form-grid">
            <div className="field">
              <label className="field-required" htmlFor="sj-customer">Customer</label>
              <EntityPicker
                id="sj-customer"
                endpoint="/api/crm/customers"
                mapRow={defaultMapRow}
                value={fields.customerId ?? ''}
                onChange={(v) => setField('customerId', v)}
                ariaLabel="Customer"
                placeholder="Search customer..."
              />
            </div>
            <div className="field">
              <label className="field-required" htmlFor="sj-classification">Security classification</label>
              <select
                id="sj-classification"
                value={fields.classification ?? 'RESTRICTED'}
                onChange={(e) => setField('classification', e.target.value)}
              >
                {CLASSIFICATIONS.map((c) => (
                  <option key={c} value={c}>{statusLabel(c)}</option>
                ))}
              </select>
            </div>
            <div className="field">
              <label className="field-required" htmlFor="sj-qty">Planned quantity</label>
              <input
                id="sj-qty"
                inputMode="numeric"
                value={fields.quantityPlanned ?? ''}
                onChange={(e) => setField('quantityPlanned', e.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="sj-due">Due date</label>
              <input id="sj-due" type="date" value={fields.dueDate ?? ''} onChange={(e) => setField('dueDate', e.target.value)} />
            </div>
            <div className="field">
              <label className="field-required" htmlFor="sj-desc">Description</label>
              <input id="sj-desc" value={fields.description ?? ''} onChange={(e) => setField('description', e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="sj-notes">Notes</label>
              <input id="sj-notes" value={fields.notes ?? ''} onChange={(e) => setField('notes', e.target.value)} />
            </div>
          </div>          <h3 className="section-title">Material requirements</h3>
          {reqRows.map((r, i) => (
            <div className="stack-row" key={r.key}>
              <div className="field" style={{ flex: 1 }}>
                <label htmlFor={`sj-req-${r.key}`}>Product {i + 1}</label>
                <EntityPicker
                  id={`sj-req-${r.key}`}
                  endpoint="/api/inventory/items"
                  value={r.productId}
                  onChange={(v) => setReqRow(r.key, 'productId', v)}
                  ariaLabel={`Product ${i + 1}`}
                  placeholder="Search product..."
                />
              </div>
              <div className="field">
                <label htmlFor={`sj-qty-${r.key}`}>Quantity</label>
                <input
                  id={`sj-qty-${r.key}`}
                  inputMode="numeric"
                  value={r.qty}
                  onChange={(e) => setReqRow(r.key, 'qty', e.target.value)}
                />
              </div>
              <div className="field">
                <label htmlFor={`sj-cost-${r.key}`}>Unit cost</label>
                <input
                  id={`sj-cost-${r.key}`}
                  inputMode="decimal"
                  value={r.unitCost}
                  onChange={(e) => setReqRow(r.key, 'unitCost', e.target.value)}
                />
              </div>
              <button type="button" className="btn" onClick={() => removeReqRow(r.key)} disabled={reqRows.length === 1}>
                Remove
              </button>
            </div>
          ))}
          <button type="button" className="btn" onClick={() => setReqRows((p) => [...p, newReqRow()])}>
            + Add material
          </button>

          {formError ? <div className="alert alert-error">{formError}</div> : null}

          <div className="head-actions">
            <button className="btn" onClick={() => setShowCreate(false)} disabled={busy}>Cancel</button>
            <button className="btn btn-primary" onClick={createJob} disabled={busy}>
              {busy ? 'Creating...' : 'Create job'}
            </button>
          </div>
        </Modal>
      )}
      {formKind && (
        <Modal title={formTitle} onClose={() => setFormKind(null)}>
          {formError ? <div className="alert alert-error">{formError}</div> : null}

          {formKind === 'issue-materials' && (
            <>
              <p className="muted">
                Every authorized requirement must be issued in a single movement. Dual control requires a verifier who is not
                the issuer.
              </p>
              <div className="field">
                <label className="field-required" htmlFor="sj-verifier">Verified by</label>
                <EntityPicker
                  id="sj-verifier"
                  endpoint="/api/admin/users"
                  searchParam="search"
                  mapRow={mapUser}
                  value={fields.verifiedBy ?? ''}
                  onChange={(v) => setField('verifiedBy', v)}
                  ariaLabel="Verified by"
                  placeholder="Search user..."
                />
              </div>
              <div className="field">
                <label htmlFor="sj-to-location">To location</label>
                <input id="sj-to-location" value={fields.toLocation ?? ''} onChange={(e) => setField('toLocation', e.target.value)} />
              </div>
            </>
          )}

          {formKind === 'assign-machine' && (
            <div className="field">
              <label className="field-required" htmlFor="sj-machine">Secure machine</label>
              <EntityPicker
                id="sj-machine"
                endpoint="/api/production/machines"
                query={{ isSecure: 'true' }}
                value={fields.machineId ?? ''}
                onChange={(v) => setField('machineId', v)}
                ariaLabel="Secure machine"
                placeholder="Search secure machine..."
                emptyHint="No secure machines are registered. Flag a machine as secure before assigning it."
              />
            </div>
          )}

          {formKind === 'assign-operator' && (
            <div className="field">
              <label className="field-required" htmlFor="sj-operator">Operator</label>
              <EntityPicker
                id="sj-operator"
                options={operators.map((o) => ({
                  value: String(pick(o, 'userId', 'user_id') ?? ''),
                  label: pick<string>(o, 'operatorName', 'operator_name') ?? `User ${String(pick(o, 'userId', 'user_id'))}`,
                  hint: pick<string>(o, 'operatorEmail', 'operator_email'),
                }))}
                value={fields.operatorUserId ?? ''}
                onChange={(v) => setField('operatorUserId', v)}
                ariaLabel="Operator"
                placeholder="Search pre-authorized operator..."
                emptyHint="No operator is pre-authorized on this job."
              />
            </div>
          )}
          {formKind === 'complete' && (
            <div className="form-grid">
              <div className="field">
                <label className="field-required" htmlFor="sj-product">Finished product</label>
                <EntityPicker
                  id="sj-product"
                  endpoint="/api/inventory/items"
                  value={fields.productId ?? ''}
                  onChange={(v) => setField('productId', v)}
                  ariaLabel="Finished product"
                  placeholder="Search product..."
                />
              </div>
              <div className="field">
                <label className="field-required" htmlFor="sj-good">Good quantity</label>
                <input id="sj-good" inputMode="numeric" value={fields.quantityGood ?? ''} onChange={(e) => setField('quantityGood', e.target.value)} />
              </div>
              <div className="field">
                <label htmlFor="sj-spoiled">Spoiled</label>
                <input id="sj-spoiled" inputMode="numeric" value={fields.quantitySpoiled ?? ''} onChange={(e) => setField('quantitySpoiled', e.target.value)} />
              </div>
              <div className="field">
                <label htmlFor="sj-waste">Waste</label>
                <input id="sj-waste" inputMode="numeric" value={fields.quantityWaste ?? ''} onChange={(e) => setField('quantityWaste', e.target.value)} />
              </div>
              <div className="field">
                <label htmlFor="sj-rework">Rework</label>
                <input id="sj-rework" inputMode="numeric" value={fields.quantityRework ?? ''} onChange={(e) => setField('quantityRework', e.target.value)} />
              </div>
            </div>
          )}

          {formKind === 'qc' && (
            <>
              <div className="field">
                <label className="field-required" htmlFor="sj-qc-result">Result</label>
                <select id="sj-qc-result" value={fields.qcResult ?? 'PASSED'} onChange={(e) => setField('qcResult', e.target.value)}>
                  {QC_RESULTS.map((r) => (
                    <option key={r} value={r}>{statusLabel(r)}</option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor="sj-qc-batch">Batch</label>
                <EntityPicker
                  id="sj-qc-batch"
                  options={batchOptions(batches)}
                  value={fields.batchId ?? ''}
                  onChange={(v) => setField('batchId', v)}
                  ariaLabel="Batch"
                  placeholder="PENDING batches are inspected by default"
                  emptyHint="No batches recorded on this job."
                />
              </div>
              <div className="field">
                <label htmlFor="sj-qc-notes">Notes</label>
                <input id="sj-qc-notes" value={fields.notes ?? ''} onChange={(e) => setField('notes', e.target.value)} />
              </div>
            </>
          )}
          {formKind === 'reconcile' && (
            <>
              <div className="field">
                <label className="field-required" htmlFor="sj-rec-material">Material</label>
                <EntityPicker
                  id="sj-rec-material"
                  options={productOptions(requirements)}
                  value={fields.materialProductId ?? ''}
                  onChange={(v) => setField('materialProductId', v)}
                  ariaLabel="Material"
                  placeholder="Select the material being reconciled"
                  emptyHint="No material requirements recorded on this job."
                />
              </div>
              <div className="form-grid">
                <div className="field">
                  <label className="field-required" htmlFor="sj-issued">Issued</label>
                  <input id="sj-issued" inputMode="numeric" value={fields.quantityIssued ?? ''} onChange={(e) => setField('quantityIssued', e.target.value)} />
                </div>
                <div className="field">
                  <label htmlFor="sj-output">Output</label>
                  <input id="sj-output" inputMode="numeric" value={fields.quantityOutput ?? ''} onChange={(e) => setField('quantityOutput', e.target.value)} />
                </div>
                <div className="field">
                  <label htmlFor="sj-spoiled-rec">Spoiled</label>
                  <input id="sj-spoiled-rec" inputMode="numeric" value={fields.quantitySpoiled ?? ''} onChange={(e) => setField('quantitySpoiled', e.target.value)} />
                </div>
                <div className="field">
                  <label htmlFor="sj-waste-rec">Waste</label>
                  <input id="sj-waste-rec" inputMode="numeric" value={fields.quantityWaste ?? ''} onChange={(e) => setField('quantityWaste', e.target.value)} />
                </div>
                <div className="field">
                  <label htmlFor="sj-returned">Returned</label>
                  <input id="sj-returned" inputMode="numeric" value={fields.quantityReturned ?? ''} onChange={(e) => setField('quantityReturned', e.target.value)} />
                </div>
              </div>
              <p className="muted">Variance {fmtNum(reconcileVariance)}</p>
              <div className="field">
                <label className="field-required" htmlFor="sj-second-checker">Second checker</label>
                <EntityPicker
                  id="sj-second-checker"
                  endpoint="/api/admin/users"
                  searchParam="search"
                  mapRow={mapUser}
                  value={fields.secondCheckerId ?? ''}
                  onChange={(v) => setField('secondCheckerId', v)}
                  ariaLabel="Second checker"
                  placeholder="Search user..."
                />
              </div>
              <div className="field">
                <label htmlFor="sj-rec-notes">Notes</label>
                <input id="sj-rec-notes" value={fields.notes ?? ''} onChange={(e) => setField('notes', e.target.value)} />
              </div>
            </>
          )}

          {formKind === 'resume' && (
            <div className="field">
              <label className="field-required" htmlFor="sj-resume">Resume to stage</label>
              <select id="sj-resume" value={fields.toStatus ?? 'IN_PRODUCTION'} onChange={(e) => setField('toStatus', e.target.value)}>
                {HOLDABLE.map((s) => (
                  <option key={s} value={s}>{statusLabel(s)}</option>
                ))}
              </select>
            </div>
          )}

          <div className="head-actions">
            <button className="btn" onClick={() => setFormKind(null)} disabled={busy}>Cancel</button>
            <button className="btn btn-primary" onClick={submitForm} disabled={busy}>
              {busy ? 'Working...' : formTitle}
            </button>
          </div>
        </Modal>
      )}
      {confirm && confirm.kind === 'resolve' && confirmCopy === undefined && (
        <ConfirmDialog
          title="Close material variance"
          body="Closing the variance records that the difference between issued and produced material has been investigated. Dual control applies."
          confirmLabel="Close variance"
          reasonLabel="Investigation notes (written to the audit trail)"
          onCancel={() => setConfirm(null)}
          onConfirm={(reason) => {
            const recId = confirm.recId;
            setConfirm(null);
            if (recId !== undefined) void resolveRec(recId, reason);
          }}
        />
      )}

      {confirmCopy && (
        <ConfirmDialog
          title={confirmCopy.title}
          body={confirmCopy.body}
          confirmLabel={confirmCopy.confirmLabel}
          danger={confirmCopy.danger}
          reasonLabel={confirmCopy.useReason ? 'Reason (written to the audit trail)' : null}
          reasonRequired={confirmCopy.useReason}
          onCancel={() => setConfirm(null)}
          onConfirm={(reason) => {
            const action = confirmCopy.action;
            setConfirm(null);
            void runAction(action, confirmCopy.useReason ? { reason: reason || undefined } : undefined);
          }}
        />
      )}
    </div>
  );
}