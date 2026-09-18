/**
 * HOPE DESIGN SERVICE DESK - QR asset service desk (spec 13, 12, 27).
 *
 * The scan flow the spec demands:
 *
 *   SCAN QR -> AUTHENTICATE -> RBAC -> ABAC -> ASSET IDENTIFIED
 *   -> VIEW AUTHORIZED DETAILS -> CREATE / VIEW SERVICE TICKETS
 *
 * The server refuses before it reveals anything a caller is not entitled to,
 * and every attempt - allowed or denied - lands in the scan ledger. This view
 * therefore shows the stepper, the authorized asset card, the resulting ticket
 * or work order, and the immutable ledger of who scanned what from where.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { navigate, useHashQuery } from '../../router';
import { can, useAuth } from '../../auth';
import { ErrorBanner, Modal, Spinner } from '../../components/ui';
import { Field, Inp, Sel, Txa, FormErr } from '../hikvision/fields';
import {
  EmptyRow,
  KpiRow,
  KpiTile,
  Nothing,
  PriorityChip,
  SecCard,
  SdHead,
  SdTabs,
  StatusChip,
  dash,
  fmtAgo,
  fmtDT,
  has,
  label,
  modStyle,
  num,
  openTicket,
  s,
  sdApi,
  sdErr,
  type Rec,
} from '../serviceDeskShared';

/** The seven gates the spec draws for a scan. */
const SCAN_STEPS: Array<[string, string]> = [
  ['SCAN QR', 'The tag value is read from the camera or the keypad.'],
  ['AUTHENTICATE', 'The caller must already hold a valid session.'],
  ['RBAC', 'The intent must map to a permission the caller holds.'],
  ['ABAC', 'Classification, custody, branch and security attributes are evaluated.'],
  ['ASSET IDENTIFIED', 'The tag resolves to one asset or one machine.'],
  ['VIEW AUTHORIZED DETAILS', 'Only the fields the policy allows are returned.'],
  ['CREATE / VIEW SERVICE TICKETS', 'The intent is carried out and audited.'],
];

interface ActionDef {
  code: string;
  text: string;
  hint: string;
  /** Read intents change nothing; raise intents open a new ticket. */
  kind: 'READ' | 'RAISE' | 'UPDATE';
  perm: string;
  /** Raise intents ask for a subject and a description. */
  needsSubject?: boolean;
}

/**
 * The seven scan intents (asset_service_scans.action). UPDATE_TICKET is a desk
 * action: it needs service_desk.tickets.update, which employee_self_service
 * does not hold, so the employee surface hides it.
 */
const SCAN_ACTIONS: ActionDef[] = [
  {
    code: 'VIEW',
    text: 'View authorized details',
    hint: 'Read the asset card. Custody and financial fields are withheld unless the policy allows them.',
    kind: 'READ',
    perm: 'service_desk.tickets.view',
  },
  {
    code: 'VIEW_ASSET_HISTORY',
    text: 'View asset history',
    hint: 'Ticket counts, recent tickets and inspection figures for this asset.',
    kind: 'READ',
    perm: 'service_desk.tickets.view',
  },
  {
    code: 'VIEW_MAINTENANCE_HISTORY',
    text: 'View maintenance history',
    hint: 'Work orders, maintenance logs, downtime, cost and the next service date.',
    kind: 'READ',
    perm: 'service_desk.tickets.view',
  },
  {
    code: 'REPORT_INCIDENT',
    text: 'Report incident',
    hint: 'Something is broken on this asset. Opens an INCIDENT against it.',
    kind: 'RAISE',
    perm: 'service_desk.tickets.create',
    needsSubject: true,
  },
  {
    code: 'CREATE_SERVICE_REQUEST',
    text: 'Create service request',
    hint: 'Ask for help with this asset. Opens a SERVICE_REQUEST against it.',
    kind: 'RAISE',
    perm: 'service_desk.tickets.create',
    needsSubject: true,
  },
  {
    code: 'REQUEST_MAINTENANCE',
    text: 'Request maintenance',
    hint: 'Opens a MAINTENANCE_REQUEST and files it on the maintenance queue.',
    kind: 'RAISE',
    perm: 'service_desk.tickets.create',
    needsSubject: true,
  },
  {
    code: 'UPDATE_TICKET',
    text: 'Update ticket',
    hint: 'Append a work note to a ticket that is already carrying this asset.',
    kind: 'UPDATE',
    perm: 'service_desk.tickets.update',
  },
];

