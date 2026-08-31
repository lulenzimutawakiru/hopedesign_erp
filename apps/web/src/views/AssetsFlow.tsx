import { useEffect, useMemo, useState } from 'react';
import { api, fmtDate, fmtMoney, fmtNum } from '../api';
import { useAuth, can } from '../auth';
import { useCompanyProfile } from '../company';
import { navigate, useHashQuery } from '../router';
import { Badge, ErrorBanner, Modal, PageLoader, Pager } from '../components/ui';
import { EmptyState, Skeleton } from '../components/os';
import { AssetModuleTabs, ChartCard, ModuleHeader, Rec, labelize, s, tileStyle } from './assetsShared';
import { AssetDesk } from './AssetDesk';
import { AssetScan, VerifyFlow, TagsFlow, CustodyFlow, TransfersFlow } from './AssetOps';
import { MaintenanceFlow, AuditsFlow, DepreciationFlow, DisposalsFlow, ImpairmentsFlow, AnomaliesFlow } from './AssetLifecycle';
import { ImportFlow, ExportFlow } from './AssetData';

const DEP_METHODS = ['STRAIGHT_LINE', 'REDUCING_BALANCE', 'UNITS_OF_PRODUCTION', 'CUSTOM', 'NONE']; // t
const CURRENCIES = ['UGX', 'USD', 'KES', 'GBP', 'EUR'];
const CONDITIONS = ['NEW', 'EXCELLENT', 'GOOD', 'FAIR', 'POOR', 'DAMAGED', 'CRITICAL', 'UNDER_REPAIR', 'BEYOND_ECONOMIC_REPAIR', 'DISPOSED'];
const OPS_STATES = ['NOT_IN_USE', 'IN_USE', 'IDLE', 'QUARANTINED', 'OFFLINE'];
const TAG_TYPES = ['QR', 'BARCODE', 'QR_BARCODE'];

async function fetchRows(path: string): Promise<Rec[]> {
  try {
    const r = await api<{ data: unknown }>(path);
    const d = r.data;
    if (Array.isArray(d)) return d as Rec[];
    const rows = (d as Rec | null)?.rows;
    return Array.isArray(rows) ? (rows as Rec[]) : [];
  } catch {
    return [];
  }
}

export default function AssetsFlow({ path }: { path: string }) {
  const parts = path.split('/').filter(Boolean);
  const id = parts[2] ?? null;
  if (id && Number(id) > 0) return <AssetDesk id={Number(id)} />;
  if (parts.length <= 1) return <AssetBoard />;
  switch (parts[1]) {
    case 'scan': return <AssetScan />;
    case 'verify': return <VerifyFlow />;
    case 'tags': return <TagsFlow />;
    case 'custody': return <CustodyFlow />;
    case 'transfers': return <TransfersFlow />;
    case 'audits': return <AuditsFlow />;
    case 'maintenance': return <MaintenanceFlow />;
    case 'depreciation': return <DepreciationFlow />;
    case 'impairments': return <ImpairmentsFlow />;
    case 'disposals': return <DisposalsFlow />;
    case 'anomalies': return <AnomaliesFlow />;
    case 'import': return <ImportFlow />;
    case 'export': return <ExportFlow />;
    case 'register': return <Register />;
    default: return <AssetBoard />;
  }
}

function KpiTile({ label, value, sub, icon, accent, tint, href, money }: {
  label: string; value: unknown; sub: string; icon: string; accent: string; tint: string; href: string; money?: boolean;
}) {
  return (
    <button className="kpi-tile" style={tileStyle(accent, tint)} onClick={() => navigate(href)}>
      <span className="kpi-tile-icon" aria-hidden>{icon}</span>
      <span className="kpi-tile-body">
        <span className="kpi-tile-label">{label}</span>
        <span className="kpi-tile-value">{money ? fmtMoney(value) : fmtNum(value)}</span>
        <span className="kpi-tile-sub">{sub}</span>
      </span>
    </button>
  );
}

