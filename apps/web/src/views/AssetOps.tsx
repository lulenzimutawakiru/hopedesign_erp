import { useCallback, useEffect, useRef, useState } from 'react';
import jsQR from 'jsqr';
import { api, fmtDate, fmtMoney, fmtNum } from '../api';
import { useAuth, can } from '../auth';
import { navigate } from '../router';
import { Badge, ErrorBanner, Modal, Pager } from '../components/ui';
import { ConfirmDialog, Drawer, EmptyState, Skeleton } from '../components/os';
import { AssetModuleTabs, ModuleHeader, labelize, s } from './assetsShared';

type Rec = Record<string, unknown>;

const SCAN_ACTIONS = ['IDENTIFY', 'VERIFY', 'ASSIGN', 'TRANSFER', 'INSPECT', 'AUDIT', 'MAINTAIN', 'CHECKIN', 'CHECKOUT', 'REPORT_DAMAGE', 'REPORT_MISSING', 'DISPOSE', 'TRACK'];
const TAG_TYPES = ['QR', 'BARCODE', 'QR_BARCODE'];
const TRANSFER_TYPES = ['EMPLOYEE', 'DEPARTMENT', 'BRANCH', 'WAREHOUSE', 'LOCATION', 'PROJECT'];
const CONDITIONS = ['NEW', 'EXCELLENT', 'GOOD', 'FAIR', 'POOR', 'DAMAGED', 'CRITICAL', 'UNDER_REPAIR', 'BEYOND_ECONOMIC_REPAIR'];

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

function slicePage(rows: Rec[], page: number, pageSize: number): Rec[] {
  return rows.slice((page - 1) * pageSize, page * pageSize);
}