/** asset_service_scans.outcome - the ledger vocabulary. */
const OUTCOME_META: Record<string, { text: string; tone: string; icon: string }> = {
  SUCCESS: { text: 'Allowed', tone: 'ok', icon: '\u2713' },
  DENIED_RBAC: { text: 'Denied - permission', tone: 'bad', icon: '\u2715' },
  DENIED_ABAC: { text: 'Denied - policy', tone: 'bad', icon: '\u2715' },
  DENIED_SCOPE: { text: 'Denied - scope', tone: 'bad', icon: '\u2715' },
  ASSET_NOT_FOUND: { text: 'Unknown tag', tone: 'warn', icon: '?' },
  ERROR: { text: 'Error', tone: 'warn', icon: '!' },
};

function outcomeMeta(code: unknown): { text: string; tone: string; icon: string } {
  return OUTCOME_META[s(code)] ?? { text: label(code) || 'Unknown', tone: 'warn', icon: '?' };
}

/** How far down the seven gates a response travelled. */
function gatesReached(result: Rec | null): number {
  if (!result) return 0;
  const asset = (result.asset ?? null) as Rec | null;
  if (!asset) return 3;
  const identified = num(asset.assetId) > 0 || num(asset.machineId) > 0;
  if (!identified) return 4;
  const action = s(result.action);
  const carried =
    action === 'REPORT_INCIDENT' ||
    action === 'CREATE_SERVICE_REQUEST' ||
    action === 'REQUEST_MAINTENANCE' ||
    action === 'UPDATE_TICKET';
  return carried && (num(result.ticketId) > 0 || num(result.commentId) > 0) ? 7 : 6;
}

function ScanStepper({ reached, denied }: { reached: number; denied: boolean }) {
  return (
    <ol className="sd-wf" style={{ gridTemplateColumns: 'repeat(7, minmax(0, 1fr))' }}>
      {SCAN_STEPS.map(([text, hint], i) => {
        const n = i + 1;
        const state = denied && n === reached + 1 ? 'on bad' : n <= reached ? 'done' : n === reached + 1 ? 'on' : 'off';
        return (
          <li key={text} className={'sd-wf-step ' + state} title={hint}>
            <span className="sd-wf-num">{state.includes('done') ? '\u2713' : state.includes('bad') ? '\u2715' : n}</span>
            <span className="sd-wf-text">{text}</span>
          </li>
        );
      })}
    </ol>
  );
}

/** A key/value fact that simply disappears when the policy withheld the value. */
function Fact({ k, v, mono }: { k: string; v: unknown; mono?: boolean }) {
  if (v === null || v === undefined || v === '') return null;
  return (
    <div className="sd-fact">
      <span className="sd-fact-k">{k}</span>
      <span className={'sd-fact-v' + (mono ? ' td-cell-mono' : '')}>{s(v)}</span>
    </div>
  );
}

function Statement({ text, tone }: { text: string; tone?: string }) {
  return (
    <p className={'sd-subnote' + (tone ? ' sd-' + tone : '')}>{text}</p>
  );
}
/**
 * The asset card: exactly the fields the ABAC decision released. Anything the
 * policy withheld simply is not rendered, so the absence is a feature.
 */
