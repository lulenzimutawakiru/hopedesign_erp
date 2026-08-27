import { useCallback, useEffect, useState } from 'react';
import { api, fmtMoney, fmtNum } from '../api';
import { useAuth, can } from '../auth';
import { navigate } from '../router';
import { Badge, ErrorBanner, PageLoader } from '../components/ui';

type Rec = Record<string, unknown>;

function parseCrm(path: string): { view: string; id: string | null } {
  const parts = path.split('/').filter(Boolean);
  if (parts[0] !== 'crm') return { view: 'board', id: null };
  return { view: parts[1] ?? 'board', id: parts[2] ?? null };
}

export default function CrmFlow({ path }: { path: string }) {
  const { view, id } = parseCrm(path);
  if (view === 'customers' && id === 'new') return <CustomerComposer />;
  if (view === 'customers' && id) return <CustomerDesk id={Number(id)} />;
  if (view === 'customers') return <CustomerList />;
  if (view === 'leads' && id === 'new') return <LeadComposer />;
  if (view === 'leads' && id) return <LeadDesk id={Number(id)} />;
  if (view === 'leads') return <LeadList />;
  if (view === 'opportunities' && id === 'new') return <OppComposer />;
  if (view === 'opportunities' && id) return <OppDesk id={Number(id)} />;
  if (view === 'pipeline') return <Pipeline />;
  if (view === 'activities') return <ActivityList />;
  if (view === 'complaints' && id) return <ComplaintDesk id={Number(id)} />;
  if (view === 'complaints') return <ComplaintList />;
  if (view === 'contacts') return <ContactList />;
  if (view === 'analytics') return <CrmAnalytics />;
  if (view === 'mine') return <MyDesk />;
  return <CrmBoard />;
}

function OwnerPicker({ value, onChange, owners }: { value: string; onChange: (v: string) => void; owners: Rec[] }) {
  return (
    <select className="cell-input" value={value} onChange={(e) => onChange(e.target.value)} aria-label="Assign owner">
      <option value="">Assign owner…</option>
      {owners.map((u) => (
        <option key={String(u.id)} value={String(u.id)}>{String(u.firstName)} {String(u.lastName)}</option>
      ))}
    </select>
  );
}

function AssignInline({ entity, id, onDone }: { entity: 'customers' | 'leads' | 'opportunities'; id: number; onDone: () => void }) {
  const [owners, setOwners] = useState<Rec[]>([]);
  const [ownerId, setOwnerId] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api<{ data: Rec[] }>('/api/ops/crm/owners').then((r) => setOwners(r.data ?? [])).catch(() => undefined);
  }, []);
  return (
    <>
      <OwnerPicker value={ownerId} onChange={setOwnerId} owners={owners} />
      <button
        className="btn btn-sm"
        disabled={busy || !ownerId}
        onClick={async () => {
          setBusy(true);
          try {
            await api(`/api/ops/crm/${entity}/${id}/assign`, { method: 'POST', body: JSON.stringify({ userId: Number(ownerId) }) });
            onDone();
          } finally { setBusy(false); }
        }}
      >Assign</button>
    </>
  );
}

function HealthMeter({ health }: { health: Rec }) {
  const score = Number(health.score ?? 0);
  const band = String(health.band ?? 'watch');
  return (
    <div className="health-meter" aria-label={`Account health ${score} ${band}`}>
      <div className="health-bar" data-band={band}><span style={{ width: `${score}%` }} /></div>
      <strong>{score}</strong>
      <span className="muted">{band}</span>
    </div>
  );
}