export function AssetScan() {
  const { user } = useAuth();
  const [code, setCode] = useState('');
  const [action, setAction] = useState('VERIFY');
  const [locationId, setLocationId] = useState('');
  const [note, setNote] = useState('');
  const [result, setResult] = useState<Rec | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [cameraOn, setCameraOn] = useState(false);
  const [camHint, setCamHint] = useState('Align the code inside the frame');
  const [locations, setLocations] = useState<Rec[]>([]);
  const [history, setHistory] = useState<Rec[]>([]);
  const [histLoading, setHistLoading] = useState(true);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef(0);
  const lockedRef = useRef(false);
  const actionRef = useRef(action);
  const locationRef = useRef(locationId);
  const noteRef = useRef(note);
  const postRef = useRef<(raw: string) => Promise<void>>(async () => undefined);
  actionRef.current = action;
  locationRef.current = locationId;
  noteRef.current = note;

  const loadHistory = useCallback(() => {
    setHistLoading(true);
    api<{ data: { rows: Rec[] } }>('/api/ops/assets/scans?pageSize=200')
      .then((r) => setHistory(r.data.rows ?? []))
      .catch(() => undefined)
      .finally(() => setHistLoading(false));
  }, []);

  useEffect(() => {
    fetchRows('/api/assets/locations?pageSize=500')
      .then(setLocations)
      .catch(() => undefined);
    loadHistory();
  }, [loadHistory]);

  const stopCamera = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setCameraOn(false);
  }, []);

  useEffect(() => () => stopCamera(), [stopCamera]);

  const postCode = async (raw: string) => {
    const c = raw.trim();
    if (!c || lockedRef.current) return;
    lockedRef.current = true;
    setBusy(true);
    setError('');
    try {
      const r = await api<{ data: Rec }>('/api/ops/assets/scans', {
        method: 'POST',
        body: JSON.stringify({
          code: c,
          action: actionRef.current || undefined,
          locationId: locationRef.current || undefined,
          note: noteRef.current || undefined,
          device: cameraOn ? 'camera' : 'manual',
        }),
      });
      setResult(r.data);
      setCode('');
      stopCamera();
      loadHistory();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Scan failed');
      lockedRef.current = false;
    } finally {
      setBusy(false);
    }
  };
  postRef.current = postCode;

  const tick = useCallback(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || video.readyState < 2) {
      rafRef.current = requestAnimationFrame(tick);
      return;
    }
    const w = video.videoWidth;
    const h = video.videoHeight;
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(video, 0, 0, w, h);
    const image = ctx.getImageData(0, 0, w, h);
    const decoded = jsQR(image.data, w, h, { inversionAttempts: 'dontInvert' });
    if (decoded?.data) {
      setCamHint('Code locked');
      void postRef.current(decoded.data);
      return;
    }
    rafRef.current = requestAnimationFrame(tick);
  }, []);

  const startCamera = async () => {
    setError('');
    lockedRef.current = false;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
      streamRef.current = stream;
      setCameraOn(true);
      setCamHint('Align the code inside the frame');
      requestAnimationFrame(() => {
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          void videoRef.current.play();
          rafRef.current = requestAnimationFrame(tick);
        }
      });
    } catch {
      setError('Camera blocked or unavailable. Type the code or use a USB / Bluetooth scanner instead.');
    }
  };

  const submit = async (e?: { preventDefault(): void }) => {
    e?.preventDefault();
    lockedRef.current = false;
    await postCode(code);
  };
  return (
    <div className="page">
      <ModuleHeader
        kicker="Asset management"
        title="Global asset scanner"
        sub="Scan a QR or barcode tag with your phone, tablet, USB or Bluetooth scanner. Every scan is authenticated, authorized by RBAC + ABAC and written to the scan log."
        actions={can(user, 'assets.register.create') ? <button className="btn btn-primary" onClick={() => navigate('/assets/register?new=1')}>Register asset</button> : undefined}
      />
      <AssetModuleTabs active="scan" />
      {error && <ErrorBanner error={error} />}
      <div className="grid-2">
        <section className="card card-pad">
          <div className="card-head"><h3>Scan a tag</h3></div>
          <div className="scan-stage">
            {cameraOn ? (
              <>
                <video ref={videoRef} className="scan-video" muted playsInline />
                <p className="hint">{camHint}</p>
                <button type="button" className="btn btn-sm" onClick={stopCamera}>Stop camera</button>
              </>
            ) : (
              <div className="quick-actions">
                <button type="button" className="btn btn-primary" onClick={() => void startCamera()}>Open camera</button>
                <span className="muted" style={{ fontSize: 12 }}>or type the code below</span>
              </div>
            )}
            <canvas ref={canvasRef} hidden />
          </div>
          <form onSubmit={submit}>
            <label className="field">
              <span>QR code / payload</span>
              <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="HDG-AST-2026-000001 or scanned payload" autoComplete="off" />
            </label>
            <div className="grid-2">
              <label className="field">
                <span>Action</span>
                <select value={action} onChange={(e) => setAction(e.target.value)}>
                  {SCAN_ACTIONS.map((a) => <option key={a} value={a}>{labelize(a)}</option>)}
                </select>
              </label>
              <label className="field">
                <span>Location (optional)</span>
                <select value={locationId} onChange={(e) => setLocationId(e.target.value)}>
                  <option value="">Not set</option>
                  {locations.map((l) => <option key={s(l.id)} value={String(l.id)}>{s(l.name)}{s(l.code) ? ` (${s(l.code)})` : ''}</option>)}
                </select>
              </label>
            </div>
            <label className="field">
              <span>Note (optional)</span>
              <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Condition observed, context or reason" />
            </label>
            <button className="btn btn-primary btn-block" disabled={busy || !code.trim()}>{busy ? 'Scanning...' : 'Scan'}</button>
          </form>
          {result && <ScanResult result={result} />}
        </section>
        <section className="card card-pad">
          <div className="card-head"><h3>Recent scans</h3></div>
          {histLoading ? <Skeleton rows={6} /> : history.length === 0 ? (
            <EmptyState title="No scans yet" body="Scans performed in this session appear here." />
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>Asset</th><th>Action</th><th>Result</th><th>When</th><th>By</th></tr></thead>
                <tbody>
                  {history.slice(0, 12).map((h, i) => (
                    <tr key={i}>
                      <td><strong>{s(h.asset_no)}</strong><br /><span className="muted">{s(h.asset_name)}</span></td>
                      <td>{labelize(h.scan_type)}</td>
                      <td><Badge value={h.result} /></td>
                      <td>{fmtDate(h.scanned_at)}</td>
                      <td>{s(h.scanned_by_name)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="hint" style={{ marginTop: 10 }}>Last-known location is derived from authorized scans, not GPS. No GPS precision is claimed.</p>
        </section>
      </div>
    </div>
  );
}

function ScanResult({ result }: { result: Rec }) {
  const { user } = useAuth();
  const asset = (result.asset as Rec) ?? {};
  const tag = (result.tag as Rec) ?? {};
  const qr = (result.qr as Rec) ?? {};
  const lastKnown = (result.lastKnown as Rec) ?? {};
  const id = num(asset.id);
  const kind = s(result.result);
  const ok = kind === 'AUTHENTIC';
  return (
    <div className={`scan-result ${ok ? 'scan-verified' : ''}`} style={{ marginTop: 14 }}>
      <div className="verify-mark">{ok ? 'QR AUTHENTIC' : kind === 'VOID' ? 'TAG VOIDED' : labelize(kind) || 'UNKNOWN RESULT'}</div>
      <div className="result-row"><span>Asset</span><strong>{s(asset.assetNo)}</strong></div>
      <div className="result-row"><span>Name</span><strong>{s(asset.name)}</strong></div>
      <div className="result-row"><span>Status</span><Badge value={asset.status} /></div>
      <div className="result-row"><span>Condition</span><span>{labelize(asset.condition)}</span></div>
      <div className="result-row"><span>Custodian</span><strong>{s(asset.custodianName) || 'Unassigned'}</strong></div>
      <div className="result-row"><span>Location</span><strong>{s(asset.locationName) || 'Not set'}</strong></div>
      <div className="result-row"><span>Book value</span><strong>{fmtMoney(asset.currentBookValue)} {s(asset.currency)}</strong></div>
      <div className="result-row"><span>Tag</span><span>{s(tag.tagNo)} - {labelize(tag.status)}</span></div>
      <div className="result-row"><span>QR token</span><code className="td-cell-mono">{s(qr.code)}</code></div>
      {s(lastKnown.scannedAt) && (
        <div className="result-row"><span>Last verified</span><span>{fmtDate(lastKnown.scannedAt)} by {s(lastKnown.scannedBy) || '-'}</span></div>
      )}
      <div className="quick-actions scan-actions">
        {id > 0 && can(user, 'assets.register.view') && <button className="btn" onClick={() => navigate(`/assets/${id}`)}>Asset 360</button>}
        {id > 0 && can(user, 'assets.register.verify') && <button className="btn" onClick={() => navigate('/assets/verify')}>Verify</button>}
        {id > 0 && can(user, 'assets.maintenance.create') && <button className="btn" onClick={() => navigate('/assets/maintenance')}>Maintenance</button>}
        {id > 0 && can(user, 'assets.transfers.create') && <button className="btn" onClick={() => navigate('/assets/transfers')}>Transfer</button>}
      </div>
      <p className="hint" style={{ marginTop: 8 }}>Only actions permitted by your role and scope are shown. The QR token itself contains no asset data.</p>
    </div>
  );
}
export function VerifyFlow() {
  const { user } = useAuth();
  const [rows, setRows] = useState<Rec[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize] = useState(25);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [locationId, setLocationId] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const [dueOnly, setDueOnly] = useState(false);
  const [locations, setLocations] = useState<Rec[]>([]);
  const [departments, setDepartments] = useState<Rec[]>([]);
  const [target, setTarget] = useState<Rec | null>(null);

  useEffect(() => {
    fetchRows('/api/assets/locations?pageSize=500').then(setLocations).catch(() => undefined);
    fetchRows('/api/ops/hr/departments').then(setDepartments).catch(() => undefined);
  }, []);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError('');
    const p = new URLSearchParams();
    if (status) p.set('status', status);
    if (locationId) p.set('locationId', locationId);
    if (departmentId) p.set('departmentId', departmentId);
    if (dueOnly) p.set('dueOnly', '1');
    if (search) p.set('search', search);
    p.set('page', String(page));
    p.set('pageSize', String(pageSize));
    api<{ data: { rows: Rec[]; total: number } }>(`/api/ops/assets/verification?${p.toString()}`)
      .then((r) => { if (!alive) return; setRows(r.data.rows ?? []); setTotal(r.data.total ?? 0); })
      .catch((e) => { if (alive) setError(e instanceof Error ? e.message : 'Verification queue failed'); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [status, locationId, departmentId, dueOnly, search, page, pageSize]);

  const refresh = () => setPage((p) => (p === 1 ? 1 : p));

  return (
    <div className="page">
      <ModuleHeader
        kicker="Asset management"
        title="Asset verification"
        sub="Physically verify assets against the register. Scans compare expected location, custodian and condition and record exceptions for the audit trail."
        actions={can(user, 'assets.register.verify') ? <button className="btn btn-primary" onClick={() => setTarget({})}>Verify by scan</button> : undefined}
      />
      <AssetModuleTabs active="verify" />
      <div className="card card-pad" style={{ marginBottom: 14 }}>
        <div className="form-grid">
          <div className="field">
            <label htmlFor="vf-search">Search</label>
            <input id="vf-search" placeholder="Asset ID, name, serial, QR" value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { setPage(1); refresh(); } }} />
          </div>
          <div className="field">
            <label htmlFor="vf-status">Status</label>
            <select id="vf-status" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
              <option value="">Any status</option>
              <option value="ASSIGNED">Assigned</option>
              <option value="IN_USE">In use</option>
              <option value="IN_STORE">In store</option>
              <option value="AVAILABLE">Available</option>
              <option value="UNDER_MAINTENANCE">Under maintenance</option>
              <option value="MISSING">Missing</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="vf-loc">Location</label>
            <select id="vf-loc" value={locationId} onChange={(e) => { setLocationId(e.target.value); setPage(1); }}>
              <option value="">Any location</option>
              {locations.map((l) => <option key={s(l.id)} value={String(l.id)}>{s(l.name)}</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor="vf-dep">Department</label>
            <select id="vf-dep" value={departmentId} onChange={(e) => { setDepartmentId(e.target.value); setPage(1); }}>
              <option value="">Any department</option>
              {departments.map((d) => <option key={s(d.id)} value={String(d.id)}>{s(d.name)}</option>)}
            </select>
          </div>
          <div className="field" style={{ justifyContent: 'flex-end' }}>
            <label>&nbsp;</label>
            <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center', fontSize: 12 }}>
              <input type="checkbox" checked={dueOnly} onChange={(e) => { setDueOnly(e.target.checked); setPage(1); }} />
              Due for verification only
            </label>
          </div>
        </div>
      </div>
      {error && <ErrorBanner error={error} />}
      <section className="card card-pad">
        <div className="card-head"><h3>Verification queue</h3></div>
        {loading && rows.length === 0 ? <Skeleton rows={6} /> : rows.length === 0 ? (
          <EmptyState title="Nothing to verify" body="No assets match the current filters." />
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Asset</th><th>Category</th><th>Status</th><th>Condition</th><th>Location</th><th>Custodian</th><th>Last verified</th><th></th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={s(r.id)}>
                    <td><strong>{s(r.asset_no)}</strong><br /><span className="muted">{s(r.name)}</span></td>
                    <td>{s(r.category_name) || '-'}</td>
                    <td><Badge value={r.status} /></td>
                    <td>{labelize(r.condition)}</td>
                    <td>{s(r.location_name) || '-'}</td>
                    <td>{s(r.custodian_name) || '-'}</td>
                    <td>{r.last_verified_at ? fmtDate(r.last_verified_at) : <span className="muted">Never</span>}</td>
                    <td className="td-actions">
                      {can(user, 'assets.register.verify') && <button className="btn btn-sm" onClick={() => setTarget(r)}>Verify</button>}
                      {can(user, 'assets.register.view') && <button className="link-btn" onClick={() => navigate(`/assets/${num(r.id)}`)}>360</button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="pager" style={{ marginTop: 12 }}>
          <Pager page={page} pageSize={pageSize} total={total} onPage={setPage} />
        </div>
      </section>
      {target && <VerifyModal asset={target} onClose={() => setTarget(null)} onDone={() => { setTarget(null); setPage(1); refresh(); }} />}
    </div>
  );
}

function VerifyModal({ asset, onClose, onDone }: { asset: Rec; onClose: () => void; onDone: () => void }) {
  const [assets, setAssets] = useState<Rec[]>([]);
  const [assetId, setAssetId] = useState(asset && num(asset.id) > 0 ? String(asset.id) : '');
  const [code, setCode] = useState('');
  const [locationId, setLocationId] = useState(asset ? String(asset.location_id ?? '') : '');
  const [custodianUserId, setCustodianUserId] = useState(asset ? String(asset.custodian_user_id ?? '') : '');
  const [condition, setCondition] = useState(asset ? s(asset.condition) : '');
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
    if (!asset || num(asset.id) <= 0) fetchRows('/api/ops/assets?pageSize=200').then(setAssets).catch(() => undefined);
  }, [asset]);

  const submit = async () => {
    setBusy(true); setError(''); setResponse(null);
    try {
      const r = await api<{ data: Rec }>('/api/ops/assets/verification/verify', {
        method: 'POST',
        body: JSON.stringify({
          assetId: assetId || undefined,
          code: code || undefined,
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
        {!response && <button className="btn btn-primary" disabled={busy || (!assetId && !code.trim())} onClick={() => void submit()}>{busy ? 'Submitting...' : 'Submit verification'}</button>}
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
          {(!asset || num(asset.id) <= 0) && (
            <>
              <div className="field" style={{ gridColumn: '1 / -1' }}>
                <label htmlFor="vm-code">Scan code or asset</label>
                <input id="vm-code" value={code} onChange={(e) => setCode(e.target.value)} placeholder="Paste a scanned QR payload" />
              </div>
              <div className="field">
                <label htmlFor="vm-asset">Or choose asset</label>
                <select id="vm-asset" value={assetId} onChange={(e) => setAssetId(e.target.value)}>
                  <option value="">Select asset</option>
                  {assets.map((a) => <option key={s(a.id)} value={String(a.id)}>{s(a.asset_no)} - {s(a.name)}</option>)}
                </select>
              </div>
            </>
          )}
          {asset && num(asset.id) > 0 && (
            <div className="callout callout-info" style={{ gridColumn: '1 / -1' }}>
              {s(asset.asset_no)} - {s(asset.name)}
            </div>
          )}
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
export function TagsFlow() {
  const { user } = useAuth();
  const [tab, setTab] = useState('tags');
  const [tags, setTags] = useState<Rec[]>([]);
  const [jobs, setJobs] = useState<Rec[]>([]);
  const [events, setEvents] = useState<Rec[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [tagPage, setTagPage] = useState(1);
  const [jobPage, setJobPage] = useState(1);
  const [eventPage, setEventPage] = useState(1);
  const [tagStatus, setTagStatus] = useState('');
  const [tagSearch, setTagSearch] = useState('');
  const [assets, setAssets] = useState<Rec[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [tagType, setTagType] = useState('QR');
  const [modal, setModal] = useState('');
  const [printTarget, setPrintTarget] = useState<Rec | null>(null);
  const [replaceTarget, setReplaceTarget] = useState<Rec | null>(null);
  const [voidTarget, setVoidTarget] = useState<Rec | null>(null);
  const [notice, setNotice] = useState('');
  const pageSize = 20;

  const load = useCallback(() => {
    setLoading(true); setError('');
    Promise.all([
      fetchRows('/api/ops/assets/tags?pageSize=200'),
      fetchRows('/api/ops/assets/tags/print-jobs?pageSize=200'),
      fetchRows('/api/ops/assets/tags/events?pageSize=200'),
    ])
      .then(([t, j, ev]) => { setTags(t); setJobs(j); setEvents(ev); })
      .catch((e) => setError(e instanceof Error ? e.message : 'Tags failed to load'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  const filtered = tags.filter((t) =>
    (!tagStatus || s(t.status) === tagStatus) &&
    (!tagSearch || (s(t.asset_no) + ' ' + s(t.asset_name) + ' ' + s(t.tag_no) + ' ' + s(t.qr_code)).toLowerCase().includes(tagSearch.toLowerCase()))
  );

  const openGenerate = () => {
    setSelected(new Set());
    setModal('generate');
    fetchRows('/api/ops/assets?pageSize=200').then(setAssets).catch(() => undefined);
  };

  const run = async (fn: () => Promise<unknown>, okMsg: string) => {
    try {
      await fn();
      setNotice(okMsg);
      setTimeout(() => setNotice(''), 2500);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Action failed');
    }
  };

  const toggle = (id: number) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id); else next.add(id);
    setSelected(next);
  };

  const generateBulk = async () => {
    if (!selected.size) return;
    await run(async () => {
      await api('/api/ops/assets/tags/generate-bulk', { method: 'POST', body: JSON.stringify({ assetIds: [...selected], tagType }) });
    }, `Generated tags for ${selected.size} assets`);
    setModal('');
  };

  const toggleAll = (rows: Rec[]) => {
    const ids = rows.map((r) => num(r.id)).filter((i) => i > 0);
    const allSelected = ids.length > 0 && ids.every((i) => selected.has(i));
    const next = new Set(selected);
    if (allSelected) ids.forEach((i) => next.delete(i)); else ids.forEach((i) => next.add(i));
    setSelected(next);
  };

  const voidTag = async (reason: string) => {
    if (!voidTarget) return;
    const id = num(voidTarget.id);
    await run(async () => {
      await api(`/api/ops/assets/tags/${id}/void`, { method: 'POST', body: JSON.stringify({ reason: reason || undefined }) });
    }, `Tag ${s(voidTarget.tag_no)} voided`);
    setVoidTarget(null);
  };

  const tagAction = (id: number, act: string, msg: string) => {
    void run(async () => {
      await api(`/api/ops/assets/tags/${id}/${act}`, { method: 'POST', body: JSON.stringify({}) });
    }, msg);
  };

  const scopeTags = slicePage(filtered, tagPage, pageSize);
  const scopeJobs = slicePage(jobs, jobPage, pageSize);
  const scopeEvents = slicePage(events, eventPage, pageSize);

  return (
    <div className="page">
      <ModuleHeader
        kicker="Asset management"
        title="Asset tags"
        sub="Secure QR and barcode identities for every physical asset. A voided tag is never reactivated; replacements keep full tag history."
        actions={can(user, 'assets.tags.generate') ? <button className="btn btn-primary" onClick={openGenerate}>Generate bulk tags</button> : undefined}
      />
      <AssetModuleTabs active="tags" />
      {notice && <div className="notice-banner">{notice}</div>}
      {error && <ErrorBanner error={error} />}
      <div className="tabs" style={{ marginBottom: 14 }}>
        <button className={tab === 'tags' ? 'tab active' : 'tab'} onClick={() => setTab('tags')}>Tags</button>
        <button className={tab === 'jobs' ? 'tab active' : 'tab'} onClick={() => setTab('jobs')}>Print jobs</button>
        <button className={tab === 'events' ? 'tab active' : 'tab'} onClick={() => setTab('events')}>Tag events</button>
      </div>
      {loading ? <Skeleton rows={8} /> : tab === 'tags' && (
        <section className="card card-pad">
          <div className="card-head"><h3>Tag register</h3></div>
          <div className="form-grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))' }}>
            <div className="field">
              <label htmlFor="tg-search">Search</label>
              <input id="tg-search" placeholder="Tag, asset or QR token" value={tagSearch} onChange={(e) => setTagSearch(e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="tg-status">Tag status</label>
              <select id="tg-status" value={tagStatus} onChange={(e) => setTagStatus(e.target.value)}>
                <option value="">Any status</option>
                {['ACTIVE', 'PENDING', 'PRINTED', 'ASSIGNED', 'DAMAGED', 'LOST', 'REPLACEMENT_PENDING', 'REPLACED', 'VOID', 'ARCHIVED'].map((st) => <option key={st} value={st}>{labelize(st)}</option>)}
              </select>
            </div>
          </div>
          {scopeTags.length === 0 ? <EmptyState title="No tags found" body="Generate a tag for an asset or clear the filters." /> : (
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th><input type="checkbox" checked={scopeTags.length > 0 && scopeTags.every((t) => selected.has(num(t.id)))} onChange={() => toggleAll(scopeTags)} /></th><th>Tag</th><th>Asset</th><th>QR token</th><th>Status</th><th>Created</th><th></th></tr></thead>
                <tbody>
                  {scopeTags.map((t) => {
                    const tid = num(t.id);
                    const aid = num(t.asset_id);
                    return (
                      <tr key={s(t.id)}>
                        <td><input type="checkbox" checked={selected.has(tid)} onChange={() => toggle(tid)} /></td>
                        <td className="td-cell-mono">{s(t.tag_no)}</td>
                        <td><strong>{s(t.asset_no)}</strong><br /><span className="muted">{s(t.asset_name)}</span></td>
                        <td><code className="td-cell-mono">{s(t.qr_code)}</code></td>
                        <td><Badge value={t.status} /></td>
                        <td>{fmtDate(t.created_at)}</td>
                        <td className="td-actions">
                          {can(user, 'assets.tags.generate') && ['PENDING', 'PRINTED'].includes(s(t.status)) && aid > 0 && <button className="btn btn-sm" onClick={() => setPrintTarget(t)}>Print</button>}
                          {can(user, 'assets.tags.replace') && aid > 0 && <button className="btn btn-sm" onClick={() => setReplaceTarget(t)}>Replace</button>}
                          {can(user, 'assets.tags.generate') && ['ACTIVE', 'ASSIGNED'].includes(s(t.status)) && <button className="btn btn-sm" onClick={() => tagAction(tid, 'verify', `Tag ${s(t.tag_no)} verified`)}>Verify</button>}
                          {can(user, 'assets.tags.generate') && ['ACTIVE'].includes(s(t.status)) && <button className="btn btn-sm" onClick={() => tagAction(tid, 'attach', `Tag ${s(t.tag_no)} attached`)}>Attach</button>}
                          {can(user, 'assets.tags.void') && !['VOID', 'ARCHIVED', 'REPLACED'].includes(s(t.status)) && <button className="link-btn" onClick={() => setVoidTarget(t)}>Void</button>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <div className="pager" style={{ marginTop: 12 }}><Pager page={tagPage} pageSize={pageSize} total={filtered.length} onPage={setTagPage} /></div>
        </section>
      )}
      {tab === 'jobs' && (
        <section className="card card-pad">
          <div className="card-head"><h3>Tag print jobs</h3></div>
          {scopeJobs.length === 0 ? <EmptyState title="No print jobs" body="Print jobs created from tag printing appear here with full audit details." /> : (
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>Job</th><th>Template</th><th>Quantity</th><th>Assets</th><th>Printer</th><th>Status</th><th>Requested by</th><th>Completed</th><th>Reprint reason</th></tr></thead>
                <tbody>
                  {scopeJobs.map((p) => (
                    <tr key={s(p.id)}>
                      <td className="td-cell-mono">{s(p.job_no)}</td>
                      <td>{s(p.template_name) || '-'}</td>
                      <td>{fmtNum(num(p.quantity))}</td>
                      <td>{s(p.asset_ids) ? String(p.asset_ids).length : '-'}</td>
                      <td>{s(p.printer) || '-'}</td>
                      <td><Badge value={p.status} /></td>
                      <td>{s(p.requested_by_name)}</td>
                      <td>{p.completed_at ? fmtDate(p.completed_at) : '-'}</td>
                      <td>{s(p.reprint_reason) || '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="pager" style={{ marginTop: 12 }}><Pager page={jobPage} pageSize={pageSize} total={jobs.length} onPage={setJobPage} /></div>
        </section>
      )}
      {tab === 'events' && (
        <section className="card card-pad">
          <div className="card-head"><h3>Tag event history</h3></div>
          {scopeEvents.length === 0 ? <EmptyState title="No tag events" body="Generate, print, attach, verify, replace and void events appear here." /> : (
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>Tag</th><th>Event</th><th>Asset</th><th>By</th><th>When</th></tr></thead>
                <tbody>
                  {scopeEvents.map((e) => (
                    <tr key={s(e.id)}>
                      <td className="td-cell-mono">{s(e.tag_no)}</td>
                      <td>{labelize(e.event_type ?? e.event ?? e.action)}</td>
                      <td>{s(e.asset_no) || '-'}</td>
                      <td>{s(e.performed_by_name)}</td>
                      <td>{fmtDate(e.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="pager" style={{ marginTop: 12 }}><Pager page={eventPage} pageSize={pageSize} total={events.length} onPage={setEventPage} /></div>
        </section>
      )}
      {modal === 'generate' && (
        <Modal title="Generate bulk tags" onClose={() => setModal('')} wide footer={
          <div className="quick-actions">
            <button className="btn" onClick={() => setModal('')}>Cancel</button>
            <button className="btn btn-primary" disabled={!selected.size} onClick={() => void generateBulk()}>Generate {selected.size} tag(s)</button>
          </div>
        }>
          <div className="form-grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))' }}>
            <div className="field">
              <label htmlFor="gen-type">Tag type</label>
              <select id="gen-type" value={tagType} onChange={(e) => setTagType(e.target.value)}>
                {TAG_TYPES.map((tt) => <option key={tt} value={tt}>{labelize(tt)}</option>)}
              </select>
            </div>
            <div className="field">
              <label>&nbsp;</label>
              <button className="btn btn-sm" onClick={() => toggleAll(assets)}>Toggle all</button>
            </div>
          </div>
          <div className="table-wrap" style={{ maxHeight: 420, overflowY: 'auto' }}>
            <table className="data">
              <thead><tr><th><input type="checkbox" checked={assets.length > 0 && assets.every((a) => selected.has(num(a.id)))} onChange={() => toggleAll(assets)} /></th><th>Asset</th><th>Category</th><th>Status</th><th>Location</th></tr></thead>
              <tbody>
                {assets.map((a) => (
                  <tr key={s(a.id)}>
                    <td><input type="checkbox" checked={selected.has(num(a.id))} onChange={() => toggle(num(a.id))} /></td>
                    <td><strong>{s(a.asset_no)}</strong><br /><span className="muted">{s(a.name)}</span></td>
                    <td>{s(a.category_name) || '-'}</td>
                    <td><Badge value={a.status} /></td>
                    <td>{s(a.location_name) || '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="hint">Secure opaque QR tokens are generated server-side. They contain no asset details.</p>
        </Modal>
      )}
      {printTarget && <PrintModal target={printTarget} onClose={() => setPrintTarget(null)} onDone={() => { setPrintTarget(null); load(); }} />}
      {replaceTarget && <ReplaceModal target={replaceTarget} onClose={() => setReplaceTarget(null)} onDone={() => { setReplaceTarget(null); load(); }} />}
      {voidTarget && (
        <ConfirmDialog
          title="Void tag"
          body={`Void tag ${s(voidTarget.tag_no)}? A voided tag can never be reactivated. The record is kept for history.`}
          confirmLabel="Void tag"
          danger
          onCancel={() => setVoidTarget(null)}
          onConfirm={(reason) => void voidTag(reason)}
        />
      )}
    </div>
  );
}

function PrintModal({ target, onClose, onDone }: { target: Rec; onClose: () => void; onDone: () => void }) {
  const [templateId, setTemplateId] = useState('');
  const [printer, setPrinter] = useState('');
  const [reprintReason, setReprintReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const aid = num(target.asset_id);
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
    <Modal title={`Print tag - ${s(target.tag_no)}`} onClose={onClose} footer={
      <div className="quick-actions">
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={busy || !aid} onClick={() => void submit()}>{busy ? 'Sending...' : 'Send to print'}</button>
      </div>
    }>
      <p className="muted">Creates a print job for asset {s(target.asset_no)} ({s(target.asset_name)}). Every print is recorded in the tag print audit.</p>
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

function ReplaceModal({ target, onClose, onDone }: { target: Rec; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const [tagType, setTagType] = useState('QR');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [replacement, setReplacement] = useState<Rec | null>(null);
  const aid = num(target.asset_id);
  const submit = async () => {
    setBusy(true); setError('');
    try {
      const r = await api<{ data: Rec }>(`/api/ops/assets/${aid}/tags/replace`, {
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
    <Modal title={`Replace tag - ${s(target.tag_no)}`} onClose={onClose} footer={
      <div className="quick-actions">
        <button className="btn" onClick={onClose}>Close</button>
        {!replacement && <button className="btn btn-primary" disabled={busy || !aid} onClick={() => void submit()}>{busy ? 'Replacing...' : 'Void and replace'}</button>}
      </div>
    }>
      {replacement ? (
        <div className="stack">
          <div className="callout callout-info">Old tag voided. Replacement <strong>{s(replacement.tagNo)}</strong> created with status {labelize(replacement.status)}.</div>
          <div className="field"><label>New QR token</label><code className="td-cell-mono">{s(replacement.qrCode)}</code></div>
          <button className="btn btn-primary" onClick={onDone}>Done</button>
        </div>
      ) : (
        <>
          <p className="muted">Voids {s(target.tag_no)} and generates a fresh replacement tag. The old tag record is never deleted.</p>
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
export function CustodyFlow() {
  const { user } = useAuth();
  const [rows, setRows] = useState<Rec[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [assignTarget, setAssignTarget] = useState<Rec | null>(null);
  const [returnTarget, setReturnTarget] = useState<Rec | null>(null);
  const [acceptTarget, setAcceptTarget] = useState<Rec | null>(null);
  const pageSize = 20;

  const load = useCallback(() => {
    setLoading(true); setError('');
    api<{ data: { rows: Rec[] } }>('/api/ops/assets/custody?pageSize=200')
      .then((r) => setRows(r.data.rows ?? []))
      .catch((e) => setError(e instanceof Error ? e.message : 'Custody history failed'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  const filtered = rows.filter((c) =>
    !search || (s(c.asset_no) + ' ' + s(c.asset_name) + ' ' + s(c.custodian_name) + ' ' + s(c.department_name)).toLowerCase().includes(search.toLowerCase())
  );
  const scope = slicePage(filtered, page, pageSize);

  const accept = async () => {
    if (!acceptTarget) return;
    try {
      await api(`/api/ops/assets/custody/${num(acceptTarget.id)}/accept`, { method: 'POST', body: JSON.stringify({}) });
      setAcceptTarget(null);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Acceptance failed');
    }
  };

  return (
    <div className="page">
      <ModuleHeader
        kicker="Asset management"
        title="Asset custody"
        sub="Employee and department custody with assignment, digital acknowledgement, expected return dates and return processing. Custody history is never overwritten."
        actions={can(user, 'assets.assignments.create') ? <button className="btn btn-primary" onClick={() => setAssignTarget({})}>Assign asset</button> : undefined}
      />
      <AssetModuleTabs active="custody" />
      {error && <ErrorBanner error={error} />}
      <section className="card card-pad">
        <div className="card-head"><h3>Custody register</h3></div>
        <div className="form-grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))' }}>
          <div className="field">
            <label htmlFor="cu-search">Search</label>
            <input id="cu-search" placeholder="Asset, custodian or department" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
        </div>
        {loading ? <Skeleton rows={6} /> : scope.length === 0 ? (
          <EmptyState title="No custody records" body="Assignments and returns will appear here." />
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Asset</th><th>Custodian</th><th>From</th><th>Department</th><th>Action</th><th>Current</th><th>Accepted</th><th>Expected return</th><th>Released</th><th></th></tr></thead>
              <tbody>
                {scope.map((c) => {
                  const current = c.is_current === true || s(c.is_current) === 'true' || num(c.is_current) === 1;
                  const pendingAccept = current && !c.accepted_at;
                  return (
                    <tr key={s(c.id)}>
                      <td><strong>{s(c.asset_no)}</strong><br /><span className="muted">{s(c.asset_name)}</span></td>
                      <td><strong>{s(c.custodian_name)}</strong></td>
                      <td>{s(c.from_user_name) || '-'}</td>
                      <td>{s(c.department_name) || '-'}</td>
                      <td>{labelize(c.action)}</td>
                      <td>{current ? <Badge value="ASSIGNED" /> : <span className="muted">No</span>}</td>
                      <td>{c.accepted_at ? fmtDate(c.accepted_at) : <span className="muted">Pending</span>}</td>
                      <td>{c.expected_return_date ? fmtDate(c.expected_return_date) : '-'}</td>
                      <td>{c.released_at ? fmtDate(c.released_at) : '-'}</td>
                      <td className="td-actions">
                        {pendingAccept && can(user, 'assets.assignments.complete') && <button className="btn btn-sm" onClick={() => setAcceptTarget(c)}>Accept</button>}
                        {current && can(user, 'assets.assignments.return') && <button className="btn btn-sm" onClick={() => setReturnTarget(c)}>Return</button>}
                        {can(user, 'assets.register.view') && num(c.asset_id) > 0 && <button className="link-btn" onClick={() => navigate(`/assets/${num(c.asset_id)}`)}>360</button>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <div className="pager" style={{ marginTop: 12 }}><Pager page={page} pageSize={pageSize} total={filtered.length} onPage={setPage} /></div>
      </section>
      {assignTarget && <AssignModal asset={assignTarget} onClose={() => setAssignTarget(null)} onDone={() => { setAssignTarget(null); load(); }} />}
      {returnTarget && <ReturnModal asset={returnTarget} onClose={() => setReturnTarget(null)} onDone={() => { setReturnTarget(null); load(); }} />}
      {acceptTarget && (
        <Modal title="Accept assignment" onClose={() => setAcceptTarget(null)} footer={
          <div className="quick-actions">
            <button className="btn" onClick={() => setAcceptTarget(null)}>Cancel</button>
            <button className="btn btn-primary" onClick={() => void accept()}>Confirm acceptance</button>
          </div>
        }>
          <p>Confirm digital acknowledgement for <strong>{s(acceptTarget.asset_no)}</strong> ({s(acceptTarget.asset_name)}) to <strong>{s(acceptTarget.custodian_name)}</strong>. The acknowledgement is recorded in the custody and audit history.</p>
        </Modal>
      )}
    </div>
  );
}

function AssignModal({ asset, onClose, onDone }: { asset: Rec; onClose: () => void; onDone: () => void }) {
  const [assets, setAssets] = useState<Rec[]>([]);
  const [assetId, setAssetId] = useState(asset && num(asset.id) > 0 ? String(asset.id) : '');
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
    if (!asset || num(asset.id) <= 0) fetchRows('/api/ops/assets?pageSize=200').then(setAssets).catch(() => undefined);
  }, [asset]);

  const submit = async () => {
    setBusy(true); setError('');
    try {
      await api(`/api/ops/assets/${assetId}/assign`, {
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
    <Modal title="Assign asset" onClose={onClose} wide footer={
      <div className="quick-actions">
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={busy || !assetId || (custodianType === 'employee' ? !custodianUserId : !custodianDepartmentId)} onClick={() => void submit()}>{busy ? 'Assigning...' : 'Assign asset'}</button>
      </div>
    }>
      <div className="form-grid">
        {(!asset || num(asset.id) <= 0) && (
          <div className="field" style={{ gridColumn: '1 / -1' }}>
            <label htmlFor="am-asset">Asset</label>
            <select id="am-asset" value={assetId} onChange={(e) => setAssetId(e.target.value)}>
              <option value="">Select asset</option>
              {assets.map((a) => <option key={s(a.id)} value={String(a.id)}>{s(a.asset_no)} - {s(a.name)}</option>)}
            </select>
          </div>
        )}
        {asset && num(asset.id) > 0 && <div className="callout callout-info" style={{ gridColumn: '1 / -1' }}>{s(asset.asset_no)} - {s(asset.asset_name)}</div>}
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
  const [returnToStore, setReturnToStore] = useState(true);
  const [condition, setCondition] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async () => {
    setBusy(true); setError('');
    try {
      await api(`/api/ops/assets/${num(asset.asset_id)}/return`, {
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
      <p className="muted">Releases custody for <strong>{s(asset.asset_name)}</strong> currently held by <strong>{s(asset.custodian_name)}</strong>.</p>
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
export function TransfersFlow() {
  const { user } = useAuth();
  const [rows, setRows] = useState<Rec[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [detailId, setDetailId] = useState<number | null>(null);
  const [detail, setDetail] = useState<Rec | null>(null);
  const [busy, setBusy] = useState(false);
  const [completeOpen, setCompleteOpen] = useState(false);
  const [scanCodes, setScanCodes] = useState('');
  const [verifiedSel, setVerifiedSel] = useState<Set<number>>(new Set());
  const [confirmApprove, setConfirmApprove] = useState(false);
  const pageSize = 20;

  const load = useCallback(() => {
    setLoading(true); setError('');
    api<{ data: { rows: Rec[] } }>('/api/ops/assets/transfers?pageSize=200')
      .then((r) => setRows(r.data.rows ?? []))
      .catch((e) => setError(e instanceof Error ? e.message : 'Transfers failed to load'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!detailId) { setDetail(null); return; }
    setBusy(true);
    api<{ data: Rec }>(`/api/ops/assets/transfers/${detailId}`)
      .then((r) => setDetail(r.data))
      .catch((e) => setError(e instanceof Error ? e.message : 'Transfer detail failed'))
      .finally(() => setBusy(false));
  }, [detailId]);

  const filtered = rows.filter((t) =>
    !search || (s(t.transfer_no ?? t.id) + ' ' + s(t.from_location_name) + ' ' + s(t.to_location_name) + ' ' + s(t.from_user_name) + ' ' + s(t.to_user_name)).toLowerCase().includes(search.toLowerCase())
  );
  const scope = slicePage(filtered, page, pageSize);

  const approve = async () => {
    if (!detailId) return;
    setBusy(true); setError('');
    try {
      await api(`/api/ops/assets/transfers/${detailId}/approve`, { method: 'POST', body: JSON.stringify({}) });
      setConfirmApprove(false);
      setDetailId(null);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Approval failed');
      setBusy(false);
    }
  };

  const openComplete = () => {
    setCompleteOpen(true);
    setScanCodes('');
    setVerifiedSel(new Set());
  };

  const complete = async () => {
    if (!detailId) return;
    setBusy(true); setError('');
    const items = ((detail?.items as Rec[]) ?? []).filter((it) => it.verified_at);
    const codes = scanCodes.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
    const verifiedIds = items.map((it) => num(it.asset_id)).filter((i) => i > 0);
    try {
      await api(`/api/ops/assets/transfers/${detailId}/complete`, {
        method: 'POST',
        body: JSON.stringify({
          verifiedAssetIds: [...new Set([...verifiedIds, ...verifiedSel])],
          scanCodes: codes.length ? codes : undefined,
        }),
      });
      setCompleteOpen(false);
      setDetailId(null);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Completion failed');
      setBusy(false);
    }
  };

  const items = ((detail?.items as Rec[]) ?? []);

  return (
    <div className="page">
      <ModuleHeader
        kicker="Asset management"
        title="Asset transfers"
        sub="Employee, department, branch, warehouse, location and project transfers with approval, handover and scan verification. High-value transfers require dual control."
        actions={can(user, 'assets.transfers.create') ? <button className="btn btn-primary" onClick={() => setCreateOpen(true)}>New transfer</button> : undefined}
      />
      <AssetModuleTabs active="transfers" />
      {error && <ErrorBanner error={error} />}
      <section className="card card-pad">
        <div className="card-head"><h3>Transfer register</h3></div>
        <div className="form-grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))' }}>
          <div className="field">
            <label htmlFor="tr-search">Search</label>
            <input id="tr-search" placeholder="Transfer, location or user" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
        </div>
        {loading ? <Skeleton rows={6} /> : scope.length === 0 ? (
          <EmptyState title="No transfers" body="Transfer requests appear here once created." />
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Transfer</th><th>Type</th><th>Status</th><th>Items</th><th>From</th><th>To</th><th>Value</th><th>Dual control</th><th></th></tr></thead>
              <tbody>
                {scope.map((t) => (
                  <tr key={s(t.id)}>
                    <td className="td-cell-mono">{s(t.transfer_no ?? t.id)}</td>
                    <td>{labelize(t.transfer_type)}</td>
                    <td><Badge value={t.status} /></td>
                    <td>{fmtNum(num(t.item_count))}{num(t.verified_count) > 0 ? ` / ${fmtNum(num(t.verified_count))} verified` : ''}</td>
                    <td>{s(t.from_location_name) || s(t.from_user_name) || '-'}</td>
                    <td>{s(t.to_location_name) || s(t.to_user_name) || '-'}</td>
                    <td>{fmtMoney(t.total_value)}</td>
                    <td>{t.requires_dual_control === true || s(t.requires_dual_control) === 'true' ? 'Yes' : '-'}</td>
                    <td className="td-actions">
                      {can(user, 'assets.transfers.view') && <button className="btn btn-sm" onClick={() => setDetailId(num(t.id))}>Open</button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="pager" style={{ marginTop: 12 }}><Pager page={page} pageSize={pageSize} total={filtered.length} onPage={setPage} /></div>
      </section>
      {createOpen && <CreateTransferModal onClose={() => setCreateOpen(false)} onDone={() => { setCreateOpen(false); load(); }} />}
      {detail && (
        <Drawer title={`Transfer ${s(detail.transfer_no ?? detail.id)}`} onClose={() => setDetailId(null)} footer={
          <div className="quick-actions">
            {['DRAFT', 'SUBMITTED'].includes(s(detail.status)) && can(user, 'assets.transfers.approve') && <button className="btn btn-primary" onClick={() => setConfirmApprove(true)}>Approve</button>}
            {['APPROVED', 'PENDING_HANDOVER'].includes(s(detail.status)) && can(user, 'assets.transfers.complete') && <button className="btn btn-primary" onClick={openComplete}>Complete with scans</button>}
            <button className="btn" onClick={() => setDetailId(null)}>Close</button>
          </div>
        }>
          <div className="stack">
            <div className="callout callout-info">
              <strong>{labelize(detail.transfer_type)}</strong> - {labelize(detail.status)}
              {detail.requires_dual_control === true || s(detail.requires_dual_control) === 'true' ? ' - high value, dual control required' : ''}
            </div>
            <div className="form-grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))' }}>
              <div className="field"><label>From</label><span>{s(detail.from_location_name) || s(detail.from_user_name) || '-'}</span></div>
              <div className="field"><label>To</label><span>{s(detail.to_location_name) || s(detail.to_user_name) || '-'}</span></div>
              <div className="field"><label>Total value</label><strong>{fmtMoney(detail.total_value)}</strong></div>
              <div className="field"><label>Reason</label><span>{s(detail.reason) || '-'}</span></div>
            </div>
            {busy ? <Skeleton rows={4} /> : (
              <div className="table-wrap">
                <table className="data">
                  <thead><tr><th>Asset</th><th>Serial</th><th>QR</th><th>Verified</th><th>By</th></tr></thead>
                  <tbody>
                    {items.map((it) => (
                      <tr key={s(it.asset_id)}>
                        <td><strong>{s(it.asset_no)}</strong><br /><span className="muted">{s(it.asset_name)}</span></td>
                        <td>{s(it.serial_no) || '-'}</td>
                        <td><code className="td-cell-mono">{s(it.qr_code)}</code></td>
                        <td>{it.verified_at ? fmtDate(it.verified_at) : <span className="muted">Pending</span>}</td>
                        <td>{s(it.verified_by) || '-'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {completeOpen && (
              <Modal title="Complete transfer" onClose={() => setCompleteOpen(false)} wide footer={
                <div className="quick-actions">
                  <button className="btn" onClick={() => setCompleteOpen(false)}>Cancel</button>
                  <button className="btn btn-primary" disabled={busy} onClick={() => void complete()}>{busy ? 'Completing...' : 'Complete transfer'}</button>
                </div>
              }>
                <p className="muted">Every item must be verified before the transfer can complete. Tick items received in good order or paste scanned QR payloads, one per line.</p>
                <div className="form-grid">
                  <div className="field" style={{ gridColumn: '1 / -1' }}>
                    <label htmlFor="cm-codes">Scanned QR payloads (one per line)</label>
                    <textarea id="cm-codes" rows={4} value={scanCodes} onChange={(e) => setScanCodes(e.target.value)} placeholder={'HDG-AST-2026-000001\nHDG-AST-2026-000002'} />
                  </div>
                  <div className="table-wrap" style={{ gridColumn: '1 / -1' }}>
                    <table className="data">
                      <thead><tr><th>Verified by scan</th><th>Asset</th><th>Status</th></tr></thead>
                      <tbody>
                        {items.map((it) => {
                          const id = num(it.asset_id);
                          const already = !!it.verified_at;
                          return (
                            <tr key={s(it.asset_id)}>
                              <td>
                                <input type="checkbox" disabled={already} checked={already || verifiedSel.has(id)} onChange={() => {
                                  const next = new Set(verifiedSel);
                                  if (next.has(id)) next.delete(id); else next.add(id);
                                  setVerifiedSel(next);
                                }} />
                              </td>
                              <td><strong>{s(it.asset_no)}</strong><br /><span className="muted">{s(it.asset_name)}</span></td>
                              <td>{already ? <Badge value="VERIFIED" /> : <Badge value="PENDING" />}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              </Modal>
            )}
          </div>
        </Drawer>
      )}
      {confirmApprove && detail && (
        <Modal title="Approve transfer" onClose={() => setConfirmApprove(false)} footer={
          <div className="quick-actions">
            <button className="btn" onClick={() => setConfirmApprove(false)}>Cancel</button>
            <button className="btn btn-primary" onClick={() => void approve()}>Approve</button>
          </div>
        }>
          <p>Approve transfer <strong>{s(detail.transfer_no ?? detail.id)}</strong>? Approval moves it to pending handover and is recorded in the audit trail.</p>
        </Modal>
      )}
    </div>
  );
}

function CreateTransferModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [transferType, setTransferType] = useState('EMPLOYEE');
  const [toLocationId, setToLocationId] = useState('');
  const [toDepartmentId, setToDepartmentId] = useState('');
  const [toBranchId, setToBranchId] = useState('');
  const [toProjectId, setToProjectId] = useState('');
  const [toUserId, setToUserId] = useState('');
  const [reason, setReason] = useState('');
  const [assetSearch, setAssetSearch] = useState('');
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [assets, setAssets] = useState<Rec[]>([]);
  const [locations, setLocations] = useState<Rec[]>([]);
  const [departments, setDepartments] = useState<Rec[]>([]);
  const [employees, setEmployees] = useState<Rec[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    fetchRows('/api/ops/assets?pageSize=200').then(setAssets).catch(() => undefined);
    fetchRows('/api/assets/locations?pageSize=500').then(setLocations).catch(() => undefined);
    fetchRows('/api/ops/hr/departments').then(setDepartments).catch(() => undefined);
    fetchRows('/api/ops/hr/employees?pageSize=100').then(setEmployees).catch(() => undefined);
  }, []);

  const toggle = (id: number) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id); else next.add(id);
    setSelected(next);
  };

  const filteredAssets = assets.filter((a) =>
    !assetSearch || (s(a.asset_no) + ' ' + s(a.name) + ' ' + s(a.category_name)).toLowerCase().includes(assetSearch.toLowerCase())
  );

  const submit = async () => {
    setBusy(true); setError('');
    try {
      await api('/api/ops/assets/transfers', {
        method: 'POST',
        body: JSON.stringify({
          transferType,
          assetIds: [...selected],
          toLocationId: ['WAREHOUSE', 'LOCATION'].includes(transferType) ? toLocationId || undefined : undefined,
          toDepartmentId: transferType === 'DEPARTMENT' ? toDepartmentId || undefined : undefined,
          toBranchId: transferType === 'BRANCH' ? toBranchId || undefined : undefined,
          toProjectId: transferType === 'PROJECT' ? toProjectId || undefined : undefined,
          toUserId: transferType === 'EMPLOYEE' ? toUserId || undefined : undefined,
          reason: reason || undefined,
        }),
      });
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Transfer creation failed');
      setBusy(false);
    }
  };

  return (
    <Modal title="New asset transfer" onClose={onClose} wide footer={
      <div className="quick-actions">
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={busy || !selected.size} onClick={() => void submit()}>{busy ? 'Creating...' : `Create transfer (${selected.size} asset${selected.size === 1 ? '' : 's'})`}</button>
      </div>
    }>
      <div className="form-grid">
        <div className="field">
          <label htmlFor="cm-type">Transfer type</label>
          <select id="cm-type" value={transferType} onChange={(e) => setTransferType(e.target.value)}>
            {TRANSFER_TYPES.map((tt) => <option key={tt} value={tt}>{labelize(tt)}</option>)}
          </select>
        </div>
        {transferType === 'EMPLOYEE' && (
          <div className="field">
            <label htmlFor="cm-user">Receiving employee</label>
            <select id="cm-user" value={toUserId} onChange={(e) => setToUserId(e.target.value)}>
              <option value="">Select employee</option>
              {employees.map((e) => <option key={s(e.id)} value={String(e.id)}>{s(e.first_name)} {s(e.last_name)}{s(e.department_name) ? ` - ${s(e.department_name)}` : ''}</option>)}
            </select>
          </div>
        )}
        {transferType === 'DEPARTMENT' && (
          <div className="field">
            <label htmlFor="cm-dep">Receiving department</label>
            <select id="cm-dep" value={toDepartmentId} onChange={(e) => setToDepartmentId(e.target.value)}>
              <option value="">Select department</option>
              {departments.map((d) => <option key={s(d.id)} value={String(d.id)}>{s(d.name)}</option>)}
            </select>
          </div>
        )}
        {['WAREHOUSE', 'LOCATION'].includes(transferType) && (
          <div className="field">
            <label htmlFor="cm-loc">Destination location</label>
            <select id="cm-loc" value={toLocationId} onChange={(e) => setToLocationId(e.target.value)}>
              <option value="">Select location</option>
              {locations.map((l) => <option key={s(l.id)} value={String(l.id)}>{s(l.name)}</option>)}
            </select>
          </div>
        )}
        {transferType === 'BRANCH' && (
          <div className="field">
            <label htmlFor="cm-branch">Destination branch ID</label>
            <input id="cm-branch" type="number" value={toBranchId} onChange={(e) => setToBranchId(e.target.value)} placeholder="Branch id" />
          </div>
        )}
        {transferType === 'PROJECT' && (
          <div className="field">
            <label htmlFor="cm-proj">Destination project ID</label>
            <input id="cm-proj" type="number" value={toProjectId} onChange={(e) => setToProjectId(e.target.value)} placeholder="Project id" />
          </div>
        )}
        <div className="field">
          <label htmlFor="cm-reason">Reason</label>
          <input id="cm-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Business reason for transfer" />
        </div>
      </div>
      <div className="form-grid" style={{ marginTop: 10 }}>
        <div className="field">
          <label htmlFor="cm-assets">Filter assets</label>
          <input id="cm-assets" value={assetSearch} onChange={(e) => setAssetSearch(e.target.value)} placeholder="Search assets to add" />
        </div>
      </div>
      <div className="table-wrap" style={{ maxHeight: 360, overflowY: 'auto' }}>
        <table className="data">
          <thead><tr><th><input type="checkbox" checked={filteredAssets.length > 0 && filteredAssets.every((a) => selected.has(num(a.id)))} onChange={() => {
            const ids = filteredAssets.map((a) => num(a.id));
            const all = ids.length > 0 && ids.every((i) => selected.has(i));
            const next = new Set(selected);
            if (all) ids.forEach((i) => next.delete(i)); else ids.forEach((i) => next.add(i));
            setSelected(next);
          }} /></th><th>Asset</th><th>Category</th><th>Status</th><th>Location</th></tr></thead>
          <tbody>
            {filteredAssets.map((a) => (
              <tr key={s(a.id)}>
                <td><input type="checkbox" checked={selected.has(num(a.id))} onChange={() => toggle(num(a.id))} /></td>
                <td><strong>{s(a.asset_no)}</strong><br /><span className="muted">{s(a.name)}</span></td>
                <td>{s(a.category_name) || '-'}</td>
                <td><Badge value={a.status} /></td>
                <td>{s(a.location_name) || '-'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {error && <div className="alert alert-error" style={{ marginTop: 10 }}>{error}</div>}
    </Modal>
  );
}
