import { useCallback, useEffect, useState, type ReactNode } from 'react';
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
  let body: ReactNode;
  if (view === 'customers' && id === 'new') body = <CustomerComposer />;
  else if (view === 'customers' && id) body = <CustomerDesk id={Number(id)} />;
  else if (view === 'customers') body = <CustomerList />;
  else if (view === 'leads' && id === 'new') body = <LeadComposer />;
  else if (view === 'leads' && id) body = <LeadDesk id={Number(id)} />;
  else if (view === 'leads') body = <LeadList />;
  else if (view === 'opportunities' && id === 'new') body = <OppComposer />;
  else if (view === 'opportunities' && id) body = <OppDesk id={Number(id)} />;
  else if (view === 'pipeline') body = <Pipeline />;
  else if (view === 'activities') body = <ActivityList />;
  else if (view === 'complaints' && id) body = <ComplaintDesk id={Number(id)} />;
  else if (view === 'complaints') body = <ComplaintList />;
  else if (view === 'contacts') body = <ContactList />;
  else if (view === 'analytics') body = <CrmAnalytics />;
  else if (view === 'mine') body = <MyDesk />;
  else body = <CrmBoard />;
  return <div className="crm-shell">{body}</div>;
}

type CmdAction = { label: string; onClick: () => void; primary?: boolean; danger?: boolean; success?: boolean; disabled?: boolean };

