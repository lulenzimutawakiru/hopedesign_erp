import { useEffect, useState } from 'react';
import { api, fmtDate, fmtMoney } from '../api';
import { can, useAuth } from '../auth';
import { navigate } from '../router';

interface ScoreFactor {
  key: string;
  label: string;
  points: number;
  max: number;
  detail?: string;
}

interface Prospect {
  id: number;
  code: string;
  name: string;
  legalName?: string | null;
  industry?: string | null;
  country?: string | null;
  region?: string | null;
  city?: string | null;
  website?: string | null;
  email?: string | null;
  phone?: string | null;
  employeesMin?: number | null;
  employeesMax?: number | null;
  revenueMin?: number | null;
  revenueMax?: number | null;
  sourceProvider?: string | null;
  sourceQuery?: string | null;
  sourceRank?: number | null;
  status: string;
  score?: number | null;
  scoreVersion?: number | null;
  scoreFactors?: ScoreFactor[];
  duplicateOf?: number | null;
  duplicateScore?: number | null;
  extracted?: Record<string, unknown>;
  ai?: Record<string, unknown>;
  raw?: Record<string, unknown>;
  convertedCustomerId?: number | null;
  convertedLeadId?: number | null;
  convertedAt?: string | null;
  reviewedBy?: number | null;
  reviewedAt?: string | null;
  reviewNotes?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  [k: string]: unknown;
}

interface Campaign {
  id: number;
  code: string;
  name: string;
  description?: string | null;
  status: string;
  criteria?: Record<string, unknown>;
  schedule?: { enabled?: boolean; everyMs?: number };
  ownerUserId?: number | null;
  maxResults?: number | null;
  lastRunAt?: string | null;
  nextRunAt?: string | null;
  runCount?: number | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  [k: string]: unknown;
}

interface DashboardData {
  totals: { total: number; newCount: number; reviewed: number; approved: number; converted: number; rejected: number; duplicates: number; avgScore: number };
  bands: { hot: number; warm: number; cool: number; cold: number };
  industries: { industry: string; count: number }[];
  sources: { provider: string; count: number }[];
  campaigns: { total: number; active: number };
  recent: Prospect[];
  aiProvider: string;
  searchProvider: string;
}

const s = (v: unknown): string => (v === null || v === undefined ? '' : String(v));
const label = (v: unknown, fallback = '—') => (v === null || v === undefined || s(v).length === 0 ? fallback : s(v));

const PROSPECT_TONE: Record<string, { color: string; bg: string }> = {
  NEW: { color: '#1d4ed8', bg: '#dbeafe' },
  REVIEWED: { color: '#0369a1', bg: '#e0f2fe' },
  APPROVED: { color: '#15803d', bg: '#dcfce7' },
  REJECTED: { color: '#b91c1c', bg: '#fee2e2' },
  CONVERTED: { color: '#6d28d9', bg: '#ede9fe' },
  DISCARDED: { color: '#475569', bg: '#f1f5f9' },
};

const CAMPAIGN_TONE: Record<string, { color: string; bg: string }> = {
  DRAFT: { color: '#475569', bg: '#e2e8f0' },
  ACTIVE: { color: '#15803d', bg: '#dcfce7' },
  PAUSED: { color: '#b45309', bg: '#fef3c7' },
  COMPLETED: { color: '#0369a1', bg: '#e0f2fe' },
  ARCHIVED: { color: '#475569', bg: '#f1f5f9' },
};

function Pill({ value, tone }: { value?: string | null; tone: Record<string, { color: string; bg: string }> }) {
  const t = tone[s(value).toUpperCase()] ?? CAMPAIGN_TONE.DRAFT;
  return (
    <span className="badge" style={{ color: t.color, background: t.bg, border: '1px solid ' + t.color + '33' }}>
      {s(value)}
    </span>
  );
}

function scoreColor(score: number | null | undefined): string {
  if (score == null) return '#94a3b8';
  if (score >= 80) return '#15803d';
  if (score >= 60) return '#b45309';
  if (score >= 40) return '#0369a1';
  return '#b91c1c';
}

