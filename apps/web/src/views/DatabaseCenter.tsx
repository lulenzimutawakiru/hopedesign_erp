import { useEffect, useState, type ReactNode } from 'react';
import { api, fmtDate, fmtNum } from '../api';
import { useAuth, can } from '../auth';
import { ErrorBanner, Modal } from '../components/ui';
import { ConfirmDialog, EmptyState, Meter, Skeleton } from '../components/os';
import { Rec, s, tileStyle } from './assetsShared';

type Row = Rec;
const DATA = (path: string) => `/api/admin/database${path}`;

function useFetch<T = Row>(path: string) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [n, setN] = useState(0);
  useEffect(() => {
    let on = true;
    setLoading(true);
    api<{ data: T }>(DATA(path))
      .then((r) => { if (on) { setData(r.data); setError(''); } })
      .catch((e) => { if (on) setError(e instanceof Error ? e.message : 'Request failed'); })
      .finally(() => { if (on) setLoading(false); });
    return () => { on = false; };
  }, [path, n]);
  return { data, error, loading, refresh: () => setN((x) => x + 1) };
}

function Card({ title, sub, children, actions }: { title: string; sub?: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="card card-pad">
      <div className="card-head">
        <div>
          <h3>{title}</h3>
          {sub && <p className="muted" style={{ margin: 0 }}>{sub}</p>}
        </div>
        {actions && <div className="head-actions">{actions}</div>}
      </div>
      {children}
    </section>
  );
}

function LoadOr({ loading, error, children }: { loading: boolean; error: string; children: ReactNode }) {
  if (loading) return <div style={{ padding: '18px 4px' }}><Skeleton rows={5} /></div>;
  if (error) return <ErrorBanner error={error} />;
  return <>{children}</>;
}