function AssetCard({ asset, onOpenTicket }: { asset: Rec; onOpenTicket: () => void }) {
  const financial = (asset.financial ?? null) as Rec | null;
  const qr = (asset.qr ?? null) as Rec | null;
  return (
    <SecCard
      title="Affected asset"
      sub="Authorized detail only. Withheld fields are omitted rather than blanked."
      pad
      actions={
        asset.entityType === 'MACHINE' ? (
          <span className="sd-chip sd-chip-public" title="This tag belongs to the machine register">
            Machine register
          </span>
        ) : (
          <span className="sd-chip sd-chip-internal" title="This tag belongs to the asset register">
            Asset register
          </span>
        )
      }
    >
      <div className="sd-asset-hero">
        <div>
          <p className="sd-asset-no td-cell-mono">{s(asset.assetNo)}</p>
          <h3 className="sd-asset-name">{dash(asset.name)}</h3>
        </div>
        <div className="sd-asset-flags">
          <StatusChip value={asset.status} />
          {s(asset.operationalState) && <span className="sd-chip">{label(asset.operationalState)}</span>}
          {s(asset.condition) && <span className="sd-chip">{label(asset.condition)}</span>}
          {asset.isSecure === true && <span className="sd-chip sd-chip-high">Secure device</span>}
          {asset.isMachine === true && <span className="sd-chip">Machine</span>}
        </div>
      </div>

      <div className="sd-facts">
        <Fact k="Asset id" v={asset.assetId} mono />
        <Fact k="Machine id" v={asset.machineId} mono />
        <Fact k="Entity" v={asset.entityType} />
        <Fact k="Category" v={asset.categoryName} />
        <Fact k="Location" v={asset.locationName} />
        <Fact k="Department" v={asset.departmentId} mono />
        <Fact k="Branch" v={asset.branchId} mono />
        <Fact k="Manufacturer" v={asset.manufacturer} />
        <Fact k="Model" v={asset.model} />
        <Fact k="Serial" v={asset.serialNo} mono />
        <Fact k="Custodian" v={asset.custodianName} />
        <Fact k="Custodian no" v={asset.custodianEmployeeNo} mono />
        <Fact k="Maintenance" v={label(asset.maintenanceStatus)} />
        <Fact k="Next service" v={asset.nextMaintenanceDate ? fmtDT(asset.nextMaintenanceDate) : null} />
        <Fact k="Last scan" v={asset.lastScanAt ? fmtAgo(asset.lastScanAt) : null} />
        <Fact k="Last verified" v={asset.lastVerifiedAt ? fmtDT(asset.lastVerifiedAt) : null} />
        {qr && <Fact k="QR tag" v={qr.value} mono />}
        {qr && qr.status !== null && qr.status !== undefined && <Fact k="QR status" v={label(qr.status)} />}
        {financial && <Fact k="Book value" v={num(financial.currentBookValue) || null} />}
        {financial && <Fact k="Warranty" v={label(financial.warrantyStatus)} />}
        {financial && <Fact k="Currency" v={financial.currency} />}
      </div>

      {financial && num(financial.purchaseCost) > 0 && (
        <Statement text={'Purchase cost is held on the asset register and shown to authorized finance roles only.'} />
      )}

      <div className="sd-act-row">
        <button className="btn btn-sm" onClick={onOpenTicket}>Search tickets for this asset</button>
        <button className="btn btn-sm" onClick={() => navigate('/service-desk/new')}>Raise a request</button>
      </div>
    </SecCard>
  );
}

/** The ticket a RAISE or UPDATE intent produced. */
function TicketOutcome({ result, onClose }: { result: Rec; onClose: () => void }) {
  const ticket = (result.ticket ?? null) as Rec | null;
  const workOrder = (result.workOrder ?? null) as Rec | null;
  if (!ticket && !workOrder) return null;
  const sla = ticket ? ((ticket.sla ?? null) as Rec | null) : null;
  const cls = ticket ? ((ticket.classification ?? null) as Rec | null) : null;
  const assign = ticket ? ((ticket.assignment ?? null) as Rec | null) : null;
  const id = num(result.ticketId) || (ticket ? num(ticket.ticketId) : 0);
  const number = s(result.ticketNumber) || (ticket ? s(ticket.ticketNumber) : '');
  return (
    <SecCard
      title={s(result.action) === 'UPDATE_TICKET' ? 'Ticket updated' : 'Ticket raised from the scan'}
      sub="The scan and the ticket share an audit trail end to end."
      pad
      actions={
        id > 0 ? (
          <button className="btn btn-sm btn-primary" onClick={() => openTicket(id)}>
            Open {number || 'ticket'}
          </button>
        ) : null
      }
    >
      <div className="sd-tcard">
        <div className="sd-tcard-top">
          <div>
            <p className="td-cell-mono sd-tcard-no">{number || dash(id)}</p>
            <p className="sd-tcard-subj">{ticket ? dash(ticket.subject) : 'Work order raised'}</p>
          </div>
          <div className="sd-tcard-chips">
            {ticket && <StatusChip value={ticket.status} />}
            {ticket && <PriorityChip value={ticket.priority} compact />}
            {ticket && <span className="sd-chip">{label(ticket.ticketType)}</span>}
          </div>
        </div>
        <div className="sd-facts">
          {cls && <Fact k="Category" v={cls.categoryCode} />}
          {cls && <Fact k="Subcategory" v={cls.subcategoryCode} />}
          {cls && <Fact k="Classified by" v={cls.explicit === true ? 'Caller' : 'Automatic rules'} />}
          {assign && <Fact k="Queue" v={assign.queueId} mono />}
          {assign && <Fact k="Strategy" v={label(assign.strategy)} />}
          {assign && <Fact k="Assigned to" v={assign.assignedToUserId} mono />}
          {assign && assign.strategyDetail !== undefined && assign.strategyDetail !== null && (
            <Fact k="Strategy note" v={(assign.strategyDetail as Rec).fallback ?? (assign.strategyDetail as Rec).effective} />
          )}
          {sla && <Fact k="Respond by" v={sla.responseDueAt ? fmtDT(sla.responseDueAt) : null} />}
          {sla && <Fact k="Resolve by" v={sla.resolutionDueAt ? fmtDT(sla.resolutionDueAt) : null} />}
          {sla && <Fact k="Escalation" v={label(sla.escalationLevel)} />}
        </div>
        {num(result.commentId) > 0 && (
          <Statement text={'Work note #' + s(result.commentId) + ' was appended to the ticket from this scan.'} />
        )}
      </div>
      <div className="sd-act-row">
        <button className="btn btn-sm" onClick={onClose}>Scan another tag</button>
      </div>
    </SecCard>
  );
}

