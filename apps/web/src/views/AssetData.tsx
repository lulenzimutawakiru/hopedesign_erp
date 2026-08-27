import { useCallback, useEffect, useState } from 'react';
import { api, fmtDate, fmtNum } from '../api';
import { useAuth, can } from '../auth';
import { Badge, ErrorBanner, Modal, Pager } from '../components/ui';
import { EmptyState, Skeleton } from '../components/os';
import { AssetModuleTabs, ModuleHeader, apiRaw, downloadBlob, labelize, s } from './assetsShared';

type Rec = Record<string, unknown>;

const EXPORT_FORMATS = ['pdf', 'xlsx', 'csv', 'json'];
const REPORT_TYPES = [
  'Asset Register',
  'Asset Valuation',
  'Assets by Category',
  'Assets by Branch',
  'Assets by Department',
  'Assets by Custodian',
  'Assets by Location',
  'Asset Movement',
  'Asset Audit',
  'Missing Assets',
  'Damaged Assets',
  'Maintenance Cost',
  'Depreciation',
  'Disposal',
  'Warranty Expiry',
  'Insurance Expiry',
  'Asset Utilization',
  'Asset Lifecycle',
];
const STATUS_OPTIONS = ['DRAFT', 'PENDING_APPROVAL', 'REGISTERED', 'IN_STORE', 'AVAILABLE', 'ASSIGNED', 'IN_USE', 'TRANSFERRED', 'UNDER_MAINTENANCE', 'UNDER_INSPECTION', 'MISSING', 'LOST', 'STOLEN', 'DAMAGED', 'QUARANTINED', 'RESERVED', 'DISPOSED', 'RETIRED', 'ARCHIVED'];
const IMPORT_HINT = 'Accepted files: CSV, XLSX, JSON. Recognised headers include name, serial_no, purchase_cost, purchase_date, category, supplier, manufacturer, model, location, custodian_email, condition, useful_life_months, residual_value.';

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function showVal(v: unknown): string {
  if (v === null || v === undefined) return '-';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function parseJsonField(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { return v; }
}

async function fetchRows(path: string): Promise<Rec[]> {
  const r = await api<{ data: unknown }>(path);
  const d = r.data;
  if (Array.isArray(d)) return d as Rec[];
  const rr = (d as Rec | null)?.rows;
  return Array.isArray(rr) ? (rr as Rec[]) : [];
}

type ImportErrorRow = { row: string; message: string };

function toImportErrors(v: unknown): ImportErrorRow[] {
  const parsed = parseJsonField(v);
  if (!Array.isArray(parsed)) return [];
  return (parsed as Rec[]).map((e) => ({
    row: e.row != null ? String(e.row) : e.line != null ? String(e.line) : '-',
    message: s(e.message ?? e.error ?? JSON.stringify(e)),
  }));
}

export function ImportFlow() {
  const { user } = useAuth();
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<Rec | null>(null);
  const [jobs, setJobs] = useState<Rec[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize] = useState(20);
  const [loading, setLoading] = useState(true);
  const [errorsTarget, setErrorsTarget] = useState<{ jobNo: string; errors: ImportErrorRow[] } | null>(null);

  const canCreate = can(user, 'assets.imports.create');
  const canView = can(user, 'assets.imports.view');

  const loadJobs = useCallback(() => {
    setLoading(true); setError('');
    const p = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
    api<{ data: { rows: Rec[]; total: number } }>(`/api/ops/assets/import-jobs?${p.toString()}`)
      .then((r) => { setJobs(r.data.rows ?? []); setTotal(r.data.total ?? 0); })
      .catch((e) => setError(e instanceof Error ? e.message : 'Import jobs failed'))
      .finally(() => setLoading(false));
  }, [page, pageSize]);

  useEffect(() => { if (canView) loadJobs(); }, [canView, loadJobs]);

  const doImport = async () => {
    if (!file) { setError('Choose a CSV, XLSX or JSON file first.'); return; }
    setBusy(true); setError(''); setResult(null);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await apiRaw('/api/ops/assets/import', { method: 'POST', body: fd });
      if (!res.ok) {
        let msg = `Import failed (${res.status})`;
        try { const b = await res.json(); msg = b?.error?.message ?? msg; } catch { /* not json */ }
        throw new Error(msg);
      }
      const body = (await res.json()) as { data?: Rec };
      setResult(body.data ?? null);
      setFile(null);
      setPage(1);
      if (canView) loadJobs();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Import failed');
    } finally {
      setBusy(false);
    }
  };

  const resultErrors = toImportErrors(result?.errors);

  return (
    <div className="page">
      <ModuleHeader
        kicker="Asset management"
        title="Asset import"
        sub="Bulk-load assets from CSV, XLSX or JSON. Rows are validated, registered and written to the asset timeline with a permanent audit record."
      />
      <AssetModuleTabs active="import" />
      {error && <ErrorBanner error={error} />}
      {!canCreate && !canView ? (
        <EmptyState title="No import access" body="Your role does not grant asset import permissions. Ask an administrator to assign assets.imports.view or assets.imports.create." />
      ) : (
        <>
          {canCreate && (
            <section className="card card-pad" style={{ marginBottom: 14 }}>
              <div className="card-head"><h3>Upload asset file</h3></div>
              <div className="form-grid">
                <div className="field">
                  <label htmlFor="imp-file">Data file</label>
                  <input id="imp-file" type="file" accept=".csv,.xlsx,.json"
                    onChange={(e) => { setFile(e.target.files?.[0] ?? null); setError(''); setResult(null); }} />
                  <p className="muted" style={{ marginTop: 6, maxWidth: 760 }}>{IMPORT_HINT}</p>
                </div>
                <div className="field" style={{ justifyContent: 'flex-end' }}>
                  <label>&nbsp;</label>
                  <button className="btn btn-primary" disabled={busy || !file} onClick={() => void doImport()}>
                    {busy ? 'Importing...' : 'Import file'}
                  </button>
                </div>
              </div>
            </section>
          )}
          {result && (
            <section className="card card-pad" style={{ marginBottom: 14 }}>
              <div className="card-head"><h3>Import result - {s(result.jobNo)}</h3></div>
              <div className="grid-3" style={{ marginBottom: 12 }}>
                <div className="callout callout-info"><strong>{fmtNum(num(result.totalRows))}</strong><br /><span className="muted">Total rows</span></div>
                <div className="callout callout-info"><strong>{fmtNum(num(result.successCount))}</strong><br /><span className="muted">Imported</span></div>
                <div className="callout callout-info"><strong>{fmtNum(num(result.errorCount))}</strong><br /><span className="muted">Errors</span></div>
              </div>
              {resultErrors.length > 0 && (
                <div className="table-wrap">
                  <table className="data">
                    <thead><tr><th>Row</th><th>Message</th></tr></thead>
                    <tbody>
                      {resultErrors.slice(0, 200).map((e, i) => (
                        <tr key={i}><td className="td-cell-mono">{e.row}</td><td>{e.message}</td></tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {resultErrors.length === 0 && <p className="muted" style={{ margin: 0 }}>All rows imported successfully.</p>}
            </section>
          )}
          {canView && (
            <section className="card card-pad">
              <div className="card-head"><h3>Import jobs</h3></div>
              {loading && jobs.length === 0 ? <Skeleton rows={5} /> : jobs.length === 0 ? (
                <EmptyState title="No import jobs" body="Files uploaded through this screen or the import API appear here with their validation results." />
              ) : (
                <div className="table-wrap">
                  <table className="data">
                    <thead><tr><th>Job</th><th>File</th><th>Format</th><th>Rows</th><th>Success</th><th>Errors</th><th>Status</th><th>Created</th><th></th></tr></thead>
                    <tbody>
                      {jobs.map((j) => {
                        const jerrs = toImportErrors(j.errors);
                        return (
                          <tr key={s(j.id)}>
                            <td className="td-cell-mono">{s(j.job_no)}</td>
                            <td>{s(j.file_name)}</td>
                            <td>{labelize(j.format)}</td>
                            <td>{fmtNum(j.total_rows)}</td>
                            <td>{fmtNum(j.success_count)}</td>
                            <td>{fmtNum(j.error_count)}</td>
                            <td><Badge value={j.status} /></td>
                            <td>{fmtDate(j.created_at)}</td>
                            <td className="td-actions">
                              {jerrs.length > 0 && (
                                <button className="btn btn-sm" onClick={() => setErrorsTarget({ jobNo: s(j.job_no), errors: jerrs })}>Errors</button>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
              <div className="pager" style={{ marginTop: 12 }}><Pager page={page} pageSize={pageSize} total={total} onPage={setPage} /></div>
            </section>
          )}
        </>
      )}
      {errorsTarget && (
        <Modal title={`Import errors - ${errorsTarget.jobNo}`} onClose={() => setErrorsTarget(null)} wide>
          {errorsTarget.errors.length === 0 ? (
            <EmptyState title="No errors" body="Every row in this job imported successfully." />
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>Row</th><th>Message</th></tr></thead>
                <tbody>
                  {errorsTarget.errors.slice(0, 200).map((e, i) => (
                    <tr key={i}><td className="td-cell-mono">{e.row}</td><td>{e.message}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Modal>
      )}
    </div>
  );
}
export function ExportFlow() {
  const { user } = useAuth();
  const [format, setFormat] = useState('xlsx');
  const [reportType, setReportType] = useState('Asset Register');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [locationId, setLocationId] = useState('');
  const [custodianId, setCustodianId] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const [isMachine, setIsMachine] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [jobs, setJobs] = useState<Rec[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize] = useState(20);
  const [loading, setLoading] = useState(true);
  const [categories, setCategories] = useState<Rec[]>([]);
  const [locations, setLocations] = useState<Rec[]>([]);
  const [custodians, setCustodians] = useState<Rec[]>([]);
  const [departments, setDepartments] = useState<Rec[]>([]);
  const [detailTarget, setDetailTarget] = useState<{ jobNo: string; filters: Rec } | null>(null);

  const canCreate = can(user, 'assets.exports.create');
  const canView = can(user, 'assets.exports.view');

  const loadJobs = useCallback(() => {
    setLoading(true); setError('');
    const p = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
    api<{ data: { rows: Rec[]; total: number } }>(`/api/ops/assets/export-jobs?${p.toString()}`)
      .then((r) => { setJobs(r.data.rows ?? []); setTotal(r.data.total ?? 0); })
      .catch((e) => setError(e instanceof Error ? e.message : 'Export jobs failed'))
      .finally(() => setLoading(false));
  }, [page, pageSize]);

  useEffect(() => { if (canView) loadJobs(); }, [canView, loadJobs]);

  useEffect(() => {
    fetchRows('/api/assets/categories?pageSize=500').then(setCategories).catch(() => undefined);
    fetchRows('/api/assets/locations?pageSize=500').then(setLocations).catch(() => undefined);
    fetchRows('/api/ops/assets/custody').then(setCustodians).catch(() => undefined);
    fetchRows('/api/ops/hr/departments').then(setDepartments).catch(() => undefined);
  }, []);

  const doExport = async () => {
    setBusy(true); setError('');
    try {
      const q = new URLSearchParams();
      q.set('format', format);
      q.set('reportType', reportType);
      if (search) q.set('search', search);
      if (status) q.set('status', status);
      if (categoryId) q.set('categoryId', categoryId);
      if (locationId) q.set('locationId', locationId);
      if (custodianId) q.set('custodianId', custodianId);
      if (departmentId) q.set('departmentId', departmentId);
      if (isMachine) q.set('isMachine', '1');
      await downloadBlob(`/api/ops/assets/export?${q.toString()}`, `asset-register.${format}`);
      setPage(1);
      if (canView) loadJobs();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Export failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page">
      <ModuleHeader
        kicker="Asset management"
        title="Asset export"
        sub="Generate asset register, valuation, movement, audit, maintenance cost, depreciation, disposal, warranty and insurance reports as PDF, XLSX, CSV or JSON. Every export respects RBAC + ABAC scope and is recorded as a job."
      />
      <AssetModuleTabs active="export" />
      {error && <ErrorBanner error={error} />}
      {!canCreate && !canView ? (
        <EmptyState title="No export access" body="Your role does not grant asset export permissions. Ask an administrator to assign assets.exports.view or assets.exports.create." />
      ) : (
        <>
          {canCreate && (
            <section className="card card-pad" style={{ marginBottom: 14 }}>
              <div className="card-head"><h3>Export parameters</h3></div>
              <div className="form-grid">
                <div className="field">
                  <label htmlFor="ex-format">Format</label>
                  <select id="ex-format" value={format} onChange={(e) => setFormat(e.target.value)}>
                    {EXPORT_FORMATS.map((f) => <option key={f} value={f}>{f.toUpperCase()}</option>)}
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="ex-report">Report type</label>
                  <select id="ex-report" value={reportType} onChange={(e) => setReportType(e.target.value)}>
                    {REPORT_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="ex-search">Search</label>
                  <input id="ex-search" placeholder="Asset ID, name, serial, barcode" value={search} onChange={(e) => setSearch(e.target.value)} />
                </div>
                <div className="field">
                  <label htmlFor="ex-status">Status</label>
                  <select id="ex-status" value={status} onChange={(e) => setStatus(e.target.value)}>
                    <option value="">Any status</option>
                    {STATUS_OPTIONS.map((st) => <option key={st} value={st}>{labelize(st)}</option>)}
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="ex-category">Category</label>
                  <select id="ex-category" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
                    <option value="">All categories</option>
                    {categories.map((c) => <option key={s(c.id)} value={s(c.id)}>{s(c.name)}</option>)}
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="ex-location">Location</label>
                  <select id="ex-location" value={locationId} onChange={(e) => setLocationId(e.target.value)}>
                    <option value="">All locations</option>
                    {locations.map((l) => <option key={s(l.id)} value={s(l.id)}>{s(l.name)}</option>)}
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="ex-custodian">Custodian</label>
                  <select id="ex-custodian" value={custodianId} onChange={(e) => setCustodianId(e.target.value)}>
                    <option value="">All custodians</option>
                    {custodians.map((cu) => <option key={s(cu.id)} value={s(cu.id)}>{s(cu.name ?? cu.display_name)}</option>)}
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="ex-department">Department</label>
                  <select id="ex-department" value={departmentId} onChange={(e) => setDepartmentId(e.target.value)}>
                    <option value="">All departments</option>
                    {departments.map((d) => <option key={s(d.id)} value={s(d.id)}>{s(d.name)}</option>)}
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="ex-machine">Scope</label>
                  <select id="ex-machine" value={isMachine ? 'machine' : 'all'} onChange={(e) => setIsMachine(e.target.value === 'machine')}>
                    <option value="all">All assets</option>
                    <option value="machine">Production machines only</option>
                  </select>
                </div>
                <div className="field" style={{ justifyContent: 'flex-end' }}>
                  <label>&nbsp;</label>
                  <button className="btn btn-primary" disabled={busy} onClick={() => void doExport()}>
                    {busy ? 'Exporting...' : `Download ${format.toUpperCase()}`}
                  </button>
                </div>
              </div>
              <p className="muted" style={{ marginTop: 10, marginBottom: 0 }}>Branch scope is applied from your session. The download is written to the export job register for audit.</p>
            </section>
          )}
          {canView && (
            <section className="card card-pad">
              <div className="card-head"><h3>Export jobs</h3></div>
              {loading && jobs.length === 0 ? <Skeleton rows={5} /> : jobs.length === 0 ? (
                <EmptyState title="No export jobs" body="Exports run from this screen or the export API are recorded here with their filters." />
              ) : (
                <div className="table-wrap">
                  <table className="data">
                    <thead><tr><th>Job</th><th>Format</th><th>Report</th><th>Status</th><th>Created</th><th></th></tr></thead>
                    <tbody>
                      {jobs.map((j) => {
                        const parsed = parseJsonField(j.filters);
                        const filters = parsed && typeof parsed === 'object' ? (parsed as Rec) : null;
                        const rowCount = filters ? num(filters.rowCount) : 0;
                        return (
                          <tr key={s(j.id)}>
                            <td className="td-cell-mono">{s(j.job_no)}</td>
                            <td>{labelize(j.format)}</td>
                            <td>{s(j.report_type) || '-'}</td>
                            <td><Badge value={j.status} /></td>
                            <td>{fmtDate(j.created_at)}</td>
                            <td className="td-actions">
                              <button className="btn btn-sm" onClick={() => setDetailTarget({ jobNo: s(j.job_no), filters: filters ?? {} })}>
                                Details{rowCount > 0 ? ` (${fmtNum(rowCount)} rows)` : ''}
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
              <div className="pager" style={{ marginTop: 12 }}><Pager page={page} pageSize={pageSize} total={total} onPage={setPage} /></div>
            </section>
          )}
        </>
      )}
      {detailTarget && (
        <Modal title={`Export filters - ${detailTarget.jobNo}`} onClose={() => setDetailTarget(null)} wide>
          {Object.keys(detailTarget.filters).length === 0 ? (
            <EmptyState title="No filters stored" body="This job was generated without recorded filter details." />
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>Filter</th><th>Value</th></tr></thead>
                <tbody>
                  {Object.entries(detailTarget.filters).map(([k, v]) => (
                    <tr key={k}><td className="td-cell-mono">{k}</td><td>{showVal(v)}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Modal>
      )}
    </div>
  );
}