function DbTable({ cols, rows, rowKey }: { cols: string[]; rows: Row[]; rowKey: (r: Row, i: number) => string }) {
  if (rows.length === 0) return <EmptyState title="No records" body="Nothing to show here yet." />;
  return (
    <div className="table-wrap">
      <table className="data">
        <thead>
          <tr>{cols.map((c) => <th key={c}>{c}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={rowKey(r, i)}>
              {cols.map((c) => (
                <td key={c} className={/^(when|duration|id|code|ip|db|query|pid|size)/i.test(c) ? 'td-cell-mono' : undefined}>
                  {renderCell(r[c])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function renderCell(v: unknown): ReactNode {
  if (v === null || v === undefined || v === '') return <span className="muted">-</span>;
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (typeof v === 'object') return <span className="td-cell-mono">{JSON.stringify(v).slice(0, 60)}</span>;
  return String(v);
}

function StatusPill({ status }: { status: unknown }) {
  const st = String(status ?? '').toUpperCase();
  const tone = st === 'HEALTHY' || st === 'PASS' ? 'badge-green' : st === 'WARNING' ? 'badge-amber' : st === 'CRITICAL' || st === 'FAIL' ? 'badge-red' : 'badge-neutral';
  return <span className={`badge ${tone}`}><span className="badge-icon" aria-hidden>●</span>{String(status ?? '-')}</span>;
}

const TABS: Array<[string, string, string]> = [
  ['overview', 'Overview', '🧭'],
  ['tables', 'Tables', '🗂'],
  ['connections', 'Connections', '🔌'],
  ['queries', 'Queries', '⚡'],
  ['locks', 'Locks', '🔒'],
  ['indexes', 'Indexes', '🧮'],
  ['maintenance', 'Maintenance', '🔧'],
  ['backups', 'Backups', '💾'],
  ['integrity', 'Integrity', '🛡'],
  ['quality', 'Data Quality', '✨'],
  ['retention', 'Retention', '🗄'],
  ['migrations', 'Migrations', '🔄'],
  ['audit', 'Audit Trail', '📜'],
  ['settings', 'Settings', '⚙'],
];

export default function DatabaseCenter() {
  const { user } = useAuth();
  const [tab, setTab] = useState('overview');
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="mod-kicker" data-mod="adm">Administration</p>
          <h1>Database Management Center</h1>
          <p className="muted" style={{ maxWidth: 880 }}>
            Real-time control plane for the Hope Design Group ERP PostgreSQL database. Health, storage, connections,
            queries, indexes, locks, maintenance, backups, restores, integrity, data quality, retention, migrations and audit — protected by RBAC + ABAC.
          </p>
        </div>
      </header>
      <nav className="module-nav tabs">
        {TABS.map(([id, label, icon]) => (
          <button key={id} className={`tab ${tab === id ? 'active' : ''}`} onClick={() => setTab(id)}>
            <span aria-hidden>{icon}</span> {label}
          </button>
        ))}
      </nav>
      <div style={{ marginTop: 16 }}>
        {tab === 'overview' && <OverviewTab canManage={can(user, 'database.backup.create')} />}
        {tab === 'tables' && <TablesTab />}
        {tab === 'connections' && <ConnectionsTab />}
        {tab === 'queries' && <QueriesTab />}
        {tab === 'locks' && <LocksTab />}
        {tab === 'indexes' && <IndexesTab />}
        {tab === 'maintenance' && <MaintenanceTab canRun={can(user, 'database.maintenance.run')} />}
        {tab === 'backups' && <BackupsTab canCreate={can(user, 'database.backup.create')} canRestore={can(user, 'database.restore.request')} canApprove={can(user, 'database.restore.approve')} />}
        {tab === 'integrity' && <IntegrityTab canRun={can(user, 'database.integrity.run')} />}
        {tab === 'quality' && <QualityTab />}
        {tab === 'retention' && <RetentionTab canEdit={can(user, 'database.retention.manage')} />}
        {tab === 'migrations' && <MigrationsTab />}
        {tab === 'audit' && <AuditTab />}
        {tab === 'settings' && <SettingsTab />}
      </div>
    </div>
  );
}

function OverviewTab({ canManage }: { canManage: boolean }) {
  const { data, error, loading, refresh } = useFetch<Row>('/health');
  const db = (data?.database ?? {}) as Row;
  const conn = (data?.connections ?? {}) as Row;
  const perf = (data?.performance ?? {}) as Row;
  const repl = (data?.replication ?? {}) as Row;
  const bks = (data?.backups ?? {}) as Row;
  return (
    <>
      <LoadOr loading={loading} error={error}>
        <div className="kpi-grid--tiles">
          <div className="kpi-tile" style={tileStyle('#16a34a', 'rgba(22,163,74,0.14)')}>
            <span className="kpi-tile-icon" aria-hidden>♥</span>
            <span className="kpi-tile-body">
              <span className="kpi-tile-label">Health</span>
              <span className="kpi-tile-value" style={{ fontSize: 18 }}><StatusPill status={data?.status} /></span>
              <span className="kpi-tile-sub">Checked {data?.checkedAt ? fmtDate(data.checkedAt) : '-'}</span>
            </span>
          </div>
          <div className="kpi-tile" style={tileStyle('#0891b2', 'rgba(8,145,178,0.14)')}>
            <span className="kpi-tile-icon" aria-hidden>◫</span>
            <span className="kpi-tile-body">
              <span className="kpi-tile-label">Storage used</span>
              <span className="kpi-tile-value">{s(db.sizePretty)}</span>
              <span className="kpi-tile-sub">{s(db.storagePct)}% of {s(db.totalPretty)}</span>
            </span>
          </div>
          <div className="kpi-tile" style={tileStyle('#4f46e5', 'rgba(79,70,229,0.14)')}>
            <span className="kpi-tile-icon" aria-hidden>⇅</span>
            <span className="kpi-tile-body">
              <span className="kpi-tile-label">Connections</span>
              <span className="kpi-tile-value">{fmtNum(conn.total)}</span>
              <span className="kpi-tile-sub">{fmtNum(conn.active)} active / {fmtNum(conn.max)} max · {s(conn.utilizationPct)}%</span>
            </span>
          </div>
          <div className="kpi-tile" style={tileStyle('#ca8a04', 'rgba(202,138,4,0.14)')}>
            <span className="kpi-tile-icon" aria-hidden>⏱</span>
            <span className="kpi-tile-body">
              <span className="kpi-tile-label">Query latency</span>
              <span className="kpi-tile-value">{fmtNum(perf.avgQueryDurationMs)} ms</span>
              <span className="kpi-tile-sub">{fmtNum(perf.slowQueries)} slow queries</span>
            </span>
          </div>
          <div className="kpi-tile" style={tileStyle('#7c3aed', 'rgba(124,58,237,0.14)')}>
            <span className="kpi-tile-icon" aria-hidden>⚡</span>
            <span className="kpi-tile-body">
              <span className="kpi-tile-label">Cache hit rate</span>
              <span className="kpi-tile-value">{s(perf.cacheHitPct)}%</span>
              <span className="kpi-tile-sub">{s(perf.tpsEstimate)} TPS estimate</span>
            </span>
          </div>
          <div className="kpi-tile" style={tileStyle('#ea580c', 'rgba(234,88,12,0.14)')}>
            <span className="kpi-tile-icon" aria-hidden>♺</span>
            <span className="kpi-tile-body">
              <span className="kpi-tile-label">Replication</span>
              <span className="kpi-tile-value" style={{ fontSize: 16 }}><StatusPill status={repl.status} /></span>
              <span className="kpi-tile-sub">{fmtNum(repl.replicas)} replica(s)</span>
            </span>
          </div>
          <div className="kpi-tile" style={tileStyle('#0d9488', 'rgba(13,148,136,0.14)')}>
            <span className="kpi-tile-icon" aria-hidden>💾</span>
            <span className="kpi-tile-body">
              <span className="kpi-tile-label">Last backup</span>
              <span className="kpi-tile-value" style={{ fontSize: 16 }}>{bks.lastBackup ? <StatusPill status={bks.backupStatus} /> : 'NONE'}</span>
              <span className="kpi-tile-sub">{bks.lastBackup ? `${s((bks.lastBackup as Row).backupId)} · ${s((bks.lastBackup as Row).backupType)}` : 'No backup records'}</span>
            </span>
          </div>
        </div>
        <div className="grid-2" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(320px,1fr))', gap: 14, marginTop: 16 }}>
          <Card title="Storage capacity">
            <Meter label="Database size" value={Number(db.storagePct ?? 0)} max={100} />
            <p className="muted" style={{ margin: '10px 0 0' }}>{s(db.sizePretty)} of {s(db.totalPretty)} capacity · threshold warning at {s((data?.thresholds as Row)?.storageWarnPct)}%</p>
          </Card>
          <Card title="Connection pool">
            <Meter label="Utilization" value={Number(conn.utilizationPct ?? 0)} max={100} />
            <p className="muted" style={{ margin: '10px 0 0' }}>{fmtNum(conn.idle)} idle · {fmtNum(conn.idleInTx)} idle in transaction · {fmtNum(conn.waiting)} waiting · threshold {s((data?.thresholds as Row)?.connectionWarnPct)}%</p>
          </Card>
        </div>
      </LoadOr>
      <div style={{ marginTop: 14, display: 'flex', gap: 8 }}>
        <button className="btn" onClick={refresh}>↻ Refresh health</button>
        {canManage && <button className="btn btn-primary" onClick={() => { api(DATA('/backups'), { method: 'POST', body: JSON.stringify({ backupType: 'FULL' }) }).then(refresh).catch((e) => alert(e.message)); }}>Create full backup</button>}
      </div>
    </>
  );
}

function TablesTab() {
  const { data, error, loading } = useFetch<Row>('/storage');
  const tables = (Array.isArray(data?.tables) ? data?.tables : []) as Row[];
  const schemas = (Array.isArray(data?.schemas) ? data?.schemas : []) as Row[];
  return (
    <>
      <LoadOr loading={loading} error={error}>
        <div className="kpi-grid--tiles">
          <div className="kpi-tile" style={tileStyle('#334155', 'rgba(51,65,85,0.14)')}>
            <span className="kpi-tile-icon" aria-hidden>Σ</span>
            <span className="kpi-tile-body"><span className="kpi-tile-label">Total size</span><span className="kpi-tile-value">{s(data?.totalSizePretty)}</span><span className="kpi-tile-sub">across the public schema</span></span>
          </div>
          <div className="kpi-tile" style={tileStyle('#0891b2', 'rgba(8,145,178,0.14)')}>
            <span className="kpi-tile-icon" aria-hidden>▤</span>
            <span className="kpi-tile-body"><span className="kpi-tile-label">Tables</span><span className="kpi-tile-value">{fmtNum(data?.tableCount)}</span><span className="kpi-tile-sub">tables + views in scope</span></span>
          </div>
          <div className="kpi-tile" style={tileStyle('#7c3aed', 'rgba(124,58,237,0.14)')}>
            <span className="kpi-tile-icon" aria-hidden>⌗</span>
            <span className="kpi-tile-body"><span className="kpi-tile-label">Schemas</span><span className="kpi-tile-value">{schemas.length}</span><span className="kpi-tile-sub">non-system schemas</span></span>
          </div>
        </div>
        <Card title="Schema storage" sub="Logical schemas across the ERP">
          <DbTable cols={['schema', 'objects', 'size']} rows={schemas} rowKey={(r) => s(r.schema)} />
        </Card>
        <div style={{ marginTop: 14 }}>
          <Card title="Tables & views" sub="public schema · row estimates · classification">
            <DbTable
              cols={['table', 'kind', 'rows', 'size', 'indexes', 'owner', 'rls', 'classification']}
              rows={tables}
              rowKey={(r) => `${s(r.schema)}.${s(r.tableName)}`}
            />
          </Card>
        </div>
      </LoadOr>
    </>
  );
}

function ConnectionsTab() {
  const { data, error, loading } = useFetch<Row>('/connections');
  const summary = (Array.isArray(data?.summary) ? data?.summary : []) as Row[];
  const conns = (Array.isArray(data?.connections) ? data?.connections : []) as Row[];
  const blocked = (Array.isArray(data?.blocked) ? data?.blocked : []) as Row[];
  return (
    <LoadOr loading={loading} error={error}>
      <div className="kpi-grid--tiles">
        <div className="kpi-tile" style={tileStyle('#4f46e5', 'rgba(79,70,229,0.14)')}>
          <span className="kpi-tile-icon" aria-hidden>⇅</span>
          <span className="kpi-tile-body"><span className="kpi-tile-label">Active connections</span><span className="kpi-tile-value">{fmtNum(data?.total)}</span><span className="kpi-tile-sub">non-self sessions</span></span>
        </div>
        <div className="kpi-tile" style={tileStyle('#dc2626', 'rgba(220,38,38,0.14)')}>
          <span className="kpi-tile-icon" aria-hidden>⛔</span>
          <span className="kpi-tile-body"><span className="kpi-tile-label">Blocked sessions</span><span className="kpi-tile-value">{fmtNum(blocked.length)}</span><span className="kpi-tile-sub">waiting on locks</span></span>
        </div>
      </div>
      <Card title="Summary by state">
        <DbTable cols={['state', 'connections']} rows={summary} rowKey={(r) => s(r.state)} />
      </Card>
      <div style={{ marginTop: 14 }}>
        <Card title="Live connections" sub="pg_stat_activity">
          <DbTable
            cols={['pid', 'user', 'app', 'client', 'state', 'wait', 'duration(s)', 'query']}
            rows={conns}
            rowKey={(r) => `c-${s(r.pid)}`}
          />
        </Card>
      </div>
      {blocked.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <Card title="Lock chains" sub="Blocked → blocking sessions">
            <DbTable
              cols={['blocked_pid', 'blocked_state', 'blocked_s', 'blocked_query', 'blocking_pid', 'blocking_query']}
              rows={blocked}
              rowKey={(r) => `b-${s(r.blockedPid)}`}
            />
          </Card>
        </div>
      )}
    </LoadOr>
  );
}

function QueriesTab() {
  const { data, error, loading, refresh } = useFetch<Row>('/queries');
  const active = (Array.isArray(data?.active) ? data?.active : []) as Row[];
  const top = (Array.isArray(data?.topStatements) ? data?.topStatements : []) as Row[];
  return (
    <LoadOr loading={loading} error={error}>
      <div className="kpi-grid--tiles">
        <div className="kpi-tile" style={tileStyle('#16a34a', 'rgba(22,163,74,0.14)')}>
          <span className="kpi-tile-icon" aria-hidden>⚡</span>
          <span className="kpi-tile-body"><span className="kpi-tile-label">Active queries</span><span className="kpi-tile-value">{fmtNum(active.length)}</span><span className="kpi-tile-sub">running now</span></span>
        </div>
        <div className="kpi-tile" style={tileStyle('#ea580c', 'rgba(234,88,12,0.14)')}>
          <span className="kpi-tile-icon" aria-hidden>⚠</span>
          <span className="kpi-tile-body"><span className="kpi-tile-label">Slow queries</span><span className="kpi-tile-value">{fmtNum(data?.slowCount)}</span><span className="kpi-tile-sub">above {s(data?.slowQueryMs)} ms</span></span>
        </div>
      </div>
      <Card title="Active queries" sub="pg_stat_activity · non-idle sessions" actions={<button className="btn btn-sm" onClick={refresh}>↻</button>}>
        <DbTable
          cols={['pid', 'user', 'app', 'state', 'duration(s)', 'query']}
          rows={active}
          rowKey={(r) => `q-${s(r.pid)}`}
        />
      </Card>
      <div style={{ marginTop: 14 }}>
        <Card title="Top statements by mean duration" sub="pg_stat_statements">
          <DbTable
            cols={['query', 'calls', 'mean_exec_time', 'total_exec_time', 'rows']}
            rows={top}
            rowKey={(_r, i) => `s-${i}`}
          />
        </Card>
      </div>
    </LoadOr>
  );
}

function IndexesTab() {
  const { data, error, loading } = useFetch<Row>('/indexes');
  const indexes = (Array.isArray(data?.indexes) ? data?.indexes : []) as Row[];
  const recommendations = (Array.isArray(data?.recommendations) ? data?.recommendations : []) as string[];
  return (
    <LoadOr loading={loading} error={error}>
      <div className="kpi-grid--tiles">
        <div className="kpi-tile" style={tileStyle('#4f46e5', 'rgba(79,70,229,0.14)')}>
          <span className="kpi-tile-icon" aria-hidden>⌗</span>
          <span className="kpi-tile-body"><span className="kpi-tile-label">Indexes</span><span className="kpi-tile-value">{fmtNum(data?.total)}</span><span className="kpi-tile-sub">in public schema</span></span>
        </div>
        <div className="kpi-tile" style={tileStyle('#ca8a04', 'rgba(202,138,4,0.14)')}>
          <span className="kpi-tile-icon" aria-hidden>◌</span>
          <span className="kpi-tile-body"><span className="kpi-tile-label">Unused</span><span className="kpi-tile-value">{fmtNum((Array.isArray(data?.unused) ? data?.unused : []).length)}</span><span className="kpi-tile-sub">non-constraint, zero scans</span></span>
        </div>
        <div className="kpi-tile" style={tileStyle('#dc2626', 'rgba(220,38,38,0.14)')}>
          <span className="kpi-tile-icon" aria-hidden>◧</span>
          <span className="kpi-tile-body"><span className="kpi-tile-label">Large indexes</span><span className="kpi-tile-value">{fmtNum((Array.isArray(data?.large) ? data?.large : []).length)}</span><span className="kpi-tile-sub">exceed 100 MB</span></span>
        </div>
      </div>
      {recommendations.length > 0 && (
        <Card title="Recommendations" sub="Review before any drop or change — production index changes require approval">
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {recommendations.map((r) => <li key={r} style={{ margin: '6px 0' }}>{r}</li>)}
          </ul>
        </Card>
      )}
      <div style={{ marginTop: 14 }}>
        <Card title="Index registry" sub="Largest indexes first">
          <DbTable
            cols={['index', 'table', 'size', 'scans', 'tuples_read', 'unique', 'primary']}
            rows={indexes}
            rowKey={(r) => `${s(r.schema)}.${s(r.indexName)}`}
          />
        </Card>
      </div>
    </LoadOr>
  );
}

function BackupsTab({ canCreate, canRestore, canApprove }: { canCreate: boolean; canRestore: boolean; canApprove: boolean }) {
  const { data, error, loading, refresh } = useFetch<Row>('/backups');
  const backups = (Array.isArray(data?.backups) ? data?.backups : []) as Row[];
  const restores = (Array.isArray(data?.restores) ? data?.restores : []) as Row[];
  const [confirmBk, setConfirmBk] = useState<Row | null>(null);
  const [restoreReason, setRestoreReason] = useState('');
  const [restoring, setRestoring] = useState<Row | null>(null);
  const [busy, setBusy] = useState(false);
  const act = async (path: string, body: unknown) => {
    setBusy(true);
    try {
      await api(DATA(path), { method: 'POST', body: JSON.stringify(body) });
      refresh();
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Action failed');
    } finally {
      setBusy(false);
    }
  };
  return (
    <LoadOr loading={loading} error={error}>
      <div className="head-actions" style={{ justifyContent: 'flex-start', marginBottom: 12 }}>
        {canCreate && <button className="btn btn-primary" disabled={busy} onClick={() => setConfirmBk({})}>＋ Create backup</button>}
        {canRestore && <span className="muted" style={{ alignSelf: 'center' }}>Restores require a reason and risk confirmation; production restore needs approval.</span>}
      </div>
      <Card title="Backup records" sub="FULL / INCREMENTAL / DIFFERENTIAL · local + offsite + immutable strategy">
        <DbTable
          cols={['backup_id', 'type', 'scope', 'status', 'started', 'completed', 'size', 'retention(d)', 'encrypted']}
          rows={backups}
          rowKey={(r) => s(r.backupId)}
        />
      </Card>
      <div style={{ marginTop: 14 }}>
        <Card title="Restore requests" sub="Approved by a database.restore.approve holder only">
          <DbTable
            cols={['id', 'backup_id', 'status', 'reason', 'requested_by', 'approved_by', 'recovery_point', 'created']}
            rows={restores}
            rowKey={(r) => `r-${s(r.id)}`}
          />
        </Card>
      </div>
      {canRestore && (
        <div style={{ marginTop: 14 }}>
          <Card title="Request a restore" sub="Select a backup, state the reason — the request enters the approval workflow">
            <div className="form-row" style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
              <select
                className="input"
                style={{ maxWidth: 260 }}
                value={restoring?.id ? String(restoring.id) : ''}
                onChange={(e) => setRestoring(backups.find((b) => String(b.id) === e.target.value) ?? null)}
              >
                <option value="">Select backup…</option>
                {backups.map((b) => (
                  <option key={s(b.id)} value={s(b.id)}>{s(b.backupId)} · {s(b.backupType)} · {s(b.status)}</option>
                ))}
              </select>
              <input
                className="input"
                style={{ flex: 1, minWidth: 220 }}
                placeholder="Reason (required, e.g. test recovery in isolated environment)"
                value={restoreReason}
                onChange={(e) => setRestoreReason(e.target.value)}
              />
              <button
                className="btn"
                disabled={busy || !restoring || !restoreReason.trim()}
                onClick={() => act(`/backups/${s(restoring?.id)}/restore`, { reason: restoreReason.trim() }).then(() => setRestoreReason(''))}
              >
                Request restore
              </button>
            </div>
          </Card>
        </div>
      )}
      {canApprove && (
        <div style={{ marginTop: 14 }}>
          <Card title="Pending approvals" sub="Decide restore requests (database.restore.approve)">
            <DbTable
              cols={['id', 'backup_id', 'reason', 'requested_by', 'actions']}
              rows={restores.filter((r) => ['REQUESTED', 'RISK_CONFIRMED', 'MFA_VERIFIED'].includes(String(r.status)))}
              rowKey={(r) => `a-${s(r.id)}`}
            />
          </Card>
        </div>
      )}
      {confirmBk && (
        <ConfirmDialog
          title="Create database backup"
          body="This registers a FULL database backup record. The backup service executes it; records are encrypted by default and retained per policy."
          confirmLabel="Create backup"
          onCancel={() => setConfirmBk(null)}
          onConfirm={() => { act('/backups', { backupType: 'FULL' }); setConfirmBk(null); }}
        />
      )}
    </LoadOr>
  );
}

function IntegrityTab({ canRun }: { canRun: boolean }) {
  const { data, error, loading, refresh } = useFetch<Row>('/integrity');
  const [summary, setSummary] = useState<Row | null>(null);
  const [busy, setBusy] = useState(false);
  const runNow = async () => {
    setBusy(true);
    try {
      const r = await api<{ data: Row }>(DATA('/integrity/run'), { method: 'POST' });
      setSummary(r.data);
      refresh();
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Integrity run failed');
    } finally {
      setBusy(false);
    }
  };
  const runs = (Array.isArray(data) ? data : []) as Row[];
  return (
    <>
      {summary && (
        <Card title="Latest integrity run" sub="Data integrity engine">
          <div className="kpi-grid--tiles" style={{ marginTop: 4 }}>
            <div className="kpi-tile" style={tileStyle('#16a34a', 'rgba(22,163,74,0.14)')}>
              <span className="kpi-tile-icon" aria-hidden>✓</span>
              <span className="kpi-tile-body"><span className="kpi-tile-label">Overall</span><span className="kpi-tile-value"><StatusPill status={summary.overall} /></span><span className="kpi-tile-sub">{fmtNum(summary.passed)} passed · {fmtNum(summary.warnings)} warnings · {fmtNum(summary.failed)} failed</span></span>
            </div>
          </div>
        </Card>
      )}
      <div style={{ marginTop: 14 }}>
        <LoadOr loading={loading} error={error}>
          <div className="head-actions" style={{ justifyContent: 'flex-start', marginBottom: 12 }}>
            {canRun && <button className="btn btn-primary" disabled={busy} onClick={runNow}>{busy ? 'Running checks…' : '▶ Run integrity checks'}</button>}
          </div>
          <Card title="Integrity run history" sub="Double-entry balance, QR uniqueness, duplicates, orphans, negative amounts, required fields">
            <DbTable
              cols={['check_name', 'status', 'passed', 'failed', 'warnings', 'started', 'run_by']}
              rows={runs}
              rowKey={(r) => `${s(r.id)}-${s(r.checkName)}`}
            />
          </Card>
        </LoadOr>
      </div>
    </>
  );
}

function QualityTab() {
  const { data, error, loading } = useFetch<Row>('/data-quality');
  const issues = (Array.isArray(data?.issues) ? data?.issues : []) as Row[];
  return (
    <LoadOr loading={loading} error={error}>
      <div className="kpi-grid--tiles">
        <div className="kpi-tile" style={tileStyle('#16a34a', 'rgba(22,163,74,0.14)')}>
          <span className="kpi-tile-icon" aria-hidden>★</span>
          <span className="kpi-tile-body"><span className="kpi-tile-label">Data quality score</span><span className="kpi-tile-value">{fmtNum(data?.score)}%</span><span className="kpi-tile-sub">checked {data?.checkedAt ? fmtDate(data.checkedAt) : '-'}</span></span>
        </div>
        <div className="kpi-tile" style={tileStyle('#dc2626', 'rgba(220,38,38,0.14)')}>
          <span className="kpi-tile-icon" aria-hidden>✕</span>
          <span className="kpi-tile-body"><span className="kpi-tile-label">Critical issues</span><span className="kpi-tile-value">{fmtNum(data?.critical)}</span><span className="kpi-tile-sub">QR duplication, integrity failures</span></span>
        </div>
        <div className="kpi-tile" style={tileStyle('#ca8a04', 'rgba(202,138,4,0.14)')}>
          <span className="kpi-tile-icon" aria-hidden>⚠</span>
          <span className="kpi-tile-body"><span className="kpi-tile-label">Warnings</span><span className="kpi-tile-value">{fmtNum(data?.warnings)}</span><span className="kpi-tile-sub">duplicates, invalid contacts, missing fields</span></span>
        </div>
      </div>
      <div style={{ marginTop: 14 }}>
        <Card title="Detected issues" sub="Data quality center">
          <DbTable cols={['severity', 'category', 'detail', 'count']} rows={issues} rowKey={(_r, i) => `q-${i}`} />
        </Card>
      </div>
    </LoadOr>
  );
}

function RetentionTab({ canEdit }: { canEdit: boolean }) {
  const { data, error, loading, refresh } = useFetch<Row[]>('/retention');
  const policies = (Array.isArray(data) ? data : []) as Row[];
  const [edit, setEdit] = useState<Row | null>(null);
  const [days, setDays] = useState('');
  const [hold, setHold] = useState(false);
  const save = async () => {
    if (!edit) return;
    try {
      await api(DATA(`/retention/${s(edit.id)}`), {
        method: 'PUT',
        body: JSON.stringify({ retentionDays: Number(days), legalHold: hold }),
      });
      setEdit(null);
      refresh();
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Update failed');
    }
  };
  return (
    <LoadOr loading={loading} error={error}>
      <Card title="Retention policies" sub="Records are never purged while on legal hold, under audit, or required for traceability">
        <DbTable
          cols={['category', 'retention_days', 'legal_hold', 'applies_to', 'notes', 'updated', 'actions']}
          rows={policies}
          rowKey={(r) => s(r.id)}
        />
      </Card>
      {edit && (
        <Modal
          title={`Retention policy — ${s(edit.category)}`}
          onClose={() => setEdit(null)}
          footer={
            <>
              <button className="btn" onClick={() => setEdit(null)}>Cancel</button>
              <button className="btn btn-primary" onClick={save}>Save policy</button>
            </>
          }
        >
          <div className="form-stack" style={{ display: 'grid', gap: 12 }}>
            <label className="field">
              <span>Retention days</span>
              <input className="input" type="number" min={1} value={days} onChange={(e) => setDays(e.target.value)} />
            </label>
            <label className="field check">
              <input type="checkbox" checked={hold} onChange={(e) => setHold(e.target.checked)} />
              <span>Legal hold — never purge</span>
            </label>
          </div>
        </Modal>
      )}
      {canEdit && (
        <div style={{ marginTop: 14 }}>
          <Card title="Edit a policy" sub="Select a category to update retention days / legal hold">
            <div className="form-row" style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
              <select
                className="input"
                style={{ maxWidth: 280 }}
                value={edit?.id ? String(edit.id) : ''}
                onChange={(e) => {
                  const p = policies.find((x) => String(x.id) === e.target.value);
                  if (p) { setEdit(p); setDays(String(p.retentionDays ?? '')); setHold(Boolean(p.legalHold)); }
                }}
              >
                <option value="">Select policy…</option>
                {policies.map((p) => <option key={s(p.id)} value={s(p.id)}>{s(p.category)}</option>)}
              </select>
              <input className="input" style={{ maxWidth: 140 }} type="number" min={1} placeholder="Days" value={days} onChange={(e) => setDays(e.target.value)} />
              <label className="check" style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                <input type="checkbox" checked={hold} onChange={(e) => setHold(e.target.checked)} /> Legal hold
              </label>
              <button className="btn btn-primary" disabled={!edit || !days} onClick={save}>Save</button>
            </div>
          </Card>
        </div>
      )}
    </LoadOr>
  );
}

function MigrationsTab() {
  const { data, error, loading } = useFetch<Row>('/migrations');
  const audit = (Array.isArray(data?.audit) ? data?.audit : []) as Row[];
  const applied = (Array.isArray(data?.applied) ? data?.applied : []) as Row[];
  return (
    <LoadOr loading={loading} error={error}>
      <Card title="Applied migrations" sub="schema_migrations · version-controlled, checksum-verified">
        <DbTable cols={['name', 'applied_at']} rows={applied} rowKey={(_r, i) => `m-${i}`} />
      </Card>
      <div style={{ marginTop: 14 }}>
        <Card title="Migration audit events" sub="db_migration_audit · who ran what, when">
          <DbTable
            cols={['migration_name', 'action', 'status', 'duration_ms', 'executed_at', 'executed_by', 'notes']}
            rows={audit}
            rowKey={(r) => `ma-${s(r.id)}`}
          />
        </Card>
      </div>
    </LoadOr>
  );
}

function AuditTab() {
  const { data, error, loading } = useFetch<Row[]>('/audit');
  const events = (Array.isArray(data) ? data : []) as Row[];
  return (
    <LoadOr loading={loading} error={error}>
      <Card title="Database audit trail" sub="Append-only events scoped to database administration actions">
        <DbTable
          cols={['created_at', 'actor', 'action', 'resource', 'record', 'metadata']}
          rows={events}
          rowKey={(r) => `aud-${s(r.id)}`}
        />
      </Card>
    </LoadOr>
  );
}

function SettingsTab() {
  const { data, error, loading, refresh } = useFetch<Row[]>('/settings');
  const settings = (Array.isArray(data) ? data : []) as Row[];
  const [edit, setEdit] = useState<Row | null>(null);
  const [val, setVal] = useState('');
  const save = async () => {
    if (!edit) return;
    try {
      await api(DATA('/settings'), {
        method: 'PUT',
        body: JSON.stringify({ key: edit.key, value: val }),
      });
      setEdit(null);
      refresh();
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Update failed');
    }
  };
  return (
    <LoadOr loading={loading} error={error}>
      <Card title="Database settings" sub="Thresholds and behavior used by the management center — values are stored per tenant">
        <DbTable
          cols={['key', 'value', 'updated_at', 'updated_by']}
          rows={settings}
          rowKey={(r) => s(r.id)}
        />
      </Card>
      {edit && (
        <Modal
          title={`Setting — ${s(edit.key)}`}
          onClose={() => setEdit(null)}
          footer={
            <>
              <button className="btn" onClick={() => setEdit(null)}>Cancel</button>
              <button className="btn btn-primary" onClick={save}>Save setting</button>
            </>
          }
        >
          <div className="form-stack" style={{ display: 'grid', gap: 12 }}>
            <label className="field">
              <span>Value (JSON or plain value)</span>
              <input className="input" value={val} onChange={(e) => setVal(e.target.value)} />
            </label>
          </div>
        </Modal>
      )}
      <div style={{ marginTop: 14 }}>
        <Card title="Edit a setting" sub="e.g. storage_warning_pct, connection_warning_pct, slow_query_ms, statement_timeout_ms">
          <div className="form-row" style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
            <select
              className="input"
              style={{ maxWidth: 280 }}
              value={edit?.key ? String(edit.key) : ''}
              onChange={(e) => {
                const p = settings.find((x) => String(x.key) === e.target.value);
                if (p) { setEdit(p); setVal(typeof p.raw === 'object' && p.raw ? String((p.raw as Row).value ?? '') : String(p.value ?? '')); }
              }}
            >
              <option value="">Select setting…</option>
              {settings.map((x) => <option key={s(x.key)} value={s(x.key)}>{s(x.key)}</option>)}
            </select>
            <input className="input" style={{ flex: 1, minWidth: 200 }} placeholder="New value" value={val} onChange={(e) => setVal(e.target.value)} />
            <button className="btn btn-primary" disabled={!edit} onClick={save}>Save</button>
          </div>
        </Card>
      </div>
    </LoadOr>
  );
}

function LocksTab() {
  const { data, error, loading, refresh } = useFetch<Row>('/locks');
  const summary = (Array.isArray(data?.summary) ? data?.summary : []) as Row[];
  const blocked = (Array.isArray(data?.blocked) ? data?.blocked : []) as Row[];
  const longTx = (Array.isArray(data?.longTransactions) ? data?.longTransactions : []) as Row[];
  const waiting = summary.reduce((acc, r) => acc + (Number(r.waiting) || 0), 0);
  return (
    <LoadOr loading={loading} error={error}>
      <div className="kpi-grid--tiles">
        <div className="kpi-tile" style={tileStyle('#dc2626', 'rgba(220,38,38,0.14)')}>
          <span className="kpi-tile-icon" aria-hidden>🔒</span>
          <span className="kpi-tile-body"><span className="kpi-tile-label">Blocked sessions</span><span className="kpi-tile-value">{fmtNum(waiting)}</span><span className="kpi-tile-sub">waiting on lock grants</span></span>
        </div>
        <div className="kpi-tile" style={tileStyle('#ea580c', 'rgba(234,88,12,0.14)')}>
          <span className="kpi-tile-icon" aria-hidden>⏳</span>
          <span className="kpi-tile-body"><span className="kpi-tile-label">Long transactions</span><span className="kpi-tile-value">{fmtNum(longTx.length)}</span><span className="kpi-tile-sub">open &gt; 30 seconds</span></span>
        </div>
        <div className="kpi-tile" style={tileStyle('#7c3aed', 'rgba(124,58,237,0.14)')}>
          <span className="kpi-tile-icon" aria-hidden>💥</span>
          <span className="kpi-tile-body"><span className="kpi-tile-label">Deadlocks</span><span className="kpi-tile-value">{fmtNum(data?.deadlocks)}</span><span className="kpi-tile-sub">since last stats reset</span></span>
        </div>
      </div>
      <Card title="Lock summary" sub="pg_locks grouped by lock mode and target" actions={<button className="btn btn-sm" onClick={refresh}>↻</button>}>
        <DbTable cols={['mode', 'target', 'granted', 'waiting', 'total']} rows={summary} rowKey={(r) => `l-${s(r.mode)}-${s(r.target)}`} />
      </Card>
      {blocked.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <Card title="Blocked / blocking chains" sub="pg_blocking_pids · who is waiting on whom">
            <DbTable
              cols={['waiting_pid', 'state', 'wait(s)', 'waiting_query', 'blocking_pid', 'blocking_app', 'blocking_query']}
              rows={blocked}
              rowKey={(r) => `blk-${s(r.waitingPid)}-${s(r.blockingPid)}`}
            />
          </Card>
        </div>
      )}
      <div style={{ marginTop: 14 }}>
        <Card title="Long transactions" sub="open transactions older than 30 seconds · review before any termination">
          <DbTable
            cols={['pid', 'user', 'app', 'state', 'xact(s)', 'query(s)', 'query']}
            rows={longTx}
            rowKey={(r) => `lx-${s(r.pid)}`}
          />
        </Card>
      </div>
    </LoadOr>
  );
}

function MaintenanceTab({ canRun }: { canRun: boolean }) {
  const [table, setTable] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Row | null>(null);
  const [confirmReindex, setConfirmReindex] = useState(false);
  const run = async (action: string) => {
    if (!table.trim()) {
      alert('Enter a table first, e.g. finance.journal_entries or products');
      return;
    }
    if (action === 'REINDEX' && !confirmReindex) {
      setConfirmReindex(true);
      return;
    }
    setBusy(true);
    try {
      const r = await api<{ data: Row }>(DATA('/maintenance'), {
        method: 'POST',
        body: JSON.stringify({ action, table: table.trim(), confirmDangerous: action === 'REINDEX' }),
      });
      setResult(r.data);
      setConfirmReindex(false);
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Maintenance failed');
    } finally {
      setBusy(false);
    }
  };
  const actions: Array<{ action: string; label: string; danger?: boolean }> = [
    { action: 'ANALYZE', label: '▶ ANALYZE' },
    { action: 'VACUUM', label: '▶ VACUUM' },
    { action: 'VACUUM_ANALYZE', label: '▶ VACUUM ANALYZE' },
    { action: 'REINDEX', label: '⚠ REINDEX', danger: true },
  ];
  return (
    <>
      {!canRun && (
        <Card title="Restricted" sub="Requires database.maintenance.run">
          <EmptyState title="No access" body="Maintenance commands are restricted to privileged database administrators under RBAC + ABAC." />
        </Card>
      )}
      {canRun && (
        <Card title="Maintenance runner" sub="Run ANALYZE / VACUUM / VACUUM ANALYZE / REINDEX on one table · audited, duration-tracked, ABAC-gated">
          <div className="form-row" style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
            <input
              className="input"
              style={{ flex: 1, minWidth: 220 }}
              placeholder="Table, e.g. finance.journal_entries or products"
              value={table}
              onChange={(e) => setTable(e.target.value)}
              disabled={busy}
            />
            {actions.map((a) => (
              <button key={a.action} className={`btn ${a.danger ? 'btn-danger' : 'btn-primary'}`} disabled={busy} onClick={() => run(a.action)}>
                {busy ? 'Running…' : a.label}
              </button>
            ))}
          </div>
          <p className="muted" style={{ margin: '10px 0 0' }}>
            VACUUM cannot run inside a transaction and is executed on a dedicated connection. REINDEX TABLE takes an ACCESS EXCLUSIVE lock and requires explicit confirmation.
          </p>
        </Card>
      )}
      {result && (
        <div style={{ marginTop: 14 }}>
          <Card title="Last maintenance result" sub="Audit event written to the database audit trail">
            <div className="kpi-grid--tiles">
              <div className="kpi-tile" style={tileStyle('#16a34a', 'rgba(22,163,74,0.14)')}>
                <span className="kpi-tile-icon" aria-hidden>✓</span>
                <span className="kpi-tile-body"><span className="kpi-tile-label">Status</span><span className="kpi-tile-value"><StatusPill status={result.status} /></span><span className="kpi-tile-sub">{s(result.action)} {s(result.schema)}.{s(result.table)}</span></span>
              </div>
              <div className="kpi-tile" style={tileStyle('#0891b2', 'rgba(8,145,178,0.14)')}>
                <span className="kpi-tile-icon" aria-hidden>⏱</span>
                <span className="kpi-tile-body"><span className="kpi-tile-label">Duration</span><span className="kpi-tile-value">{fmtNum(result.durationMs)} ms</span><span className="kpi-tile-sub">{s(result.sql)}</span></span>
              </div>
            </div>
          </Card>
        </div>
      )}
      {confirmReindex && (
        <ConfirmDialog
          title="Confirm REINDEX TABLE"
          body="REINDEX TABLE takes an ACCESS EXCLUSIVE lock, blocking reads and writes on the table while it runs. This is a HIGH-risk action and will be recorded in the audit trail. Proceed?"
          confirmLabel="Confirm REINDEX"
          onCancel={() => setConfirmReindex(false)}
          onConfirm={() => run('REINDEX')}
        />
      )}
    </>
  );
}