/** Work orders, maintenance logs and totals for the scanned asset. */
function MaintenancePanel({ maintenance }: { maintenance: Rec }) {
  const workOrders = (maintenance.workOrders ?? []) as Rec[];
  const logs = (maintenance.maintenanceLogs ?? []) as Rec[];
  const totals = (maintenance.totals ?? {}) as Rec;
  const runtime = (maintenance.machineRuntime ?? null) as Rec | null;
  const rows = workOrders.length > 0 ? workOrders : logs;
  return (
    <SecCard
      title="Maintenance history"
      sub="Work orders and maintenance logs filed against this asset or machine."
    >
      <div className="sd-facts sd-facts-pad">
        <Fact k="Work orders" v={num(totals.workOrders)} />
        <Fact k="Downtime" v={num(totals.downtimeHours) + ' h'} />
        <Fact k="Cost" v={num(totals.cost)} />
        <Fact k="Next service" v={totals.nextMaintenanceDate ? fmtDT(totals.nextMaintenanceDate) : null} />
        {runtime && <Fact k="Runtime" v={runtime.hours ? num(runtime.hours) + ' h' : null} />}
        {runtime && <Fact k="Last runtime read" v={runtime.readAt ? fmtDT(runtime.readAt) : null} />}
      </div>
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th style={{ width: '150px' }}>Reference</th>
              <th>Work</th>
              <th style={{ width: '130px' }}>Status</th>
              <th style={{ width: '150px' }}>When</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && <EmptyRow cols={4}>No maintenance has been recorded on this asset yet.</EmptyRow>}
            {rows.map((w, i) => (
              <tr key={s(w.id) || String(i)}>
                <td className="td-cell-mono">{dash(w.work_order_number ?? w.order_number ?? w.reference ?? w.machine_code)}</td>
                <td>{dash(w.description ?? w.summary ?? w.title ?? w.work_type)}</td>
                <td>{has(w.status) ? <StatusChip value={w.status} /> : <span className="muted">{dash(w.work_type)}</span>}</td>
                <td className="muted">{fmtDT(w.created_at ?? w.performed_at ?? w.scheduled_date ?? w.logged_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </SecCard>
  );
}

/** Ticket counts and recent tickets for the scanned asset. */
function HistoryPanel({ history, onOpenTicket }: { history: Rec; onOpenTicket: (id: unknown) => void }) {
  const tickets = (history.tickets ?? {}) as Rec;
  const insp = (history.inspections ?? {}) as Rec;
  const recent = (history.recentTickets ?? []) as Rec[];
  return (
    <SecCard title="Asset service history" sub="Every ticket ever raised against this asset, and how often it is inspected.">
      <div className="sd-facts sd-facts-pad">
        <Fact k="Open tickets" v={num(tickets.open)} />
        <Fact k="Total tickets" v={num(tickets.total)} />
        <Fact k="Last 30 days" v={num(tickets.last30Days)} />
        <Fact k="Scans recorded" v={num(insp.scans)} />
        <Fact k="Denied scans" v={num(insp.denials)} />
        <Fact k="Last scan" v={insp.lastScanAt ? fmtDT(insp.lastScanAt) : null} />
      </div>
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th style={{ width: '170px' }}>Ticket</th>
              <th>Subject</th>
              <th style={{ width: '130px' }}>Type</th>
              <th style={{ width: '130px' }}>Status</th>
              <th style={{ width: '110px' }}>Priority</th>
            </tr>
          </thead>
          <tbody>
            {recent.length === 0 && <EmptyRow cols={5}>No tickets have been raised against this asset.</EmptyRow>}
            {recent.map((t) => (
              <tr key={s(t.id)} className="sd-ticket-row" onClick={() => onOpenTicket(t.id)}>
                <td className="td-cell-mono">{dash(t.ticket_number)}</td>
                <td>{dash(t.subject)}</td>
                <td className="muted">{label(t.ticket_type)}</td>
                <td><StatusChip value={t.status} /></td>
                <td><PriorityChip value={t.priority} compact /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </SecCard>
  );
}
/** The scan ledger: who scanned what, when, from where and with what result. */
function LedgerTable({ rows, onOpen }: { rows: Rec[]; onOpen: (r: Rec) => void }) {
  return (
    <div className="table-wrap">
      <table className="table sd-scan-table">
        <thead>
          <tr>
            <th style={{ width: '150px' }}>When</th>
            <th style={{ width: '150px' }}>Scanned by</th>
            <th style={{ width: '130px' }}>Tag</th>
            <th>Asset</th>
            <th style={{ width: '170px' }}>Intent</th>
            <th style={{ width: '160px' }}>Outcome</th>
            <th style={{ width: '150px' }}>Ticket</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <EmptyRow cols={7}>
              No scans recorded for these filters. Every scan - allowed or denied - is written to this ledger.
            </EmptyRow>
          )}
          {rows.map((r) => {
            const meta = outcomeMeta(r.outcome);
            return (
              <tr key={s(r.id)} className="sd-ticket-row" onClick={() => onOpen(r)}>
                <td className="muted">{fmtDT(r.created_at)}</td>
                <td>{dash(r.scanned_by_name)}</td>
                <td className="td-cell-mono">{dash(r.qr_value)}</td>
                <td>
                  <div className="sd-subj-cell">
                    <span className="sd-subj">{dash(r.asset_no)}</span>
                    <span className="sub muted">asset #{dash(r.asset_id)}</span>
                  </div>
                </td>
                <td className="muted">{label(r.action)}</td>
                <td>
                  <span className={'sd-out sd-out-' + meta.tone} title={s(r.deny_reason) || undefined}>
                    <span aria-hidden>{meta.icon}</span> {meta.text}
                  </span>
                  {has(r.deny_reason) && <span className="sub muted">{s(r.deny_reason)}</span>}
                </td>
                <td>
                  {has(r.ticket_number) ? (
                    <span className="td-cell-mono">{s(r.ticket_number)}</span>
                  ) : (
                    <span className="muted">{'\u2013'}</span>
                  )}
                  {has(r.ticket_subject) && <span className="sub muted">{s(r.ticket_subject)}</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function LedgerDetail({ row, onClose }: { row: Rec; onClose: () => void }) {
  const meta = outcomeMeta(row.outcome);
  return (
    <Modal title={'Scan #' + s(row.id)} onClose={onClose} wide>
      <div className="sd-facts">
        <Fact k="When" v={fmtDT(row.created_at)} />
        <Fact k="Scanned by" v={row.scanned_by_name} />
        <Fact k="User id" v={row.scanned_by} mono />
        <Fact k="Employee" v={row.scanned_by_employee_id} mono />
        <Fact k="Outcome" v={meta.text} />
        <Fact k="Deny reason" v={row.deny_reason} />
        <Fact k="Intent" v={label(row.action)} />
        <Fact k="Tag" v={row.qr_value} mono />
        <Fact k="QR record" v={row.qr_code_id} mono />
        <Fact k="Asset no" v={row.asset_no} mono />
        <Fact k="Asset id" v={row.asset_id} mono />
        <Fact k="Ticket" v={row.ticket_number} mono />
        <Fact k="Device" v={row.device} />
        <Fact k="IP address" v={row.ip} mono />
        <Fact k="GPS lat" v={row.gps_lat} mono />
        <Fact k="GPS lng" v={row.gps_lng} mono />
      </div>
      <Statement text="This record is append-only. It cannot be edited or deleted from the Service Desk." />
      <pre className="sd-pre">{JSON.stringify(row.metadata ?? {}, null, 2)}</pre>
    </Modal>
  );
}
const PAGE_SIZE = 25;

export default function ServiceDeskScan() {
  const { user } = useAuth();
  const query = useHashQuery();

  const canRead = can(user, 'service_desk.tickets.view') || can(user, 'service_desk.tickets.view_own');
  const canCreate = can(user, 'service_desk.tickets.create');
  const canUpdate = can(user, 'service_desk.tickets.update');
  const canOverridePriority = can(user, 'service_desk.tickets.assign');
  const isAgent = can(user, 'service_desk.tickets.assign') || can(user, 'service_desk.assets.view');

  const intents = useMemo(
    () =>
      SCAN_ACTIONS.filter((a) => {
        if (a.kind === 'READ') return canRead;
        if (a.code === 'UPDATE_TICKET') return canUpdate;
        return canCreate;
      }),
    [canRead, canCreate, canUpdate]
  );

  const [mode, setMode] = useState<'desk' | 'mine'>(isAgent ? 'desk' : 'mine');
  const [code, setCode] = useState('');
  const [action, setAction] = useState('VIEW');
  const [note, setNote] = useState('');
  const [subject, setSubject] = useState('');
  const [description, setDescription] = useState('');
  const [device, setDevice] = useState('');
  const [ticketId, setTicketId] = useState('');
  const [priority, setPriority] = useState('');
  const [gpsLat, setGpsLat] = useState('');
  const [gpsLng, setGpsLng] = useState('');

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [denied, setDenied] = useState('');
  const [deniedStep, setDeniedStep] = useState(4);
  const [result, setResult] = useState<Rec | null>(null);

  const [rows, setRows] = useState<Rec[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [listErr, setListErr] = useState('');
  const [tick, setTick] = useState(0);
  const [q, setQ] = useState('');
  const [fAction, setFAction] = useState('');
  const [fOutcome, setFOutcome] = useState('');
  const [fFrom, setFFrom] = useState('');
  const [fTo, setFTo] = useState('');
  const [detail, setDetail] = useState<Rec | null>(null);

  const current = intents.find((a) => a.code === action) ?? intents[0] ?? SCAN_ACTIONS[0];

  // A QR deep link lands here as /service-desk/scan?code=HDG-... ; the tag
  // pre-fills so a technician only has to confirm the intent.
  useEffect(() => {
    const c = s(query.get('code') ?? '');
    if (c) setCode(c);
  }, [query]);

  const load = useCallback(async () => {
    setLoading(true);
    setListErr('');
    try {
      const base = mode === 'desk' ? '/api/service-desk' : '/api/my/service-desk';
      const params = new URLSearchParams();
      params.set('page', String(page));
      params.set('pageSize', String(PAGE_SIZE));
      if (q.trim()) params.set('search', q.trim());
      if (fAction) params.set('action', fAction);
      if (fOutcome === 'DENIED') params.set('denialOnly', 'true');
      else if (fOutcome) params.set('outcome', fOutcome);
      if (fFrom) params.set('from', fFrom);
      if (fTo) params.set('to', fTo);
      const data = await sdApi<Rec>(base + '/asset-scans?' + params.toString());
      setRows((data.items as Rec[]) ?? []);
      setTotal(num(data.total));
    } catch (e) {
      setListErr(sdErr(e));
      setRows([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  }, [mode, page, q, fAction, fOutcome, fFrom, fTo]);

  useEffect(() => {
    void load();
  }, [load, tick]);

  const resetOutcome = () => {
    setError('');
    setDenied('');
    setDeniedStep(4);
    setResult(null);
  };

  const submit = async () => {
    const tag = code.trim();
    if (!tag) {
      setError('Scan or type a tag value first.');
      return;
    }
    setBusy(true);
    resetOutcome();
    const base = mode === 'desk' ? '/api/service-desk' : '/api/my/service-desk';
    const payload: Rec = { code: tag, action };
    if (note.trim()) payload.note = note.trim();
    if (device.trim()) payload.device = device.trim();
    if (gpsLat.trim()) payload.gpsLat = Number(gpsLat);
    if (gpsLng.trim()) payload.gpsLng = Number(gpsLng);
    if (current.needsSubject) {
      if (subject.trim()) payload.subject = subject.trim();
      if (description.trim()) payload.description = description.trim();
    }
    if (action === 'UPDATE_TICKET' && ticketId.trim()) payload.ticketId = Number(ticketId.trim());
    if (canOverridePriority && priority) payload.priority = priority;
    try {
      const out = await sdApi<Rec>(base + '/scan', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      setResult(out);
      setTick((v) => v + 1);
    } catch (e) {
      // A refusal is still an audited scan; say so rather than hiding it.
      const msg = sdErr(e);
      setDenied(msg);
      setDeniedStep(/permission|forbidden/i.test(msg) ? 3 : /no asset|not found/i.test(msg) ? 5 : 4);
      setTick((v) => v + 1);
    } finally {
      setBusy(false);
    }
  };

  const locate = () => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      setError('This device does not report a position.');
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (p) => {
        setGpsLat(p.coords.latitude.toFixed(6));
        setGpsLng(p.coords.longitude.toFixed(6));
      },
      () => setError('Location was refused, so the scan will be recorded without GPS.'),
      { timeout: 8000 }
    );
  };

  const reached = gatesReached(result);
  const asset = (result?.asset ?? null) as Rec | null;
  const history = (result?.history ?? null) as Rec | null;
  const maintenance = (result?.maintenance ?? null) as Rec | null;
  const recentTags = useMemo(() => {
    const seen: string[] = [];
    for (const r of rows) {
      const v = s(r.qr_value);
      if (v && seen.indexOf(v) === -1) seen.push(v);
      if (seen.length >= 6) break;
    }
    return seen;
  }, [rows]);

  const allowed = rows.filter((r) => s(r.outcome) === 'SUCCESS').length;
  const refused = rows.length - allowed;

  return (
    <div className="page sd-page" style={modStyle()}>
      <SdHead
        title="Asset QR Service Desk"
        sub="Scan a tag, have the policy decide what you may see, then read, report or maintain the asset. Every scan is written to an immutable ledger."
        kicker={'Service desk \u00b7 asset scans'}
        actions={
          <div className="sd-mode-switch">
            <button
              className={mode === 'mine' ? 'btn btn-sm btn-primary' : 'btn btn-sm'}
              onClick={() => setMode('mine')}
            >
              My scans
            </button>
            {isAgent && (
              <button
                className={mode === 'desk' ? 'btn btn-sm btn-primary' : 'btn btn-sm'}
                onClick={() => setMode('desk')}
              >
                Service desk
              </button>
            )}
          </div>
        }
      />
      <SdTabs active="scan" />

      <KpiRow>
        <KpiTile label="Scans on this page" value={rows.length} sub={'page ' + page} icon={'\u25CF'} />
        <KpiTile label="Allowed" value={allowed} sub="outcome SUCCESS" icon={'\u2713'} />
        <KpiTile
          label="Refused"
          value={refused}
          sub="RBAC, ABAC or scope"
          icon={'\u2715'}
          accent={refused > 0 ? '#FF0000' : undefined}
          tint={refused > 0 ? 'rgba(255,0,0,0.08)' : undefined}
        />
        <KpiTile label="Ledger entries" value={total} sub={mode === 'desk' ? 'whole company' : 'raised by me'} icon={'\u2261'} />
      </KpiRow>

      <div className="grid-2 sd-scan-top">
        <SecCard
          title="Scan a tag"
          sub={'Intents available to ' + dash(user?.first_name) + ' ' + s(user?.last_name)}
          pad
        >
          <div className="sd-form-grid">
            <Field label="Tag or QR value" req hint="Asset number, machine code or QR payload. Spaces are ignored.">
              <Inp value={code} onChange={setCode} placeholder="FSS104" autoFocus />
            </Field>
            <Field label="Intent" req hint={current.hint}>
              <Sel
                value={action}
                onChange={setAction}
                options={intents.map((a) => ({ value: a.code, label: a.text }))}
              />
            </Field>
            {current.needsSubject && (
              <Field label="Subject" hint="Leave blank and the desk names it from the asset and the intent.">
                <Inp value={subject} onChange={setSubject} placeholder="Guillotine cutter will not start" />
              </Field>
            )}
            {current.needsSubject && (
              <Field label="Description" hint="What the technician needs to know before arriving.">
                <Txa value={description} onChange={setDescription} rows={3} />
              </Field>
            )}
            {action === 'UPDATE_TICKET' && (
              <Field label="Ticket id" hint="The ticket must already carry this asset.">
                <Inp value={ticketId} onChange={setTicketId} placeholder="1234" />
              </Field>
            )}
            <Field label="Work note" hint="Recorded on the scan record and, for UPDATE_TICKET, on the ticket.">
              <Inp value={note} onChange={setNote} />
            </Field>
            <Field label="Device" hint="The handset or terminal doing the scanning, for the audit trail.">
              <Inp value={device} onChange={setDevice} placeholder="PDA-07" />
            </Field>
            {canOverridePriority && (
              <Field label="Priority override" hint="Authorized override. The reason travels with the audit record.">
                <Sel
                  value={priority}
                  onChange={setPriority}
                  placeholder="Derive from impact and urgency"
                  options={[
                    { value: 'P1', label: 'P1 Critical' },
                    { value: 'P2', label: 'P2 High' },
                    { value: 'P3', label: 'P3 Medium' },
                    { value: 'P4', label: 'P4 Low' },
                  ]}
                />
              </Field>
            )}
            <Field label="Position" hint="Optional. Recorded with the scan for field verification.">
              <div className="sd-gps">
                <Inp value={gpsLat} onChange={setGpsLat} placeholder="Latitude" />
                <Inp value={gpsLng} onChange={setGpsLng} placeholder="Longitude" />
                <button className="btn btn-sm" onClick={locate}>Use my position</button>
              </div>
            </Field>
          </div>

          {recentTags.length > 0 && (
            <div className="sd-tags sd-tags-pad">
              {recentTags.map((t) => (
                <button key={t} className="chip" onClick={() => setCode(t)}>{t}</button>
              ))}
            </div>
          )}

          <FormErr msg={error} />
          <div className="sd-act-row">
            <button className="btn btn-primary" onClick={submit} disabled={busy || !code.trim()}>
              {busy ? 'Scanning\u2026' : 'Execute scan'}
            </button>
            <button
              className="btn btn-sm"
              onClick={() => {
                resetOutcome();
                setCode('');
                setSubject('');
                setDescription('');
                setNote('');
                setTicketId('');
                setPriority('');
              }}
            >
              Clear
            </button>
          </div>
        </SecCard>

        <div className="sd-stack">
          <SecCard title="Scan flow" sub="The gates every scan passes through, in order." pad>
            <ScanStepper reached={denied !== '' ? deniedStep - 1 : reached} denied={denied !== ''} />
            {busy && <p className="sd-subnote">Resolving the tag\u2026</p>}
            {denied !== '' && (
              <div className="sd-deny">
                <p className="sd-deny-head">
                  <span aria-hidden>{'\u2715'}</span> Scan refused
                </p>
                <p className="sd-deny-body">{denied}</p>
                <p className="sd-subnote">
                  The attempt was still written to the ledger with its outcome and reason. That is the point of the audit.
                </p>
              </div>
            )}
            {result && (
              <p className="sd-subnote">
                Intent <b>{label(result.action)}</b> completed as scan #{s(result.scanId)}.
              </p>
            )}
          </SecCard>

          {!result && denied === '' && (
            <SecCard title="What a scan answers" pad>
              <ul className="sd-bullets">
                <li><b>Who is this?</b> Custody, department, location and branch.</li>
                <li><b>What is wrong?</b> Open tickets and the last 30 days of faults.</li>
                <li><b>When is it due?</b> Maintenance state and the next service date.</li>
                <li><b>What may I see?</b> Only what the classification and scope allow.</li>
              </ul>
              <Nothing
                text="The asset card appears here once a tag resolves."
                action="Open the request form"
                onAction={() => navigate('/service-desk/new')}
              />
            </SecCard>
          )}
        </div>
      </div>

      {result && asset && <AssetCard asset={asset} onOpenTicket={() => navigate('/service-desk/tickets')} />}
      {result && <TicketOutcome result={result} onClose={resetOutcome} />}
      {result && history && <HistoryPanel history={history} onOpenTicket={(id) => openTicket(id)} />}
      {result && maintenance && <MaintenancePanel maintenance={maintenance} />}

      <SecCard
        title="Scan ledger"
        sub="Append-only. Denials are first-class rows, not errors that vanish."
        actions={
          <button className="btn btn-sm" onClick={() => setTick((v) => v + 1)} disabled={loading}>
            {loading ? 'Refreshing\u2026' : 'Refresh'}
          </button>
        }
      >
        <div className="filter-bar sd-filter-bar">
          <Inp value={q} onChange={(v) => { setQ(v); setPage(1); }} placeholder="Search tag, asset or reason" />
          <Sel
            value={fAction}
            onChange={(v) => { setFAction(v); setPage(1); }}
            placeholder="Any intent"
            options={SCAN_ACTIONS.map((a) => ({ value: a.code, label: a.text }))}
          />
          <Sel
            value={fOutcome}
            onChange={(v) => { setFOutcome(v); setPage(1); }}
            placeholder="Any outcome"
            options={[
              { value: 'SUCCESS', label: 'Allowed only' },
              { value: 'DENIED', label: 'Refused only' },
              { value: 'DENIED_RBAC', label: 'Denied - permission' },
              { value: 'DENIED_ABAC', label: 'Denied - policy' },
              { value: 'DENIED_SCOPE', label: 'Denied - scope' },
              { value: 'ASSET_NOT_FOUND', label: 'Unknown tag' },
              { value: 'ERROR', label: 'Error' },
            ]}
          />
          <Inp value={fFrom} onChange={(v) => { setFFrom(v); setPage(1); }} type="date" />
          <Inp value={fTo} onChange={(v) => { setFTo(v); setPage(1); }} type="date" />
          {(q || fAction || fOutcome || fFrom || fTo) && (
            <button
              className="btn btn-sm"
              onClick={() => { setQ(''); setFAction(''); setFOutcome(''); setFFrom(''); setFTo(''); setPage(1); }}
            >
              Clear filters
            </button>
          )}
        </div>
        {listErr ? <ErrorBanner error={listErr} /> : null}
        {loading && rows.length === 0 ? (
          <div className="center-box"><Spinner /></div>
        ) : (
          <LedgerTable rows={rows} onOpen={setDetail} />
        )}
        <div className="table-foot">
          <span className="muted">
            {total === 0
              ? 'No scans'
              : 'Showing ' + (page - 1) * PAGE_SIZE + 1 + '\u2013' + Math.min(page * PAGE_SIZE, total) + ' of ' + total}
          </span>
          <span className="pager">
            <button className="btn btn-sm" disabled={page <= 1 || loading} onClick={() => setPage(page - 1)}>Previous</button>
            <button className="btn btn-sm" disabled={page * PAGE_SIZE >= total || loading} onClick={() => setPage(page + 1)}>Next</button>
          </span>
        </div>
      </SecCard>

      {detail && <LedgerDetail row={detail} onClose={() => setDetail(null)} />}
    </div>
  );
}