function ScoreBadge({ score }: { score?: number | null }) {
  return (
    <span className="badge" style={{ color: scoreColor(score), background: scoreColor(score) + '1a', border: '1px solid ' + scoreColor(score) + '44', fontWeight: 600 }}>
      {score == null ? '—' : score}
    </span>
  );
}

const csvSplit = (v: string): string[] => v.split(',').map((x) => x.trim()).filter(Boolean);

function PageHead({ title, subtitle, children }: { title: string; subtitle: string; children?: React.ReactNode }) {
  return (
    <header className="page-head">
      <div>
        <h1>{title}</h1>
        <p className="muted">{subtitle}</p>
      </div>
      <div style={{ display: 'flex', gap: 8 }}>{children}</div>
    </header>
  );
}

// ---------------------------------------------------------------------------
// Dashboard (section A)
// ---------------------------------------------------------------------------

function DashboardView() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    api<{ data: DashboardData }>('/api/ops/intelligence/dashboard')
      .then((r) => { if (alive) setData(r.data); })
      .catch((e) => { if (alive) setError(e instanceof Error ? e.message : 'Failed to load'); });
    return () => { alive = false; };
  }, []);

  const t = data?.totals;
  const b = data?.bands;

  return (
    <div className="page">
      <PageHead title="Intelligence" subtitle="AI lead discovery, scoring and prospect database.">
        <button className="btn btn-ghost" onClick={() => navigate('/intelligence/campaigns')}>Campaigns</button>
        <button className="btn btn-ghost" onClick={() => navigate('/intelligence/prospects')}>Prospects</button>
        <button className="btn btn-ghost" onClick={() => navigate('/intelligence/review')}>Review</button>
      </PageHead>

      {error && <div className="alert alert-error">{error}</div>}
      {!data && !error && <p className="muted">Loading…</p>}

      {data && (
        <>
          <div className="stat-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))' }}>
            <Stat label="Prospects" value={t?.total ?? 0} />
            <Stat label="New" value={t?.newCount ?? 0} />
            <Stat label="Approved" value={t?.approved ?? 0} />
            <Stat label="Converted" value={t?.converted ?? 0} />
            <Stat label="Duplicates" value={t?.duplicates ?? 0} />
            <Stat label="Avg score" value={t?.avgScore ?? 0} />
          </div>

          <section className="card" style={{ marginTop: 16 }}>
            <h3 className="card-title">Score distribution</h3>
            <div className="score-bands">
              <Band label="Hot" count={b?.hot ?? 0} color="#15803d" />
              <Band label="Warm" count={b?.warm ?? 0} color="#b45309" />
              <Band label="Cool" count={b?.cool ?? 0} color="#0369a1" />
              <Band label="Cold" count={b?.cold ?? 0} color="#b91c1c" />
            </div>
          </section>

          <div className="grid-2" style={{ marginTop: 16 }}>
            <section className="card">
              <h3 className="card-title">Top industries</h3>
              {data.industries.length === 0 && <p className="muted">No prospects yet.</p>}
              {data.industries.map((r) => (
                <div key={r.industry} className="kv-row">
                  <span>{r.industry}</span>
                  <span className="cell-mono">{r.count}</span>
                </div>
              ))}
            </section>
            <section className="card">
              <h3 className="card-title">Providers</h3>
              <div className="kv-row"><span>Search provider</span><span className="cell-mono">{data.searchProvider}</span></div>
              <div className="kv-row"><span>AI engine</span><span className="cell-mono">{data.aiProvider}</span></div>
              <div className="kv-row"><span>Active campaigns</span><span className="cell-mono">{data.campaigns.active}/{data.campaigns.total}</span></div>
            </section>
          </div>

          <section className="card" style={{ marginTop: 16 }}>
            <h3 className="card-title">Recent prospects</h3>
            {data.recent.length === 0 && <p className="muted">No prospects yet.</p>}
            {data.recent.length > 0 && (
              <div className="table-wrap">
                <table className="table data">
                  <thead><tr><th>Code</th><th>Name</th><th>Industry</th><th>Score</th><th>Status</th></tr></thead>
                  <tbody>
                    {data.recent.map((p) => (
                      <tr key={p.id} style={{ cursor: 'pointer' }} onClick={() => navigate('/intelligence/prospects/' + p.id)}>
                        <td className="cell-mono">{p.code}</td>
                        <td>{p.name}</td>
                        <td>{label(p.industry)}</td>
                        <td><ScoreBadge score={p.score} /></td>
                        <td><Pill value={p.status} tone={PROSPECT_TONE} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="stat">
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}

function Band({ label, count, color }: { label: string; count: number; color: string }) {
  return (
    <div className="band">
      <span className="badge" style={{ color, background: color + '1a' }}>{label}</span>
      <span className="cell-mono" style={{ fontSize: 18, fontWeight: 600 }}>{count}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Prospects (sections G/H/I)
// ---------------------------------------------------------------------------

function ProspectsView() {
  const { user } = useAuth();
  const [list, setList] = useState<Prospect[] | null>(null);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ name: '', industry: '', country: '', city: '', website: '', email: '', phone: '' });

  const canCreate = can(user, 'intelligence.prospects.create');

  const load = () => {
    const params = new URLSearchParams();
    if (status) params.set('status', status);
    if (q.trim()) params.set('q', q.trim());
    api<{ data: Prospect[] }>('/api/ops/intelligence/prospects' + (params.toString() ? '?' + params.toString() : ''))
      .then((r) => setList(r.data))
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load'));
  };

  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = async () => {
    if (!form.name.trim()) { setError('Name is required'); return; }
    setBusy(true);
    setError('');
    try {
      await api<{ data: Prospect }>('/api/ops/intelligence/prospects', {
        method: 'POST',
        body: JSON.stringify({ ...form, country: form.country || null, city: form.city || null }),
      });
      setShowForm(false);
      setForm({ name: '', industry: '', country: '', city: '', website: '', email: '', phone: '' });
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Create failed');
    } finally {
      setBusy(false);
    }
  };

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value });

  return (
    <div className="page">
      <PageHead title="Prospects" subtitle="Discovered and manually-added businesses, scored and explained.">
        <button className="btn btn-ghost" onClick={() => navigate('/intelligence')}>Dashboard</button>
        {canCreate && <button className="btn btn-primary" onClick={() => setShowForm((v) => !v)}>{showForm ? 'Cancel' : 'New prospect'}</button>}
      </PageHead>

      {error && <div className="alert alert-error">{error}</div>}

      {showForm && (
        <section className="card" style={{ marginBottom: 16 }}>
          <h3 className="card-title">Add prospect</h3>
          <div className="form-grid">
            <Field label="Name *"><input value={form.name} onChange={set('name')} /></Field>
            <Field label="Industry"><input value={form.industry} onChange={set('industry')} /></Field>
            <Field label="Country"><input value={form.country} onChange={set('country')} /></Field>
            <Field label="City"><input value={form.city} onChange={set('city')} /></Field>
            <Field label="Website"><input value={form.website} onChange={set('website')} /></Field>
            <Field label="Email"><input value={form.email} onChange={set('email')} /></Field>
            <Field label="Phone"><input value={form.phone} onChange={set('phone')} /></Field>
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <button className="btn btn-primary" onClick={submit} disabled={busy}>{busy ? 'Saving…' : 'Add & enrich'}</button>
          </div>
        </section>
      )}

      <section className="card">
        <div className="toolbar" style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
          <input placeholder="Search name…" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') load(); }} style={{ maxWidth: 220 }} />
          <select value={status} onChange={(e) => { setStatus(e.target.value); }}>
            <option value="">All statuses</option>
            {['NEW', 'REVIEWED', 'APPROVED', 'REJECTED', 'CONVERTED', 'DISCARDED'].map((x) => <option key={x} value={x}>{x}</option>)}
          </select>
          <button className="btn btn-ghost" onClick={load}>Apply</button>
        </div>
        {!list && <p className="muted">Loading…</p>}
        {list && list.length === 0 && <p className="muted">No prospects match.</p>}
        {list && list.length > 0 && (
          <div className="table-wrap">
            <table className="table data">
              <thead><tr><th>Code</th><th>Name</th><th>Industry</th><th>Location</th><th>Score</th><th>Status</th></tr></thead>
              <tbody>
                {list.map((p) => (
                  <tr key={p.id} style={{ cursor: 'pointer' }} onClick={() => navigate('/intelligence/prospects/' + p.id)}>
                    <td className="cell-mono">{p.code}</td>
                    <td>{p.name}{p.duplicateOf != null && <span className="muted" title="Possible duplicate"> ⚠</span>}</td>
                    <td>{label(p.industry)}</td>
                    <td>{[p.city, p.country].filter(Boolean).join(', ') || '—'}</td>
                    <td><ScoreBadge score={p.score} /></td>
                    <td><Pill value={p.status} tone={PROSPECT_TONE} /></td>
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

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
    </label>
  );
}

// ---------------------------------------------------------------------------
// Prospect detail
// ---------------------------------------------------------------------------

function ProspectDetail({ id }: { id: number }) {
  const { user } = useAuth();
  const [p, setP] = useState<Prospect | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [notes, setNotes] = useState('');

  const canEnrich = can(user, 'intelligence.prospects.enrich');
  const canReview = can(user, 'intelligence.prospects.review');
  const canConvert = can(user, 'intelligence.prospects.convert');
  const canDelete = can(user, 'intelligence.prospects.delete');

  const load = () => api<{ data: Prospect }>('/api/ops/intelligence/prospects/' + id).then((r) => setP(r.data)).catch((e) => setError(e instanceof Error ? e.message : 'Failed to load'));
  useEffect(() => { load(); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  const act = async (fn: () => Promise<unknown>, label: string) => {
    setBusy(label);
    setError('');
    try {
      await fn();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : label + ' failed');
    } finally {
      setBusy('');
    }
  };

  const review = (decision: string) => act(() => api('/api/ops/intelligence/prospects/' + id + '/review', { method: 'POST', body: JSON.stringify({ decision, notes: notes.trim() || null }) }), decision);

  if (!p && !error) return <div className="page"><p className="muted">Loading…</p></div>;

  return (
    <div className="page">
      <PageHead title={p ? `${p.code} · ${p.name}` : 'Prospect'} subtitle="Scored, explained and reviewed prospect.">
        <button className="btn btn-ghost" onClick={() => navigate('/intelligence/prospects')}>Back</button>
      </PageHead>

      {error && <div className="alert alert-error">{error}</div>}
      {p && (
        <>
          <div className="kv-grid" style={{ marginBottom: 16 }}>
            <Kv k="Status"><Pill value={p.status} tone={PROSPECT_TONE} /></Kv>
            <Kv k="Score"><ScoreBadge score={p.score} /></Kv>
            <Kv k="Industry">{label(p.industry)}</Kv>
            <Kv k="Location">{[p.city, p.country].filter(Boolean).join(', ') || '—'}</Kv>
            <Kv k="Website">{p.website ? <a href={p.website} target="_blank" rel="noreferrer">{p.website}</a> : '—'}</Kv>
            <Kv k="Email">{label(p.email)}</Kv>
            <Kv k="Phone">{label(p.phone)}</Kv>
            <Kv k="Employees">{p.employeesMin != null ? `${p.employeesMin}–${p.employeesMax ?? p.employeesMin}` : '—'}</Kv>
            <Kv k="Revenue">{p.revenueMin != null ? fmtMoney(p.revenueMin) : '—'}</Kv>
            <Kv k="Source">{label(p.sourceProvider)}{p.sourceProvider === 'sandbox' && <span className="muted"> (sandbox)</span>}</Kv>
            <Kv k="Converted">{p.convertedCustomerId != null ? <span className="cell-mono">#{p.convertedCustomerId}</span> : '—'}</Kv>
          </div>

          {p.duplicateOf != null && (
            <div className="alert alert-warn">Possible duplicate of prospect #{p.duplicateOf} (similarity {(p.duplicateScore ?? 0).toFixed(2)}).</div>
          )}

          <section className="card" style={{ marginBottom: 16 }}>
            <h3 className="card-title">Why this score</h3>
            {(p.scoreFactors ?? []).length === 0 && <p className="muted">No score factors recorded.</p>}
            {(p.scoreFactors ?? []).map((f) => (
              <div key={f.key} className="factor-row">
                <span>{f.label}</span>
                <div className="factor-bar"><div style={{ width: `${f.max > 0 ? Math.round((f.points / f.max) * 100) : 0}%` }} /></div>
                <span className="cell-mono">{f.points}/{f.max}</span>
                {f.detail && <span className="muted">{f.detail}</span>}
              </div>
            ))}
          </section>

          {p.ai && s(p.ai.rationale) && (
            <section className="card" style={{ marginBottom: 16 }}>
              <h3 className="card-title">AI rationale <span className="muted">({s(p.ai.source)})</span></h3>
              <p>{s(p.ai.rationale)}</p>
              {Array.isArray(p.ai.buyingSignals) && (p.ai.buyingSignals as string[]).length > 0 && (
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
                  {(p.ai.buyingSignals as string[]).map((sig) => <span key={sig} className="badge">{sig}</span>)}
                </div>
              )}
            </section>
          )}

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {canEnrich && <button className="btn btn-ghost" disabled={busy !== ''} onClick={() => act(() => api('/api/ops/intelligence/prospects/' + id + '/enrich', { method: 'POST' }), 'Enriching')}>Re-enrich</button>}
            {canReview && p.status !== 'CONVERTED' && (
              <>
                <input placeholder="Review notes…" value={notes} onChange={(e) => setNotes(e.target.value)} style={{ maxWidth: 220 }} />
                <button className="btn btn-ghost" disabled={busy !== ''} onClick={() => review('REVIEWED')}>Mark reviewed</button>
                <button className="btn btn-primary" disabled={busy !== ''} onClick={() => review('APPROVED')}>Approve</button>
                <button className="btn btn-danger" disabled={busy !== ''} onClick={() => review('REJECTED')}>Reject</button>
                <button className="btn btn-ghost" disabled={busy !== ''} onClick={() => review('DISCARDED')}>Discard</button>
              </>
            )}
            {canConvert && p.status === 'APPROVED' && (
              <button className="btn btn-primary" disabled={busy !== ''} onClick={() => act(() => api('/api/ops/intelligence/prospects/' + id + '/convert', { method: 'POST' }), 'Converting')}>Convert to CRM</button>
            )}
            {canDelete && p.status !== 'CONVERTED' && (
              <button className="btn btn-danger" disabled={busy !== ''} onClick={() => { if (confirm('Delete this prospect?')) act(() => api('/api/ops/intelligence/prospects/' + id, { method: 'DELETE' }).then(() => navigate('/intelligence/prospects')), 'Deleting'); }}>Delete</button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function Kv({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div className="kv">
      <div className="kv-k">{k}</div>
      <div className="kv-v">{children}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Review queue (section K)
// ---------------------------------------------------------------------------

function ReviewView() {
  const { user } = useAuth();
  const [list, setList] = useState<Prospect[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<number | null>(null);

  const canReview = can(user, 'intelligence.prospects.review');

  const load = () => api<{ data: Prospect[] }>('/api/ops/intelligence/prospects').then((r) =>
    setList(r.data.filter((p) => p.status === 'NEW' || p.status === 'REVIEWED'))
  ).catch((e) => setError(e instanceof Error ? e.message : 'Failed to load'));
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const review = async (id: number, decision: string) => {
    setBusy(id);
    setError('');
    try {
      await api('/api/ops/intelligence/prospects/' + id + '/review', { method: 'POST', body: JSON.stringify({ decision }) });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Review failed');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="page">
      <PageHead title="Review queue" subtitle="Approve or reject discovered prospects before they reach CRM.">
        <button className="btn btn-ghost" onClick={() => navigate('/intelligence')}>Dashboard</button>
      </PageHead>
      {error && <div className="alert alert-error">{error}</div>}
      <section className="card">
        {!list && <p className="muted">Loading…</p>}
        {list && list.length === 0 && <p className="muted">Queue is clear.</p>}
        {list && list.length > 0 && (
          <div className="table-wrap">
            <table className="table data">
              <thead><tr><th>Code</th><th>Name</th><th>Industry</th><th>Score</th><th>Status</th><th /></tr></thead>
              <tbody>
                {list.map((p) => (
                  <tr key={p.id}>
                    <td className="cell-mono" style={{ cursor: 'pointer' }} onClick={() => navigate('/intelligence/prospects/' + p.id)}>{p.code}</td>
                    <td style={{ cursor: 'pointer' }} onClick={() => navigate('/intelligence/prospects/' + p.id)}>{p.name}</td>
                    <td>{label(p.industry)}</td>
                    <td><ScoreBadge score={p.score} /></td>
                    <td><Pill value={p.status} tone={PROSPECT_TONE} /></td>
                    <td style={{ display: 'flex', gap: 6 }}>
                      {canReview && (
                        <>
                          <button className="btn btn-primary btn-sm" disabled={busy === p.id} onClick={() => review(p.id, 'APPROVED')}>Approve</button>
                          <button className="btn btn-danger btn-sm" disabled={busy === p.id} onClick={() => review(p.id, 'REJECTED')}>Reject</button>
                        </>
                      )}
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

// ---------------------------------------------------------------------------
// Campaigns (section B)
// ---------------------------------------------------------------------------

const EVERY_MS_OPTIONS: { value: number; label: string }[] = [
  { value: 3_600_000, label: 'Hourly' },
  { value: 86_400_000, label: 'Daily' },
  { value: 604_800_000, label: 'Weekly' },
];

function CampaignsView() {
  const { user } = useAuth();
  const [list, setList] = useState<Campaign[] | null>(null);
  const [error, setError] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ name: '', description: '', query: '', industries: '', countries: '', cities: '', minEmployees: '', maxEmployees: '', maxResults: '50', scheduleEnabled: false, everyMs: '86400000' });

  const canCreate = can(user, 'intelligence.campaigns.create');

  const load = () => api<{ data: Campaign[] }>('/api/ops/intelligence/campaigns').then((r) => setList(r.data)).catch((e) => setError(e instanceof Error ? e.message : 'Failed to load'));
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    setForm({ ...form, [k]: e.target.type === 'checkbox' ? (e.target as HTMLInputElement).checked : e.target.value });

  const submit = async () => {
    if (!form.name.trim()) { setError('Name is required'); return; }
    setBusy(true);
    setError('');
    try {
      const body = {
        name: form.name,
        description: form.description || null,
        maxResults: Number(form.maxResults) || 50,
        criteria: {
          query: form.query || null,
          industries: csvSplit(form.industries),
          countries: csvSplit(form.countries),
          cities: csvSplit(form.cities),
          minEmployees: form.minEmployees ? Number(form.minEmployees) : null,
          maxEmployees: form.maxEmployees ? Number(form.maxEmployees) : null,
        },
        schedule: { enabled: form.scheduleEnabled, everyMs: Number(form.everyMs) },
      };
      await api<{ data: Campaign }>('/api/ops/intelligence/campaigns', { method: 'POST', body: JSON.stringify(body) });
      setShowForm(false);
      setForm({ name: '', description: '', query: '', industries: '', countries: '', cities: '', minEmployees: '', maxEmployees: '', maxResults: '50', scheduleEnabled: false, everyMs: '86400000' });
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Create failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page">
      <PageHead title="Discovery campaigns" subtitle="Targeted searches by industry, geography and keywords.">
        <button className="btn btn-ghost" onClick={() => navigate('/intelligence')}>Dashboard</button>
        {canCreate && <button className="btn btn-primary" onClick={() => setShowForm((v) => !v)}>{showForm ? 'Cancel' : 'New campaign'}</button>}
      </PageHead>

      {error && <div className="alert alert-error">{error}</div>}

      {showForm && (
        <section className="card" style={{ marginBottom: 16 }}>
          <h3 className="card-title">New campaign</h3>
          <div className="form-grid">
            <Field label="Name *"><input value={form.name} onChange={set('name')} /></Field>
            <Field label="Description"><textarea value={form.description} onChange={set('description')} rows={2} /></Field>
            <Field label="Search query"><input value={form.query} onChange={set('query')} /></Field>
            <Field label="Industries (comma-separated)"><input value={form.industries} onChange={set('industries')} placeholder="Printing, Packaging" /></Field>
            <Field label="Countries"><input value={form.countries} onChange={set('countries')} placeholder="Uganda, Kenya" /></Field>
            <Field label="Cities"><input value={form.cities} onChange={set('cities')} placeholder="Kampala" /></Field>
            <Field label="Min employees"><input type="number" value={form.minEmployees} onChange={set('minEmployees')} /></Field>
            <Field label="Max employees"><input type="number" value={form.maxEmployees} onChange={set('maxEmployees')} /></Field>
            <Field label="Max results"><input type="number" value={form.maxResults} onChange={set('maxResults')} /></Field>
            <Field label="Schedule">
              <select value={form.everyMs} onChange={set('everyMs')} disabled={!form.scheduleEnabled}>
                {EVERY_MS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </Field>
          </div>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 12 }}>
            <input type="checkbox" checked={form.scheduleEnabled} onChange={set('scheduleEnabled')} /> Recurring (run automatically)
          </label>
          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <button className="btn btn-primary" onClick={submit} disabled={busy}>{busy ? 'Saving…' : 'Create'}</button>
          </div>
        </section>
      )}

      <section className="card">
        {!list && <p className="muted">Loading…</p>}
        {list && list.length === 0 && <p className="muted">No campaigns yet.</p>}
        {list && list.length > 0 && (
          <div className="table-wrap">
            <table className="table data">
              <thead><tr><th>Code</th><th>Name</th><th>Status</th><th>Runs</th><th>Last run</th></tr></thead>
              <tbody>
                {list.map((c) => (
                  <tr key={c.id} style={{ cursor: 'pointer' }} onClick={() => navigate('/intelligence/campaigns/' + c.id)}>
                    <td className="cell-mono">{c.code}</td>
                    <td>{c.name}</td>
                    <td><Pill value={c.status} tone={CAMPAIGN_TONE} /></td>
                    <td>{c.runCount ?? 0}</td>
                    <td>{fmtDate(c.lastRunAt)}</td>
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

// ---------------------------------------------------------------------------
// Campaign detail
// ---------------------------------------------------------------------------

function CampaignDetail({ id }: { id: number }) {
  const { user } = useAuth();
  const [c, setC] = useState<Campaign | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [runResult, setRunResult] = useState('');

  const canRun = can(user, 'intelligence.campaigns.run');
  const canUpdate = can(user, 'intelligence.campaigns.update');
  const canDelete = can(user, 'intelligence.campaigns.delete');

  const load = () => api<{ data: Campaign }>('/api/ops/intelligence/campaigns/' + id).then((r) => setC(r.data)).catch((e) => setError(e instanceof Error ? e.message : 'Failed to load'));
  useEffect(() => { load(); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  const act = async (fn: () => Promise<unknown>, label: string) => {
    setBusy(label);
    setError('');
    try {
      await fn();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : label + ' failed');
    } finally {
      setBusy('');
    }
  };

  const status = (s: string) => act(() => api('/api/ops/intelligence/campaigns/' + id + '/status', { method: 'POST', body: JSON.stringify({ status: s }) }), s);

  const run = async () => {
    setBusy('Running');
    setError('');
    setRunResult('');
    try {
      const r = await api<{ data: { discovered: number; inserted: number; duplicates: number } }>('/api/ops/intelligence/campaigns/' + id + '/run', { method: 'POST' });
      setRunResult(`Discovered ${r.data.discovered}, inserted ${r.data.inserted}, flagged duplicates ${r.data.duplicates}.`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Run failed');
    } finally {
      setBusy('');
    }
  };

  if (!c && !error) return <div className="page"><p className="muted">Loading…</p></div>;

  return (
    <div className="page">
      <PageHead title={c ? `${c.code} · ${c.name}` : 'Campaign'} subtitle="Targeting criteria and run history.">
        <button className="btn btn-ghost" onClick={() => navigate('/intelligence/campaigns')}>Back</button>
      </PageHead>

      {error && <div className="alert alert-error">{error}</div>}
      {runResult && <div className="alert alert-ok">{runResult}</div>}

      {c && (
        <>
          <div className="kv-grid" style={{ marginBottom: 16 }}>
            <Kv k="Status"><Pill value={c.status} tone={CAMPAIGN_TONE} /></Kv>
            <Kv k="Runs">{c.runCount ?? 0}</Kv>
            <Kv k="Last run">{fmtDate(c.lastRunAt)}</Kv>
            <Kv k="Next run">{fmtDate(c.nextRunAt)}</Kv>
            <Kv k="Max results">{c.maxResults ?? 50}</Kv>
            <Kv k="Recurring">{c.schedule?.enabled ? 'Yes' : 'No'}</Kv>
          </div>

          <section className="card" style={{ marginBottom: 16 }}>
            <h3 className="card-title">Criteria</h3>
            {c.criteria && Object.keys(c.criteria).length > 0 ? (
              <div className="kv-grid">
                {Object.entries(c.criteria).map(([k, v]) => (
                  <Kv key={k} k={k}>{Array.isArray(v) ? (v.length ? v.join(', ') : '—') : (v == null ? '—' : String(v))}</Kv>
                ))}
              </div>
            ) : <p className="muted">No criteria set.</p>}
          </section>

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {canRun && <button className="btn btn-primary" disabled={busy !== ''} onClick={run}>{busy === 'Running' ? 'Running…' : 'Run now'}</button>}
            {canUpdate && c.status === 'DRAFT' && <button className="btn btn-ghost" disabled={busy !== ''} onClick={() => status('ACTIVE')}>Activate</button>}
            {canUpdate && c.status === 'ACTIVE' && <button className="btn btn-ghost" disabled={busy !== ''} onClick={() => status('PAUSED')}>Pause</button>}
            {canUpdate && c.status === 'PAUSED' && <button className="btn btn-ghost" disabled={busy !== ''} onClick={() => status('ACTIVE')}>Resume</button>}
            {canDelete && <button className="btn btn-danger" disabled={busy !== ''} onClick={() => { if (confirm('Delete this campaign?')) act(() => api('/api/ops/intelligence/campaigns/' + id, { method: 'DELETE' }).then(() => navigate('/intelligence/campaigns')), 'Deleting'); }}>Delete</button>}
          </div>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Root dispatcher
// ---------------------------------------------------------------------------

export default function Intelligence({ path }: { path: string }) {
  const parts = path.split('/').filter(Boolean); // e.g. ['intelligence','prospects','3']
  if (parts.length <= 1) return <DashboardView />;

  if (parts[1] === 'prospects') {
    const id = Number(parts[2]);
    if (Number.isFinite(id) && id > 0) return <ProspectDetail id={id} />;
    return <ProspectsView />;
  }

  if (parts[1] === 'campaigns') {
    if (parts[2] === 'new') return <CampaignsView />;
    const id = Number(parts[2]);
    if (Number.isFinite(id) && id > 0) return <CampaignDetail id={id} />;
    return <CampaignsView />;
  }

  if (parts[1] === 'review') return <ReviewView />;

  return <DashboardView />;
}
