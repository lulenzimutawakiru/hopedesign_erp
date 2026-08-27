import { useCallback, useEffect, useState } from 'react';
import { api, fmtDate, fmtMoney, fmtNum } from '../api';
import { useAuth, can } from '../auth';
import { navigate, useHashQuery } from '../router';
import { Badge, ErrorBanner, Modal, PageLoader } from '../components/ui';
import { ConfirmDialog, EmptyState } from '../components/os';
import { DefRow, DefSec, apiRaw, downloadBlob, labelize, s } from './assetsShared';

type Rec = Record<string, unknown>;

const CUSTODY_RELEASED = new Set(['UNASSIGNED', 'RETURNED', 'TRANSFERRED', 'RELEASED']);

const TABS: Array<[string, string]> = [
  ['overview', 'Overview'],
  ['identity', 'Identity'],
  ['financial', 'Financial'],
  ['custody', 'Custody'],
  ['location', 'Location'],
  ['tags', 'Tags'],
  ['maintenance', 'Maintenance'],
  ['audits', 'Audits'],
  ['documents', 'Documents'],
  ['timeline', 'Timeline'],
];

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function showVal(v: unknown): string {
  if (v === null || v === undefined) return '-';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

async function fetchRows(path: string): Promise<Rec[]> {
  const r = await api<{ data: unknown }>(path);
  const d = r.data;
  if (Array.isArray(d)) return d as Rec[];
  const rr = (d as Rec | null)?.rows;
  return Array.isArray(rr) ? (rr as Rec[]) : [];
}

type PartRow = { productId: number | string; qty: number | string; unitCost: number | string };

function copyText(text: string): void {
  void navigator.clipboard?.writeText(text).catch(() => undefined);
}

function TagRowBadge({ value }: { value: unknown }) {
  const v = s(value);
  if (v === 'ACTIVE' || v === 'ASSIGNED') return <span className="badge badge-green"><span className="badge-icon" aria-hidden>+</span>{labelize(v)}</span>;
  if (v === 'PENDING' || v === 'PRINTED' || v === 'REPLACEMENT_PENDING') return <span className="badge badge-amber"><span className="badge-icon" aria-hidden>~</span>{labelize(v)}</span>;
  if (v === 'VOID' || v === 'ARCHIVED') return <span className="badge badge-neutral"><span className="badge-icon" aria-hidden>-</span>{labelize(v)}</span>;
  if (v === 'DAMAGED' || v === 'LOST') return <span className="badge badge-red"><span className="badge-icon" aria-hidden>!</span>{labelize(v)}</span>;
  return <Badge value={v} />;
}

function QrToken({ code }: { code: unknown }) {
  const [copied, setCopied] = useState(false);
  const text = s(code);
  if (!text) return <span className="muted">No tag generated yet.</span>;
  const doCopy = () => { copyText(text); setCopied(true); setTimeout(() => setCopied(false), 1600); };
  return (
    <div className="card card-pad" style={{ maxWidth: 460 }}>
      <div className="card-head"><h3>Secure QR identity</h3></div>
      <p className="muted" style={{ fontSize: 12, marginTop: 0 }}>Opaque token. It carries no asset details and only resolves through an authenticated, authorized scan.</p>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <code className="cell-mono" style={{ background: 'var(--panel)', padding: '6px 10px', borderRadius: 8 }}>{text}</code>
        <button className="btn btn-sm" onClick={doCopy}>{copied ? 'Copied' : 'Copy token'}</button>
      </div>
    </div>
  );
}

export default function AssetDesk({ id }: { id: number }) {
  const { user } = useAuth();
  const q = useHashQuery();
  const [data, setData] = useState<Rec | null>(null);
  const [error, setError] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  const [notice, setNotice] = useState('');
  const [modal, setModal] = useState('');
  const [confirm, setConfirm] = useState<{ title: string; body: string; label: string; danger?: boolean; onConfirm: (reason: string) => Promise<void> } | null>(null);
  const tab = q.get('tab') ?? 'overview';

  const load = useCallback(async () => {
    const r = await api<{ data: Rec }>(`/api/ops/assets/${id}`);
    setData(r.data);
  }, [id]);

  useEffect(() => {
    setData(null);
    setError('');
    load().catch((e) => setError(e instanceof Error ? e.message : 'Failed to load asset'));
  }, [load, reloadKey]);

  const refresh = () => setReloadKey((k) => k + 1);
  const openTab = (k: string) => navigate(`/assets/${id}?tab=${k}`, { replace: true });

  if (error && !data) return <ErrorBanner error={error} />;
  if (!data) return <PageLoader label="Opening asset 360" />;

  const asset = (data.asset as Rec) ?? {};
  const tags = (data.tags as Rec[]) ?? [];
  const timeline = (data.timeline as Rec[]) ?? [];
  const documents = (data.documents as Rec[]) ?? [];
  const photos = (data.photos as Rec[]) ?? [];
  const maintenance = (data.maintenance as Rec[]) ?? [];
  const audits = (data.audits as Rec[]) ?? [];
  const custody = (data.custody as Rec[]) ?? [];
  const currentCustody = (data.currentCustody as Rec) ?? null;
  const warranties = (data.warranties as Rec[]) ?? [];
  const insurance = (data.insurance as Rec[]) ?? [];
  const comments = (data.comments as Rec[]) ?? [];
  const recentScans = (data.recentScans as Rec[]) ?? [];

  const status = s(asset.status);
  const isTerminal = ['DISPOSED', 'RETIRED', 'ARCHIVED'].includes(status);
  const qr = tags.find((t) => t.status === 'ACTIVE' || t.status === 'ASSIGNED') ?? tags[0] ?? null;

  const actions: Array<{ label: string; onClick: () => void; perm?: string; primary?: boolean }> = [];
  if (!isTerminal && can(user, 'assets.register.update')) actions.push({ label: 'Edit', onClick: () => setModal('edit') });
  if (status === 'DRAFT' && can(user, 'assets.register.submit')) actions.push({ label: 'Submit', primary: true, onClick: () => setModal('submit') });
  if (can(user, 'assets.register.capitalize') && ['REGISTERED', 'AVAILABLE', 'IN_STORE', 'PENDING_APPROVAL'].includes(status)) actions.push({ label: 'Capitalise', onClick: () => setModal('capitalize') });
  if (can(user, 'assets.tags.generate') && ['DRAFT', 'PENDING_APPROVAL', 'REGISTERED', 'IN_STORE', 'AVAILABLE'].includes(status)) actions.push({ label: 'Generate tag', onClick: () => setModal('tag') });
  if (qr && can(user, 'assets.tags.print')) actions.push({ label: 'Print tag', onClick: () => setModal('print') });
  if (qr && can(user, 'assets.tags.replace')) actions.push({ label: 'Replace tag', onClick: () => setModal('replace') });
  if (can(user, 'assets.assignments.create') && ['AVAILABLE', 'IN_STORE', 'REGISTERED', 'RESERVED', 'TRANSFERRED'].includes(status)) actions.push({ label: 'Assign', primary: true, onClick: () => setModal('assign') });
  if (can(user, 'assets.assignments.return') && ['ASSIGNED', 'IN_USE'].includes(status)) actions.push({ label: 'Return', onClick: () => setModal('return') });
  if (can(user, 'assets.maintenance.create') && !isTerminal) actions.push({ label: 'Maintenance', onClick: () => setModal('maintenance') });
  if (can(user, 'assets.register.verify') && !isTerminal) actions.push({ label: 'Verify', onClick: () => setModal('verify') });
  if (can(user, 'assets.register.update') && !['MISSING', 'LOST', 'STOLEN', 'DISPOSED', 'RETIRED', 'ARCHIVED'].includes(status)) actions.push({ label: 'Report missing', onClick: () => setModal('missing') });
  if (status === 'MISSING' && can(user, 'assets.register.update')) actions.push({ label: 'Escalate', onClick: () => setModal('escalate') });
  if (['MISSING', 'LOST', 'STOLEN'].includes(status) && can(user, 'assets.register.update')) actions.push({ label: 'Recover', onClick: () => setModal('recover') });
  if (can(user, 'assets.disposals.create') && !isTerminal) actions.push({ label: 'Dispose', onClick: () => setModal('dispose') });
  if (can(user, 'assets.register.comment')) actions.push({ label: 'Comment', onClick: () => setModal('comment') });

  const act = async (path: string, body?: unknown, msg?: string) => {
    setError('');
    setNotice('');
    try {
      await api(path, { method: 'POST', body: JSON.stringify(body ?? {}) });
      setNotice(msg ?? 'Done');
      setModal('');
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <button className="btn btn-sm" onClick={() => navigate('/assets/register')}>Back to register</button>
          <h1>{s(asset.name)} <span className="cell-mono">{s(asset.asset_no)}</span></h1>
          <div className="page-meta">
            <span>Status <b>{labelize(status)}</b></span>
            <span>Condition <b>{labelize(asset.condition)}</b></span>
            <span>Custody <b>{labelize(asset.custody_status)}</b></span>
            {s(asset.custodian_name) && <span>Custodian <b>{s(asset.custodian_name)}</b></span>}
            {s(asset.location_name) && <span>Location <b>{s(asset.location_name)}</b></span>}
            <span>Book value <b>{fmtMoney(asset.current_book_value)}</b></span>
          </div>
        </div>
        <div className="head-actions">
          {actions.filter((a) => !a.primary).map((a) => (
            <button key={a.label} className="btn" onClick={a.onClick}>{a.label}</button>
          ))}
          {actions.filter((a) => a.primary).map((a) => (
            <button key={a.label} className="btn btn-primary" onClick={a.onClick}>{a.label}</button>
          ))}
        </div>
      </header>
      {notice && <div className="notice-banner">{notice}</div>}
      {error && <ErrorBanner error={error} />}
      <div className="tabs" role="tablist">
        {TABS.map(([k, label]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'tab active' : 'tab'} onClick={() => openTab(k)}>{label}</button>
        ))}
      </div>
      <div className="stack" style={{ marginTop: 14 }}>
        {tab === 'overview' && <OverviewTab asset={asset} tags={tags} qr={qr} currentCustody={currentCustody} recentScans={recentScans} warranties={warranties} insurance={insurance} maintenance={maintenance} onAction={setModal} />}
        {tab === 'identity' && <IdentityTab asset={asset} />}
        {tab === 'financial' && <FinancialTab asset={asset} />}
        {tab === 'custody' && <CustodyTab asset={asset} custody={custody} />}
        {tab === 'location' && <LocationTab asset={asset} />}
        {tab === 'tags' && <TagsTab asset={asset} tags={tags} onAction={setModal} />}
        {tab === 'maintenance' && <MaintenanceTab asset={asset} rows={maintenance} onAction={setModal} />}
        {tab === 'audits' && <AuditsTab asset={asset} rows={audits} />}
        {tab === 'documents' && <DocumentsTab asset={asset} documents={documents} photos={photos} onChanged={refresh} />}
        {tab === 'timeline' && <TimelineTab asset={asset} timeline={timeline} comments={comments} />}
      </div>
      {modal === 'edit' && <EditModal asset={asset} onClose={() => setModal('')} onSaved={() => { setModal(''); refresh(); }} />}
      {modal === 'submit' && (
        <ConfirmDialog title="Submit asset for approval" body="The asset and its generated tag will be submitted for the configured approval workflow." confirmLabel="Submit" onCancel={() => setModal('')} onConfirm={() => void act(`/api/ops/assets/${id}/submit`, {}, 'Submitted for approval')} />
      )}
      {modal === 'capitalize' && <CapitalizeModal asset={asset} onClose={() => setModal('')} onDone={() => { setModal(''); refresh(); }} />}
      {modal === 'tag' && <TagModal asset={asset} onClose={() => setModal('')} onDone={() => { setModal(''); refresh(); }} />}
      {modal === 'print' && <PrintModal asset={asset} tags={tags} onClose={() => setModal('')} onDone={() => { setModal(''); refresh(); }} />}
      {modal === 'replace' && <ReplaceModal asset={asset} onClose={() => setModal('')} onDone={() => { setModal(''); refresh(); }} />}
      {modal === 'assign' && <AssignModal asset={asset} onClose={() => setModal('')} onDone={() => { setModal(''); refresh(); }} />}
      {modal === 'return' && <ReturnModal asset={asset} onClose={() => setModal('')} onDone={() => { setModal(''); refresh(); }} />}
      {modal === 'maintenance' && <MaintenanceModal asset={asset} onClose={() => setModal('')} onDone={() => { setModal(''); refresh(); }} />}
      {modal === 'verify' && <VerifyModal asset={asset} onClose={() => setModal('')} onDone={() => { setModal(''); refresh(); }} />}
      {modal === 'missing' && <MissingModal asset={asset} onClose={() => setModal('')} onDone={() => { setModal(''); refresh(); }} />}
      {modal === 'escalate' && <EscalateModal asset={asset} onClose={() => setModal('')} onDone={() => { setModal(''); refresh(); }} />}
      {modal === 'recover' && <RecoverModal asset={asset} onClose={() => setModal('')} onDone={() => { setModal(''); refresh(); }} />}
      {modal === 'dispose' && <DisposeModal asset={asset} onClose={() => setModal('')} onDone={() => { setModal(''); refresh(); }} />}
      {modal === 'comment' && <CommentModal asset={asset} onClose={() => setModal('')} onDone={() => { setModal(''); refresh(); }} />}
      {confirm && (
        <ConfirmDialog
          title={confirm.title}
          body={confirm.body}
          confirmLabel={confirm.label}
          danger={confirm.danger}
          onCancel={() => setConfirm(null)}
          onConfirm={(reason) => void confirm.onConfirm(reason).finally(() => setConfirm(null))}
        />
      )}
    </div>
  );
}
function OverviewTab({ asset, tags, qr, currentCustody, recentScans, warranties, insurance, maintenance, onAction }: {
  asset: Rec; tags: Rec[]; qr: Rec | null; currentCustody: Rec | null; recentScans: Rec[];
  warranties: Rec[]; insurance: Rec[]; maintenance: Rec[]; onAction: (m: string) => void;
}) {
  const dueMaint = num(asset.next_maintenance) ? new Date(s(asset.next_maintenance)).getTime() <= Date.now() + 14 * 86400000 : false;
  return (
    <div className="grid-3">
      <section className="card def-sec" style={{ gridColumn: '1 / -1' }}>
        <div className="def-sec-head">
          <span className="def-sec-icon" aria-hidden>{s(asset.is_machine) === 'true' || asset.is_machine === true ? 'M' : 'A'}</span>
          <div>
            <h3>{s(asset.name)}</h3>
            <p>{s(asset.asset_no)} - {s(asset.category_name) || labelize(asset.category_id)} {s(asset.serial_no) ? `- SN ${s(asset.serial_no)}` : ''}</p>
          </div>
        </div>
        <div className="form-grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))' }}>
          <div className="field"><label>Status</label><Badge value={asset.status} /></div>
          <div className="field"><label>Condition</label><Badge value={asset.condition} /></div>
          <div className="field"><label>Operational state</label><span className="muted">{labelize(asset.operational_state)}</span></div>
          <div className="field"><label>Custody status</label><span className="muted">{labelize(asset.custody_status)}</span></div>
          <div className="field"><label>Custodian</label><strong>{s(currentCustody ? (currentCustody.custodian_name ?? currentCustody.to_user_name) : (asset.custodian_name ?? 'Unassigned'))}</strong></div>
          <div className="field"><label>Location</label><strong>{s(asset.location_name) || s(asset.building) || 'Not set'}</strong></div>
          <div className="field"><label>Book value</label><strong>{fmtMoney(asset.current_book_value)} {s(asset.currency)}</strong></div>
          <div className="field"><label>Warranty</label><span className="muted">{labelize(asset.warranty_status)}</span></div>
          <div className="field"><label>Insurance</label><span className="muted">{labelize(asset.insurance_status)}</span></div>
          <div className="field"><label>Maintenance</label><span className="muted">{labelize(asset.maintenance_status)}</span></div>
        </div>
        {qr && (
          <div style={{ marginTop: 14 }}>
            <QrToken code={(qr as Rec).qr_code ?? (qr as Rec).code} />
          </div>
        )}
        <div className="quick-actions">
          <button className="btn btn-sm" onClick={() => onAction('tag')}>Tag</button>
          <button className="btn btn-sm" onClick={() => onAction('assign')}>Assign</button>
          <button className="btn btn-sm" onClick={() => onAction('maintenance')}>Maintenance</button>
          <button className="btn btn-sm" onClick={() => onAction('verify')}>Verify</button>
          <button className="btn btn-sm" onClick={() => onAction('dispose')}>Dispose</button>
        </div>
      </section>

      <DefSec icon="F" title="Financial summary" sub="Cost, depreciation and book value">
        <DefRow k="Acquisition cost" v={`${fmtMoney(asset.purchase_cost)} ${s(asset.currency)}`} />
        <DefRow k="Accumulated depreciation" v={fmtMoney(asset.accumulated_depreciation)} />
        <DefRow k="Current book value" v={fmtMoney(asset.current_book_value)} />
        <DefRow k="Capitalized" v={asset.capitalized === true || s(asset.capitalized) === 'true' ? 'Yes' : 'No'} />
        <DefRow k="Capitalization date" v={fmtDate(asset.capitalization_date)} />
        <DefRow k="Useful life" v={s(asset.useful_life_months) ? `${s(asset.useful_life_months)} months` : '-'} />
      </DefSec>

      <DefSec icon="C" title="Custody & assignment" sub="Who holds this asset today">
        <DefRow k="Current custodian" v={s(currentCustody ? (currentCustody.custodian_name ?? currentCustody.to_user_name) : (asset.custodian_name ?? 'Unassigned'))} />
        <DefRow k="Assigned date" v={fmtDate(asset.assigned_date)} />
        <DefRow k="Expected return" v={fmtDate(asset.expected_return_date)} />
        <DefRow k="Department" v={s(asset.department_name) || '-'} />
        <DefRow k="Project" v={s(asset.project_name) || '-'} />
        <DefRow k="Tags" v={`${tags.length} tag(s)`} />
      </DefSec>

      <DefSec icon="T" title="Operational status" sub="Maintenance, warranty and insurance signals">
        <DefRow k="Maintenance status" v={labelize(asset.maintenance_status)} />
        <DefRow k="Last maintenance" v={fmtDate(asset.last_maintenance)} />
        <DefRow k="Next maintenance" v={<span style={{ color: dueMaint ? 'var(--clay)' : undefined }}>{fmtDate(asset.next_maintenance)}{dueMaint ? ' - due soon' : ''}</span>} />
        <DefRow k="Last inspection" v={fmtDate(asset.last_inspection)} />
        <DefRow k="Next inspection" v={fmtDate(asset.next_inspection)} />
        <DefRow k="Warranty" v={warranties.length ? `${labelize(warranties[0].status ?? '')} until ${fmtDate(warranties[0].end_date)}` : labelize(asset.warranty_status)} />
        <DefRow k="Insurance" v={insurance.length ? `${labelize(insurance[0].status ?? '')} until ${fmtDate(insurance[0].end_date)}` : labelize(asset.insurance_status)} />
      </DefSec>

      <section className="card card-pad" style={{ gridColumn: '1 / -1' }}>
        <div className="card-head"><h3>Recent scans</h3></div>
        {recentScans.length === 0 ? (
          <p className="muted">No scans recorded yet.</p>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>When</th><th>Action</th><th>Result</th><th>Location</th><th>User</th></tr></thead>
              <tbody>
                {recentScans.map((r) => (
                  <tr key={String(r.id)}>
                    <td className="cell-mono">{fmtDate(r.created_at)}</td>
                    <td>{labelize(r.scan_type)}</td>
                    <td><Badge value={r.result} /></td>
                    <td>{s(r.location_name) || '-'}</td>
                    <td>{s(r.scanned_by_name) || '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card card-pad" style={{ gridColumn: '1 / -1' }}>
        <div className="card-head"><h3>Recent maintenance</h3></div>
        {maintenance.length === 0 ? (
          <p className="muted">No maintenance work orders yet.</p>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>WO no</th><th>Type</th><th>Status</th><th>Priority</th><th>Cost</th><th>Next due</th></tr></thead>
              <tbody>
                {maintenance.slice(0, 6).map((r) => (
                  <tr key={String(r.id)}>
                    <td className="cell-mono">{s(r.wo_no)}</td>
                    <td>{labelize(r.maintenance_type)}</td>
                    <td><Badge value={r.status} /></td>
                    <td>{labelize(r.priority)}</td>
                    <td className="cell-num">{fmtMoney(r.actual_cost ?? r.estimated_cost)}</td>
                    <td>{fmtDate(r.next_maintenance_date)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
function IdentityTab({ asset }: { asset: Rec }) {
  return (
    <div className="def-sec-grid">
      <DefSec icon="I" title="Identification" sub="How this asset is identified in the register">
        <DefRow k="Asset ID" v={<span className="cell-mono">{s(asset.asset_no)}</span>} mono />
        <DefRow k="Name" v={s(asset.name)} />
        <DefRow k="Category" v={s(asset.category_name) || labelize(asset.category_id)} />
        <DefRow k="Type" v={s(asset.type_name) || labelize(asset.type_id)} />
        <DefRow k="Class" v={s(asset.class_name) || labelize(asset.class_id)} />
        <DefRow k="Description" v={s(asset.description) || '-'} />
      </DefSec>
      <DefSec icon="S" title="Manufacturer & supplier" sub="Origin and procurement identity">
        <DefRow k="Manufacturer" v={s(asset.manufacturer) || '-'} />
        <DefRow k="Model" v={s(asset.model) || '-'} />
        <DefRow k="Serial number" v={<span className="cell-mono">{s(asset.serial_no) || '-'}</span>} mono />
        <DefRow k="Part number" v={s(asset.part_no) || '-'} />
        <DefRow k="SKU" v={s(asset.sku) || '-'} />
        <DefRow k="Barcode" v={<span className="cell-mono">{s(asset.barcode) || '-'}</span>} mono />
        <DefRow k="Supplier" v={s(asset.supplier_name) || '-'} />
      </DefSec>
      <DefSec icon="M" title="Machine profile" sub="Production machine attributes where applicable">
        <DefRow k="Production machine" v={asset.is_machine === true || s(asset.is_machine) === 'true' ? 'Yes' : 'No'} />
        <DefRow k="Machine reference" v={s(asset.machine_ref) || '-'} />
        <DefRow k="High value" v={asset.is_high_value === true || s(asset.is_high_value) === 'true' ? 'Yes' : 'No'} />
        <DefRow k="Serialized" v={asset.is_serialized === false || s(asset.is_serialized) === 'false' ? 'No' : 'Yes'} />
      </DefSec>
      <DefSec icon="O" title="Organisation" sub="Company, branch and department scope">
        <DefRow k="Company" v={s(asset.company_name) || '-'} />
        <DefRow k="Branch" v={s(asset.branch_name) || '-'} />
        <DefRow k="Department" v={s(asset.department_name) || '-'} />
        <DefRow k="Cost centre" v={s(asset.cost_centre_name) || '-'} />
        <DefRow k="Project" v={s(asset.project_name) || '-'} />
      </DefSec>
    </div>
  );
}

function FinancialTab({ asset }: { asset: Rec }) {
  const entries = ((asset as Rec).depreciation_schedule as Rec[]) ?? [];
  return (
    <div className="stack">
      <div className="grid-3">
        <DefSec icon="C" title="Acquisition" sub="How the asset entered the books">
          <DefRow k="Purchase cost" v={`${fmtMoney(asset.purchase_cost)} ${s(asset.currency)}`} />
          <DefRow k="Purchase date" v={fmtDate(asset.purchase_date)} />
          <DefRow k="PO number" v={<span className="cell-mono">{s(asset.po_number) || '-'}</span>} mono />
          <DefRow k="Invoice number" v={<span className="cell-mono">{s(asset.invoice_number) || '-'}</span>} mono />
          <DefRow k="GRN number" v={<span className="cell-mono">{s(asset.grn_number) || '-'}</span>} mono />
          <DefRow k="Capitalization date" v={fmtDate(asset.capitalization_date)} />
          <DefRow k="Capitalized" v={asset.capitalized === true || s(asset.capitalized) === 'true' ? 'Yes' : 'No'} />
        </DefSec>
        <DefSec icon="D" title="Depreciation" sub="Method, life and accumulated charge">
          <DefRow k="Method" v={labelize(asset.depreciation_method)} />
          <DefRow k="Useful life" v={s(asset.useful_life_months) ? `${s(asset.useful_life_months)} months` : '-'} />
          <DefRow k="Residual value" v={fmtMoney(asset.residual_value)} />
          <DefRow k="Accumulated depreciation" v={fmtMoney(asset.accumulated_depreciation)} />
          <DefRow k="Current book value" v={fmtMoney(asset.current_book_value)} />
          <DefRow k="Net book value" v={fmtMoney(num(asset.current_book_value) - num(asset.accumulated_depreciation))} />
          <DefRow k="End of life" v={fmtDate(asset.eol_date)} />
        </DefSec>
        <DefSec icon="G" title="Accounting reference" sub="Source-of-truth GL posting">
          <DefRow k="GL journal" v={s(asset.gl_journal_no) || (asset.gl_journal_id ? `Journal #${s(asset.gl_journal_id)}` : '-')} />
          <DefRow k="Depreciation config" v={s(asset.depreciation_config) || '-'} />
        </DefSec>
      </div>
      <section className="card card-pad">
        <div className="card-head"><h3>Depreciation schedule</h3></div>
        {entries.length === 0 ? (
          <p className="muted">Open the Depreciation module to run and post the schedule.</p>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Period</th><th>Method</th><th className="cell-num">Charge</th><th className="cell-num">Accumulated</th><th className="cell-num">Book value</th><th>Status</th></tr></thead>
              <tbody>
                {entries.map((e) => (
                  <tr key={String(e.id)}>
                    <td className="cell-mono">{s(e.period_label) || s(e.period)}</td>
                    <td>{labelize(e.method)}</td>
                    <td className="cell-num">{fmtMoney(e.amount)}</td>
                    <td className="cell-num">{fmtMoney(e.accumulated)}</td>
                    <td className="cell-num">{fmtMoney(e.book_value)}</td>
                    <td><Badge value={e.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
function CustodyTab({ asset, custody }: { asset: Rec; custody: Rec[] }) {
  return (
    <div className="stack">
      <div className="grid-2">
        <DefSec icon="H" title="Current custody" sub="Who is accountable right now">
          <DefRow k="Custodian" v={s(asset.custodian_name) || 'Unassigned'} />
          <DefRow k="Custody status" v={labelize(asset.custody_status)} />
          <DefRow k="Assigned date" v={fmtDate(asset.assigned_date)} />
          <DefRow k="Expected return" v={fmtDate(asset.expected_return_date)} />
        </DefSec>
        <DefSec icon="L" title="History" sub="Complete custody ledger">
          <DefRow k="Assignments on record" v={String(custody.length)} />
          <DefRow k="Last release" v={fmtDate(custody.find((c) => CUSTODY_RELEASED.has(s(c.custody_status)))?.released_at)} />
        </DefSec>
      </div>
      <section className="card card-pad">
        <div className="card-head"><h3>Custody ledger</h3></div>
        {custody.length === 0 ? (
          <EmptyState title="No custody history" body="Assign this asset to an employee, department or project to start the ledger." />
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Custodian</th><th>From</th><th>To</th><th>Status</th><th>Assigned</th><th>Expected return</th><th>Accepted</th></tr></thead>
              <tbody>
                {custody.map((c) => (
                  <tr key={String(c.id)}>
                    <td><strong>{s(c.custodian_name) || s(c.to_user_name)}</strong>{s(c.from_user_name) ? <div className="muted">from {s(c.from_user_name)}</div> : null}</td>
                    <td>{s(c.department_name) || '-'}</td>
                    <td>{s(c.to_department_name) || '-'}</td>
                    <td><Badge value={c.custody_status} /></td>
                    <td>{fmtDate(c.assigned_date)}</td>
                    <td>{fmtDate(c.expected_return_date)}</td>
                    <td>{fmtDate(c.accepted_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function LocationTab({ asset }: { asset: Rec }) {
  const chain: string[] = [];
  if (s(asset.company_name)) chain.push(s(asset.company_name));
  if (s(asset.branch_name)) chain.push(s(asset.branch_name));
  if (s(asset.building)) chain.push(s(asset.building));
  if (s(asset.floor)) chain.push(s(asset.floor));
  if (s(asset.department_name)) chain.push(s(asset.department_name));
  if (s(asset.location_name)) chain.push(s(asset.location_name));
  if (s(asset.room)) chain.push(s(asset.room));
  if (s(asset.rack_bin) || s(asset.bin)) chain.push(s(asset.rack_bin) || s(asset.bin));
  return (
    <div className="stack">
      <DefSec icon="P" title="Hierarchical location" sub="Company to rack/bin">
        {chain.length === 0 ? (
          <DefRow k="Location" v={<span className="muted">No location assigned yet.</span>} />
        ) : (
          chain.map((step, i) => (
            <DefRow key={`${i}-${step}`} k={i === 0 ? 'Location path' : i === 1 ? 'Branch' : i === 2 ? 'Building' : i === 3 ? 'Floor' : i === 4 ? 'Department' : i === chain.length - 1 ? 'Room / bin' : 'Level'} v={step} />
          ))
        )}
        <DefRow k="Warehouse" v={s(asset.warehouse_name) || '-'} />
        <DefRow k="Last scan location" v={s(asset.last_scan_location_name) || '-'} />
        <DefRow k="Last verified" v={fmtDate(asset.last_verified_at)} />
      </DefSec>
      <section className="card card-pad">
        <div className="card-head"><h3>Movement map</h3></div>
        <p className="muted" style={{ marginTop: 0 }}>Open the Timeline tab to view the full movement history with dates, users and approvals. Every location change is recorded with an audit event.</p>
        <button className="btn btn-sm" onClick={() => navigate(`/assets/${Number(asset.id)}?tab=timeline`, { replace: true })}>View movement history</button>
      </section>
    </div>
  );
}
function TagsTab({ asset, tags, onAction }: { asset: Rec; tags: Rec[]; onAction: (m: string) => void }) {
  const active = tags.find((t) => t.status === 'ACTIVE' || t.status === 'ASSIGNED');
  const events = ((asset as Rec).tag_events as Rec[]) ?? [];
  return (
    <div className="stack">
      <div className="grid-2">
        <section className="card card-pad">
          <div className="card-head"><h3>Physical tag</h3></div>
          {active ? (
            <>
              <p className="muted" style={{ marginTop: 0 }}>Active tag for this asset. The QR payload is an opaque secure token.</p>
              <QrToken code={(active as Rec).qr_code ?? (active as Rec).code} />
              <div className="def-list" style={{ marginTop: 10 }}>
                <DefRow k="Tag number" v={<span className="cell-mono">{s((active as Rec).tag_no)}</span>} mono />
                <DefRow k="Tag type" v={labelize((active as Rec).tag_type)} />
                <DefRow k="Status" v={<TagRowBadge value={(active as Rec).status} />} />
                <DefRow k="Printed" v={fmtDate((active as Rec).printed_at)} />
                <DefRow k="Attached" v={fmtDate((active as Rec).attached_at)} />
              </div>
            </>
          ) : (
            <EmptyState
              title="No active tag"
              body="Generate a QR or barcode tag so this asset can be scanned in the field."
              action="Generate tag"
              onAction={() => onAction('tag')}
            />
          )}
        </section>
        <DefSec icon="Q" title="Tag states" sub="A voided tag is never reactivated">
          <DefRow k="Total tags" v={String(tags.length)} />
          <DefRow k="Active" v={String(tags.filter((t) => ['ACTIVE', 'ASSIGNED'].includes(s(t.status))).length)} />
          <DefRow k="Pending / printed" v={String(tags.filter((t) => ['PENDING', 'PRINTED'].includes(s(t.status))).length)} />
          <DefRow k="Replaced" v={String(tags.filter((t) => ['REPLACED', 'REPLACEMENT_PENDING'].includes(s(t.status))).length)} />
          <DefRow k="Void / archived" v={String(tags.filter((t) => ['VOID', 'ARCHIVED'].includes(s(t.status))).length)} />
        </DefSec>
      </div>
      <section className="card card-pad">
        <div className="card-head"><h3>Tag history</h3></div>
        {tags.length === 0 ? (
          <p className="muted">No tags yet.</p>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Tag no</th><th>Type</th><th>Status</th><th>Printed</th><th>Attached</th><th>Replaces</th><th>Voided</th></tr></thead>
              <tbody>
                {tags.map((t) => (
                  <tr key={String(t.id)}>
                    <td className="cell-mono">{s(t.tag_no)}</td>
                    <td>{labelize(t.tag_type)}</td>
                    <td><TagRowBadge value={t.status} /></td>
                    <td>{fmtDate(t.printed_at)}</td>
                    <td>{fmtDate(t.attached_at)}</td>
                    <td className="cell-mono">{s(t.replacement_of_id) || '-'}</td>
                    <td>{fmtDate(t.voided_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <section className="card card-pad">
        <div className="card-head"><h3>Tag events</h3></div>
        {events.length === 0 ? (
          <p className="muted">No tag events recorded.</p>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Event</th><th>Detail</th><th>When</th><th>User</th></tr></thead>
              <tbody>
                {events.map((e) => (
                  <tr key={String(e.id)}>
                    <td>{labelize(e.event_type)}</td>
                    <td>{s(e.description) || s(e.reason) || '-'}</td>
                    <td className="cell-mono">{fmtDate(e.created_at)}</td>
                    <td>{s(e.user_name) || '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function MaintenanceTab({ asset, rows, onAction }: { asset: Rec; rows: Rec[]; onAction: (m: string) => void }) {
  const totalCost = rows.reduce((acc, r) => acc + (num(r.actual_cost) || num(r.cost)), 0);
  return (
    <div className="stack">
      <section className="card card-pad">
        <div className="card-head">
          <div>
            <h3>Maintenance history</h3>
            <p className="muted" style={{ margin: '2px 0 0' }}>{s(asset.asset_no)} - {rows.length} work order(s), {fmtMoney(totalCost)} total cost</p>
          </div>
          <button className="btn btn-sm btn-primary" onClick={() => onAction('maintenance')}>New work order</button>
        </div>
        {rows.length === 0 ? (
          <p className="muted">No maintenance work orders recorded for this asset.</p>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>WO no</th><th>Type</th><th>Priority</th><th>Status</th><th>Cost</th><th>Downtime</th><th>Scheduled</th><th>Next due</th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={String(r.id)}>
                    <td className="cell-mono">{s(r.wo_no)}</td>
                    <td>{labelize(r.maintenance_type)}</td>
                    <td>{labelize(r.priority)}</td>
                    <td><Badge value={r.status} /></td>
                    <td className="cell-num">{fmtMoney(r.actual_cost ?? r.cost)}</td>
                    <td className="cell-num">{num(r.downtime_hours) ? `${s(r.downtime_hours)}h` : '-'}</td>
                    <td>{fmtDate(r.scheduled_date)}</td>
                    <td>{fmtDate(r.next_maintenance_date)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function AuditsTab({ asset, rows }: { asset: Rec; rows: Rec[] }) {
  return (
    <div className="stack">
      <section className="card card-pad">
        <div className="card-head"><h3>Asset audits</h3></div>
        <p className="muted" style={{ marginTop: 0 }}>Audit participation for {s(asset.asset_no)}. Every scan and exception is recorded in the audit trail.</p>
        {rows.length === 0 ? (
          <p className="muted">This asset has not been included in any audit yet.</p>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Audit no</th><th>Type</th><th>Status</th><th>Expected</th><th>Verified</th><th>Started</th><th>Completed</th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={String(r.id)}>
                    <td className="cell-mono">{s(r.audit_no)}</td>
                    <td>{labelize(r.audit_type)}</td>
                    <td><Badge value={r.status} /></td>
                    <td className="cell-num">{num(r.expected_count) || '-'}</td>
                    <td className="cell-num">{num(r.verified_count) || '-'}</td>
                    <td>{fmtDate(r.started_at)}</td>
                    <td>{fmtDate(r.completed_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function DocumentsTab({ asset, documents, photos, onChanged }: { asset: Rec; documents: Rec[]; photos: Rec[]; onChanged: () => void }) {
  const DOC_CATEGORIES = ['PURCHASE_INVOICE', 'PO', 'WARRANTY', 'MANUAL', 'CERTIFICATE', 'INSURANCE', 'INSPECTION_CERTIFICATE', 'MAINTENANCE_REPORT', 'TRANSFER_FORM', 'ASSIGNMENT_FORM', 'DISPOSAL_APPROVAL', 'PHOTO', 'OTHER'];
  const PHOTO_CATEGORIES = ['FRONT', 'BACK', 'SERIAL_NUMBER', 'QR_TAG', 'CONDITION', 'DAMAGE', 'LOCATION', 'OTHER'];
  const [title, setTitle] = useState('');
  const [category, setCategory] = useState('OTHER');
  const [description, setDescription] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [photoCategory, setPhotoCategory] = useState('OTHER');
  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const aid = num(asset.id);

  const uploadDoc = async () => {
    if (!file) { setError('Choose a file to upload.'); return; }
    setBusy(true); setError('');
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('title', title || s(file.name));
      fd.append('category', category || 'OTHER');
      if (description) fd.append('description', description);
      if (expiresAt) fd.append('expiresAt', expiresAt);
      const res = await apiRaw(`/api/ops/assets/${aid}/documents`, { method: 'POST', body: fd });
      if (!res.ok) {
        let msg = `Upload failed (${res.status})`;
        try { const b = await res.json(); msg = b?.error?.message ?? msg; } catch { /* not json */ }
        throw new Error(msg);
      }
      setTitle(''); setDescription(''); setExpiresAt(''); setFile(null);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Upload failed');
    } finally {
      setBusy(false);
    }
  };

  const uploadPhoto = async () => {
    if (!photoFile) { setError('Choose a photo to upload.'); return; }
    setBusy(true); setError('');
    try {
      const fd = new FormData();
      fd.append('file', photoFile);
      fd.append('category', photoCategory || 'OTHER');
      const res = await apiRaw(`/api/ops/assets/${aid}/photos`, { method: 'POST', body: fd });
      if (!res.ok) {
        let msg = `Upload failed (${res.status})`;
        try { const b = await res.json(); msg = b?.error?.message ?? msg; } catch { /* not json */ }
        throw new Error(msg);
      }
      setPhotoFile(null);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Photo upload failed');
    } finally {
      setBusy(false);
    }
  };

  const download = (d: Rec) => {
    downloadBlob(`/api/ops/assets/${aid}/documents/${num(d.id)}/file`, s(d.file_name) || 'document').catch((e) => setError(e instanceof Error ? e.message : 'Download failed'));
  };

  const removeDoc = async (d: Rec) => {
    setBusy(true); setError('');
    try {
      await api(`/api/ops/assets/${aid}/documents/${num(d.id)}`, { method: 'DELETE', body: JSON.stringify({ reason: 'Removed from asset 360' }) });
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Delete failed');
      setBusy(false);
    }
  };

  const removePhoto = async (p: Rec) => {
    setBusy(true); setError('');
    try {
      await api(`/api/ops/assets/${aid}/photos/${num(p.id)}`, { method: 'DELETE', body: JSON.stringify({ reason: 'Removed from asset 360' }) });
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Delete failed');
      setBusy(false);
    }
  };

  return (
    <div className="stack">
      {error && <ErrorBanner error={error} />}
      <section className="card card-pad">
        <div className="card-head"><h3>Upload document</h3></div>
        <div className="form-grid">
          <div className="field" style={{ gridColumn: '1 / -1' }}>
            <label htmlFor="dt-file">File</label>
            <input id="dt-file" type="file" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          </div>
          <div className="field">
            <label htmlFor="dt-title">Title</label>
            <input id="dt-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Purchase invoice, warranty cert..." />
          </div>
          <div className="field">
            <label htmlFor="dt-cat">Category</label>
            <select id="dt-cat" value={category} onChange={(e) => setCategory(e.target.value)}>
              {DOC_CATEGORIES.map((c) => <option key={c} value={c}>{labelize(c)}</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor="dt-exp">Expires</label>
            <input id="dt-exp" type="date" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} />
          </div>
          <div className="field" style={{ gridColumn: '1 / -1' }}>
            <label htmlFor="dt-desc">Description</label>
            <input id="dt-desc" value={description} onChange={(e) => setDescription(e.target.value)} />
          </div>
        </div>
        <div className="quick-actions">
          <button className="btn btn-sm btn-primary" disabled={busy || !file} onClick={() => void uploadDoc()}>{busy ? 'Uploading...' : 'Upload document'}</button>
        </div>
      </section>
      <section className="card card-pad">
        <div className="card-head"><h3>Documents</h3></div>
        {documents.length === 0 ? (
          <p className="muted">No documents attached.</p>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Doc no</th><th>Title</th><th>Category</th><th>Version</th><th>Status</th><th>Size</th><th></th></tr></thead>
              <tbody>
                {documents.map((d) => (
                  <tr key={String(d.id)}>
                    <td className="cell-mono">{s(d.doc_no)}</td>
                    <td>{s(d.title) || s(d.file_name)}</td>
                    <td>{labelize(d.category)}</td>
                    <td>{s(d.version) || '-'}</td>
                    <td><Badge value={d.status} /></td>
                    <td>{fmtNum(num(d.file_size))} B</td>
                    <td className="td-actions">
                      <button className="btn btn-sm" onClick={() => download(d)}>Download</button>
                      <button className="btn btn-sm btn-danger" disabled={busy} onClick={() => void removeDoc(d)}>Delete</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <section className="card card-pad">
        <div className="card-head"><h3>Photos</h3></div>
        <div className="form-grid">
          <div className="field">
            <label htmlFor="pt-file">Photo</label>
            <input id="pt-file" type="file" accept="image/*" onChange={(e) => setPhotoFile(e.target.files?.[0] ?? null)} />
          </div>
          <div className="field">
            <label htmlFor="pt-cat">Category</label>
            <select id="pt-cat" value={photoCategory} onChange={(e) => setPhotoCategory(e.target.value)}>
              {PHOTO_CATEGORIES.map((c) => <option key={c} value={c}>{labelize(c)}</option>)}
            </select>
          </div>
          <div className="field" style={{ display: 'flex', alignItems: 'flex-end' }}>
            <button className="btn btn-sm btn-primary" disabled={busy || !photoFile} onClick={() => void uploadPhoto()}>{busy ? 'Uploading...' : 'Upload photo'}</button>
          </div>
        </div>
        {photos.length === 0 ? (
          <p className="muted">No photos attached.</p>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Category</th><th>File</th><th>Uploaded</th><th></th></tr></thead>
              <tbody>
                {photos.map((p) => (
                  <tr key={String(p.id)}>
                    <td>{labelize(p.category)}</td>
                    <td>{s(p.file_name) || '-'}</td>
                    <td>{fmtDate(p.created_at)}</td>
                    <td className="td-actions">
                      <button className="btn btn-sm btn-danger" disabled={busy} onClick={() => void removePhoto(p)}>Delete</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function TimelineTab({ asset, timeline, comments }: { asset: Rec; timeline: Rec[]; comments: Rec[] }) {
  return (
    <div className="stack">
      <section className="card card-pad">
        <div className="card-head"><h3>Asset timeline</h3></div>
        <p className="muted" style={{ marginTop: 0 }}>Every lifecycle event for {s(asset.asset_no)} with user, date, previous and new value.</p>
        {timeline.length === 0 ? (
          <p className="muted">No lifecycle events recorded yet.</p>
        ) : (
          <div className="timeline">
            {timeline.map((t) => (
              <div key={String(t.id)} className="timeline-item">
                <span className="timeline-dot" aria-hidden />
                <div className="timeline-body">
                  <div className="timeline-title">{s(t.title) || labelize(t.event_type)}</div>
                  {s(t.description) && <p className="muted" style={{ margin: '2px 0' }}>{s(t.description)}</p>}
                  {(showVal(t.old_value) !== '-' || showVal(t.new_value) !== '-') && (
                    <p className="muted" style={{ margin: '2px 0' }}>
                      <span className="cell-mono">{showVal(t.old_value)}</span> -&gt; <span className="cell-mono">{showVal(t.new_value)}</span>
                    </p>
                  )}
                  {s(t.reason) && <p className="muted" style={{ margin: '2px 0' }}>Reason: {s(t.reason)}</p>}
                  {s(t.reference_doc_id) && <p className="muted" style={{ margin: '2px 0' }}>Ref: {s(t.reference_doc_id)}</p>}
                  <div className="timeline-meta">{fmtDate(t.occurred_at)}{s(t.user_name) ? ` by ${s(t.user_name)}` : ''}{s(t.location_name) ? ` at ${s(t.location_name)}` : ''}</div>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
      <section className="card card-pad">
        <div className="card-head"><h3>Comments</h3></div>
        {comments.length === 0 ? (
          <p className="muted">No comments recorded.</p>
        ) : (
          <div className="stack">
            {comments.map((c) => (
              <div key={String(c.id)} className="callout" style={{ marginBottom: 0 }}>
                <div className="callout-body">
                  <p style={{ margin: '0 0 4px' }}>{s(c.body)}</p>
                  <span className="timeline-meta">{s(c.created_by)} - {fmtDate(c.created_at)}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function EditModal({ asset, onClose, onSaved }: { asset: Rec; onClose: () => void; onSaved: () => void }) {
  const CURRENCIES = ['UGX', 'USD', 'KES', 'GBP', 'EUR'];
  const DEP_METHODS = ['STRAIGHT_LINE', 'REDUCING_BALANCE', 'UNITS_OF_PRODUCTION', 'CUSTOM', 'NONE'];
  const [categories, setCategories] = useState<Rec[]>([]);
  const [types, setTypes] = useState<Rec[]>([]);
  const [classes, setClasses] = useState<Rec[]>([]);
  const [locations, setLocations] = useState<Rec[]>([]);
  const [warehouses, setWarehouses] = useState<Rec[]>([]);
  const [departments, setDepartments] = useState<Rec[]>([]);
  const [projects, setProjects] = useState<Rec[]>([]);
  const [suppliers, setSuppliers] = useState<Rec[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const locked = s(asset.status) !== 'DRAFT';

  const [name, setName] = useState(s(asset.name));
  const [description, setDescription] = useState(s(asset.description));
  const [manufacturer, setManufacturer] = useState(s(asset.manufacturer));
  const [model, setModel] = useState(s(asset.model));
  const [serialNo, setSerialNo] = useState(s(asset.serial_no));
  const [partNo, setPartNo] = useState(s(asset.part_no));
  const [sku, setSku] = useState(s(asset.sku));
  const [barcode, setBarcode] = useState(s(asset.barcode));
  const [categoryId, setCategoryId] = useState(String(asset.category_id ?? ''));
  const [typeId, setTypeId] = useState(String(asset.type_id ?? ''));
  const [classId, setClassId] = useState(String(asset.class_id ?? ''));
  const [isMachine, setIsMachine] = useState(asset.is_machine === true || s(asset.is_machine) === 'true');
  const [machineRef, setMachineRef] = useState(s(asset.machine_ref));
  const [isHighValue, setIsHighValue] = useState(asset.is_high_value === true || s(asset.is_high_value) === 'true');
  const [isSerialized, setIsSerialized] = useState(asset.is_serialized === true || s(asset.is_serialized) === 'true');
  const [departmentId, setDepartmentId] = useState(String(asset.department_id ?? ''));
  const [costCentreId, setCostCentreId] = useState(String(asset.cost_centre_id ?? ''));
  const [projectId, setProjectId] = useState(String(asset.project_id ?? ''));
  const [locationId, setLocationId] = useState(String(asset.location_id ?? ''));
  const [warehouseId, setWarehouseId] = useState(String(asset.warehouse_id ?? ''));
  const [branchId, setBranchId] = useState(String(asset.branch_id ?? ''));
  const [floor, setFloor] = useState(s(asset.floor));
  const [room, setRoom] = useState(s(asset.room));
  const [building, setBuilding] = useState(s(asset.building));
  const [purchaseCost, setPurchaseCost] = useState(s(asset.purchase_cost));
  const [currency, setCurrency] = useState(s(asset.currency) || 'UGX');
  const [purchaseDate, setPurchaseDate] = useState(s(asset.purchase_date).slice(0, 10));
  const [supplierId, setSupplierId] = useState(String(asset.supplier_id ?? ''));
  const [poNumber, setPoNumber] = useState(s(asset.po_number));
  const [invoiceNumber, setInvoiceNumber] = useState(s(asset.invoice_number));
  const [grnNumber, setGrnNumber] = useState(s(asset.grn_number));
  const [capitalizationDate, setCapitalizationDate] = useState(s(asset.capitalization_date).slice(0, 10));
  const [usefulLifeMonths, setUsefulLifeMonths] = useState(s(asset.useful_life_months));
  const [residualValue, setResidualValue] = useState(s(asset.residual_value));
  const [depreciationMethod, setDepreciationMethod] = useState(s(asset.depreciation_method) || 'STRAIGHT_LINE');
  const [expectedReturnDate, setExpectedReturnDate] = useState(s(asset.expected_return_date).slice(0, 10));
  const [eolDate, setEolDate] = useState(s(asset.eol_date).slice(0, 10));

  useEffect(() => {
    fetchRows('/api/assets/categories?pageSize=500').then(setCategories).catch(() => undefined);
    fetchRows('/api/assets/types').then(setTypes).catch(() => undefined);
    fetchRows('/api/assets/classes').then(setClasses).catch(() => undefined);
    fetchRows('/api/assets/locations?pageSize=500').then(setLocations).catch(() => undefined);
    fetchRows('/api/inventory/warehouses').then(setWarehouses).catch(() => undefined);
    fetchRows('/api/ops/hr/departments').then(setDepartments).catch(() => undefined);
    fetchRows('/api/hr/projects').then(setProjects).catch(() => undefined);
    api<{ data: unknown }>('/api/ops/procurement/suppliers')
      .then((r) => setSuppliers(Array.isArray(r.data) ? (r.data as Rec[]) : []))
      .catch(() => undefined);
  }, []);

  const toNum = (v: string) => (v === '' ? undefined : Number(v));

  const save = async () => {
    setBusy(true); setError('');
    const body: Rec = {
      name: name || undefined,
      description: description || undefined,
      manufacturer: manufacturer || undefined,
      model: model || undefined,
      serialNo: serialNo || undefined,
      partNo: partNo || undefined,
      sku: sku || undefined,
      barcode: barcode || undefined,
      categoryId: toNum(categoryId),
      typeId: toNum(typeId),
      classId: toNum(classId),
      isMachine: isMachine || undefined,
      machineRef: machineRef || undefined,
      isHighValue: isHighValue || undefined,
      isSerialized: isSerialized || undefined,
      departmentId: toNum(departmentId),
      costCentreId: toNum(costCentreId),
      projectId: toNum(projectId),
      locationId: toNum(locationId),
      warehouseId: toNum(warehouseId),
      branchId: toNum(branchId),
      floor: floor || undefined,
      room: room || undefined,
      building: building || undefined,
      expectedReturnDate: expectedReturnDate || undefined,
      eolDate: eolDate || undefined,
    };
    if (!locked) {
      body.purchaseCost = purchaseCost === '' ? undefined : Number(purchaseCost);
      body.currency = currency || undefined;
      body.purchaseDate = purchaseDate || undefined;
      body.supplierId = toNum(supplierId);
      body.poNumber = poNumber || undefined;
      body.invoiceNumber = invoiceNumber || undefined;
      body.grnNumber = grnNumber || undefined;
      body.capitalizationDate = capitalizationDate || undefined;
      body.usefulLifeMonths = usefulLifeMonths === '' ? undefined : Number(usefulLifeMonths);
      body.residualValue = residualValue === '' ? undefined : Number(residualValue);
      body.depreciationMethod = depreciationMethod || undefined;
    }
    try {
      await api(`/api/ops/assets/${num(asset.id)}`, { method: 'PATCH', body: JSON.stringify(body) });
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
      setBusy(false);
    }
  };

  return (
    <Modal title={`Edit ${s(asset.asset_no)}`} onClose={onClose} wide footer={
      <div className="quick-actions">
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={busy} onClick={() => void save()}>{busy ? 'Saving...' : 'Save changes'}</button>
      </div>
    }>
      <div className="stack">
        {error && <ErrorBanner error={error} />}
        <h4>Identification</h4>
        <div className="form-grid">
          <div className="field" style={{ gridColumn: '1 / -1' }}>
            <label htmlFor="em-name">Asset name</label>
            <input id="em-name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="field" style={{ gridColumn: '1 / -1' }}>
            <label htmlFor="em-desc">Description</label>
            <textarea id="em-desc" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="em-cat">Category</label>
            <select id="em-cat" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
              <option value="">Not set</option>
              {categories.map((c) => <option key={s(c.id)} value={s(c.id)}>{s(c.name)}</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor="em-type">Type</label>
            <select id="em-type" value={typeId} onChange={(e) => setTypeId(e.target.value)}>
              <option value="">Not set</option>
              {types.map((c) => <option key={s(c.id)} value={s(c.id)}>{s(c.name)}</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor="em-class">Class</label>
            <select id="em-class" value={classId} onChange={(e) => setClassId(e.target.value)}>
              <option value="">Not set</option>
              {classes.map((c) => <option key={s(c.id)} value={s(c.id)}>{s(c.name)}</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor="em-man">Manufacturer</label>
            <input id="em-man" value={manufacturer} onChange={(e) => setManufacturer(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="em-model">Model</label>
            <input id="em-model" value={model} onChange={(e) => setModel(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="em-sn">Serial number</label>
            <input id="em-sn" value={serialNo} onChange={(e) => setSerialNo(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="em-part">Part number</label>
            <input id="em-part" value={partNo} onChange={(e) => setPartNo(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="em-sku">SKU</label>
            <input id="em-sku" value={sku} onChange={(e) => setSku(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="em-bc">Barcode</label>
            <input id="em-bc" value={barcode} onChange={(e) => setBarcode(e.target.value)} />
          </div>
          <div className="field" style={{ gridColumn: '1 / -1' }}>
            <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center', fontSize: 12 }}>
              <input type="checkbox" checked={isMachine} onChange={(e) => setIsMachine(e.target.checked)} /> Machine asset (FSS104, FSS300...)
            </label>
            {isMachine && <input value={machineRef} onChange={(e) => setMachineRef(e.target.value)} placeholder="Machine reference" style={{ marginTop: 6 }} />}
            <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center', fontSize: 12 }}>
              <input type="checkbox" checked={isHighValue} onChange={(e) => setIsHighValue(e.target.checked)} /> High-value asset (extra approval control)
            </label>
            <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center', fontSize: 12 }}>
              <input type="checkbox" checked={isSerialized} onChange={(e) => setIsSerialized(e.target.checked)} /> Serialized asset
            </label>
          </div>
        </div>
        <h4>Organization & location</h4>
        <div className="form-grid">
          <div className="field">
            <label htmlFor="em-dep">Department</label>
            <select id="em-dep" value={departmentId} onChange={(e) => setDepartmentId(e.target.value)}>
              <option value="">Not set</option>
              {departments.map((c) => <option key={s(c.id)} value={s(c.id)}>{s(c.name)}</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor="em-cc">Cost centre ID</label>
            <input id="em-cc" type="number" value={costCentreId} onChange={(e) => setCostCentreId(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="em-proj">Project</label>
            <select id="em-proj" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
              <option value="">Not set</option>
              {projects.map((c) => <option key={s(c.id)} value={s(c.id)}>{s(c.name)}</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor="em-loc">Location</label>
            <select id="em-loc" value={locationId} onChange={(e) => setLocationId(e.target.value)}>
              <option value="">Not set</option>
              {locations.map((c) => <option key={s(c.id)} value={s(c.id)}>{s(c.name)}</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor="em-wh">Warehouse</label>
            <select id="em-wh" value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
              <option value="">Not set</option>
              {warehouses.map((c) => <option key={s(c.id)} value={s(c.id)}>{s(c.name)}</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor="em-branch">Branch ID</label>
            <input id="em-branch" type="number" value={branchId} onChange={(e) => setBranchId(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="em-floor">Floor</label>
            <input id="em-floor" value={floor} onChange={(e) => setFloor(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="em-room">Room</label>
            <input id="em-room" value={room} onChange={(e) => setRoom(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="em-bldg">Building</label>
            <input id="em-bldg" value={building} onChange={(e) => setBuilding(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="em-eret">Expected return</label>
            <input id="em-eret" type="date" value={expectedReturnDate} onChange={(e) => setExpectedReturnDate(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="em-eol">End of life</label>
            <input id="em-eol" type="date" value={eolDate} onChange={(e) => setEolDate(e.target.value)} />
          </div>
        </div>
        <h4>Financial</h4>
        {locked && <p className="muted" style={{ marginTop: 0 }}>Financial fields are locked because this asset is {labelize(asset.status)}. Change them through finance workflows or while the asset is a draft.</p>}
        <div className="form-grid">
          <div className="field">
            <label htmlFor="em-cost">Purchase cost</label>
            <input id="em-cost" type="number" min="0" step="0.01" value={purchaseCost} disabled={locked} onChange={(e) => setPurchaseCost(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="em-cur">Currency</label>
            <select id="em-cur" value={currency} disabled={locked} onChange={(e) => setCurrency(e.target.value)}>
              {CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor="em-pdate">Purchase date</label>
            <input id="em-pdate" type="date" value={purchaseDate} disabled={locked} onChange={(e) => setPurchaseDate(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="em-sup">Supplier</label>
            <select id="em-sup" value={supplierId} disabled={locked} onChange={(e) => setSupplierId(e.target.value)}>
              <option value="">Not set</option>
              {suppliers.map((c) => <option key={s(c.id)} value={s(c.id)}>{s(c.name)}</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor="em-po">PO number</label>
            <input id="em-po" value={poNumber} disabled={locked} onChange={(e) => setPoNumber(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="em-inv">Invoice number</label>
            <input id="em-inv" value={invoiceNumber} disabled={locked} onChange={(e) => setInvoiceNumber(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="em-grn">GRN number</label>
            <input id="em-grn" value={grnNumber} disabled={locked} onChange={(e) => setGrnNumber(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="em-cdate">Capitalization date</label>
            <input id="em-cdate" type="date" value={capitalizationDate} disabled={locked} onChange={(e) => setCapitalizationDate(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="em-life">Useful life (months)</label>
            <input id="em-life" type="number" min="0" step="1" value={usefulLifeMonths} disabled={locked} onChange={(e) => setUsefulLifeMonths(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="em-res">Residual value</label>
            <input id="em-res" type="number" min="0" step="0.01" value={residualValue} disabled={locked} onChange={(e) => setResidualValue(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="em-depm">Depreciation method</label>
            <select id="em-depm" value={depreciationMethod} disabled={locked} onChange={(e) => setDepreciationMethod(e.target.value)}>
              {DEP_METHODS.map((c) => <option key={c} value={c}>{labelize(c)}</option>)}
            </select>
          </div>
        </div>
      </div>
    </Modal>
  );
}

function CapitalizeModal({ asset, onClose, onDone }: { asset: Rec; onClose: () => void; onDone: () => void }) {
  const [capitalizationDate, setCapitalizationDate] = useState(new Date().toISOString().slice(0, 10));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async () => {
    setBusy(true); setError('');
    try {
      await api(`/api/ops/assets/${num(asset.id)}/capitalize`, {
        method: 'POST',
        body: JSON.stringify({ capitalizationDate: capitalizationDate || undefined }),
      });
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Capitalization failed');
      setBusy(false);
    }
  };
  return (
    <Modal title={`Capitalise ${s(asset.asset_no)}`} onClose={onClose} footer={
      <div className="quick-actions">
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={busy} onClick={() => void submit()}>{busy ? 'Saving...' : 'Capitalise asset'}</button>
      </div>
    }>
      <p className="muted">Records the capitalisation date and posts the asset into the fixed asset ledger for depreciation.</p>
      <div className="form-grid">
        <div className="field">
          <label htmlFor="cp-date">Capitalization date</label>
          <input id="cp-date" type="date" value={capitalizationDate} onChange={(e) => setCapitalizationDate(e.target.value)} />
        </div>
        {error && <div className="alert alert-error" style={{ gridColumn: '1 / -1' }}>{error}</div>}
      </div>
    </Modal>
  );
}

function TagModal({ asset, onClose, onDone }: { asset: Rec; onClose: () => void; onDone: () => void }) {
  const TAG_TYPES = ['QR', 'BARCODE', 'QR_BARCODE'];
  const [tagType, setTagType] = useState('QR');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [tag, setTag] = useState<Rec | null>(null);
  const submit = async () => {
    setBusy(true); setError('');
    try {
      const r = await api<{ data: Rec }>(`/api/ops/assets/${num(asset.id)}/tags`, { method: 'POST', body: JSON.stringify({ tagType }) });
      setTag(r.data);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Tag generation failed');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={`Generate tag - ${s(asset.asset_no)}`} onClose={onClose} footer={
      <div className="quick-actions">
        <button className="btn" onClick={onClose}>Close</button>
        {!tag && <button className="btn btn-primary" disabled={busy} onClick={() => void submit()}>{busy ? 'Generating...' : 'Generate tag'}</button>}
      </div>
    }>
      {tag ? (
        <div className="stack">
          <div className="callout callout-info">
            {tag.reuse === true ? 'Existing active tag reused. ' : 'Tag generated. '}Tag <strong>{s(tag.tagNo)}</strong> has status {labelize(tag.status)}.
          </div>
          {s(tag.qrCode ?? tag.qr_code) && <QrToken code={tag.qrCode ?? tag.qr_code} />}
          <button className="btn btn-primary" onClick={onDone}>Done</button>
        </div>
      ) : (
        <>
          <p className="muted">Creates a secure physical identity for {s(asset.asset_no)}. The QR payload is an opaque token with no asset details embedded.</p>
          <div className="form-grid">
            <div className="field">
              <label htmlFor="tg-type">Tag type</label>
              <select id="tg-type" value={tagType} onChange={(e) => setTagType(e.target.value)}>
                {TAG_TYPES.map((tt) => <option key={tt} value={tt}>{labelize(tt)}</option>)}
              </select>
            </div>
            {error && <div className="alert alert-error" style={{ gridColumn: '1 / -1' }}>{error}</div>}
          </div>
        </>
      )}
    </Modal>
  );
}

function PrintModal({ asset, tags, onClose, onDone }: { asset: Rec; tags: Rec[]; onClose: () => void; onDone: () => void }) {
  const [templateId, setTemplateId] = useState('');
  const [printer, setPrinter] = useState('');
  const [reprintReason, setReprintReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const aid = num(asset.id);
  const tag = tags.find((t) => t.status === 'ACTIVE' || t.status === 'ASSIGNED') ?? tags[0] ?? null;
  const submit = async () => {
    setBusy(true); setError('');
    try {
      await api(`/api/ops/assets/${aid}/tags/print`, {
        method: 'POST',
        body: JSON.stringify({ templateId: templateId || undefined, printer: printer || undefined, reprintReason: reprintReason || undefined }),
      });
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Print request failed');
      setBusy(false);
    }
  };
  return (
    <Modal title={`Print tag - ${s(tag?.tag_no ?? asset.asset_no)}`} onClose={onClose} footer={
      <div className="quick-actions">
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={busy || !aid} onClick={() => void submit()}>{busy ? 'Sending...' : 'Send to print'}</button>
      </div>
    }>
      <p className="muted">Creates a print job for {s(asset.asset_no)} ({s(asset.name)}). Every print is recorded in the tag print audit.</p>
      <div className="form-grid">
        <div className="field">
          <label htmlFor="pm-tpl">Template ID (optional)</label>
          <input id="pm-tpl" value={templateId} onChange={(e) => setTemplateId(e.target.value)} placeholder="Default template" />
        </div>
        <div className="field">
          <label htmlFor="pm-print">Printer (optional)</label>
          <input id="pm-print" value={printer} onChange={(e) => setPrinter(e.target.value)} placeholder="Zebra / thermal / A4" />
        </div>
        <div className="field" style={{ gridColumn: '1 / -1' }}>
          <label htmlFor="pm-reason">Reprint reason (optional)</label>
          <input id="pm-reason" value={reprintReason} onChange={(e) => setReprintReason(e.target.value)} placeholder="Damaged label, lost label, reprint" />
        </div>
        {error && <div className="alert alert-error" style={{ gridColumn: '1 / -1' }}>{error}</div>}
      </div>
    </Modal>
  );
}

function ReplaceModal({ asset, onClose, onDone }: { asset: Rec; onClose: () => void; onDone: () => void }) {
  const TAG_TYPES = ['QR', 'BARCODE', 'QR_BARCODE'];
  const [reason, setReason] = useState('');
  const [tagType, setTagType] = useState('QR');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [replacement, setReplacement] = useState<Rec | null>(null);
  const submit = async () => {
    setBusy(true); setError('');
    try {
      const r = await api<{ data: Rec }>(`/api/ops/assets/${num(asset.id)}/tags/replace`, {
        method: 'POST',
        body: JSON.stringify({ reason: reason || undefined, tagType }),
      });
      setReplacement(r.data);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Replacement failed');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={`Replace tag - ${s(asset.asset_no)}`} onClose={onClose} footer={
      <div className="quick-actions">
        <button className="btn" onClick={onClose}>Close</button>
        {!replacement && <button className="btn btn-primary" disabled={busy} onClick={() => void submit()}>{busy ? 'Replacing...' : 'Void and replace'}</button>}
      </div>
    }>
      {replacement ? (
        <div className="stack">
          <div className="callout callout-info">Old tag voided. Replacement <strong>{s(replacement.tagNo)}</strong> created with status {labelize(replacement.status)}.</div>
          {s(replacement.qr_code ?? replacement.qrCode) && (
            <div className="field"><label>New QR token</label><code className="cell-mono">{s(replacement.qr_code ?? replacement.qrCode)}</code></div>
          )}
          <button className="btn btn-primary" onClick={onDone}>Done</button>
        </div>
      ) : (
        <>
          <p className="muted">Voids the current tag and generates a fresh replacement tag. The old tag record is never deleted.</p>
          <div className="form-grid">
            <div className="field" style={{ gridColumn: '1 / -1' }}>
              <label htmlFor="rp-reason">Reason</label>
              <input id="rp-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Damaged, lost or unreadable label" />
            </div>
            <div className="field">
              <label htmlFor="rp-type">Tag type</label>
              <select id="rp-type" value={tagType} onChange={(e) => setTagType(e.target.value)}>
                {TAG_TYPES.map((tt) => <option key={tt} value={tt}>{labelize(tt)}</option>)}
              </select>
            </div>
            {error && <div className="alert alert-error" style={{ gridColumn: '1 / -1' }}>{error}</div>}
          </div>
        </>
      )}
    </Modal>
  );
}

function AssignModal({ asset, onClose, onDone }: { asset: Rec; onClose: () => void; onDone: () => void }) {
  const [custodianType, setCustodianType] = useState('employee');
  const [custodianUserId, setCustodianUserId] = useState('');
  const [custodianDepartmentId, setCustodianDepartmentId] = useState('');
  const [locationId, setLocationId] = useState('');
  const [assignedDate, setAssignedDate] = useState('');
  const [expectedReturnDate, setExpectedReturnDate] = useState('');
  const [inUse, setInUse] = useState(false);
  const [requireAcknowledgement, setRequireAcknowledgement] = useState(true);
  const [reason, setReason] = useState('');
  const [locations, setLocations] = useState<Rec[]>([]);
  const [employees, setEmployees] = useState<Rec[]>([]);
  const [departments, setDepartments] = useState<Rec[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    fetchRows('/api/assets/locations?pageSize=500').then(setLocations).catch(() => undefined);
    fetchRows('/api/ops/hr/employees?pageSize=100').then(setEmployees).catch(() => undefined);
    fetchRows('/api/ops/hr/departments').then(setDepartments).catch(() => undefined);
  }, []);

  const submit = async () => {
    setBusy(true); setError('');
    try {
      await api(`/api/ops/assets/${num(asset.id)}/assign`, {
        method: 'POST',
        body: JSON.stringify({
          custodianUserId: custodianType === 'employee' ? custodianUserId || undefined : undefined,
          custodianDepartmentId: custodianType === 'department' ? custodianDepartmentId || undefined : undefined,
          locationId: locationId || undefined,
          assignedDate: assignedDate || undefined,
          expectedReturnDate: expectedReturnDate || undefined,
          inUse: inUse || undefined,
          requireAcknowledgement: requireAcknowledgement || undefined,
          reason: reason || undefined,
        }),
      });
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Assignment failed');
      setBusy(false);
    }
  };

  return (
    <Modal title={`Assign ${s(asset.asset_no)}`} onClose={onClose} wide footer={
      <div className="quick-actions">
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={busy || (custodianType === 'employee' ? !custodianUserId : !custodianDepartmentId)} onClick={() => void submit()}>{busy ? 'Assigning...' : 'Assign asset'}</button>
      </div>
    }>
      <div className="form-grid">
        <div className="callout callout-info" style={{ gridColumn: '1 / -1' }}>{s(asset.asset_no)} - {s(asset.name)}</div>
        <div className="field">
          <label>Custodian type</label>
          <select value={custodianType} onChange={(e) => setCustodianType(e.target.value)}>
            <option value="employee">Employee</option>
            <option value="department">Department</option>
          </select>
        </div>
        {custodianType === 'employee' ? (
          <div className="field">
            <label htmlFor="am-user">Custodian</label>
            <select id="am-user" value={custodianUserId} onChange={(e) => setCustodianUserId(e.target.value)}>
              <option value="">Select employee</option>
              {employees.map((e) => <option key={s(e.id)} value={String(e.id)}>{s(e.first_name)} {s(e.last_name)}{s(e.position) ? ` - ${s(e.position)}` : ''}</option>)}
            </select>
          </div>
        ) : (
          <div className="field">
            <label htmlFor="am-dep">Department</label>
            <select id="am-dep" value={custodianDepartmentId} onChange={(e) => setCustodianDepartmentId(e.target.value)}>
              <option value="">Select department</option>
              {departments.map((d) => <option key={s(d.id)} value={String(d.id)}>{s(d.name)}</option>)}
            </select>
          </div>
        )}
        <div className="field">
          <label htmlFor="am-loc">Location</label>
          <select id="am-loc" value={locationId} onChange={(e) => setLocationId(e.target.value)}>
            <option value="">Not set</option>
            {locations.map((l) => <option key={s(l.id)} value={String(l.id)}>{s(l.name)}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="am-date">Assigned date</label>
          <input id="am-date" type="date" value={assignedDate} onChange={(e) => setAssignedDate(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="am-return">Expected return</label>
          <input id="am-return" type="date" value={expectedReturnDate} onChange={(e) => setExpectedReturnDate(e.target.value)} />
        </div>
        <div className="field" style={{ gridColumn: '1 / -1' }}>
          <label>&nbsp;</label>
          <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center', fontSize: 12 }}>
            <input type="checkbox" checked={inUse} onChange={(e) => setInUse(e.target.checked)} /> Asset is in use immediately
          </label>
          <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center', fontSize: 12 }}>
            <input type="checkbox" checked={requireAcknowledgement} onChange={(e) => setRequireAcknowledgement(e.target.checked)} /> Require custodian digital acknowledgement
          </label>
        </div>
        <div className="field" style={{ gridColumn: '1 / -1' }}>
          <label htmlFor="am-reason">Reason</label>
          <input id="am-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Purpose of assignment" />
        </div>
        {error && <div className="alert alert-error" style={{ gridColumn: '1 / -1' }}>{error}</div>}
      </div>
    </Modal>
  );
}

function ReturnModal({ asset, onClose, onDone }: { asset: Rec; onClose: () => void; onDone: () => void }) {
  const CONDITIONS = ['NEW', 'EXCELLENT', 'GOOD', 'FAIR', 'POOR', 'DAMAGED', 'CRITICAL', 'UNDER_REPAIR', 'BEYOND_ECONOMIC_REPAIR'];
  const [returnToStore, setReturnToStore] = useState(true);
  const [condition, setCondition] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async () => {
    setBusy(true); setError('');
    try {
      await api(`/api/ops/assets/${num(asset.id)}/return`, {
        method: 'POST',
        body: JSON.stringify({ returnToStore: returnToStore || undefined, condition: condition || undefined, reason: reason || undefined }),
      });
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Return failed');
      setBusy(false);
    }
  };
  return (
    <Modal title={`Return ${s(asset.asset_no)}`} onClose={onClose} footer={
      <div className="quick-actions">
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={busy} onClick={() => void submit()}>{busy ? 'Returning...' : 'Confirm return'}</button>
      </div>
    }>
      <p className="muted">Releases custody for <strong>{s(asset.name)}</strong> currently held by <strong>{s(asset.custodian_name)}</strong>.</p>
      <div className="form-grid">
        <div className="field" style={{ gridColumn: '1 / -1' }}>
          <label>&nbsp;</label>
          <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center', fontSize: 12 }}>
            <input type="checkbox" checked={returnToStore} onChange={(e) => setReturnToStore(e.target.checked)} /> Return to store after release
          </label>
        </div>
        <div className="field">
          <label htmlFor="rm-cond">Condition on return</label>
          <select id="rm-cond" value={condition} onChange={(e) => setCondition(e.target.value)}>
            <option value="">Leave unchanged</option>
            {CONDITIONS.map((c) => <option key={c} value={c}>{labelize(c)}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="rm-reason">Reason</label>
          <input id="rm-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason for return" />
        </div>
        {error && <div className="alert alert-error" style={{ gridColumn: '1 / -1' }}>{error}</div>}
      </div>
    </Modal>
  );
}

function MaintenanceModal({ asset, onClose, onDone }: { asset: Rec; onClose: () => void; onDone: () => void }) {
  const MAINT_TYPES = ['PREVENTIVE', 'CORRECTIVE', 'EMERGENCY', 'INSPECTION', 'CALIBRATION', 'SERVICE', 'REPAIR'];
  const MAINT_PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'];
  const [suppliers, setSuppliers] = useState<Rec[]>([]);
  const [products, setProducts] = useState<Rec[]>([]);
  const [maintenanceType, setMaintenanceType] = useState('PREVENTIVE');
  const [priority, setPriority] = useState('MEDIUM');
  const [scheduledDate, setScheduledDate] = useState('');
  const [cost, setCost] = useState('');
  const [downtimeHours, setDowntimeHours] = useState('');
  const [description, setDescription] = useState('');
  const [nextMaintenanceDate, setNextMaintenanceDate] = useState('');
  const [supplierId, setSupplierId] = useState('');
  const [parts, setParts] = useState<PartRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    fetchRows('/api/ops/inventory/stock?pageSize=200').then(setProducts).catch(() => undefined);
    api<{ data: unknown }>('/api/ops/procurement/suppliers')
      .then((r) => setSuppliers(Array.isArray(r.data) ? (r.data as Rec[]) : []))
      .catch(() => undefined);
  }, []);

  const save = async () => {
    setBusy(true); setError('');
    const body: Rec = {
      assetId: Number(asset.id),
      maintenanceType,
      priority,
      scheduledDate: scheduledDate || undefined,
      cost: Number(cost) || 0,
      downtimeHours: Number(downtimeHours) || 0,
      description: description || undefined,
      nextMaintenanceDate: nextMaintenanceDate || undefined,
      supplierId: Number(supplierId) || undefined,
    };
    body.parts = parts
      .filter((p) => s(p.productId) !== '' && Number(p.qty) > 0)
      .map((p) => ({ productId: Number(p.productId), qty: Number(p.qty), unitCost: Number(p.unitCost) || undefined }));
    try {
      await api('/api/ops/assets/maintenance', { method: 'POST', body: JSON.stringify(body) });
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
      setBusy(false);
    }
  };

  const updPart = (i: number, key: keyof PartRow, v: string) => {
    setParts((prev) => prev.map((p, idx) => {
      if (idx !== i) return p;
      const next = { ...p, [key]: v };
      if (key === 'productId') {
        const prod = products.find((pr) => s(pr.product_id) === v);
        if (prod && s(p.unitCost) === '') next.unitCost = s(prod.avg_cost);
      }
      return next;
    }));
  };

  return (
    <Modal title={`Maintenance - ${s(asset.asset_no)}`} onClose={onClose} wide footer={
      <div className="quick-actions">
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={busy} onClick={() => void save()}>{busy ? 'Saving...' : 'Create work order'}</button>
      </div>
    }>
      <div className="stack">
        {error && <ErrorBanner error={error} />}
        <div className="callout callout-info">{s(asset.asset_no)} - {s(asset.name)}</div>
        <div className="form-grid">
          <div className="field">
            <label htmlFor="mm-type">Maintenance type</label>
            <select id="mm-type" value={maintenanceType} onChange={(e) => setMaintenanceType(e.target.value)}>
              {MAINT_TYPES.map((x) => <option key={x} value={x}>{labelize(x)}</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor="mm-prio">Priority</label>
            <select id="mm-prio" value={priority} onChange={(e) => setPriority(e.target.value)}>
              {MAINT_PRIORITIES.map((x) => <option key={x} value={x}>{labelize(x)}</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor="mm-sched">Scheduled date</label>
            <input id="mm-sched" type="date" value={scheduledDate} onChange={(e) => setScheduledDate(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="mm-cost">Cost (service)</label>
            <input id="mm-cost" type="number" min="0" step="0.01" value={cost} onChange={(e) => setCost(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="mm-dt">Downtime (hours)</label>
            <input id="mm-dt" type="number" min="0" step="0.5" value={downtimeHours} onChange={(e) => setDowntimeHours(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="mm-next">Next maintenance</label>
            <input id="mm-next" type="date" value={nextMaintenanceDate} onChange={(e) => setNextMaintenanceDate(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="mm-sup">Supplier</label>
            <select id="mm-sup" value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
              <option value="">None</option>
              {suppliers.map((sp) => (
                <option key={s(sp.id)} value={s(sp.id)}>{s(sp.name)}</option>
              ))}
            </select>
          </div>
        </div>
        <div className="field">
          <label htmlFor="mm-desc">Description</label>
          <textarea id="mm-desc" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Symptoms, scope of work, safety notes..." />
        </div>
        <div>
          <div className="card-head"><h4>Spare parts issued from inventory</h4></div>
          {products.length === 0 && <p className="muted">Parts can be added here when inventory stock is visible to your role.</p>}
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Part / product</th><th>Qty</th><th>Unit cost</th><th></th></tr></thead>
              <tbody>
                {parts.map((p, i) => (
                  <tr key={i}>
                    <td>
                      <select value={s(p.productId)} onChange={(e) => updPart(i, 'productId', e.target.value)}>
                        <option value="">Select product...</option>
                        {products.map((pr) => (
                          <option key={s(pr.product_id)} value={s(pr.product_id)}>
                            {s(pr.product_code)} - {s(pr.product_name)} ({fmtNum(num(pr.available_qty))} avail)
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <input type="number" min="0" step="1" value={s(p.qty)} onChange={(e) => updPart(i, 'qty', e.target.value)} style={{ width: 90 }} />
                    </td>
                    <td>
                      <input type="number" min="0" step="0.01" value={s(p.unitCost)} onChange={(e) => updPart(i, 'unitCost', e.target.value)} style={{ width: 120 }} placeholder="stock avg cost" />
                    </td>
                    <td>
                      <button className="btn btn-danger" onClick={() => setParts((prev) => prev.filter((_, idx) => idx !== i))}>Remove</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <button className="btn" style={{ marginTop: 8 }} onClick={() => setParts((prev) => [...prev, { productId: '', qty: '1', unitCost: '' }])}>
            Add part row
          </button>
        </div>
      </div>
    </Modal>
  );
}

function VerifyModal({ asset, onClose, onDone }: { asset: Rec; onClose: () => void; onDone: () => void }) {
  const CONDITIONS = ['NEW', 'EXCELLENT', 'GOOD', 'FAIR', 'POOR', 'DAMAGED', 'CRITICAL', 'UNDER_REPAIR', 'BEYOND_ECONOMIC_REPAIR'];
  const [locationId, setLocationId] = useState(String(asset.location_id ?? ''));
  const [custodianUserId, setCustodianUserId] = useState(String(asset.custodian_user_id ?? ''));
  const [condition, setCondition] = useState(s(asset.condition));
  const [result, setResult] = useState('');
  const [note, setNote] = useState('');
  const [locations, setLocations] = useState<Rec[]>([]);
  const [employees, setEmployees] = useState<Rec[]>([]);
  const [busy, setBusy] = useState(false);
  const [response, setResponse] = useState<Rec | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    fetchRows('/api/assets/locations?pageSize=500').then(setLocations).catch(() => undefined);
    fetchRows('/api/ops/hr/employees?pageSize=100').then(setEmployees).catch(() => undefined);
  }, []);

  const submit = async () => {
    setBusy(true); setError(''); setResponse(null);
    try {
      const r = await api<{ data: Rec }>('/api/ops/assets/verification/verify', {
        method: 'POST',
        body: JSON.stringify({
          assetId: String(asset.id),
          locationId: locationId || undefined,
          custodianUserId: custodianUserId || undefined,
          condition: condition || undefined,
          result: result || undefined,
          note: note || undefined,
          device: 'web',
        }),
      });
      setResponse(r.data);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Verification failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Verify asset" onClose={onClose} wide footer={
      <div className="quick-actions">
        <button className="btn" onClick={onClose}>Close</button>
        {!response && <button className="btn btn-primary" disabled={busy} onClick={() => void submit()}>{busy ? 'Submitting...' : 'Submit verification'}</button>}
      </div>
    }>
      {response ? (
        <div className="stack">
          <div className="callout callout-info">
            <strong>{s(response.assetNo)}</strong> - result: <Badge value={response.result} />
          </div>
          {response.expected ? (
            <div className="field"><label>Expected</label><pre className="td-cell-mono" style={{ whiteSpace: 'pre-wrap' }}>{showVal(response.expected)}</pre></div>
          ) : null}
          {response.actual ? (
            <div className="field"><label>Actual</label><pre className="td-cell-mono" style={{ whiteSpace: 'pre-wrap' }}>{showVal(response.actual)}</pre></div>
          ) : null}
          <button className="btn btn-primary" onClick={() => { setResponse(null); onDone(); }}>Done</button>
        </div>
      ) : (
        <div className="form-grid">
          <div className="callout callout-info" style={{ gridColumn: '1 / -1' }}>
            {s(asset.asset_no)} - {s(asset.name)}
          </div>
          <div className="field">
            <label htmlFor="vm-loc">Expected location</label>
            <select id="vm-loc" value={locationId} onChange={(e) => setLocationId(e.target.value)}>
              <option value="">Not set</option>
              {locations.map((l) => <option key={s(l.id)} value={String(l.id)}>{s(l.name)}</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor="vm-cust">Expected custodian</label>
            <select id="vm-cust" value={custodianUserId} onChange={(e) => setCustodianUserId(e.target.value)}>
              <option value="">None</option>
              {employees.map((e) => <option key={s(e.id)} value={String(e.id)}>{s(e.first_name)} {s(e.last_name)}</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor="vm-cond">Condition found</label>
            <select id="vm-cond" value={condition} onChange={(e) => setCondition(e.target.value)}>
              <option value="">Leave unchanged</option>
              {CONDITIONS.map((c) => <option key={c} value={c}>{labelize(c)}</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor="vm-result">Verification result</label>
            <select id="vm-result" value={result} onChange={(e) => setResult(e.target.value)}>
              <option value="">Auto-detect from scan</option>
              <option value="VERIFIED">Verified</option>
              <option value="WRONG_LOCATION">Wrong location</option>
              <option value="WRONG_CUSTODIAN">Wrong custodian</option>
              <option value="DAMAGED">Damaged</option>
              <option value="TAG_MISSING">Tag missing</option>
              <option value="TAG_DAMAGED">Tag damaged</option>
            </select>
          </div>
          <div className="field" style={{ gridColumn: '1 / -1' }}>
            <label htmlFor="vm-note">Note</label>
            <input id="vm-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Observations for the audit trail" />
          </div>
          {error && <div className="alert alert-error" style={{ gridColumn: '1 / -1' }}>{error}</div>}
        </div>
      )}
    </Modal>
  );
}

function MissingModal({ asset, onClose, onDone }: { asset: Rec; onClose: () => void; onDone: () => void }) {
  const [locationId, setLocationId] = useState(String(asset.location_id ?? ''));
  const [description, setDescription] = useState('');
  const [reason, setReason] = useState('');
  const [locations, setLocations] = useState<Rec[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    fetchRows('/api/assets/locations?pageSize=500').then(setLocations).catch(() => undefined);
  }, []);

  const submit = async () => {
    setBusy(true); setError('');
    try {
      await api(`/api/ops/assets/${num(asset.id)}/missing`, {
        method: 'POST',
        body: JSON.stringify({ locationId: locationId || undefined, description: description || undefined, reason: reason || undefined }),
      });
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Report failed');
      setBusy(false);
    }
  };

  return (
    <Modal title={`Report missing - ${s(asset.asset_no)}`} onClose={onClose} footer={
      <div className="quick-actions">
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={busy} onClick={() => void submit()}>{busy ? 'Reporting...' : 'Report missing'}</button>
      </div>
    }>
      <p className="muted">Locks the asset status while the case is investigated. Last known location, custodian and QR scan are preserved.</p>
      <div className="form-grid">
        <div className="callout callout-info" style={{ gridColumn: '1 / -1' }}>{s(asset.asset_no)} - {s(asset.name)}</div>
        <div className="field">
          <label htmlFor="ms-loc">Last known location</label>
          <select id="ms-loc" value={locationId} onChange={(e) => setLocationId(e.target.value)}>
            <option value="">Not set</option>
            {locations.map((l) => <option key={s(l.id)} value={String(l.id)}>{s(l.name)}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="ms-reason">Reason</label>
          <input id="ms-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why it may be missing" />
        </div>
        <div className="field" style={{ gridColumn: '1 / -1' }}>
          <label htmlFor="ms-desc">Description</label>
          <textarea id="ms-desc" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Circumstances of the loss..." />
        </div>
        {error && <div className="alert alert-error" style={{ gridColumn: '1 / -1' }}>{error}</div>}
      </div>
    </Modal>
  );
}

function EscalateModal({ asset, onClose, onDone }: { asset: Rec; onClose: () => void; onDone: () => void }) {
  const [toStatus, setToStatus] = useState('LOST');
  const [description, setDescription] = useState('');
  const [reason, setReason] = useState('');
  const [investigationNote, setInvestigationNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async () => {
    setBusy(true); setError('');
    try {
      await api(`/api/ops/assets/${num(asset.id)}/missing/escalate`, {
        method: 'POST',
        body: JSON.stringify({ toStatus, description: description || undefined, reason: reason || undefined, investigationNote: investigationNote || undefined }),
      });
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Escalation failed');
      setBusy(false);
    }
  };

  return (
    <Modal title={`Escalate - ${s(asset.asset_no)}`} onClose={onClose} footer={
      <div className="quick-actions">
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-danger" disabled={busy} onClick={() => void submit()}>{busy ? 'Escalating...' : 'Escalate to lost or stolen'}</button>
      </div>
    }>
      <p className="muted">Promotes the missing report to a formal LOST or STOLEN status. This requires appropriate authorization and is recorded in the audit trail.</p>
      <div className="form-grid">
        <div className="callout callout-info" style={{ gridColumn: '1 / -1' }}>{s(asset.asset_no)} - {s(asset.name)}</div>
        <div className="field">
          <label htmlFor="es-status">Escalate to</label>
          <select id="es-status" value={toStatus} onChange={(e) => setToStatus(e.target.value)}>
            <option value="LOST">Lost</option>
            <option value="STOLEN">Stolen</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="es-reason">Reason</label>
          <input id="es-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Basis for escalation" />
        </div>
        <div className="field" style={{ gridColumn: '1 / -1' }}>
          <label htmlFor="es-note">Investigation note</label>
          <textarea id="es-note" rows={3} value={investigationNote} onChange={(e) => setInvestigationNote(e.target.value)} placeholder="Findings, police report number, insurance notification..." />
        </div>
        <div className="field" style={{ gridColumn: '1 / -1' }}>
          <label htmlFor="es-desc">Description</label>
          <textarea id="es-desc" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Additional context" />
        </div>
        {error && <div className="alert alert-error" style={{ gridColumn: '1 / -1' }}>{error}</div>}
      </div>
    </Modal>
  );
}

function RecoverModal({ asset, onClose, onDone }: { asset: Rec; onClose: () => void; onDone: () => void }) {
  const CONDITIONS = ['NEW', 'EXCELLENT', 'GOOD', 'FAIR', 'POOR', 'DAMAGED', 'CRITICAL', 'UNDER_REPAIR', 'BEYOND_ECONOMIC_REPAIR'];
  const [custodianType, setCustodianType] = useState('employee');
  const [custodianUserId, setCustodianUserId] = useState('');
  const [custodianDepartmentId, setCustodianDepartmentId] = useState('');
  const [locationId, setLocationId] = useState(String(asset.location_id ?? ''));
  const [condition, setCondition] = useState(s(asset.condition));
  const [description, setDescription] = useState('');
  const [reason, setReason] = useState('');
  const [locations, setLocations] = useState<Rec[]>([]);
  const [employees, setEmployees] = useState<Rec[]>([]);
  const [departments, setDepartments] = useState<Rec[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    fetchRows('/api/assets/locations?pageSize=500').then(setLocations).catch(() => undefined);
    fetchRows('/api/ops/hr/employees?pageSize=100').then(setEmployees).catch(() => undefined);
    fetchRows('/api/ops/hr/departments').then(setDepartments).catch(() => undefined);
  }, []);

  const submit = async () => {
    setBusy(true); setError('');
    try {
      await api(`/api/ops/assets/${num(asset.id)}/missing/recover`, {
        method: 'POST',
        body: JSON.stringify({
          custodianUserId: custodianType === 'employee' ? custodianUserId || undefined : undefined,
          custodianDepartmentId: custodianType === 'department' ? custodianDepartmentId || undefined : undefined,
          locationId: locationId || undefined,
          condition: condition || undefined,
          description: description || undefined,
          reason: reason || undefined,
        }),
      });
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Recovery failed');
      setBusy(false);
    }
  };

  return (
    <Modal title={`Recover ${s(asset.asset_no)}`} onClose={onClose} wide footer={
      <div className="quick-actions">
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={busy} onClick={() => void submit()}>{busy ? 'Recovering...' : 'Confirm recovery'}</button>
      </div>
    }>
      <p className="muted">Restores the asset to service. Custody is reassigned when a custodian is selected; otherwise the asset returns to AVAILABLE.</p>
      <div className="form-grid">
        <div className="callout callout-info" style={{ gridColumn: '1 / -1' }}>{s(asset.asset_no)} - {s(asset.name)}</div>
        <div className="field">
          <label>Custodian type</label>
          <select value={custodianType} onChange={(e) => setCustodianType(e.target.value)}>
            <option value="employee">Employee</option>
            <option value="department">Department</option>
          </select>
        </div>
        {custodianType === 'employee' ? (
          <div className="field">
            <label htmlFor="rc-user">Custodian</label>
            <select id="rc-user" value={custodianUserId} onChange={(e) => setCustodianUserId(e.target.value)}>
              <option value="">Reassign to nobody</option>
              {employees.map((e) => <option key={s(e.id)} value={String(e.id)}>{s(e.first_name)} {s(e.last_name)}{s(e.position) ? ` - ${s(e.position)}` : ''}</option>)}
            </select>
          </div>
        ) : (
          <div className="field">
            <label htmlFor="rc-dep">Department</label>
            <select id="rc-dep" value={custodianDepartmentId} onChange={(e) => setCustodianDepartmentId(e.target.value)}>
              <option value="">Reassign to nobody</option>
              {departments.map((d) => <option key={s(d.id)} value={String(d.id)}>{s(d.name)}</option>)}
            </select>
          </div>
        )}
        <div className="field">
          <label htmlFor="rc-loc">Location</label>
          <select id="rc-loc" value={locationId} onChange={(e) => setLocationId(e.target.value)}>
            <option value="">Not set</option>
            {locations.map((l) => <option key={s(l.id)} value={String(l.id)}>{s(l.name)}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="rc-cond">Condition</label>
          <select id="rc-cond" value={condition} onChange={(e) => setCondition(e.target.value)}>
            <option value="">Leave unchanged</option>
            {CONDITIONS.map((c) => <option key={c} value={c}>{labelize(c)}</option>)}
          </select>
        </div>
        <div className="field" style={{ gridColumn: '1 / -1' }}>
          <label htmlFor="rc-reason">Reason</label>
          <input id="rc-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="How the asset was recovered" />
        </div>
        <div className="field" style={{ gridColumn: '1 / -1' }}>
          <label htmlFor="rc-desc">Description</label>
          <textarea id="rc-desc" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Recovery details" />
        </div>
        {error && <div className="alert alert-error" style={{ gridColumn: '1 / -1' }}>{error}</div>}
      </div>
    </Modal>
  );
}

function DisposeModal({ asset, onClose, onDone }: { asset: Rec; onClose: () => void; onDone: () => void }) {
  const DISPOSAL_REASONS = ['OBSOLETE', 'DAMAGED', 'BEYOND_REPAIR', 'SOLD', 'LOST', 'STOLEN', 'REPLACEMENT', 'END_OF_USEFUL_LIFE', 'OTHER'];
  const DISPOSAL_METHODS = ['SALE', 'SCRAP', 'DONATION', 'RETURN_TO_SUPPLIER', 'WRITE_OFF', 'TRADE_IN'];
  const [reason, setReason] = useState('END_OF_USEFUL_LIFE');
  const [method, setMethod] = useState('SCRAP');
  const [valuation, setValuation] = useState('');
  const [disposalDate, setDisposalDate] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const save = async () => {
    setBusy(true); setError('');
    const body: Rec = {
      assetId: Number(asset.id),
      reason,
      method,
      valuation: valuation === '' ? undefined : Number(valuation),
      disposalDate: disposalDate || undefined,
      notes: notes || undefined,
    };
    try {
      await api('/api/ops/assets/disposals', { method: 'POST', body: JSON.stringify(body) });
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Disposal save failed');
      setBusy(false);
    }
  };

  return (
    <Modal title={`Dispose ${s(asset.asset_no)}`} onClose={onClose} footer={
      <div className="quick-actions">
        <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
        <button className="btn btn-danger" onClick={() => void save()} disabled={busy}>{busy ? 'Saving...' : 'Submit disposal request'}</button>
      </div>
    }>
      <div className="stack">
        {error && <ErrorBanner error={error} />}
        <p className="muted">Creates a controlled disposal request. The asset record is never deleted; it transitions through valuation, approval, accounting and retirement.</p>
        <div className="callout callout-info">{s(asset.asset_no)} - {s(asset.name)} - book value {fmtMoney(asset.current_book_value)}</div>
        <div className="form-grid">
          <div className="field">
            <label htmlFor="dp-reason">Reason</label>
            <select id="dp-reason" value={reason} onChange={(e) => setReason(e.target.value)}>
              {DISPOSAL_REASONS.map((x) => <option key={x} value={x}>{labelize(x)}</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor="dp-method">Method</label>
            <select id="dp-method" value={method} onChange={(e) => setMethod(e.target.value)}>
              {DISPOSAL_METHODS.map((x) => <option key={x} value={x}>{labelize(x)}</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor="dp-valuation">Valuation / expected proceeds</label>
            <input id="dp-valuation" type="number" min="0" step="0.01" value={valuation} onChange={(e) => setValuation(e.target.value)} placeholder="0" />
          </div>
          <div className="field">
            <label htmlFor="dp-date">Disposal date</label>
            <input id="dp-date" type="date" value={disposalDate} onChange={(e) => setDisposalDate(e.target.value)} />
          </div>
          <div className="field" style={{ gridColumn: '1 / -1' }}>
            <label htmlFor="dp-notes">Notes</label>
            <textarea id="dp-notes" rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Reason context, approvals, buyer details..." />
          </div>
        </div>
      </div>
    </Modal>
  );
}

function CommentModal({ asset, onClose, onDone }: { asset: Rec; onClose: () => void; onDone: () => void }) {
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async () => {
    if (!body.trim()) { setError('Write a comment first'); return; }
    setBusy(true); setError('');
    try {
      await api(`/api/ops/assets/${num(asset.id)}/comments`, {
        method: 'POST',
        body: JSON.stringify({ body: body.trim() }),
      });
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Comment failed');
      setBusy(false);
    }
  };

  return (
    <Modal title={`Comment - ${s(asset.asset_no)}`} onClose={onClose} footer={
      <div className="quick-actions">
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={busy || !body.trim()} onClick={() => void submit()}>{busy ? 'Posting...' : 'Post comment'}</button>
      </div>
    }>
      <div className="stack">
        <div className="callout callout-info">{s(asset.asset_no)} - {s(asset.name)}</div>
        <div className="field">
          <label htmlFor="cm-body">Comment</label>
          <textarea id="cm-body" rows={4} value={body} onChange={(e) => setBody(e.target.value)} placeholder="Add a note to the asset timeline" />
        </div>
        {error && <div className="alert alert-error">{error}</div>}
      </div>
    </Modal>
  );
}

export { AssetDesk };