function CrmBoard() {
  const { user } = useAuth();
  const [data, setData] = useState<Rec | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    api<{ data: Rec }>('/api/ops/crm/board')
      .then((r) => setData(r.data))
      .catch((e) => setError(e instanceof Error ? e.message : 'CRM board failed'));
  }, []);
  if (error && !data) return <ErrorBanner error={error} />;
  if (!data) return <PageLoader label="Opening accounts…" />;
  const kpis = (data.kpis ?? {}) as Rec;
  const leads = (data.leads as Rec[]) ?? [];
  const hot = (data.hot as Rec[]) ?? [];
  const due = (data.due as Rec[]) ?? [];
  const holds = (data.holds as Rec[]) ?? [];
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="mod-kicker" data-mod="crm">CRM</p>
          <h1>Accounts</h1>
          <p className="muted">Lead → qualify → convert → pipeline → quote. Credit is checked before a quote leaves the desk. Sales, AR, and plant sit on the same account 360.</p>
        </div>
        <div className="head-actions">
          {can(user, 'crm.activities.view') && <button className="btn" onClick={() => navigate('/crm/mine')}>My desk</button>}
          {can(user, 'crm.leads.create') && <button className="btn" onClick={() => navigate('/crm/leads/new')}>New lead</button>}
          {can(user, 'crm.customers.create') && <button className="btn btn-primary" onClick={() => navigate('/crm/customers/new')}>New account</button>}
        </div>
      </header>
      <div className="kpi-grid">
        <button className="kpi-card" onClick={() => navigate('/crm/leads')}>
          <span className="kpi-label">Open leads</span>
          <span className="kpi-value">{fmtNum(kpis.openLeads)}</span>
        </button>
        <button className="kpi-card" onClick={() => navigate('/crm/pipeline')}>
          <span className="kpi-label">Pipeline</span>
          <span className="kpi-value">{fmtMoney(kpis.pipeline)}</span>
          <span className="kpi-sub">{fmtNum(kpis.openOpps)} open · weighted {fmtMoney(kpis.weighted)}</span>
        </button>
        <button className="kpi-card" onClick={() => navigate('/crm/analytics')}>
          <span className="kpi-label">Open AR</span>
          <span className="kpi-value">{fmtMoney(kpis.openAr)}</span>
          <span className="kpi-sub">{fmtNum(kpis.blockedAccounts)} blocked · {fmtNum(kpis.heldOpps)} on hold</span>
        </button>
        <button className="kpi-card" onClick={() => navigate('/crm/activities')}>
          <span className="kpi-label">Overdue follow-ups</span>
          <span className="kpi-value">{fmtNum(kpis.overdue)}</span>
        </button>
        <button className="kpi-card" onClick={() => navigate('/crm/complaints')}>
          <span className="kpi-label">Open complaints</span>
          <span className="kpi-value">{fmtNum(kpis.openComplaints)}</span>
        </button>
      </div>
      <div className="do-now">
        <button onClick={() => navigate('/crm/mine')}><strong>My desk</strong><span>Assigned work</span></button>
        <button onClick={() => navigate('/crm/leads')}><strong>Leads</strong><span>Qualify and convert</span></button>
        <button onClick={() => navigate('/crm/pipeline')}><strong>Pipeline</strong><span>Move stages, quote</span></button>
        <button onClick={() => navigate('/crm/customers')}><strong>Accounts</strong><span>360, credit, health</span></button>
        <button onClick={() => navigate('/sales/quotations')}><strong>Quotations</strong><span>Order to cash</span></button>
      </div>
      <section className="card">
        <div className="card-head"><h3>Hot opportunities</h3></div>
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>Opportunity</th><th>Account</th><th>Stage</th><th className="cell-num">Amount</th></tr></thead>
            <tbody>
              {hot.map((r) => (
                <tr key={String(r.id)} className="row-click" onClick={() => navigate(`/crm/opportunities/${r.id}`)}>
                  <td>{String(r.name)}</td>
                  <td>{String(r.customerName ?? '—')}</td>
                  <td><Badge value={r.stage} /></td>
                  <td className="cell-num">{fmtMoney(r.amount)}</td>
                </tr>
              ))}
              {hot.length === 0 && <tr><td colSpan={4} className="muted" style={{ textAlign: 'center', padding: 24 }}>No open opportunities.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
      <section className="card">
        <div className="card-head"><h3>Open leads</h3></div>
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>Lead</th><th>Name</th><th>Status</th><th className="cell-num">Value</th></tr></thead>
            <tbody>
              {leads.map((r) => (
                <tr key={String(r.id)} className="row-click" onClick={() => navigate(`/crm/leads/${r.id}`)}>
                  <td className="cell-mono">{String(r.leadNo)}</td>
                  <td>{String(r.companyName || `${r.firstName ?? ''} ${r.lastName ?? ''}`.trim() || '—')}</td>
                  <td><Badge value={r.status} /></td>
                  <td className="cell-num">{fmtMoney(r.value)}</td>
                </tr>
              ))}
              {leads.length === 0 && <tr><td colSpan={4} className="muted" style={{ padding: 16 }}>No open leads.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
      {holds.length > 0 && (
        <section className="card">
          <div className="card-head"><h3>Credit holds</h3></div>
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Account</th><th>Status</th></tr></thead>
              <tbody>
                {holds.map((r) => (
                  <tr key={String(r.id)} className="row-click" onClick={() => navigate(`/crm/customers/${r.id}`)}>
                    <td>{String(r.name)} <span className="cell-mono">{String(r.code)}</span></td>
                    <td><Badge value={r.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
      {due.length > 0 && (
        <section className="card">
          <div className="card-head"><h3>Follow-ups</h3></div>
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Type</th><th>Subject</th><th>Due</th></tr></thead>
              <tbody>
                {due.map((r) => (
                  <tr key={String(r.id)}>
                    <td>{String(r.activityType)}</td>
                    <td>{String(r.subject)}</td>
                    <td>{r.dueAt ? String(r.dueAt).slice(0, 16).replace('T', ' ') : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}

function CustomerList() {
  const [rows, setRows] = useState<Rec[]>([]);
  const [q, setQ] = useState('');
  const [error, setError] = useState('');
  const load = useCallback(() => {
    const p = new URLSearchParams({ pageSize: '50' });
    if (q.trim()) p.set('q', q.trim());
    api<{ data: { rows: Rec[] } }>(`/api/ops/crm/customers?${p}`)
      .then((r) => setRows(r.data.rows ?? []))
      .catch((e) => setError(e instanceof Error ? e.message : 'Customers failed'));
  }, [q]);
  useEffect(() => { load(); }, [load]);
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="mod-kicker" data-mod="crm">Accounts</p>
          <h1>Customers</h1>
        </div>
        <button className="btn btn-primary" onClick={() => navigate('/crm/customers/new')}>New account</button>
      </header>
      {error && <ErrorBanner error={error} />}
      <div className="toolbar">
        <input className="search-input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, code, phone…" />
      </div>
      <div className="table-wrap card">
        <table className="data">
          <thead><tr><th>Code</th><th>Name</th><th>Status</th><th className="cell-num">Open AR</th><th className="cell-num">Limit</th><th className="cell-num">Opps</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={String(r.id)} className="row-click" onClick={() => navigate(`/crm/customers/${r.id}`)}>
                <td className="cell-mono">{String(r.code)}</td>
                <td>{String(r.name)}</td>
                <td><Badge value={r.status} /></td>
                <td className="cell-num">{fmtMoney(r.openAr)}</td>
                <td className="cell-num">{Number(r.creditLimit) > 0 ? fmtMoney(r.creditLimit) : '—'}</td>
                <td className="cell-num">{fmtNum(r.openOpps)}</td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={6} className="muted" style={{ textAlign: 'center', padding: 24 }}>No customers.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function CustomerDesk({ id }: { id: number }) {
  const { user } = useAuth();
  const [doc, setDoc] = useState<Rec | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [phone, setPhone] = useState('');
  const [subject, setSubject] = useState('');
  const [owners, setOwners] = useState<Rec[]>([]);
  const [ownerId, setOwnerId] = useState('');
  const [blockReason, setBlockReason] = useState('');
  const load = useCallback(() => {
    api<{ data: Rec }>(`/api/ops/crm/customers/${id}`)
      .then((r) => setDoc(r.data))
      .catch((e) => setError(e instanceof Error ? e.message : 'Account failed'));
  }, [id]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    api<{ data: Rec[] }>('/api/ops/crm/owners').then((r) => setOwners(r.data ?? [])).catch(() => undefined);
  }, []);
  if (error && !doc) return <ErrorBanner error={error} />;
  if (!doc) return <PageLoader label="Opening account…" />;
  const c = doc.customer as Rec;
  const credit = (doc.credit ?? {}) as Rec;
  const health = (doc.health ?? {}) as Rec;
  const aging = (doc.aging ?? {}) as Rec;
  const timeline = (doc.timeline as Rec[]) ?? [];
  const plant = (doc.plant as Rec[]) ?? [];
  const act = async (path: string, body: Rec, ok: string) => {
    setBusy(true); setError(''); setNotice('');
    try {
      await api(path, { method: 'POST', body: JSON.stringify(body) });
      setNotice(ok);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <button className="btn btn-sm" onClick={() => navigate('/crm/customers')}>Back</button>
          <h1>{String(c.name)} <span className="cell-mono">{String(c.code)}</span></h1>
          <p className="muted">{String(c.customerType)} · {String(c.email ?? c.phone ?? 'No contact yet')} · owner {String(c.ownerName || 'unassigned')}</p>
        </div>
        <Badge value={c.status} />
      </header>
      {notice && <div className="alert alert-success">{notice}</div>}
      {error && <ErrorBanner error={error} />}
      {!credit.ok && <div className="alert alert-error">Credit hold: {String(credit.reason)}. Quoting and new orders are blocked.</div>}
      <div className="kpi-grid">
        <div className={`kpi-card ${String(health.band) === 'healthy' ? '' : 'card-warn'}`}>
          <span className="kpi-label">Health</span>
          <HealthMeter health={health} />
          <span className="kpi-sub">{((health.reasons as string[]) ?? []).join(' · ') || 'No flags'}</span>
        </div>
        <div className={`kpi-card ${credit.ok ? '' : 'card-warn'}`}>
          <span className="kpi-label">Credit</span>
          <span className="kpi-value">{credit.ok ? 'OK' : 'Hold'}</span>
          <span className="kpi-sub">{credit.reason ? String(credit.reason) : `AR ${fmtMoney(credit.openAr)} · limit ${Number(credit.creditLimit) > 0 ? fmtMoney(credit.creditLimit) : 'open'}`}</span>
        </div>
        <div className="kpi-card">
          <span className="kpi-label">Open AR</span>
          <span className="kpi-value">{fmtMoney(credit.openAr)}</span>
        </div>
        <div className="kpi-card">
          <span className="kpi-label">Terms</span>
          <span className="kpi-value">{fmtNum(c.paymentTermsDays)}d</span>
        </div>
      </div>
      <div className="aging-row" style={{ marginBottom: 16 }}>
        {([
          ['Current', aging.current],
          ['1–30', aging.days130],
          ['31–60', aging.days3160],
          ['61–90', aging.days6190],
          ['90+', aging.days90Plus],
        ] as [string, unknown][]).map(([label, val]) => (
          <div key={label} className="aging-cell">
            <span className="muted">{label}</span>
            <strong>{fmtMoney(val)}</strong>
          </div>
        ))}
      </div>
      <div className="flow-actions" style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
        {can(user, 'crm.opportunities.create') && String(c.status) !== 'BLOCKED' && (
          <button className="btn btn-primary" onClick={() => navigate(`/crm/opportunities/new?customer=${id}`)}>New opportunity</button>
        )}
        {Boolean(credit.ok) && <button className="btn" onClick={() => navigate(`/sales/quotations/new?customer=${id}`)}>New quotation</button>}
        <button className="btn" onClick={() => navigate('/finance/ar')}>AR ledger</button>
        {can(user, 'crm.customers.block') && String(c.status) !== 'BLOCKED' && (
          <>
            <input className="cell-input" placeholder="Block reason" value={blockReason} onChange={(e) => setBlockReason(e.target.value)} />
            <button className="btn btn-warning" disabled={busy} onClick={() => act(`/api/ops/crm/customers/${id}/status`, { status: 'BLOCKED', reason: blockReason || 'Credit / compliance hold' }, 'Account blocked')}>Block</button>
          </>
        )}
        {can(user, 'crm.customers.block') && String(c.status) === 'BLOCKED' && (
          <button className="btn btn-success" disabled={busy} onClick={() => act(`/api/ops/crm/customers/${id}/status`, { status: 'ACTIVE', reason: 'Released from hold' }, 'Account released')}>Release hold</button>
        )}
        {can(user, 'crm.customers.update') && (
          <>
            <OwnerPicker value={ownerId} onChange={setOwnerId} owners={owners} />
            <button className="btn btn-sm" disabled={busy || !ownerId} onClick={() => act(`/api/ops/crm/customers/${id}/assign`, { userId: Number(ownerId) }, 'Owner assigned')}>Assign</button>
          </>
        )}
      </div>
      <section className="card">
        <div className="card-head"><h3>Contacts</h3></div>
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>Name</th><th>Title</th><th>Phone</th><th>Email</th></tr></thead>
            <tbody>
              {((doc.contacts as Rec[]) ?? []).map((p) => (
                <tr key={String(p.id)}>
                  <td>{String(p.firstName)} {String(p.lastName)} {p.isPrimary ? '· primary' : ''}</td>
                  <td>{String(p.title ?? '—')}</td>
                  <td>{String(p.phone ?? '—')}</td>
                  <td>{String(p.email ?? '—')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {can(user, 'crm.contacts.create') && (
          <div className="card-pad" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <input className="cell-input" placeholder="First" value={firstName} onChange={(e) => setFirstName(e.target.value)} />
            <input className="cell-input" placeholder="Last" value={lastName} onChange={(e) => setLastName(e.target.value)} />
            <input className="cell-input" placeholder="Phone" value={phone} onChange={(e) => setPhone(e.target.value)} />
            <button className="btn btn-sm" disabled={busy || !firstName || !lastName} onClick={() => act(`/api/ops/crm/customers/${id}/contacts`, { firstName, lastName, phone, isPrimary: ((doc.contacts as Rec[]) ?? []).length === 0 }, 'Contact saved')}>Add contact</button>
          </div>
        )}
      </section>
      <section className="card">
        <div className="card-head"><h3>Opportunities</h3></div>
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>Name</th><th>Stage</th><th className="cell-num">Amount</th></tr></thead>
            <tbody>
              {((doc.opportunities as Rec[]) ?? []).map((o) => (
                <tr key={String(o.id)} className="row-click" onClick={() => navigate(`/crm/opportunities/${o.id}`)}>
                  <td>{String(o.name)}</td>
                  <td><Badge value={o.stage} /></td>
                  <td className="cell-num">{fmtMoney(o.amount)}</td>
                </tr>
              ))}
              {((doc.opportunities as Rec[]) ?? []).length === 0 && <tr><td colSpan={3} className="muted" style={{ padding: 16 }}>No opportunities.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
      <section className="card">
        <div className="card-head"><h3>Sales</h3></div>
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>Quote</th><th>Status</th><th className="cell-num">Total</th></tr></thead>
            <tbody>
              {((doc.quotations as Rec[]) ?? []).map((q) => (
                <tr key={String(q.id)} className="row-click" onClick={() => navigate(`/sales/quotations/${q.id}`)}>
                  <td className="cell-mono">{String(q.quotationNo)}</td>
                  <td><Badge value={q.status} /></td>
                  <td className="cell-num">{fmtMoney(q.total)}</td>
                </tr>
              ))}
              {((doc.quotations as Rec[]) ?? []).length === 0 && <tr><td colSpan={3} className="muted" style={{ padding: 16 }}>No quotations.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
      <section className="card">
        <div className="card-head"><h3>Invoices</h3></div>
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>Invoice</th><th>Status</th><th className="cell-num">Total</th><th className="cell-num">Balance</th></tr></thead>
            <tbody>
              {((doc.invoices as Rec[]) ?? []).map((inv) => (
                <tr key={String(inv.id)} className="row-click" onClick={() => navigate(`/sales/invoices/${inv.id}`)}>
                  <td className="cell-mono">{String(inv.invoiceNo)}</td>
                  <td><Badge value={inv.status} /></td>
                  <td className="cell-num">{fmtMoney(inv.total)}</td>
                  <td className="cell-num">{fmtMoney(inv.balance)}</td>
                </tr>
              ))}
              {((doc.invoices as Rec[]) ?? []).length === 0 && <tr><td colSpan={4} className="muted" style={{ padding: 16 }}>No invoices.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
      {plant.length > 0 && (
        <section className="card">
          <div className="card-head"><h3>Plant work</h3></div>
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>WO</th><th>Product</th><th>Status</th><th className="cell-num">Qty</th></tr></thead>
              <tbody>
                {plant.map((w) => (
                  <tr key={String(w.id)} className="row-click" onClick={() => navigate(`/plant/orders/${w.id}`)}>
                    <td className="cell-mono">{String(w.woNo)}</td>
                    <td>{String(w.productCode)} · {String(w.productName)}</td>
                    <td><Badge value={w.status} /></td>
                    <td className="cell-num">{fmtNum(w.producedQty)} / {fmtNum(w.quantity)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
      <section className="card">
        <div className="card-head"><h3>Timeline</h3></div>
        <ul className="timeline">
          {timeline.map((e, i) => (
            <li key={`${e.kind}-${e.ref}-${i}`}>
              <span className="muted">{e.at ? String(e.at).slice(0, 10) : '—'}</span>
              <span>{String(e.kind)}</span>
              <span>{String(e.label)}</span>
              <Badge value={e.status} />
            </li>
          ))}
          {timeline.length === 0 && <li className="muted">No events yet.</li>}
        </ul>
      </section>
      {can(user, 'crm.complaints.create') && (
        <section className="card card-pad">
          <h3>Open a complaint</h3>
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <input className="cell-input" style={{ flex: 1 }} placeholder="Subject" value={subject} onChange={(e) => setSubject(e.target.value)} />
            <button className="btn" disabled={busy || !subject} onClick={() => act('/api/ops/crm/complaints', { customerId: id, subject }, 'Complaint opened')}>Log</button>
          </div>
        </section>
      )}
    </div>
  );
}

function CustomerComposer() {
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [limit, setLimit] = useState('0');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (!name.trim()) { setError('Name is required'); return; }
    setBusy(true); setError('');
    try {
      const r = await api<{ data: { customerId: number } }>('/api/ops/crm/customers', {
        method: 'POST',
        body: JSON.stringify({ name, phone, email, creditLimit: Number(limit) || 0 }),
      });
      navigate(`/crm/customers/${r.data.customerId}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <button className="btn btn-sm" onClick={() => navigate('/crm/customers')}>Back</button>
          <h1>New account</h1>
        </div>
      </header>
      {error && <ErrorBanner error={error} />}
      <section className="card card-pad">
        <div className="form-grid">
          <div className="field field-required" style={{ gridColumn: '1 / -1' }}><label>Name</label><input value={name} onChange={(e) => setName(e.target.value)} /></div>
          <div className="field"><label>Phone</label><input value={phone} onChange={(e) => setPhone(e.target.value)} /></div>
          <div className="field"><label>Email</label><input value={email} onChange={(e) => setEmail(e.target.value)} /></div>
          <div className="field"><label>Credit limit</label><input inputMode="decimal" value={limit} onChange={(e) => setLimit(e.target.value)} /></div>
        </div>
        <button className="btn btn-primary" style={{ marginTop: 16 }} disabled={busy} onClick={save}>Save account</button>
      </section>
    </div>
  );
}

function LeadList() {
  const [rows, setRows] = useState<Rec[]>([]);
  const [q, setQ] = useState('');
  const [error, setError] = useState('');
  const load = useCallback(() => {
    const p = new URLSearchParams({ pageSize: '50' });
    if (q.trim()) p.set('q', q.trim());
    api<{ data: { rows: Rec[] } }>(`/api/ops/crm/leads?${p}`)
      .then((r) => setRows(r.data.rows ?? []))
      .catch((e) => setError(e instanceof Error ? e.message : 'Leads failed'));
  }, [q]);
  useEffect(() => { load(); }, [load]);
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="mod-kicker" data-mod="crm">Leads</p>
          <h1>Inbound and prospecting</h1>
        </div>
        <button className="btn btn-primary" onClick={() => navigate('/crm/leads/new')}>New lead</button>
      </header>
      {error && <ErrorBanner error={error} />}
      <div className="toolbar">
        <input className="search-input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search lead…" />
      </div>
      <div className="table-wrap card">
        <table className="data">
          <thead><tr><th>Lead</th><th>Company / person</th><th>Source</th><th>Status</th><th className="cell-num">Score</th><th className="cell-num">Value</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={String(r.id)} className="row-click" onClick={() => navigate(`/crm/leads/${r.id}`)}>
                <td className="cell-mono">{String(r.leadNo)}</td>
                <td>{String(r.companyName || `${r.firstName ?? ''} ${r.lastName ?? ''}`.trim() || '—')}</td>
                <td>{String(r.source)}</td>
                <td><Badge value={r.status} /></td>
                <td className="cell-num">{fmtNum(r.score)}</td>
                <td className="cell-num">{fmtMoney(r.value)}</td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={6} className="muted" style={{ textAlign: 'center', padding: 24 }}>No leads.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function LeadDesk({ id }: { id: number }) {
  const { user } = useAuth();
  const [doc, setDoc] = useState<{ lead: Rec; activities: Rec[]; opportunities: Rec[] } | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState('');
  const [owners, setOwners] = useState<Rec[]>([]);
  const [ownerId, setOwnerId] = useState('');
  const load = useCallback(() => {
    api<{ data: { lead: Rec; activities: Rec[]; opportunities: Rec[] } }>(`/api/ops/crm/leads/${id}`)
      .then((r) => setDoc(r.data))
      .catch((e) => setError(e instanceof Error ? e.message : 'Lead failed'));
  }, [id]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    api<{ data: Rec[] }>('/api/ops/crm/owners').then((r) => setOwners(r.data ?? [])).catch(() => undefined);
  }, []);
  if (error && !doc) return <ErrorBanner error={error} />;
  if (!doc) return <PageLoader label="Opening lead…" />;
  const lead = doc.lead;
  const score = Number((lead.attributes as Rec | undefined)?.score ?? 0);
  const act = async (path: string, body: Rec = {}, ok = 'Done') => {
    setBusy(true); setError(''); setNotice('');
    try {
      const r = await api<{ data: Rec }>(path, { method: 'POST', body: JSON.stringify(body) });
      if (r.data.customerId) { navigate(`/crm/customers/${r.data.customerId}`); return; }
      setNotice(ok);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <button className="btn btn-sm" onClick={() => navigate('/crm/leads')}>Back</button>
          <h1>Lead <span className="cell-mono">{String(lead.leadNo)}</span></h1>
          <p className="muted">{String(lead.companyName || `${lead.firstName ?? ''} ${lead.lastName ?? ''}`.trim())} · {String(lead.source)} · score {fmtNum(score)}</p>
        </div>
        <Badge value={lead.status} />
      </header>
      {notice && <div className="alert alert-success">{notice}</div>}
      {error && <ErrorBanner error={error} />}
      <div className="flow-actions" style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
        {String(lead.status) === 'NEW' && can(user, 'crm.leads.update') && (
          <button className="btn" disabled={busy} onClick={() => act(`/api/ops/crm/leads/${id}/contact`, {}, 'Marked contacted')}>Mark contacted</button>
        )}
        {['NEW', 'CONTACTED'].includes(String(lead.status)) && can(user, 'crm.leads.update') && (
          <button className="btn" disabled={busy} onClick={() => act(`/api/ops/crm/leads/${id}/qualify`, {}, 'Qualified')}>Qualify</button>
        )}
        {!['CONVERTED', 'DISQUALIFIED', 'LOST'].includes(String(lead.status)) && can(user, 'crm.leads.convert') && (
          <button className="btn btn-primary" disabled={busy} onClick={() => act(`/api/ops/crm/leads/${id}/convert`, { createOpportunity: true }, 'Converted')}>Convert to account</button>
        )}
        {['NEW', 'CONTACTED', 'QUALIFIED'].includes(String(lead.status)) && can(user, 'crm.leads.update') && (
          <>
            <input className="cell-input" placeholder="Disqualify reason" value={reason} onChange={(e) => setReason(e.target.value)} />
            <button className="btn btn-warning" disabled={busy} onClick={() => act(`/api/ops/crm/leads/${id}/disqualify`, { reason: reason || 'Not a fit' }, 'Disqualified')}>Disqualify</button>
          </>
        )}
        {can(user, 'crm.leads.assign') && (
          <>
            <OwnerPicker value={ownerId} onChange={setOwnerId} owners={owners} />
            <button className="btn btn-sm" disabled={busy || !ownerId} onClick={() => act(`/api/ops/crm/leads/${id}/assign`, { userId: Number(ownerId) }, 'Assigned')}>Assign</button>
          </>
        )}
      </div>
      {doc.activities.length > 0 && (
        <section className="card">
          <div className="card-head"><h3>Activity</h3></div>
          <ul className="timeline">
            {doc.activities.map((a) => (
              <li key={String(a.id)}>
                <span className="muted">{a.createdAt ? String(a.createdAt).slice(0, 10) : '—'}</span>
                <span>{String(a.activityType)}</span>
                <span>{String(a.subject)}</span>
                <Badge value={a.done ? 'DONE' : 'OPEN'} />
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function LeadComposer() {
  const [companyName, setCompanyName] = useState('');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [phone, setPhone] = useState('');
  const [value, setValue] = useState('0');
  const [source, setSource] = useState('REFERRAL');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true); setError('');
    try {
      const r = await api<{ data: { leadId: number } }>('/api/ops/crm/leads', {
        method: 'POST',
        body: JSON.stringify({ companyName, firstName, lastName, phone, value: Number(value) || 0, source }),
      });
      navigate(`/crm/leads/${r.data.leadId}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <button className="btn btn-sm" onClick={() => navigate('/crm/leads')}>Back</button>
          <h1>New lead</h1>
        </div>
      </header>
      {error && <ErrorBanner error={error} />}
      <section className="card card-pad">
        <div className="form-grid">
          <div className="field" style={{ gridColumn: '1 / -1' }}><label>Company</label><input value={companyName} onChange={(e) => setCompanyName(e.target.value)} /></div>
          <div className="field"><label>First name</label><input value={firstName} onChange={(e) => setFirstName(e.target.value)} /></div>
          <div className="field"><label>Last name</label><input value={lastName} onChange={(e) => setLastName(e.target.value)} /></div>
          <div className="field"><label>Phone</label><input value={phone} onChange={(e) => setPhone(e.target.value)} /></div>
          <div className="field"><label>Expected value</label><input inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} /></div>
          <div className="field">
            <label>Source</label>
            <select value={source} onChange={(e) => setSource(e.target.value)}>
              {['REFERRAL', 'WALK_IN', 'WEBSITE', 'COLD_CALL', 'TRADE_SHOW', 'EXISTING', 'OTHER'].map((s) => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}
            </select>
          </div>
        </div>
        <button className="btn btn-primary" style={{ marginTop: 16 }} disabled={busy} onClick={save}>Save lead</button>
      </section>
    </div>
  );
}

function Pipeline() {
  const [data, setData] = useState<{ columns: { stage: string; rows: Rec[]; total: number }[]; weighted: number } | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(() => {
    api<{ data: { columns: { stage: string; rows: Rec[]; total: number }[]; weighted: number } }>('/api/ops/crm/pipeline')
      .then((r) => setData(r.data))
      .catch((e) => setError(e instanceof Error ? e.message : 'Pipeline failed'));
  }, []);
  useEffect(() => { load(); }, [load]);
  if (error && !data) return <ErrorBanner error={error} />;
  if (!data) return <PageLoader label="Opening pipeline…" />;
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="mod-kicker" data-mod="crm">Pipeline</p>
          <h1>Open opportunities</h1>
          <p className="muted">Weighted {fmtMoney(data.weighted)}. Drag is not used — open a card and move the stage.</p>
        </div>
        <button className="btn btn-primary" onClick={() => navigate('/crm/opportunities/new')}>New opportunity</button>
      </header>
      <div className="pipe">
        {data.columns.map((col) => (
          <div key={col.stage} className="pipe-col">
            <header>
              <strong>{col.stage.replace(/_/g, ' ')}</strong>
              <span className="muted">{fmtMoney(col.total)}</span>
            </header>
            {col.rows.map((r) => (
              <button key={String(r.id)} className="pipe-card" onClick={() => navigate(`/crm/opportunities/${r.id}`)}>
                <strong>{String(r.name)}</strong>
                <span className="muted">{String(r.customerName ?? '—')}</span>
                <span className="cell-mono">{fmtMoney(r.amount)} · {fmtNum(r.probability)}%</span>
              </button>
            ))}
            {col.rows.length === 0 && <p className="muted" style={{ padding: '8px 4px' }}>Empty</p>}
          </div>
        ))}
      </div>
    </div>
  );
}

function OppDesk({ id }: { id: number }) {
  const { user } = useAuth();
  const [doc, setDoc] = useState<{ opportunity: Rec; quotations: Rec[]; credit: Rec | null } | null>(null);
  const [products, setProducts] = useState<Rec[]>([]);
  const [productId, setProductId] = useState('');
  const [qty, setQty] = useState('1');
  const [price, setPrice] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    api<{ data: { opportunity: Rec; quotations: Rec[]; credit: Rec | null } }>(`/api/ops/crm/opportunities/${id}`)
      .then((r) => setDoc(r.data))
      .catch((e) => setError(e instanceof Error ? e.message : 'Opportunity failed'));
  }, [id]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    api<{ data: Rec[] }>('/api/ops/crm/products').then((r) => setProducts(r.data ?? [])).catch(() => undefined);
  }, []);
  if (error && !doc) return <ErrorBanner error={error} />;
  if (!doc) return <PageLoader label="Opening opportunity…" />;
  const o = doc.opportunity;
  const act = async (path: string, body: Rec = {}, ok = 'Done') => {
    setBusy(true); setError(''); setNotice('');
    try {
      const r = await api<{ data: Rec }>(path, { method: 'POST', body: JSON.stringify(body) });
      if (r.data.quotationId) { navigate(`/sales/quotations/${r.data.quotationId}`); return; }
      setNotice(ok);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };
  const stages = ['PROSPECTING', 'QUALIFICATION', 'NEEDS_ANALYSIS', 'VALUE_PROPOSITION', 'NEGOTIATION'];
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <button className="btn btn-sm" onClick={() => navigate('/crm/pipeline')}>Back</button>
          <h1>{String(o.name)}</h1>
          <p className="muted">
            <button className="linkish" onClick={() => o.customerId && navigate(`/crm/customers/${o.customerId}`)}>{String(o.customerName ?? 'No account')}</button>
            {' · '}{fmtMoney(o.amount)} · {fmtNum(o.probability)}%
          </p>
        </div>
        <Badge value={o.stage} />
      </header>
      {notice && <div className="alert alert-success">{notice}</div>}
      {error && <ErrorBanner error={error} />}
      {doc.credit && !doc.credit.ok && (
        <div className="alert alert-error">Credit hold: {String(doc.credit.reason)}. Quoting is blocked.</div>
      )}
      {String(o.status) === 'ON_HOLD' && (
        <div className="alert alert-error">This opportunity is on hold. Resume it before quoting.</div>
      )}
      {['OPEN', 'ON_HOLD'].includes(String(o.status)) && (
        <div className="flow-actions" style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
          {String(o.status) === 'OPEN' && stages.map((s) => (
            <button key={s} className="btn btn-sm" disabled={busy || s === String(o.stage)} onClick={() => act(`/api/ops/crm/opportunities/${id}/move`, { stage: s }, s.replace(/_/g, ' '))}>{s.replace(/_/g, ' ')}</button>
          ))}
          {String(o.status) === 'OPEN' && can(user, 'crm.opportunities.win') && <button className="btn btn-success" disabled={busy} onClick={() => act(`/api/ops/crm/opportunities/${id}/win`, {}, 'Won')}>Win</button>}
          {String(o.status) === 'OPEN' && can(user, 'crm.opportunities.lose') && <button className="btn btn-warning" disabled={busy} onClick={() => act(`/api/ops/crm/opportunities/${id}/lose`, { reason: 'Lost on desk' }, 'Lost')}>Lose</button>}
          {String(o.status) === 'OPEN' && can(user, 'crm.opportunities.update') && (
            <button className="btn" disabled={busy} onClick={() => act(`/api/ops/crm/opportunities/${id}/hold`, { reason: 'Held on desk' }, 'On hold')}>Hold</button>
          )}
          {String(o.status) === 'ON_HOLD' && can(user, 'crm.opportunities.update') && (
            <button className="btn btn-primary" disabled={busy} onClick={() => act(`/api/ops/crm/opportunities/${id}/resume`, {}, 'Resumed')}>Resume</button>
          )}
          {can(user, 'crm.opportunities.assign') && <AssignInline entity="opportunities" id={id} onDone={load} />}
        </div>
      )}
      {can(user, 'sales.quotations.create') && String(o.status) !== 'LOST' && String(o.status) !== 'ON_HOLD' && (!doc.credit || Boolean(doc.credit.ok)) && (
        <section className="card card-pad">
          <h3>Quote this opportunity</h3>
          <div className="form-grid" style={{ marginTop: 12 }}>
            <div className="field field-required">
              <label>Product</label>
              <select value={productId} onChange={(e) => {
                setProductId(e.target.value);
                const p = products.find((x) => String(x.id) === e.target.value);
                if (p && !price) setPrice(String(p.standardPrice ?? p.standard_price ?? ''));
              }}>
                <option value="">Select…</option>
                {products.map((p) => <option key={String(p.id)} value={String(p.id)}>{String(p.code)} · {String(p.name)} · ATP {fmtNum(p.availableQty)}</option>)}
              </select>
            </div>
            <div className="field"><label>Qty</label><input inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value)} /></div>
            <div className="field"><label>Unit price</label><input inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} /></div>
          </div>
          <button className="btn btn-primary" style={{ marginTop: 12 }} disabled={busy || !productId || !price} onClick={() => act(`/api/ops/crm/opportunities/${id}/quote`, {
            items: [{ productId: Number(productId), quantity: Number(qty), unitPrice: Number(price) }],
          })}>Create quotation</button>
        </section>
      )}
      <section className="card">
        <div className="card-head"><h3>Quotations</h3></div>
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>Quote</th><th>Status</th><th className="cell-num">Total</th></tr></thead>
            <tbody>
              {doc.quotations.map((q) => (
                <tr key={String(q.id)} className="row-click" onClick={() => navigate(`/sales/quotations/${q.id}`)}>
                  <td className="cell-mono">{String(q.quotationNo)}</td>
                  <td><Badge value={q.status} /></td>
                  <td className="cell-num">{fmtMoney(q.total)}</td>
                </tr>
              ))}
              {doc.quotations.length === 0 && <tr><td colSpan={3} className="muted" style={{ padding: 16 }}>No quotations yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function OppComposer() {
  const [customers, setCustomers] = useState<Rec[]>([]);
  const [customerId, setCustomerId] = useState('');
  const [name, setName] = useState('');
  const [amount, setAmount] = useState('0');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const preset = new URLSearchParams(window.location.hash.split('?')[1] ?? '').get('customer');
    if (preset) setCustomerId(preset);
    api<{ data: { rows: Rec[] } }>('/api/ops/crm/customers?pageSize=80')
      .then((r) => setCustomers(r.data.rows ?? []))
      .catch(() => undefined);
  }, []);
  const save = async () => {
    if (!customerId || !name.trim()) { setError('Account and name are required'); return; }
    setBusy(true); setError('');
    try {
      const r = await api<{ data: { opportunityId: number } }>('/api/ops/crm/opportunities', {
        method: 'POST',
        body: JSON.stringify({ customerId: Number(customerId), name, amount: Number(amount) || 0 }),
      });
      navigate(`/crm/opportunities/${r.data.opportunityId}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <button className="btn btn-sm" onClick={() => navigate('/crm/pipeline')}>Back</button>
          <h1>New opportunity</h1>
        </div>
      </header>
      {error && <ErrorBanner error={error} />}
      <section className="card card-pad">
        <div className="form-grid">
          <div className="field field-required">
            <label>Account</label>
            <select value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
              <option value="">Select…</option>
              {customers.map((c) => <option key={String(c.id)} value={String(c.id)}>{String(c.code)} · {String(c.name)}</option>)}
            </select>
          </div>
          <div className="field field-required"><label>Name</label><input value={name} onChange={(e) => setName(e.target.value)} /></div>
          <div className="field"><label>Amount</label><input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} /></div>
        </div>
        <button className="btn btn-primary" style={{ marginTop: 16 }} disabled={busy} onClick={save}>Save</button>
      </section>
    </div>
  );
}

function ActivityList() {
  const [rows, setRows] = useState<Rec[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    api<{ data: Rec[] }>('/api/ops/crm/activities?open=1')
      .then((r) => setRows(r.data ?? []))
      .catch((e) => setError(e instanceof Error ? e.message : 'Activities failed'));
  }, []);
  useEffect(() => { load(); }, [load]);
  const done = async (id: number) => {
    setBusy(true);
    try {
      await api(`/api/ops/crm/activities/${id}/complete`, { method: 'POST', body: '{}' });
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="mod-kicker" data-mod="crm">Activities</p>
          <h1>Open follow-ups</h1>
        </div>
      </header>
      {error && <ErrorBanner error={error} />}
      <div className="table-wrap card">
        <table className="data">
          <thead><tr><th>Type</th><th>Subject</th><th>On</th><th>Due</th><th /></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={String(r.id)}>
                <td>{String(r.activityType)}</td>
                <td>{String(r.subject)}</td>
                <td className="cell-mono">{String(r.entityType)} #{String(r.entityId)}</td>
                <td>{r.dueAt ? String(r.dueAt).slice(0, 16).replace('T', ' ') : '—'}</td>
                <td><button className="btn btn-sm" disabled={busy} onClick={() => done(Number(r.id))}>Done</button></td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={5} className="muted" style={{ textAlign: 'center', padding: 24 }}>Nothing open.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ComplaintList() {
  const [rows, setRows] = useState<Rec[]>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    api<{ data: Rec[] }>('/api/ops/crm/complaints').then((r) => setRows(r.data ?? [])).catch((e) => setError(e instanceof Error ? e.message : 'Complaints failed'));
  }, []);
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="mod-kicker" data-mod="crm">Service</p>
          <h1>Complaints</h1>
        </div>
      </header>
      {error && <ErrorBanner error={error} />}
      <div className="table-wrap card">
        <table className="data">
          <thead><tr><th>No</th><th>Account</th><th>Subject</th><th>Priority</th><th>Status</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={String(r.id)} className="row-click" onClick={() => navigate(`/crm/complaints/${r.id}`)}>
                <td className="cell-mono">{String(r.complaintNo)}</td>
                <td>{String(r.customerName)}</td>
                <td>{String(r.subject)}</td>
                <td><Badge value={r.priority} /></td>
                <td><Badge value={r.status} /></td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={5} className="muted" style={{ textAlign: 'center', padding: 24 }}>No complaints.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ComplaintDesk({ id }: { id: number }) {
  const { user } = useAuth();
  const [doc, setDoc] = useState<{ complaint: Rec } | null>(null);
  const [error, setError] = useState('');
  const [resolution, setResolution] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    api<{ data: { complaint: Rec } }>(`/api/ops/crm/complaints/${id}`)
      .then((r) => setDoc(r.data))
      .catch((e) => setError(e instanceof Error ? e.message : 'Complaint failed'));
  }, [id]);
  useEffect(() => { load(); }, [load]);
  if (error && !doc) return <ErrorBanner error={error} />;
  if (!doc) return <PageLoader label="Opening complaint…" />;
  const c = doc.complaint;
  const act = async (path: string, body: Rec = {}) => {
    setBusy(true); setError('');
    try {
      await api(path, { method: 'POST', body: JSON.stringify(body) });
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <button className="btn btn-sm" onClick={() => navigate('/crm/complaints')}>Back</button>
          <h1>Complaint <span className="cell-mono">{String(c.complaintNo)}</span></h1>
          <p className="muted">{String(c.customerName)} · {String(c.subject)}</p>
        </div>
        <Badge value={c.status} />
      </header>
      {error && <ErrorBanner error={error} />}
      {['OPEN', 'IN_PROGRESS', 'ESCALATED'].includes(String(c.status)) && (
        <div className="flow-actions" style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
          {can(user, 'crm.complaints.escalate') && String(c.status) !== 'ESCALATED' && (
            <button className="btn btn-warning" disabled={busy} onClick={() => act(`/api/ops/crm/complaints/${id}/escalate`)}>Escalate</button>
          )}
          {can(user, 'crm.complaints.resolve') && (
            <>
              <input className="cell-input" style={{ minWidth: 240 }} placeholder="Resolution" value={resolution} onChange={(e) => setResolution(e.target.value)} />
              <button className="btn btn-success" disabled={busy || !resolution} onClick={() => act(`/api/ops/crm/complaints/${id}/resolve`, { resolution })}>Resolve</button>
            </>
          )}
        </div>
      )}
      {c.resolution != null && <section className="card card-pad"><p>{String(c.resolution)}</p></section>}
      {c.customerId != null && (
        <button className="btn" onClick={() => navigate(`/crm/customers/${c.customerId}`)}>Open account 360</button>
      )}
    </div>
  );
}

function MyDesk() {
  const [data, setData] = useState<Rec | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    api<{ data: Rec }>('/api/ops/crm/mine')
      .then((r) => setData(r.data))
      .catch((e) => setError(e instanceof Error ? e.message : 'My desk failed'));
  }, []);
  if (error && !data) return <ErrorBanner error={error} />;
  if (!data) return <PageLoader label="Opening your desk…" />;
  const kpis = (data.kpis ?? {}) as Rec;
  const leads = (data.leads as Rec[]) ?? [];
  const opps = (data.opportunities as Rec[]) ?? [];
  const acts = (data.activities as Rec[]) ?? [];
  const complaints = (data.complaints as Rec[]) ?? [];
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="mod-kicker" data-mod="crm">My desk</p>
          <h1>Assigned work</h1>
          <p className="muted">Leads, opportunities, follow-ups, and complaints owned by you.</p>
        </div>
      </header>
      <div className="kpi-grid">
        <div className="kpi-card"><span className="kpi-label">My leads</span><span className="kpi-value">{fmtNum(kpis.myLeads)}</span></div>
        <div className="kpi-card"><span className="kpi-label">My pipeline</span><span className="kpi-value">{fmtNum(kpis.myOpps)}</span></div>
        <div className="kpi-card"><span className="kpi-label">Follow-ups</span><span className="kpi-value">{fmtNum(kpis.myFollowUps)}</span></div>
        <div className="kpi-card"><span className="kpi-label">Complaints</span><span className="kpi-value">{fmtNum(kpis.myComplaints)}</span></div>
      </div>
      <section className="card">
        <div className="card-head"><h3>Leads</h3></div>
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>Lead</th><th>Name</th><th>Status</th><th className="cell-num">Score</th></tr></thead>
            <tbody>
              {leads.map((r) => (
                <tr key={String(r.id)} className="row-click" onClick={() => navigate(`/crm/leads/${r.id}`)}>
                  <td className="cell-mono">{String(r.leadNo)}</td>
                  <td>{String(r.companyName || `${r.firstName ?? ''} ${r.lastName ?? ''}`.trim() || '—')}</td>
                  <td><Badge value={r.status} /></td>
                  <td className="cell-num">{fmtNum(r.score)}</td>
                </tr>
              ))}
              {leads.length === 0 && <tr><td colSpan={4} className="muted" style={{ padding: 16 }}>Nothing assigned.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
      <section className="card">
        <div className="card-head"><h3>Opportunities</h3></div>
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>Name</th><th>Account</th><th>Stage</th><th className="cell-num">Amount</th></tr></thead>
            <tbody>
              {opps.map((r) => (
                <tr key={String(r.id)} className="row-click" onClick={() => navigate(`/crm/opportunities/${r.id}`)}>
                  <td>{String(r.name)}</td>
                  <td>{String(r.customerName ?? '—')}</td>
                  <td><Badge value={r.stage} /></td>
                  <td className="cell-num">{fmtMoney(r.amount)}</td>
                </tr>
              ))}
              {opps.length === 0 && <tr><td colSpan={4} className="muted" style={{ padding: 16 }}>No open deals.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
      <section className="card">
        <div className="card-head"><h3>Follow-ups</h3></div>
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>Type</th><th>Subject</th><th>Due</th></tr></thead>
            <tbody>
              {acts.map((r) => (
                <tr key={String(r.id)}>
                  <td>{String(r.activityType)}</td>
                  <td>{String(r.subject)}</td>
                  <td>{r.dueAt ? String(r.dueAt).slice(0, 16).replace('T', ' ') : '—'}</td>
                </tr>
              ))}
              {acts.length === 0 && <tr><td colSpan={3} className="muted" style={{ padding: 16 }}>Inbox clear.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
      {complaints.length > 0 && (
        <section className="card">
          <div className="card-head"><h3>Complaints</h3></div>
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>No</th><th>Account</th><th>Priority</th></tr></thead>
              <tbody>
                {complaints.map((r) => (
                  <tr key={String(r.id)} className="row-click" onClick={() => navigate(`/crm/complaints/${r.id}`)}>
                    <td className="cell-mono">{String(r.complaintNo)}</td>
                    <td>{String(r.customerName)}</td>
                    <td><Badge value={r.priority} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}

function CrmAnalytics() {
  const [data, setData] = useState<Rec | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    api<{ data: Rec }>('/api/ops/crm/analytics')
      .then((r) => setData(r.data))
      .catch((e) => setError(e instanceof Error ? e.message : 'Analytics failed'));
  }, []);
  if (error && !data) return <ErrorBanner error={error} />;
  if (!data) return <PageLoader label="Opening analytics…" />;
  const funnel = (data.funnel ?? {}) as Rec;
  const forecast = (data.forecast ?? {}) as Rec;
  const aging = (data.aging ?? {}) as Rec;
  const sources = (data.sources as Rec[]) ?? [];
  const owners = (data.owners as Rec[]) ?? [];
  const stages = (data.stages as Rec[]) ?? [];
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="mod-kicker" data-mod="crm">Analytics</p>
          <h1>Forecast and conversion</h1>
          <p className="muted">Weighted pipeline, win rate, source mix, and AR aging. Figures come from live CRM, sales, and AR — not a sidecar cube.</p>
        </div>
      </header>
      <div className="kpi-grid">
        <div className="kpi-card">
          <span className="kpi-label">Conversion</span>
          <span className="kpi-value">{fmtNum(data.conversionRate)}%</span>
          <span className="kpi-sub">{fmtNum(funnel.leadsConverted)} of {fmtNum(funnel.leadsTotal)} leads</span>
        </div>
        <div className="kpi-card">
          <span className="kpi-label">Win rate</span>
          <span className="kpi-value">{fmtNum(data.winRate)}%</span>
          <span className="kpi-sub">{fmtNum(funnel.oppsWon)} won · {fmtNum(funnel.oppsLost)} lost</span>
        </div>
        <div className="kpi-card">
          <span className="kpi-label">Weighted forecast</span>
          <span className="kpi-value">{fmtMoney(forecast.weighted)}</span>
          <span className="kpi-sub">This month {fmtMoney(forecast.thisMonth)} · next {fmtMoney(forecast.nextMonth)}</span>
        </div>
        <div className="kpi-card">
          <span className="kpi-label">Won value</span>
          <span className="kpi-value">{fmtMoney(funnel.wonValue)}</span>
        </div>
      </div>
      <div className="aging-row" style={{ marginBottom: 16 }}>
        {([
          ['Current', aging.current],
          ['1–30', aging.days130],
          ['31–60', aging.days3160],
          ['61–90', aging.days6190],
          ['90+', aging.days90Plus],
        ] as [string, unknown][]).map(([label, val]) => (
          <div key={label} className="aging-cell">
            <span className="muted">AR {label}</span>
            <strong>{fmtMoney(val)}</strong>
          </div>
        ))}
      </div>
      <section className="card">
        <div className="card-head"><h3>Open pipeline by stage</h3></div>
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>Stage</th><th className="cell-num">Deals</th><th className="cell-num">Amount</th></tr></thead>
            <tbody>
              {stages.map((s) => (
                <tr key={String(s.stage)}>
                  <td>{String(s.stage).replace(/_/g, ' ')}</td>
                  <td className="cell-num">{fmtNum(s.deals)}</td>
                  <td className="cell-num">{fmtMoney(s.amount)}</td>
                </tr>
              ))}
              {stages.length === 0 && <tr><td colSpan={3} className="muted" style={{ padding: 16 }}>No open deals.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
      <section className="card">
        <div className="card-head"><h3>Lead sources</h3></div>
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>Source</th><th className="cell-num">Leads</th><th className="cell-num">Converted</th></tr></thead>
            <tbody>
              {sources.map((s) => (
                <tr key={String(s.source)}>
                  <td>{String(s.source).replace(/_/g, ' ')}</td>
                  <td className="cell-num">{fmtNum(s.leads)}</td>
                  <td className="cell-num">{fmtNum(s.converted)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section className="card">
        <div className="card-head"><h3>Owners</h3></div>
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>Owner</th><th className="cell-num">Open</th><th className="cell-num">Open value</th><th className="cell-num">Won</th></tr></thead>
            <tbody>
              {owners.map((o) => (
                <tr key={String(o.ownerId)}>
                  <td>{String(o.ownerName)}</td>
                  <td className="cell-num">{fmtNum(o.openDeals)}</td>
                  <td className="cell-num">{fmtMoney(o.openValue)}</td>
                  <td className="cell-num">{fmtNum(o.wonDeals)} · {fmtMoney(o.wonValue)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function ContactList() {
  const [rows, setRows] = useState<Rec[]>([]);
  const [q, setQ] = useState('');
  const [error, setError] = useState('');
  const load = useCallback(() => {
    const p = new URLSearchParams();
    if (q.trim()) p.set('q', q.trim());
    api<{ data: Rec[] }>(`/api/ops/crm/contacts?${p}`)
      .then((r) => setRows(r.data ?? []))
      .catch((e) => setError(e instanceof Error ? e.message : 'Contacts failed'));
  }, [q]);
  useEffect(() => { load(); }, [load]);
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="mod-kicker" data-mod="crm">Contacts</p>
          <h1>People on accounts</h1>
        </div>
      </header>
      {error && <ErrorBanner error={error} />}
      <div className="toolbar">
        <input className="search-input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search contact…" />
      </div>
      <div className="table-wrap card">
        <table className="data">
          <thead><tr><th>Name</th><th>Account</th><th>Title</th><th>Phone</th><th>Email</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={String(r.id)} className="row-click" onClick={() => navigate(`/crm/customers/${r.customerId}`)}>
                <td>{String(r.firstName)} {String(r.lastName)} {r.isPrimary ? '· primary' : ''}</td>
                <td>{String(r.customerName)}</td>
                <td>{String(r.title ?? '—')}</td>
                <td>{String(r.phone ?? '—')}</td>
                <td>{String(r.email ?? '—')}</td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={5} className="muted" style={{ textAlign: 'center', padding: 24 }}>No contacts.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