function AssetBoard() {
  const company = useCompanyProfile();
  const { user } = useAuth();
  const [data, setData] = useState<Rec | null>(null);
  const [recent, setRecent] = useState<Rec[]>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    api<{ data: Rec }>('/api/ops/assets/dashboard/kpis')
      .then((r) => setData(r.data))
      .catch((e) => setError(e instanceof Error ? e.message : 'Asset dashboard failed'));
    api<{ data: { rows: Rec[] } }>('/api/ops/assets?pageSize=8')
      .then((r) => setRecent(r.data.rows ?? []))
      .catch(() => undefined);
  }, []);
  if (error && !data) return <ErrorBanner error={error} />;
  if (!data) return <PageLoader label="Opening asset command centre" />;
  const byCategory = ((data.byCategory as Rec[]) ?? []).map((r) => ({ label: s(r.name), value: Number(r.value ?? r.count ?? 0) }));
  const byLocation = ((data.byLocation as Rec[]) ?? []).map((r) => ({ label: s(r.name), value: Number(r.value ?? r.count ?? 0) }));
  const byStatus = ((data.byStatus as Rec[]) ?? []).map((r) => ({ label: s(r.status), value: Number(r.count ?? 0) }));
  const cards: Array<{ key: string; label: string; value: unknown; sub: string; icon: string; accent: string; tint: string; href: string }> = [
    { key: 'total', label: 'Total assets', value: data.total, sub: 'All registered assets', icon: 'A', accent: '#475569', tint: 'rgba(71,85,105,0.12)', href: '/assets/register' },
    { key: 'active', label: 'Active assets', value: data.active, sub: 'In service today', icon: '✓', accent: '#168A5B', tint: 'rgba(22,138,91,0.12)', href: '/assets/register?status=REGISTERED,IN_STORE,AVAILABLE,ASSIGNED,IN_USE,TRANSFERRED,UNDER_MAINTENANCE,UNDER_INSPECTION,RESERVED' },
    { key: 'assigned', label: 'Assigned', value: data.assigned, sub: 'Held by custodians', icon: '☺', accent: '#2878D0', tint: 'rgba(40,120,208,0.12)', href: '/assets/register?status=ASSIGNED,IN_USE' },
    { key: 'unassigned', label: 'Unassigned', value: data.unassigned, sub: 'Available in store', icon: '○', accent: '#0891B2', tint: 'rgba(8,145,178,0.12)', href: '/assets/register?unassigned=1' },
    { key: 'in_store', label: 'In store', value: data.in_store, sub: 'Registered / in store', icon: '▣', accent: '#0E7490', tint: 'rgba(14,116,144,0.12)', href: '/assets/register?status=IN_STORE,REGISTERED' },
    { key: 'under_maint', label: 'Under maintenance', value: data.under_maintenance, sub: 'In the workshop', icon: '⚙', accent: '#D97706', tint: 'rgba(217,119,6,0.12)', href: '/assets/register?status=UNDER_MAINTENANCE' },
    { key: 'due_maint', label: 'Due maintenance', value: data.due_maintenance, sub: 'Next 30 days', icon: '⏳', accent: '#D99A00', tint: 'rgba(217,154,0,0.12)', href: '/assets/register?dueMaintenance=1' },
    { key: 'due_insp', label: 'Due inspection', value: data.due_inspection, sub: 'Next 30 days', icon: '🔎', accent: '#8B5CF6', tint: 'rgba(139,92,246,0.12)', href: '/assets/register?dueInspection=1' },
    { key: 'near_eol', label: 'Near end of life', value: data.near_eol, sub: 'Within 90 days', icon: '⌛', accent: '#B45309', tint: 'rgba(180,83,9,0.12)', href: '/assets/register?nearEol=1' },
    { key: 'missing', label: 'Missing', value: data.missing, sub: 'Under investigation', icon: '?', accent: '#C93636', tint: 'rgba(201,54,54,0.12)', href: '/assets/register?status=MISSING' },
    { key: 'lost', label: 'Lost / stolen', value: data.lost, sub: 'Locked assets', icon: '!', accent: '#9F1239', tint: 'rgba(159,18,57,0.12)', href: '/assets/register?status=LOST,STOLEN' },
    { key: 'damaged', label: 'Damaged', value: data.damaged, sub: 'Awaiting repair', icon: '✕', accent: '#DC2626', tint: 'rgba(220,38,38,0.12)', href: '/assets/register?status=DAMAGED' },
    { key: 'disposed', label: 'Disposed', value: data.disposed, sub: 'Retired from service', icon: '∅', accent: '#6B7280', tint: 'rgba(107,114,128,0.12)', href: '/assets/register?status=DISPOSED' },
  ];
  return (
    <div className="page">
      <ModuleHeader
        kicker="Asset management"
        title="Asset command centre"
        sub={`Register, tag, track and manage every physical and capital asset across ${company.name} — from procurement and custody to maintenance, depreciation and disposal.`}
        actions={
          <>
            {can(user, 'assets.register.create') && <button className="btn btn-primary" onClick={() => navigate('/assets/register?new=1')}>Register asset</button>}
            {can(user, 'assets.scans.perform') && <button className="btn" onClick={() => navigate('/assets/scan')}>Scan asset</button>}
          </>
        }
      />
      <AssetModuleTabs active="board" />
      {error && <ErrorBanner error={error} />}
      <div className="kpi-grid--tiles">
        {cards.map(({ key, ...rest }) => <KpiTile key={key} {...rest} />)}
      </div>
      <div className="grid-3" style={{ marginTop: 16 }}>
        <section className="card card-pad">
          <div className="card-head"><h3>Total acquisition cost</h3></div>
          <p className="kpi-tile-value" style={{ margin: '10px 0 4px', fontSize: 30 }}>{fmtMoney(data.total_acquisition_cost)}</p>
          <p className="muted" style={{ margin: 0, fontSize: 12 }}>Original purchase value of the register</p>
        </section>
        <section className="card card-pad">
          <div className="card-head"><h3>Current book value</h3></div>
          <p className="kpi-tile-value" style={{ margin: '10px 0 4px', fontSize: 30 }}>{fmtMoney(data.current_book_value)}</p>
          <p className="muted" style={{ margin: 0, fontSize: 12 }}>Net of accumulated depreciation</p>
        </section>
        <section className="card card-pad">
          <div className="card-head"><h3>Accumulated depreciation</h3></div>
          <p className="kpi-tile-value" style={{ margin: '10px 0 4px', fontSize: 30 }}>{fmtMoney(data.accumulated_depreciation)}</p>
          <p className="muted" style={{ margin: 0, fontSize: 12 }}>Depreciation posted to date</p>
        </section>
        <ChartCard title="Asset value by category" rows={byCategory} money />
        <ChartCard title="Asset value by location" rows={byLocation} money />
        <ChartCard title="Assets by status" rows={byStatus} />
      </div>
      <section className="card card-pad" style={{ marginTop: 16 }}>
        <div className="card-head"><h3>Recently registered assets</h3></div>
        {recent.length === 0 ? <p className="muted">No assets registered yet.</p> : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr><th>Asset ID</th><th>Name</th><th>Category</th><th>Custodian</th><th>Status</th><th>Book value</th></tr>
              </thead>
              <tbody>
                {recent.map((r) => (
                  <tr key={s(r.asset_no)} className="row-link" onClick={() => navigate(`/assets/${r.id}`)}>
                    <td className="td-cell-mono">{s(r.asset_no)}</td>
                    <td><strong>{s(r.name)}</strong></td>
                    <td>{s(r.category_name)}</td>
                    <td>{s(r.custodian_name)}</td>
                    <td><Badge value={r.status} /></td>
                    <td>{fmtMoney(r.current_book_value)}</td>
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

const STATUS_OPTIONS = ['DRAFT', 'PENDING_APPROVAL', 'REGISTERED', 'IN_STORE', 'AVAILABLE', 'ASSIGNED', 'IN_USE', 'TRANSFERRED', 'UNDER_MAINTENANCE', 'UNDER_INSPECTION', 'MISSING', 'LOST', 'STOLEN', 'DAMAGED', 'QUARANTINED', 'RESERVED', 'DISPOSED', 'RETIRED', 'ARCHIVED'];

function Register() {
  const { user } = useAuth();
  const q = useHashQuery();
  const [rows, setRows] = useState<Rec[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize] = useState(25);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState(q.get('search') ?? '');
  const [status, setStatus] = useState(q.get('status') ?? '');
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [showCreate, setShowCreate] = useState(q.get('new') === '1');
  const [showTags, setShowTags] = useState(false);
  const [tagResult, setTagResult] = useState<Rec | null>(null);
  const [busy, setBusy] = useState(false);
  const filterFlags: Array<[string, string]> = [
    ['unassigned', 'Unassigned'],
    ['dueMaintenance', 'Due maintenance'],
    ['dueInspection', 'Due inspection'],
    ['nearEol', 'Near end of life'],
    ['mine', 'My assets'],
  ];
  const qs = useMemo(() => {
    const p = new URLSearchParams();
    const statuses = (q.get('status') ?? '').split(',').filter(Boolean).join(',');
    if (statuses) p.set('status', statuses);
    const searchV = q.get('search');
    if (searchV) p.set('search', searchV);
    for (const [k] of filterFlags) if (q.get(k)) p.set(k, '1');
    if (q.get('categoryId')) p.set('categoryId', q.get('categoryId')!);
    if (q.get('locationId')) p.set('locationId', q.get('locationId')!);
    return p;
  }, [q]);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError('');
    api<{ data: { rows: Rec[]; total: number } }>(`/api/ops/assets?${qs.toString()}&page=${page}&pageSize=${pageSize}`)
      .then((r) => { if (!alive) return; setRows(r.data.rows ?? []); setTotal(r.data.total ?? 0); })
      .catch((e) => { if (alive) setError(e instanceof Error ? e.message : 'Asset register failed'); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [qs, page, pageSize]);
  const apply = (extra: Record<string, string>) => navigate('/assets/register', { query: { ...Object.fromEntries(qs), ...extra } });
  const toggle = (id: number) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id); else next.add(id);
    setSelected(next);
  };
  const generateTags = async () => {
    setBusy(true);
    setError('');
    try {
      const r = await api<{ data: Rec }>('/api/ops/assets/tags/generate-bulk', {
        method: 'POST', body: JSON.stringify({ assetIds: [...selected], tagType: 'QR' }),
      });
      setTagResult(r.data);
      setShowTags(false);
      setSelected(new Set());
    } catch (e) { setError(e instanceof Error ? e.message : 'Bulk tag generation failed'); }
    finally { setBusy(false); }
  };
  const printSelected = async () => {
    setBusy(true);
    setError('');
    try {
      let done = 0;
      for (const id of selected) {
        await api(`/api/ops/assets/${id}/tags/print`, { method: 'POST', body: JSON.stringify({}) });
        done++;
      }
      setTagResult({ jobNo: 'Batch print', quantity: done });
      setSelected(new Set());
    } catch (e) { setError(e instanceof Error ? e.message : 'Bulk print failed'); }
    finally { setBusy(false); }
  };
  return (
    <div className="page">
      <ModuleHeader
        kicker="Asset management"
        title="Asset register"
        sub="Every asset has a permanent, non-reusable asset number and complete lifecycle history. Use lifecycle actions — assignment, transfer, maintenance, audit, disposal — instead of destructive deletion."
        actions={
          <>
            {can(user, 'assets.register.create') && <button className="btn btn-primary" onClick={() => setShowCreate(true)}>Register asset</button>}
            {can(user, 'assets.scans.perform') && <button className="btn" onClick={() => navigate('/assets/scan')}>Scan asset</button>}
          </>
        }
      />
      <AssetModuleTabs active="register" />
      <div className="card card-pad" style={{ marginBottom: 14 }}>
        <div className="form-grid">
          <div className="field">
            <label htmlFor="ast-search">Search assets</label>
            <input id="ast-search" placeholder="Asset ID, name, serial, barcode, model" value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') apply({ search }); }} />
          </div>
          <div className="field">
            <label htmlFor="ast-status">Status</label>
            <select id="ast-status" value={status} onChange={(e) => { setStatus(e.target.value); apply({ status: e.target.value }); }}>
              <option value="">Any status</option>
              {STATUS_OPTIONS.map((st) => <option key={st} value={st}>{labelize(st)}</option>)}
            </select>
          </div>
          <div className="field" style={{ justifyContent: 'flex-end' }}>
            <label>&nbsp;</label>
            <button className="btn" onClick={() => apply({ search })}>Apply filters</button>
          </div>
        </div>
        <div className="page-meta" style={{ marginTop: 10 }}>
          {filterFlags.map(([k, label]) => (
            <label key={k} style={{ display: 'inline-flex', gap: 6, alignItems: 'center', fontSize: 12 }}>
              <input type="checkbox" checked={!!q.get(k)} onChange={(e) => { const nq = { ...Object.fromEntries(qs) }; if (e.target.checked) nq[k] = '1'; else delete nq[k]; navigate('/assets/register', { query: nq }); }} />
              {label}
            </label>
          ))}
        </div>
      </div>
      {error && <ErrorBanner error={error} />}
      {selected.size > 0 && (
        <div className="callout callout-info" style={{ margin: '0 0 12px' }}>
          <span className="callout-icon" aria-hidden>▣</span>
          <div className="callout-body">
            <strong>{selected.size} assets selected</strong>
            <div className="stack" style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
              {can(user, 'assets.tags.generate') && <button className="btn btn-sm btn-primary" disabled={busy} onClick={generateTags}>Generate QR tags</button>}
              {can(user, 'assets.tags.print') && <button className="btn btn-sm" disabled={busy} onClick={printSelected}>Print tags</button>}
              <button className="btn btn-sm btn-ghost" onClick={() => setSelected(new Set())}>Clear</button>
            </div>
          </div>
        </div>
      )}
      <section className="card card-pad">
        <div className="card-head"><h3>Register ({total.toLocaleString()})</h3></div>
        {loading ? <Skeleton rows={6} /> : rows.length === 0 ? (
          <EmptyState title="No assets found" body="Adjust the filters, or register a new asset to begin its lifecycle." action={can(user, 'assets.register.create') ? 'Register asset' : undefined} onAction={() => setShowCreate(true)} />
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th style={{ width: 34 }}>{can(user, 'assets.tags.generate') ? 'Sel' : ''}</th>
                  <th>QR</th><th>Asset ID</th><th>Name</th><th>Category</th><th>Type</th><th>Custodian</th><th>Location</th><th>Status</th><th>Condition</th><th>Book value</th><th>Next maint.</th><th></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={s(r.asset_no)} className="row-link" onClick={() => navigate(`/assets/${r.id}`)}>
                    <td onClick={(e) => e.stopPropagation()}>
                      {can(user, 'assets.tags.generate') && <input type="checkbox" checked={selected.has(Number(r.id))} onChange={() => toggle(Number(r.id))} aria-label={`Select ${s(r.asset_no)}`} />}
                    </td>
                    <td>{can(user, 'assets.tags.view') ? <button className="icon-btn" title="Open tag" onClick={(e) => { e.stopPropagation(); navigate(`/assets/${r.id}?tab=tags`); }}>▣</button> : '▣'}</td>
                    <td className="td-cell-mono"><button className="link-btn" onClick={(e) => { e.stopPropagation(); navigate(`/assets/${r.id}`); }}>{s(r.asset_no)}</button></td>
                    <td><strong>{s(r.name)}</strong>{r.is_machine === true && <span className="badge badge-teal" style={{ marginLeft: 6 }}>MACHINE</span>}</td>
                    <td>{s(r.category_name)}</td>
                    <td>{s(r.type_name)}</td>
                    <td>{s(r.custodian_name)}</td>
                    <td>{s(r.location_name)}</td>
                    <td><Badge value={r.status} /></td>
                    <td>{s(r.condition)}</td>
                    <td>{fmtMoney(r.current_book_value)}</td>
                    <td>{fmtDate(r.next_maintenance)}</td>
                    <td>
                      <button className="btn btn-sm" onClick={(e) => { e.stopPropagation(); navigate(`/assets/${r.id}`); }}>Open</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <Pager page={page} pageSize={pageSize} total={total} onPage={setPage} />
      </section>
      {tagResult && (
        <Modal title="Tag batch result" onClose={() => setTagResult(null)}>
          <div className="def-list">
            <div><dt>Generated / printed</dt><dd>{fmtNum(tagResult.generated ?? tagResult.quantity)}</dd></div>
            {Array.isArray(tagResult.tags) && (tagResult.tags as Rec[]).length > 0 && (
              <div><dt>QR codes</dt><dd>{(tagResult.tags as Rec[]).slice(0, 5).map((t) => s(t.qrCode)).join(', ')}{(tagResult.tags as Rec[]).length > 5 ? ' …' : ''}</dd></div>
            )}
          </div>
          <div className="modal-foot" style={{ padding: 0, paddingTop: 12, marginTop: 12 }}>
            <button className="btn btn-primary" onClick={() => navigate('/assets/tags')}>Open tag centre</button>
          </div>
        </Modal>
      )}
      {showCreate && <PostAsset onClose={() => setShowCreate(false)} />}
      {showTags && (
        <Modal title="Generate tags for selected assets" onClose={() => setShowTags(false)} footer={<button className="btn btn-primary" onClick={generateTags} disabled={busy}>{busy ? 'Generating…' : 'Generate tags'}</button>}>
          <p>This creates one opaque, signed QR token per asset. Confidential asset information is never embedded in the tag.</p>
        </Modal>
      )}
    </div>
  );
}

function PostAsset({ onClose }: { onClose: () => void }) {
  const [f, setF] = useState<Rec>({ currency: 'UGX', depreciationMethod: 'STRAIGHT_LINE', condition: 'NEW', operationalState: 'NOT_IN_USE', tagType: 'QR', isSerialized: true });
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
  const [attempted, setAttempted] = useState(false);

  useEffect(() => {
    void fetchRows('/api/assets/categories?pageSize=500').then(setCategories);
    void fetchRows('/api/assets/types').then(setTypes);
    void fetchRows('/api/assets/classes').then(setClasses);
    void fetchRows('/api/assets/locations?pageSize=500').then(setLocations);
    void fetchRows('/api/inventory/warehouses').then(setWarehouses);
    void fetchRows('/api/ops/hr/departments').then(setDepartments);
    void fetchRows('/api/hr/projects').then(setProjects);
    api<{ data: unknown }>('/api/ops/procurement/suppliers')
      .then((r) => setSuppliers(Array.isArray(r.data) ? (r.data as Rec[]) : []))
      .catch(() => undefined);
  }, []);

  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    setF((p) => ({ ...p, [k]: e.target.type === 'checkbox' ? (e.target as HTMLInputElement).checked : e.target.value }));
  const name = s(f.name).trim();
  const nameMissing = attempted && !name;
  const save = async () => {
    if (!name) {
      setAttempted(true);
      setError('Asset name is required before saving the draft.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const r = await api<{ data: { assetId: number; assetNo: string; qrId: number; qrCode: string; tagId: number } }>('/api/ops/assets', {
        method: 'POST', body: JSON.stringify(f),
      });
      navigate(`/assets/${r.data.assetId}?new=1`);
      onClose();
    } catch (e) { setError(e instanceof Error ? e.message : 'Registration failed'); }
    finally { setBusy(false); }
  };

  const cost = Number(s(f.purchaseCost));
  const life = Number(s(f.usefulLifeMonths));
  const residual = Number(s(f.residualValue)) || 0;
  const estMonthly = Number.isFinite(cost) && cost > 0 && Number.isFinite(life) && life > 0 && s(f.depreciationMethod) !== 'NONE'
    ? Math.max(0, cost - residual) / life
    : null;

  return (
    <Modal title="Register a new asset" onClose={onClose} wide
      footer={
        <>
          <span className="muted" style={{ marginRight: 'auto', fontSize: 12 }}>Only the asset name is required to save a draft.</span>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={() => void save()} disabled={busy}>{busy ? 'Saving…' : 'Save draft'}</button>
        </>
      }>
      {error && <ErrorBanner error={error} />}

      <h4 className="form-sec">Identification</h4>
      <div className="form-grid">
        <div className={`field field-required${nameMissing ? ' field-invalid' : ''}`} style={{ gridColumn: '1 / -1' }}>
          <label htmlFor="pa-name">Asset name</label>
          <input id="pa-name" value={s(f.name)} onChange={(e) => { set('name')(e); if (attempted) setAttempted(false); }} placeholder="e.g. Dell Latitude 7450 laptop" autoFocus />
          {nameMissing && <span className="field-error">Enter a name for this asset to continue.</span>}
        </div>
        <div className="field" style={{ gridColumn: '1 / -1' }}>
          <label htmlFor="pa-desc">Description</label>
          <textarea id="pa-desc" rows={2} value={s(f.description)} onChange={set('description')} placeholder="What the asset is and what it is used for" />
        </div>
        <div className="field"><label htmlFor="pa-man">Manufacturer</label><input id="pa-man" value={s(f.manufacturer)} onChange={set('manufacturer')} placeholder="e.g. Dell" /></div>
        <div className="field"><label htmlFor="pa-model">Model</label><input id="pa-model" value={s(f.model)} onChange={set('model')} placeholder="e.g. Latitude 7450" /></div>
        <div className="field"><label htmlFor="pa-sn">Serial number</label><input id="pa-sn" value={s(f.serialNo)} onChange={set('serialNo')} placeholder="Device serial / chassis number" /></div>
        <div className="field"><label htmlFor="pa-part">Part number</label><input id="pa-part" value={s(f.partNo)} onChange={set('partNo')} placeholder="Manufacturer part reference" /></div>
        <div className="field"><label htmlFor="pa-sku">SKU</label><input id="pa-sku" value={s(f.sku)} onChange={set('sku')} placeholder="Stock keeping unit, if tracked" /></div>
        <div className="field"><label htmlFor="pa-bc">Barcode</label><input id="pa-bc" value={s(f.barcode)} onChange={set('barcode')} placeholder="Existing barcode, if any" /></div>
        <div style={{ gridColumn: '1 / -1' }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'center' }}>
            <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center', fontSize: 13, fontWeight: 600 }}><input type="checkbox" checked={f.isMachine === true} onChange={set('isMachine')} /> Production machine</label>
            <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center', fontSize: 13, fontWeight: 600 }}><input type="checkbox" checked={f.isHighValue === true} onChange={set('isHighValue')} /> High-value asset</label>
            <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center', fontSize: 13, fontWeight: 600 }}><input type="checkbox" checked={f.isSerialized !== false} onChange={set('isSerialized')} /> Serialized</label>
          </div>
        </div>
        {f.isMachine === true && (
          <div className="field"><label htmlFor="pa-mref">Machine reference</label><input id="pa-mref" value={s(f.machineRef)} onChange={set('machineRef')} placeholder="e.g. FSS104" /><span className="field-hint">Links this asset to the production machine register.</span></div>
        )}
      </div>

      <h4 className="form-sec">Classification</h4>
      <div className="form-grid">
        <div className="field"><label htmlFor="pa-cat">Category</label><select id="pa-cat" value={s(f.categoryId)} onChange={set('categoryId')}><option value="">Not set</option>{categories.map((c) => <option key={s(c.id)} value={s(c.id)}>{s(c.name)}</option>)}</select><span className="field-hint">Drives the asset number prefix.</span></div>
        <div className="field"><label htmlFor="pa-type">Type</label><select id="pa-type" value={s(f.typeId)} onChange={set('typeId')}><option value="">Not set</option>{types.map((c) => <option key={s(c.id)} value={s(c.id)}>{s(c.name)}</option>)}</select></div>
        <div className="field"><label htmlFor="pa-class">Class</label><select id="pa-class" value={s(f.classId)} onChange={set('classId')}><option value="">Not set</option>{classes.map((c) => <option key={s(c.id)} value={s(c.id)}>{s(c.name)}</option>)}</select></div>
        <div className="field"><label htmlFor="pa-cond">Condition</label><select id="pa-cond" value={s(f.condition)} onChange={set('condition')}>{CONDITIONS.map((m) => <option key={m} value={m}>{labelize(m)}</option>)}</select></div>
        <div className="field"><label htmlFor="pa-op">Operational state</label><select id="pa-op" value={s(f.operationalState)} onChange={set('operationalState')}>{OPS_STATES.map((m) => <option key={m} value={m}>{labelize(m)}</option>)}</select></div>
      </div>

      <h4 className="form-sec">Location &amp; ownership</h4>
      <div className="form-grid">
        <div className="field"><label htmlFor="pa-branch">Branch ID</label><input id="pa-branch" type="number" value={s(f.branchId)} onChange={set('branchId')} placeholder="Leave blank to use your branch" /><span className="field-hint">Defaults to your branch when left blank.</span></div>
        <div className="field"><label htmlFor="pa-dept">Department</label><select id="pa-dept" value={s(f.departmentId)} onChange={set('departmentId')}><option value="">Not set</option>{departments.map((c) => <option key={s(c.id)} value={s(c.id)}>{s(c.name)}</option>)}</select></div>
        <div className="field"><label htmlFor="pa-cc">Cost centre ID</label><input id="pa-cc" type="number" value={s(f.costCentreId)} onChange={set('costCentreId')} placeholder="Finance cost centre code" /></div>
        <div className="field"><label htmlFor="pa-proj">Project</label><select id="pa-proj" value={s(f.projectId)} onChange={set('projectId')}><option value="">Not set</option>{projects.map((c) => <option key={s(c.id)} value={s(c.id)}>{s(c.name)}</option>)}</select></div>
        <div className="field"><label htmlFor="pa-loc">Location</label><select id="pa-loc" value={s(f.locationId)} onChange={set('locationId')}><option value="">Not set</option>{locations.map((c) => <option key={s(c.id)} value={s(c.id)}>{s(c.name)}</option>)}</select></div>
        <div className="field"><label htmlFor="pa-wh">Warehouse</label><select id="pa-wh" value={s(f.warehouseId)} onChange={set('warehouseId')}><option value="">Not set</option>{warehouses.map((c) => <option key={s(c.id)} value={s(c.id)}>{s(c.name)}</option>)}</select></div>
        <div className="field"><label htmlFor="pa-floor">Floor</label><input id="pa-floor" value={s(f.floor)} onChange={set('floor')} placeholder="e.g. 2" /></div>
        <div className="field"><label htmlFor="pa-room">Room</label><input id="pa-room" value={s(f.room)} onChange={set('room')} placeholder="e.g. Accounts office" /></div>
        <div className="field"><label htmlFor="pa-bldg">Building</label><input id="pa-bldg" value={s(f.building)} onChange={set('building')} /></div>
      </div>

      <h4 className="form-sec">Procurement &amp; cost</h4>
      <div className="form-grid">
        <div className="field"><label htmlFor="pa-cost">Purchase cost</label><input id="pa-cost" type="number" min="0" step="0.01" value={s(f.purchaseCost)} onChange={set('purchaseCost')} placeholder="0.00" /></div>
        <div className="field"><label htmlFor="pa-cur">Currency</label><select id="pa-cur" value={s(f.currency)} onChange={set('currency')}>{CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}</select></div>
        <div className="field"><label htmlFor="pa-pdate">Purchase date</label><input id="pa-pdate" type="date" value={s(f.purchaseDate)} onChange={set('purchaseDate')} /></div>
        <div className="field"><label htmlFor="pa-supplier">Supplier</label><select id="pa-supplier" value={s(f.supplierId)} onChange={set('supplierId')}><option value="">Not set</option>{suppliers.map((c) => <option key={s(c.id)} value={s(c.id)}>{s(c.name)}</option>)}</select></div>
        <div className="field"><label htmlFor="pa-po">PO number</label><input id="pa-po" value={s(f.poNumber)} onChange={set('poNumber')} placeholder="Purchase order reference" /></div>
        <div className="field"><label htmlFor="pa-inv">Invoice number</label><input id="pa-inv" value={s(f.invoiceNumber)} onChange={set('invoiceNumber')} /></div>
        <div className="field"><label htmlFor="pa-grn">GRN number</label><input id="pa-grn" value={s(f.grnNumber)} onChange={set('grnNumber')} placeholder="Goods received note" /></div>
        <div className="field"><label htmlFor="pa-cdate">Capitalization date</label><input id="pa-cdate" type="date" value={s(f.capitalizationDate)} onChange={set('capitalizationDate')} /><span className="field-hint">Date the asset enters the fixed asset register.</span></div>
      </div>

      <h4 className="form-sec">Depreciation &amp; tagging</h4>
      <div className="form-grid">
        <div className="field"><label htmlFor="pa-life">Useful life (months)</label><input id="pa-life" type="number" min="1" step="1" value={s(f.usefulLifeMonths)} onChange={set('usefulLifeMonths')} placeholder="e.g. 60" /></div>
        <div className="field"><label htmlFor="pa-res">Residual value</label><input id="pa-res" type="number" min="0" step="0.01" value={s(f.residualValue)} onChange={set('residualValue')} placeholder="0.00" /></div>
        <div className="field"><label htmlFor="pa-depm">Depreciation method</label><select id="pa-depm" value={s(f.depreciationMethod)} onChange={set('depreciationMethod')}>{DEP_METHODS.map((m) => <option key={m} value={m}>{labelize(m)}</option>)}</select></div>
        <div className="field"><label htmlFor="pa-tag">Tag type</label><select id="pa-tag" value={s(f.tagType)} onChange={set('tagType')}>{TAG_TYPES.map((m) => <option key={m} value={m}>{m.replace('_', ' + ')}</option>)}</select></div>
        {estMonthly !== null && (
          <div className="callout" style={{ gridColumn: '1 / -1', marginBottom: 0 }}>
            <div className="callout-body">
              <p style={{ margin: 0 }}>Estimated depreciation: <strong>{fmtMoney(estMonthly)} / month</strong> ({fmtMoney(estMonthly * 12)} per year, straight-line over {life} months).</p>
            </div>
          </div>
        )}
      </div>

      <div className="callout callout-info" style={{ marginTop: 16, marginBottom: 0 }}>
        <span className="callout-icon" aria-hidden>i</span>
        <div className="callout-body">
          <p className="callout-title">What happens next</p>
          <p>The asset is saved as a draft with a permanent asset number and a pending QR tag. Submit it for approval, then capitalise when finance confirms the accounting entry.</p>
        </div>
      </div>
    </Modal>
  );
}