function stageLabel(s: string) {
  return s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function CrmCommandBar({ entity, actions, extra }: { entity: string; actions: CmdAction[]; extra?: ReactNode }) {
  return (
    <div className="crm-cmd" role="toolbar" aria-label={`${entity} commands`}>
      <span className="crm-cmd-entity">{entity}</span>
      {actions.map((a) => (
        <button
          key={a.label}
          type="button"
          className={'crm-cmd-btn' + (a.primary ? ' is-primary' : '') + (a.danger ? ' is-danger' : '') + (a.success ? ' is-success' : '')}
          disabled={a.disabled}
          onClick={a.onClick}
        >{a.label}</button>
      ))}
      {extra ? <div className="crm-cmd-extra">{extra}</div> : null}
    </div>
  );
}

function CrmHighlights({ items }: { items: { label: string; value: ReactNode }[] }) {
  return (
    <dl className="crm-highlights">
      {items.map((it) => (
        <div className="crm-hl" key={it.label}>
          <dt>{it.label}</dt>
          <dd>{it.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function CrmBpf({
  stages,
  current,
  onSelect,
  busy,
}: {
  stages: { id: string; label: string }[];
  current: string;
  onSelect?: (id: string) => void;
  busy?: boolean;
}) {
  const idx = Math.max(0, stages.findIndex((s) => s.id === current));
  return (
    <div className="crm-bpf" role="list" aria-label="Business process">
      {stages.map((s, i) => (
        <button
          key={s.id}
          type="button"
          role="listitem"
          className={'crm-bpf-step' + (s.id === current ? ' is-active' : i < idx ? ' is-done' : '')}
          disabled={busy || !onSelect || s.id === current}
          onClick={() => onSelect?.(s.id)}
        >
          <small>Stage {i + 1}</small>
          {s.label}
        </button>
      ))}
    </div>
  );
}

function CrmTabs({ tabs, active, onChange }: { tabs: string[]; active: string; onChange: (t: string) => void }) {
  return (
    <div className="crm-tabs" role="tablist">
      {tabs.map((t) => (
        <button key={t} type="button" role="tab" aria-selected={t === active} className={'crm-tab' + (t === active ? ' is-active' : '')} onClick={() => onChange(t)}>{t}</button>
      ))}
    </div>
  );
}

function CrmViewBar({ title, view, count, onNew, newLabel, search, onSearch, placeholder }: {
  title: string; view: string; count?: number; onNew?: () => void; newLabel?: string; search?: string; onSearch?: (v: string) => void; placeholder?: string;
}) {
  return (
    <div className="crm-viewbar">
      <div>
        <div className="crm-view-meta">{view}</div>
        <h1>{title}{count != null ? <span className="muted"> · {count}</span> : null}</h1>
      </div>
      <div className="head-actions">
        {onSearch && (
          <input className="search-input" value={search ?? ''} onChange={(e) => onSearch(e.target.value)} placeholder={placeholder ?? 'Filter'} />
        )}
        {onNew && <button className="btn btn-primary" onClick={onNew}>{newLabel ?? 'New'}</button>}
      </div>
    </div>
  );
}

function CrmTimeline({ items }: { items: { at?: unknown; kind?: unknown; label?: unknown; status?: unknown; id?: unknown; activityType?: unknown; subject?: unknown; createdAt?: unknown; done?: unknown }[] }) {
  if (!items.length) return <p className="muted">No timeline posts yet.</p>;
  return (
    <ul className="crm-timeline">
      {items.map((e, i) => (
        <li key={String(e.id ?? `${e.kind}-${i}`)}>
          <span className="muted">{String(e.at ?? e.createdAt ?? '').slice(0, 10) || '—'}</span>
          <span><strong>{String(e.kind ?? e.activityType ?? '')}</strong> {String(e.label ?? e.subject ?? '')}</span>
          {e.status != null || e.done != null ? <Badge value={e.status ?? (e.done ? 'DONE' : 'OPEN')} /> : <span />}
        </li>
      ))}
    </ul>
  );
}

function CrmComposerHead({ entity, title, onCancel, onSave, busy, saveLabel }: {
  entity: string; title: string; onCancel: () => void; onSave: () => void; busy?: boolean; saveLabel?: string;
}) {
  return (
    <>
      <CrmCommandBar
        entity={entity}
        actions={[
          { label: saveLabel ?? 'Save & close', onClick: onSave, primary: true, disabled: busy },
          { label: 'Cancel', onClick: onCancel, disabled: busy },
        ]}
      />
      <div className="crm-form-head">
        <div className="crm-entity-type">New {entity.toLowerCase()}</div>
        <div className="crm-form-title"><h1>{title}</h1></div>
      </div>
    </>
  );
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
      <CrmCommandBar
        entity="Sales hub"
        actions={[
          ...(can(user, 'crm.leads.create') ? [{ label: 'New lead', onClick: () => navigate('/crm/leads/new') }] : []),
          ...(can(user, 'crm.customers.create') ? [{ label: 'New account', onClick: () => navigate('/crm/customers/new'), primary: true }] : []),
          ...(can(user, 'crm.activities.view') ? [{ label: 'My work', onClick: () => navigate('/crm/mine') }] : []),
          { label: 'Pipeline', onClick: () => navigate('/crm/pipeline') },
          { label: 'Dashboards', onClick: () => navigate('/crm/analytics') },
        ]}
      />
      <CrmViewBar title="Sales hub" view="Home" />
      <div className="crm-insight">
        <button className="crm-insight-card" onClick={() => navigate('/crm/leads')}>
          <span className="k">Open leads</span>
          <span className="v">{fmtNum(kpis.openLeads)}</span>
          <span className="s">Qualify and convert</span>
        </button>
        <button className="crm-insight-card" onClick={() => navigate('/crm/pipeline')}>
          <span className="k">Open pipeline</span>
          <span className="v">{fmtMoney(kpis.pipeline)}</span>
          <span className="s">{fmtNum(kpis.openOpps)} deals · weighted {fmtMoney(kpis.weighted)}</span>
        </button>
        <button className="crm-insight-card" onClick={() => navigate('/crm/analytics')}>
          <span className="k">Open AR</span>
          <span className="v">{fmtMoney(kpis.openAr)}</span>
          <span className="s">{fmtNum(kpis.blockedAccounts)} blocked · {fmtNum(kpis.heldOpps)} on hold</span>
        </button>
        <button className="crm-insight-card" onClick={() => navigate('/crm/activities')}>
          <span className="k">Overdue activities</span>
          <span className="v">{fmtNum(kpis.overdue)}</span>
          <span className="s">Follow-ups due</span>
        </button>
        <button className="crm-insight-card" onClick={() => navigate('/crm/complaints')}>
          <span className="k">Active cases</span>
          <span className="v">{fmtNum(kpis.openComplaints)}</span>
          <span className="s">Customer service</span>
        </button>
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
      <CrmCommandBar entity="Account" actions={[{ label: 'New', onClick: () => navigate('/crm/customers/new'), primary: true }]} />
      <CrmViewBar title="Accounts" view="All accounts" count={rows.length} search={q} onSearch={setQ} placeholder="Filter accounts" onNew={() => navigate('/crm/customers/new')} newLabel="New" />
      {error && <ErrorBanner error={error} />}
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
  const [tab, setTab] = useState('Summary');
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
      <CrmCommandBar
        entity="Account"
        actions={[
          { label: 'Save', onClick: () => setNotice('No pending edits'), disabled: busy },
          ...(can(user, 'crm.opportunities.create') && String(c.status) !== 'BLOCKED' ? [{ label: 'New opportunity', onClick: () => navigate(`/crm/opportunities/new?customer=${id}`), primary: true }] : []),
          ...(Boolean(credit.ok) ? [{ label: 'New quote', onClick: () => navigate(`/sales/quotations/new?customer=${id}`) }] : []),
          { label: 'AR ledger', onClick: () => navigate('/finance/ar') },
          ...(can(user, 'crm.customers.block') && String(c.status) !== 'BLOCKED' ? [{ label: 'Deactivate', onClick: () => act(`/api/ops/crm/customers/${id}/status`, { status: 'BLOCKED', reason: blockReason || 'Credit / compliance hold' }, 'Account blocked'), danger: true, disabled: busy }] : []),
          ...(can(user, 'crm.customers.block') && String(c.status) === 'BLOCKED' ? [{ label: 'Activate', onClick: () => act(`/api/ops/crm/customers/${id}/status`, { status: 'ACTIVE', reason: 'Released from hold' }, 'Account released'), disabled: busy }] : []),
        ]}
        extra={(
          <>
            {can(user, 'crm.customers.update') && (
              <>
                <OwnerPicker value={ownerId} onChange={setOwnerId} owners={owners} />
                <button className="crm-cmd-btn" disabled={busy || !ownerId} onClick={() => act(`/api/ops/crm/customers/${id}/assign`, { userId: Number(ownerId) }, 'Owner assigned')}>Assign</button>
              </>
            )}
            {can(user, 'crm.customers.block') && String(c.status) !== 'BLOCKED' && (
              <input className="cell-input" placeholder="Deactivate reason" value={blockReason} onChange={(e) => setBlockReason(e.target.value)} />
            )}
          </>
        )}
      />
      <div className="crm-form-head">
        <div className="crm-entity-type">Account</div>
        <div className="crm-form-title">
          <h1>{String(c.name)} <span className="cell-mono muted">{String(c.code)}</span></h1>
          <Badge value={c.status} />
        </div>
        <CrmHighlights items={[
          { label: 'Owner', value: String(c.ownerName || 'Unassigned') },
          { label: 'Status', value: String(c.status) },
          { label: 'Credit', value: credit.ok ? 'OK' : String(credit.reason ?? 'Hold') },
          { label: 'Open AR', value: fmtMoney(credit.openAr) },
          { label: 'Payment terms', value: `${fmtNum(c.paymentTermsDays)} days` },
          { label: 'Health', value: <HealthMeter health={health} /> },
        ]} />
      </div>
      {notice && <div className="alert alert-success">{notice}</div>}
      {error && <ErrorBanner error={error} />}
      {!credit.ok && <div className="alert alert-error">Credit hold: {String(credit.reason)}. Quoting and new orders are blocked.</div>}
      <CrmTabs tabs={['Summary', 'Contacts', 'Sales', 'Timeline']} active={tab} onChange={setTab} />
      {tab === 'Summary' && (
        <div className="crm-split">
          <div>
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
            <section className="card">
              <div className="card-head"><h3>Related opportunities</h3></div>
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
          </div>
          <aside>
            <section className="card">
              <div className="card-head"><h3>Recent activity</h3></div>
              <div className="card-pad">
                <CrmTimeline items={timeline.slice(0, 8)} />
              </div>
            </section>
            {can(user, 'crm.complaints.create') && (
              <section className="card card-pad">
                <h3>Open a case</h3>
                <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
                  <input className="cell-input" style={{ flex: 1, minWidth: 140 }} placeholder="Subject" value={subject} onChange={(e) => setSubject(e.target.value)} />
                  <button className="btn btn-sm" disabled={busy || !subject} onClick={() => act('/api/ops/crm/complaints', { customerId: id, subject }, 'Case opened')}>Log</button>
                </div>
              </section>
            )}
          </aside>
        </div>
      )}
      {tab === 'Contacts' && (
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
                {((doc.contacts as Rec[]) ?? []).length === 0 && <tr><td colSpan={4} className="muted" style={{ padding: 16 }}>No contacts on this account.</td></tr>}
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
      )}
      {tab === 'Sales' && (
        <>
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
            <div className="card-head"><h3>Quotations</h3></div>
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
        </>
      )}
      {tab === 'Timeline' && (
        <section className="card">
          <div className="card-head"><h3>Timeline</h3></div>
          <div className="card-pad">
            <CrmTimeline items={timeline} />
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
      <CrmComposerHead entity="Account" title="New account" onCancel={() => navigate('/crm/customers')} onSave={save} busy={busy} saveLabel="Save & close" />
      {error && <ErrorBanner error={error} />}
      <section className="crm-quick-create">
        <div className="form-grid">
          <div className="field field-required" style={{ gridColumn: '1 / -1' }}><label>Account name</label><input value={name} onChange={(e) => setName(e.target.value)} /></div>
          <div className="field"><label>Phone</label><input value={phone} onChange={(e) => setPhone(e.target.value)} /></div>
          <div className="field"><label>Email</label><input value={email} onChange={(e) => setEmail(e.target.value)} /></div>
          <div className="field"><label>Credit limit</label><input inputMode="decimal" value={limit} onChange={(e) => setLimit(e.target.value)} /></div>
        </div>
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
      <CrmCommandBar entity="Lead" actions={[{ label: 'New', onClick: () => navigate('/crm/leads/new'), primary: true }]} />
      <CrmViewBar title="Leads" view="All leads" count={rows.length} search={q} onSearch={setQ} placeholder="Filter leads" onNew={() => navigate('/crm/leads/new')} newLabel="New" />
      {error && <ErrorBanner error={error} />}
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
  const [tab, setTab] = useState('Summary');
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
  const score = Number((lead.attributes as Rec | undefined)?.score ?? lead.score ?? 0);
  const status = String(lead.status);
  const open = !['CONVERTED', 'DISQUALIFIED', 'LOST'].includes(status);
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
  const bpfCurrent = ['NEW', 'CONTACTED', 'QUALIFIED', 'CONVERTED'].includes(status) ? status : 'NEW';
  const onBpf = open && can(user, 'crm.leads.update') ? (s: string) => {
    if (s === 'CONTACTED') act(`/api/ops/crm/leads/${id}/contact`, {}, 'Marked contacted');
    else if (s === 'QUALIFIED') act(`/api/ops/crm/leads/${id}/qualify`, {}, 'Qualified');
    else if (s === 'CONVERTED' && can(user, 'crm.leads.convert')) act(`/api/ops/crm/leads/${id}/convert`, { createOpportunity: true }, 'Converted');
  } : undefined;
  const title = String(lead.companyName || `${lead.firstName ?? ''} ${lead.lastName ?? ''}`.trim() || lead.leadNo);
  return (
    <div className="page">
      <CrmCommandBar
        entity="Lead"
        actions={[
          ...(status === 'NEW' && can(user, 'crm.leads.update') ? [{ label: 'Mark contacted', onClick: () => act(`/api/ops/crm/leads/${id}/contact`, {}, 'Marked contacted'), disabled: busy }] : []),
          ...(['NEW', 'CONTACTED'].includes(status) && can(user, 'crm.leads.update') ? [{ label: 'Qualify', onClick: () => act(`/api/ops/crm/leads/${id}/qualify`, {}, 'Qualified'), disabled: busy }] : []),
          ...(open && can(user, 'crm.leads.convert') ? [{ label: 'Qualify & convert', onClick: () => act(`/api/ops/crm/leads/${id}/convert`, { createOpportunity: true }, 'Converted'), primary: true, disabled: busy }] : []),
          ...(open && can(user, 'crm.leads.update') ? [{ label: 'Disqualify', onClick: () => act(`/api/ops/crm/leads/${id}/disqualify`, { reason: reason || 'Not a fit' }, 'Disqualified'), danger: true, disabled: busy }] : []),
        ]}
        extra={(
          <>
            {open && can(user, 'crm.leads.update') && (
              <input className="cell-input" placeholder="Disqualify reason" value={reason} onChange={(e) => setReason(e.target.value)} />
            )}
            {can(user, 'crm.leads.assign') && (
              <>
                <OwnerPicker value={ownerId} onChange={setOwnerId} owners={owners} />
                <button className="crm-cmd-btn" disabled={busy || !ownerId} onClick={() => act(`/api/ops/crm/leads/${id}/assign`, { userId: Number(ownerId) }, 'Assigned')}>Assign</button>
              </>
            )}
          </>
        )}
      />
      <div className="crm-form-head">
        <div className="crm-entity-type">Lead</div>
        <div className="crm-form-title">
          <h1>{title} <span className="cell-mono muted">{String(lead.leadNo)}</span></h1>
          <Badge value={lead.status} />
        </div>
        <CrmHighlights items={[
          { label: 'Topic', value: title },
          { label: 'Source', value: stageLabel(String(lead.source ?? '—')) },
          { label: 'Rating / score', value: fmtNum(score) },
          { label: 'Est. value', value: fmtMoney(lead.value) },
          { label: 'Phone', value: String(lead.phone ?? '—') },
          { label: 'Owner', value: String(lead.ownerName || 'Unassigned') },
        ]} />
      </div>
      <CrmBpf
        stages={[
          { id: 'NEW', label: 'New' },
          { id: 'CONTACTED', label: 'Contact' },
          { id: 'QUALIFIED', label: 'Qualify' },
          { id: 'CONVERTED', label: 'Convert' },
        ]}
        current={bpfCurrent}
        onSelect={onBpf}
        busy={busy}
      />
      {notice && <div className="alert alert-success">{notice}</div>}
      {error && <ErrorBanner error={error} />}
      {status === 'DISQUALIFIED' && <div className="alert alert-error">This lead was disqualified.</div>}
      <CrmTabs tabs={['Summary', 'Timeline']} active={tab} onChange={setTab} />
      {tab === 'Summary' && (
        <div className="crm-split">
          <div>
            <section className="card card-pad">
              <h3>Lead details</h3>
              <dl className="crm-highlights" style={{ marginTop: 12 }}>
                <div className="crm-hl"><dt>Company</dt><dd>{String(lead.companyName ?? '—')}</dd></div>
                <div className="crm-hl"><dt>Contact</dt><dd>{`${lead.firstName ?? ''} ${lead.lastName ?? ''}`.trim() || '—'}</dd></div>
                <div className="crm-hl"><dt>Phone</dt><dd>{String(lead.phone ?? '—')}</dd></div>
                <div className="crm-hl"><dt>Email</dt><dd>{String(lead.email ?? '—')}</dd></div>
              </dl>
            </section>
            {doc.opportunities.length > 0 && (
              <section className="card">
                <div className="card-head"><h3>Opportunities</h3></div>
                <div className="table-wrap">
                  <table className="data">
                    <thead><tr><th>Name</th><th>Stage</th><th className="cell-num">Amount</th></tr></thead>
                    <tbody>
                      {doc.opportunities.map((o) => (
                        <tr key={String(o.id)} className="row-click" onClick={() => navigate(`/crm/opportunities/${o.id}`)}>
                          <td>{String(o.name)}</td>
                          <td><Badge value={o.stage} /></td>
                          <td className="cell-num">{fmtMoney(o.amount)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            )}
          </div>
          <aside>
            <section className="card">
              <div className="card-head"><h3>Timeline</h3></div>
              <div className="card-pad">
                <CrmTimeline items={doc.activities} />
              </div>
            </section>
          </aside>
        </div>
      )}
      {tab === 'Timeline' && (
        <section className="card">
          <div className="card-head"><h3>Timeline</h3></div>
          <div className="card-pad">
            <CrmTimeline items={doc.activities} />
          </div>
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
      <CrmComposerHead entity="Lead" title="New lead" onCancel={() => navigate('/crm/leads')} onSave={save} busy={busy} />
      {error && <ErrorBanner error={error} />}
      <section className="crm-quick-create">
        <div className="form-grid">
          <div className="field" style={{ gridColumn: '1 / -1' }}><label>Topic / company</label><input value={companyName} onChange={(e) => setCompanyName(e.target.value)} /></div>
          <div className="field"><label>First name</label><input value={firstName} onChange={(e) => setFirstName(e.target.value)} /></div>
          <div className="field"><label>Last name</label><input value={lastName} onChange={(e) => setLastName(e.target.value)} /></div>
          <div className="field"><label>Phone</label><input value={phone} onChange={(e) => setPhone(e.target.value)} /></div>
          <div className="field"><label>Est. value</label><input inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} /></div>
          <div className="field">
            <label>Lead source</label>
            <select value={source} onChange={(e) => setSource(e.target.value)}>
              {['REFERRAL', 'WALK_IN', 'WEBSITE', 'COLD_CALL', 'TRADE_SHOW', 'EXISTING', 'OTHER'].map((s) => <option key={s} value={s}>{stageLabel(s)}</option>)}
            </select>
          </div>
        </div>
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
      <CrmCommandBar
        entity="Opportunity"
        actions={[
          { label: 'New', onClick: () => navigate('/crm/opportunities/new'), primary: true },
          { label: 'Sales hub', onClick: () => navigate('/crm') },
        ]}
      />
      <CrmViewBar title="Opportunity pipeline" view="Open opportunities" />
      <p className="muted" style={{ margin: '-4px 0 12px' }}>Weighted forecast {fmtMoney(data.weighted)}. Open a card to move the business process.</p>
      <div className="pipe">
        {data.columns.map((col) => (
          <div key={col.stage} className="pipe-col">
            <header>
              <strong>{stageLabel(col.stage)} <span className="muted">({col.rows.length})</span></strong>
              <span className="muted">{fmtMoney(col.total)}</span>
            </header>
            {col.rows.map((r) => (
              <button key={String(r.id)} className="pipe-card" onClick={() => navigate(`/crm/opportunities/${r.id}`)}>
                <strong>{String(r.name)}</strong>
                <span className="muted">{String(r.customerName ?? '—')}</span>
                <span className="cell-mono">{fmtMoney(r.amount)} · {fmtNum(r.probability)}%</span>
              </button>
            ))}
            {col.rows.length === 0 && <p className="muted" style={{ padding: '8px 4px' }}>No deals</p>}
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
  const [tab, setTab] = useState('Summary');
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
  const status = String(o.status);
  const open = status === 'OPEN';
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
  const stages = [
    { id: 'PROSPECTING', label: 'Prospect' },
    { id: 'QUALIFICATION', label: 'Qualify' },
    { id: 'NEEDS_ANALYSIS', label: 'Analyze' },
    { id: 'VALUE_PROPOSITION', label: 'Propose' },
    { id: 'NEGOTIATION', label: 'Negotiate' },
  ];
  const bpfCurrent = String(o.stage) === 'WON' || String(o.stage) === 'LOST' ? 'NEGOTIATION' : String(o.stage);
  const canQuote = can(user, 'sales.quotations.create') && status !== 'LOST' && status !== 'ON_HOLD' && (!doc.credit || Boolean(doc.credit.ok));
  return (
    <div className="page">
      <CrmCommandBar
        entity="Opportunity"
        actions={[
          ...(canQuote ? [{ label: 'New quote', onClick: () => setTab('Product line'), primary: true, disabled: busy }] : []),
          ...(open && can(user, 'crm.opportunities.win') ? [{ label: 'Close as won', onClick: () => act(`/api/ops/crm/opportunities/${id}/win`, {}, 'Won — customer will be notified'), success: true, disabled: busy }] : []),
          ...(open && can(user, 'crm.opportunities.lose') ? [{ label: 'Close as lost', onClick: () => act(`/api/ops/crm/opportunities/${id}/lose`, { reason: 'Lost on desk' }, 'Lost'), danger: true, disabled: busy }] : []),
          ...(open && can(user, 'crm.opportunities.update') ? [{ label: 'Hold', onClick: () => act(`/api/ops/crm/opportunities/${id}/hold`, { reason: 'Held on desk' }, 'On hold'), disabled: busy }] : []),
          ...(status === 'ON_HOLD' && can(user, 'crm.opportunities.update') ? [{ label: 'Resume', onClick: () => act(`/api/ops/crm/opportunities/${id}/resume`, {}, 'Resumed'), primary: true, disabled: busy }] : []),
          { label: 'Open account', onClick: () => o.customerId && navigate(`/crm/customers/${o.customerId}`), disabled: !o.customerId },
        ]}
        extra={can(user, 'crm.opportunities.assign') && ['OPEN', 'ON_HOLD'].includes(status) ? <AssignInline entity="opportunities" id={id} onDone={load} /> : null}
      />
      <div className="crm-form-head">
        <div className="crm-entity-type">Opportunity</div>
        <div className="crm-form-title">
          <h1>{String(o.name)}</h1>
          <Badge value={o.stage} />
        </div>
        <CrmHighlights items={[
          { label: 'Account', value: (
            <button className="linkish" onClick={() => o.customerId && navigate(`/crm/customers/${o.customerId}`)}>{String(o.customerName ?? 'No account')}</button>
          ) },
          { label: 'Est. revenue', value: fmtMoney(o.amount) },
          { label: 'Probability', value: `${fmtNum(o.probability)}%` },
          { label: 'Status', value: status },
          { label: 'Credit', value: doc.credit ? (doc.credit.ok ? 'OK' : String(doc.credit.reason ?? 'Hold')) : '—' },
          { label: 'Owner', value: String(o.ownerName || 'Unassigned') },
        ]} />
      </div>
      <CrmBpf
        stages={stages}
        current={bpfCurrent}
        onSelect={open ? (s) => act(`/api/ops/crm/opportunities/${id}/move`, { stage: s }, `${stageLabel(s)} — customer will be notified`) : undefined}
        busy={busy}
      />
      {notice && <div className="alert alert-success">{notice}</div>}
      {error && <ErrorBanner error={error} />}
      {doc.credit && !doc.credit.ok && (
        <div className="alert alert-error">Credit hold: {String(doc.credit.reason)}. Quoting is blocked.</div>
      )}
      {status === 'ON_HOLD' && (
        <div className="alert alert-error">This opportunity is on hold. Resume it before quoting.</div>
      )}
      {open && (
        <p className="muted" style={{ margin: '0 0 10px' }}>Stage changes and wins email and SMS the customer when contact details are on file.</p>
      )}
      <CrmTabs tabs={['Summary', 'Product line', 'Quotes']} active={tab} onChange={setTab} />
      {tab === 'Summary' && (
        <div className="crm-split">
          <section className="card card-pad">
            <h3>Deal summary</h3>
            <dl className="crm-highlights" style={{ marginTop: 12 }}>
              <div className="crm-hl"><dt>Topic</dt><dd>{String(o.name)}</dd></div>
              <div className="crm-hl"><dt>Pipeline stage</dt><dd>{stageLabel(String(o.stage))}</dd></div>
              <div className="crm-hl"><dt>Est. close</dt><dd>{o.expectedClose ? String(o.expectedClose).slice(0, 10) : '—'}</dd></div>
              <div className="crm-hl"><dt>Weighted</dt><dd>{fmtMoney(Number(o.amount ?? 0) * Number(o.probability ?? 0) / 100)}</dd></div>
            </dl>
          </section>
          <aside>
            <section className="card">
              <div className="card-head"><h3>Quotes</h3></div>
              <div className="table-wrap">
                <table className="data">
                  <thead><tr><th>Quote</th><th>Status</th></tr></thead>
                  <tbody>
                    {doc.quotations.slice(0, 5).map((q) => (
                      <tr key={String(q.id)} className="row-click" onClick={() => navigate(`/sales/quotations/${q.id}`)}>
                        <td className="cell-mono">{String(q.quotationNo)}</td>
                        <td><Badge value={q.status} /></td>
                      </tr>
                    ))}
                    {doc.quotations.length === 0 && <tr><td colSpan={2} className="muted" style={{ padding: 16 }}>No quotes yet.</td></tr>}
                  </tbody>
                </table>
              </div>
            </section>
          </aside>
        </div>
      )}
      {tab === 'Product line' && (
        <section className="card card-pad">
          <h3>Quote this opportunity</h3>
          {canQuote ? (
            <>
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
            </>
          ) : (
            <p className="muted" style={{ marginTop: 12 }}>Quoting is blocked for this opportunity.</p>
          )}
        </section>
      )}
      {tab === 'Quotes' && (
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
      )}
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
      <CrmComposerHead entity="Opportunity" title="New opportunity" onCancel={() => navigate('/crm/pipeline')} onSave={save} busy={busy} />
      {error && <ErrorBanner error={error} />}
      <section className="crm-quick-create">
        <div className="form-grid">
          <div className="field field-required">
            <label>Account</label>
            <select value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
              <option value="">Select…</option>
              {customers.map((c) => <option key={String(c.id)} value={String(c.id)}>{String(c.code)} · {String(c.name)}</option>)}
            </select>
          </div>
          <div className="field field-required"><label>Topic</label><input value={name} onChange={(e) => setName(e.target.value)} /></div>
          <div className="field"><label>Est. revenue</label><input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} /></div>
        </div>
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
      <CrmCommandBar entity="Activity" actions={[{ label: 'My work', onClick: () => navigate('/crm/mine') }]} />
      <CrmViewBar title="Activities" view="Open follow-ups" count={rows.length} />
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
      <CrmCommandBar entity="Case" actions={[{ label: 'Sales hub', onClick: () => navigate('/crm') }]} />
      <CrmViewBar title="Cases" view="All cases" count={rows.length} />
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
  const [notice, setNotice] = useState('');
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
  const act = async (path: string, body: Rec = {}, ok = 'Done') => {
    setBusy(true); setError(''); setNotice('');
    try {
      await api(path, { method: 'POST', body: JSON.stringify(body) });
      setNotice(ok);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };
  const status = String(c.status);
  const open = ['OPEN', 'IN_PROGRESS', 'ESCALATED'].includes(status);
  return (
    <div className="page">
      <CrmCommandBar
        entity="Case"
        actions={[
          ...(open && can(user, 'crm.complaints.escalate') && status !== 'ESCALATED' ? [{ label: 'Escalate', onClick: () => act(`/api/ops/crm/complaints/${id}/escalate`), danger: true, disabled: busy }] : []),
          ...(open && can(user, 'crm.complaints.resolve') ? [{ label: 'Resolve', onClick: () => act(`/api/ops/crm/complaints/${id}/resolve`, { resolution }, 'Resolved — customer will be notified'), success: true, disabled: busy || !resolution }] : []),
          ...(c.customerId != null ? [{ label: 'Open account', onClick: () => navigate(`/crm/customers/${c.customerId}`) }] : []),
        ]}
        extra={open && can(user, 'crm.complaints.resolve') ? (
          <input className="cell-input" placeholder="Resolution" value={resolution} onChange={(e) => setResolution(e.target.value)} />
        ) : null}
      />
      <div className="crm-form-head">
        <div className="crm-entity-type">Case</div>
        <div className="crm-form-title">
          <h1>{String(c.subject)} <span className="cell-mono muted">{String(c.complaintNo)}</span></h1>
          <Badge value={c.status} />
        </div>
        <CrmHighlights items={[
          { label: 'Account', value: String(c.customerName ?? '—') },
          { label: 'Priority', value: String(c.priority ?? '—') },
          { label: 'Status', value: status },
          { label: 'Owner', value: String(c.ownerName || 'Unassigned') },
        ]} />
      </div>
      <CrmBpf
        stages={[
          { id: 'OPEN', label: 'Identify' },
          { id: 'IN_PROGRESS', label: 'Research' },
          { id: 'ESCALATED', label: 'Escalate' },
          { id: 'RESOLVED', label: 'Resolve' },
        ]}
        current={status === 'CLOSED' ? 'RESOLVED' : status}
      />
      {notice && <div className="alert alert-success">{notice}</div>}
      {error && <ErrorBanner error={error} />}
      <CrmTabs tabs={['Summary']} active="Summary" onChange={() => undefined} />
      <section className="card card-pad">
        <h3>Description</h3>
        <p style={{ marginTop: 8 }}>{String(c.notes ?? c.subject ?? '—')}</p>
        {c.resolution != null && (
          <>
            <h3 style={{ marginTop: 16 }}>Resolution</h3>
            <p style={{ marginTop: 8 }}>{String(c.resolution)}</p>
          </>
        )}
      </section>
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
      <CrmCommandBar
        entity="My work"
        actions={[
          { label: 'New lead', onClick: () => navigate('/crm/leads/new') },
          { label: 'New opportunity', onClick: () => navigate('/crm/opportunities/new'), primary: true },
        ]}
      />
      <CrmViewBar title="My work" view="Assigned to me" />
      <div className="crm-insight">
        <button className="crm-insight-card" onClick={() => navigate('/crm/leads')}><span className="k">My leads</span><span className="v">{fmtNum(kpis.myLeads)}</span></button>
        <button className="crm-insight-card" onClick={() => navigate('/crm/pipeline')}><span className="k">My pipeline</span><span className="v">{fmtNum(kpis.myOpps)}</span></button>
        <button className="crm-insight-card" onClick={() => navigate('/crm/activities')}><span className="k">Follow-ups</span><span className="v">{fmtNum(kpis.myFollowUps)}</span></button>
        <button className="crm-insight-card" onClick={() => navigate('/crm/complaints')}><span className="k">Cases</span><span className="v">{fmtNum(kpis.myComplaints)}</span></button>
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
      <CrmCommandBar entity="Dashboard" actions={[{ label: 'Pipeline', onClick: () => navigate('/crm/pipeline') }, { label: 'Sales hub', onClick: () => navigate('/crm') }]} />
      <CrmViewBar title="Sales dashboards" view="Forecast and conversion" />
      <p className="muted" style={{ margin: '-4px 0 12px' }}>Weighted pipeline, win rate, source mix, and AR aging from live CRM, sales, and AR.</p>
      <div className="crm-insight">
        <div className="crm-insight-card">
          <span className="k">Conversion</span>
          <span className="v">{fmtNum(data.conversionRate)}%</span>
          <span className="s">{fmtNum(funnel.leadsConverted)} of {fmtNum(funnel.leadsTotal)} leads</span>
        </div>
        <div className="crm-insight-card">
          <span className="k">Win rate</span>
          <span className="v">{fmtNum(data.winRate)}%</span>
          <span className="s">{fmtNum(funnel.oppsWon)} won · {fmtNum(funnel.oppsLost)} lost</span>
        </div>
        <div className="crm-insight-card">
          <span className="k">Weighted forecast</span>
          <span className="v">{fmtMoney(forecast.weighted)}</span>
          <span className="s">This month {fmtMoney(forecast.thisMonth)} · next {fmtMoney(forecast.nextMonth)}</span>
        </div>
        <div className="crm-insight-card">
          <span className="k">Won value</span>
          <span className="v">{fmtMoney(funnel.wonValue)}</span>
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
      <CrmCommandBar entity="Contact" actions={[{ label: 'New account', onClick: () => navigate('/crm/customers/new'), primary: true }]} />
      <CrmViewBar title="Contacts" view="All contacts" count={rows.length} search={q} onSearch={setQ} placeholder="Filter contacts" />
      {error && <ErrorBanner error={error} />}
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
