import { useCallback, useEffect, useState } from 'react';
import { api, fmtDate, fmtMoney, fmtNum } from '../../api';
import { useAuth, can } from '../../auth';
import { navigate } from '../../router';
import { Badge, ErrorBanner, PageLoader } from '../../components/ui';
import { toast } from '../../components/toast';

type Rec = Record<string, unknown>;

interface SalesSettings {
  defaultQuotationValidityDays: number;
  lockConfirmedSales: boolean;
  proformaInvoice: boolean;
  showMargins: boolean;
  discounts: boolean;
  saleWarnings: boolean;
  defaultTemplateId: number | null;
  invoicingPolicy: 'delivered';
}

const EMPTY_SETTINGS: SalesSettings = {
  defaultQuotationValidityDays: 30,
  lockConfirmedSales: false,
  proformaInvoice: false,
  showMargins: false,
  discounts: true,
  saleWarnings: true,
  defaultTemplateId: null,
  invoicingPolicy: 'delivered',
};

export function SalesSettingsPage() {
  const { user } = useAuth();
  const [form, setForm] = useState<SalesSettings>(EMPTY_SETTINGS);
  const [templates, setTemplates] = useState<Rec[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const canSave = can(user, 'sales.settings.update');

  useEffect(() => {
    Promise.all([
      api<{ data: SalesSettings }>('/api/ops/sales/settings'),
      api<{ data: Rec[] }>('/api/ops/sales/templates').catch(() => ({ data: [] as Rec[] })),
    ])
      .then(([settings, temps]) => {
        setForm({ ...EMPTY_SETTINGS, ...settings.data });
        setTemplates(temps.data ?? []);
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not load sales settings'))
      .finally(() => setLoading(false));
  }, []);

  const save = async () => {
    setBusy(true);
    setError('');
    try {
      const r = await api<{ data: SalesSettings }>('/api/ops/sales/settings', {
        method: 'PUT',
        body: JSON.stringify({
          ...form,
          defaultTemplateId: form.defaultTemplateId || null,
        }),
      });
      setForm({ ...EMPTY_SETTINGS, ...r.data });
      toast.success('Sales settings saved');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save settings');
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <PageLoader variant="page" label="Opening sales settings…" />;
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="mod-kicker" data-mod="sales">Sales</p>
          <h1>Settings</h1>
          <p className="muted">Quotations and orders. Invoicing uses delivered quantities.</p>
        </div>
        {canSave && <button className="btn btn-primary" type="button" disabled={busy} onClick={save}>Save</button>}
      </header>
      {error && <ErrorBanner error={error} />}
      <section className="card card-pad">
        <h3 style={{ marginTop: 0 }}>Quotations &amp; Orders</h3>
        <div className="form-grid">
          <label className="field">
            <span>Default quotation validity (days)</span>
            <input
              type="number"
              min={0}
              max={365}
              disabled={!canSave}
              value={form.defaultQuotationValidityDays}
              onChange={(e) => setForm({ ...form, defaultQuotationValidityDays: Number(e.target.value) })}
            />
          </label>
          <label className="field">
            <span>Default template</span>
            <select
              disabled={!canSave}
              value={form.defaultTemplateId ?? ''}
              onChange={(e) => setForm({ ...form, defaultTemplateId: e.target.value ? Number(e.target.value) : null })}
            >
              <option value="">None</option>
              {templates.filter((t) => t.active !== false).map((t) => (
                <option key={String(t.id)} value={String(t.id)}>{String(t.name)}</option>
              ))}
            </select>
          </label>
        </div>
        <label className="check"><input type="checkbox" disabled={!canSave} checked={form.discounts} onChange={(e) => setForm({ ...form, discounts: e.target.checked })} /> Discounts</label>
        <label className="check"><input type="checkbox" disabled={!canSave} checked={form.showMargins} onChange={(e) => setForm({ ...form, showMargins: e.target.checked })} /> Margins</label>
        <label className="check"><input type="checkbox" disabled={!canSave} checked={form.lockConfirmedSales} onChange={(e) => setForm({ ...form, lockConfirmedSales: e.target.checked })} /> Lock confirmed sales</label>
        <label className="check"><input type="checkbox" disabled={!canSave} checked={form.proformaInvoice} onChange={(e) => setForm({ ...form, proformaInvoice: e.target.checked })} /> Pro-forma invoice</label>
        <label className="check"><input type="checkbox" disabled={!canSave} checked={form.saleWarnings} onChange={(e) => setForm({ ...form, saleWarnings: e.target.checked })} /> Sale warnings</label>
        <p className="muted">
          Invoicing policy is delivered quantities. A sales order is invoiced after dispatch, and only the dispatched quantity is billed.
          Online signature, online payment, the PDF quote builder, recurring plans, commissions, marketplaces, and gift cards are not part of this sales app.
        </p>
      </section>
    </div>
  );
}

interface Person { id: number; firstName: string; lastName: string; email?: string }

export function SalesTeamsPage() {
  const { user } = useAuth();
  const [teams, setTeams] = useState<Rec[]>([]);
  const [people, setPeople] = useState<Person[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState('');
  const [leaderUserId, setLeaderUserId] = useState<number | ''>('');
  const [memberIds, setMemberIds] = useState<number[]>([]);
  const [editing, setEditing] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const canEdit = can(user, 'sales.teams.create') || can(user, 'sales.teams.update');

  const load = useCallback(async () => {
    const [t, p] = await Promise.all([
      api<{ data: Rec[] }>('/api/ops/sales/teams'),
      api<{ data: Person[] }>('/api/ops/sales/salespeople'),
    ]);
    setTeams(t.data ?? []);
    setPeople(p.data ?? []);
  }, []);

  useEffect(() => {
    load().catch((e) => setError(e instanceof Error ? e.message : 'Could not load sales teams')).finally(() => setLoading(false));
  }, [load]);

  const personName = (p: Person) => `${p.firstName ?? ''} ${p.lastName ?? ''}`.trim();

  const save = async () => {
    setBusy(true);
    setError('');
    try {
      await api('/api/ops/sales/teams' + (editing ? `/${editing}` : ''), {
        method: editing ? 'PUT' : 'POST',
        body: JSON.stringify({ name, leaderUserId: leaderUserId || null, memberIds, active: true }),
      });
      setName('');
      setLeaderUserId('');
      setMemberIds([]);
      setEditing(null);
      await load();
      toast.success('Sales team saved');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save the sales team');
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <PageLoader variant="page" label="Opening sales teams…" />;
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="mod-kicker" data-mod="sales">Sales</p>
          <h1>Sales Teams</h1>
        </div>
      </header>
      {error && <ErrorBanner error={error} />}
      <div className="table-wrap card">
        <table className="data">
          <thead><tr><th>Team</th><th>Leader</th><th>Members</th><th>Status</th></tr></thead>
          <tbody>
            {teams.map((team) => {
              const members = (team.members as { name?: string }[]) ?? [];
              return (
                <tr key={String(team.id)} className="row-click" onClick={() => {
                  if (!canEdit) return;
                  setEditing(Number(team.id));
                  setName(String(team.name ?? ''));
                  setLeaderUserId(team.leaderUserId ? Number(team.leaderUserId) : '');
                  setMemberIds(members.map((m) => Number((m as { userId?: number }).userId)).filter((id) => id > 0));
                }}>
                  <td>{String(team.name)}</td>
                  <td>{String(team.leaderName ?? '') || '—'}</td>
                  <td>{members.map((m) => m.name).filter(Boolean).join(', ') || '—'}</td>
                  <td><Badge value={team.active === false ? 'INACTIVE' : 'ACTIVE'} /></td>
                </tr>
              );
            })}
            {teams.length === 0 && <tr><td colSpan={4} style={{ textAlign: 'center', padding: 24, color: 'var(--muted)' }}>No sales teams yet</td></tr>}
          </tbody>
        </table>
      </div>
      {canEdit && (
        <section className="card card-pad" style={{ marginTop: 16 }}>
          <h3 style={{ marginTop: 0 }}>{editing ? 'Edit team' : 'New team'}</h3>
          <div className="form-grid">
            <label className="field"><span>Name</span><input value={name} onChange={(e) => setName(e.target.value)} /></label>
            <label className="field">
              <span>Team leader</span>
              <select value={leaderUserId} onChange={(e) => setLeaderUserId(e.target.value ? Number(e.target.value) : '')}>
                <option value="">None</option>
                {people.map((p) => <option key={p.id} value={p.id}>{personName(p)}</option>)}
              </select>
            </label>
          </div>
          <div className="field">
            <span>Members</span>
            <div className="sale-members">
              {people.map((p) => (
                <label key={p.id} className="check">
                  <input
                    type="checkbox"
                    checked={memberIds.includes(p.id)}
                    onChange={(e) => setMemberIds((ids) => e.target.checked ? [...ids, p.id] : ids.filter((id) => id !== p.id))}
                  />
                  {personName(p)}
                </label>
              ))}
            </div>
          </div>
          <button className="btn btn-primary" type="button" disabled={busy || !name.trim()} onClick={save}>Save team</button>
        </section>
      )}
    </div>
  );
}

export function QuotationTemplatesPage() {
  const { user } = useAuth();
  const [rows, setRows] = useState<Rec[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const canEdit = can(user, 'sales.templates.create') || can(user, 'sales.templates.update');

  useEffect(() => {
    api<{ data: Rec[] }>('/api/ops/sales/templates')
      .then((r) => setRows(r.data ?? []))
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not load templates'))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <PageLoader variant="page" label="Opening quotation templates…" />;
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="mod-kicker" data-mod="sales">Sales</p>
          <h1>Quotation Templates</h1>
          <p className="muted">A template fills the lines, notes, and validity of a new quotation.</p>
        </div>
        {canEdit && <button className="btn btn-primary" type="button" onClick={() => navigate('/sales/templates/new')}>New</button>}
      </header>
      {error && <ErrorBanner error={error} />}
      <div className="table-wrap card">
        <table className="data">
          <thead><tr><th>Template</th><th>Validity</th><th className="cell-num">Lines</th><th>Status</th></tr></thead>
          <tbody>
            {rows.map((row) => (
              <tr key={String(row.id)} className="row-click" onClick={() => navigate(`/sales/templates/${row.id}`)}>
                <td>{String(row.name)}</td>
                <td>{row.validityDays != null ? `${row.validityDays} days` : '—'}</td>
                <td className="cell-num">{fmtNum(row.lineCount)}</td>
                <td><Badge value={row.active === false ? 'INACTIVE' : 'ACTIVE'} /></td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={4} style={{ textAlign: 'center', padding: 24, color: 'var(--muted)' }}>No quotation templates yet</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function OrdersToInvoice() {
  const { user } = useAuth();
  const [rows, setRows] = useState<Rec[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<number | null>(null);

  const load = useCallback(async () => {
    const r = await api<{ data: Rec[] }>('/api/ops/sales/to-invoice');
    setRows(r.data ?? []);
  }, []);

  useEffect(() => {
    load().catch((e) => setError(e instanceof Error ? e.message : 'Could not load orders to invoice')).finally(() => setLoading(false));
  }, [load]);

  const invoice = async (orderId: number) => {
    setBusy(orderId);
    setError('');
    try {
      const r = await api<{ data: { invoiceId: number } }>('/api/ops/sales/invoices', {
        method: 'POST',
        body: JSON.stringify({ orderId }),
      });
      navigate(`/sales/invoices/${r.data.invoiceId}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not create the invoice');
      setBusy(null);
    }
  };

  if (loading) return <PageLoader variant="page" label="Opening orders to invoice…" />;
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="mod-kicker" data-mod="sales">Sales</p>
          <h1>Orders to Invoice</h1>
          <p className="muted">Dispatched quantities that have not been billed yet.</p>
        </div>
      </header>
      {error && <ErrorBanner error={error} />}
      <div className="table-wrap card">
        <table className="data">
          <thead>
            <tr><th>Number</th><th>Order date</th><th>Customer</th><th className="cell-num">Delivered</th><th className="cell-num">Invoiced</th><th className="cell-num">Total</th><th>Status</th><th></th></tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={String(row.id)}>
                <td className="cell-mono row-click" onClick={() => navigate(`/sales/orders/${row.id}`)}>{String(row.orderNo)}</td>
                <td>{fmtDate(row.orderDate)}</td>
                <td>{String(row.customerName ?? '')}</td>
                <td className="cell-num">{fmtNum(row.dispatchedQty)}</td>
                <td className="cell-num">{fmtNum(row.invoicedQty)}</td>
                <td className="cell-num">{fmtMoney(row.total)}</td>
                <td><Badge value={row.status} /></td>
                <td>
                  {can(user, 'sales.invoices.create') && (
                    <button className="btn btn-sm btn-primary" type="button" disabled={busy === Number(row.id)} onClick={() => invoice(Number(row.id))}>Create invoice</button>
                  )}
                </td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={8} style={{ textAlign: 'center', padding: 24, color: 'var(--muted)' }}>Nothing is waiting to be invoiced</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function OrdersToUpsell() {
  const { user } = useAuth();
  const [rows, setRows] = useState<Rec[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<number | null>(null);

  useEffect(() => {
    api<{ data: Rec[] }>('/api/ops/sales/to-upsell')
      .then((r) => setRows(r.data ?? []))
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not load orders to upsell'))
      .finally(() => setLoading(false));
  }, []);

  const quote = async (row: Rec) => {
    const orderId = Number(row.id);
    setBusy(orderId);
    setError('');
    try {
      const optionals = (row.optionals as Rec[]) ?? [];
      const r = await api<{ data: { quotationId: number } }>('/api/ops/sales/quotations', {
        method: 'POST',
        body: JSON.stringify({
          customerId: Number(row.customerId),
          sourceDocument: String(row.orderNo ?? ''),
          notes: `Optional products from ${String(row.orderNo ?? 'the sales order')}`,
          items: optionals.map((line) => ({
            productId: Number(line.productId),
            description: String(line.description ?? ''),
            quantity: Number(line.quantity ?? 1),
            unitPrice: Number(line.unitPrice ?? 0),
          })),
        }),
      });
      navigate(`/sales/quotations/${r.data.quotationId}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not create the quotation');
      setBusy(null);
    }
  };

  if (loading) return <PageLoader variant="page" label="Opening orders to upsell…" />;
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="mod-kicker" data-mod="sales">Sales</p>
          <h1>Orders to Upsell</h1>
          <p className="muted">Optional products that were offered and have not been added to the order.</p>
        </div>
      </header>
      {error && <ErrorBanner error={error} />}
      <div className="table-wrap card">
        <table className="data">
          <thead><tr><th>Number</th><th>Customer</th><th>Optional products</th><th></th></tr></thead>
          <tbody>
            {rows.map((row) => {
              const optionals = (row.optionals as Rec[]) ?? [];
              return (
                <tr key={String(row.id)}>
                  <td className="cell-mono row-click" onClick={() => navigate(`/sales/orders/${row.id}`)}>{String(row.orderNo)}</td>
                  <td>{String(row.customerName ?? '')}</td>
                  <td>{optionals.map((line) => String(line.description ?? '')).filter(Boolean).join(', ')}</td>
                  <td>
                    {can(user, 'sales.quotations.create') && (
                      <button className="btn btn-sm" type="button" disabled={busy === Number(row.id)} onClick={() => quote(row)}>Create quotation</button>
                    )}
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 && <tr><td colSpan={4} style={{ textAlign: 'center', padding: 24, color: 'var(--muted)' }}>No optional products are waiting</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function SalesAnalysisPage() {
  const [groupBy, setGroupBy] = useState('customer');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [rows, setRows] = useState<Rec[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const params = new URLSearchParams({ groupBy });
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    const r = await api<{ data: { rows: Rec[] } }>(`/api/ops/sales/analysis?${params.toString()}`);
    setRows(r.data.rows ?? []);
  }, [groupBy, from, to]);

  useEffect(() => {
    setLoading(true);
    load().catch((e) => setError(e instanceof Error ? e.message : 'Could not load sales analysis')).finally(() => setLoading(false));
  }, [load]);

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="mod-kicker" data-mod="sales">Sales</p>
          <h1>Sales</h1>
          <p className="muted">Confirmed orders, grouped for analysis.</p>
        </div>
      </header>
      <div className="toolbar">
        <label className="field">
          <span>Group by</span>
          <select value={groupBy} onChange={(e) => setGroupBy(e.target.value)}>
            <option value="customer">Customer</option>
            <option value="salesperson">Salesperson</option>
            <option value="product">Product</option>
            <option value="team">Sales team</option>
          </select>
        </label>
        <label className="field"><span>From</span><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label className="field"><span>To</span><input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
      </div>
      {error && <ErrorBanner error={error} />}
      {loading ? <PageLoader label="Loading sales analysis…" /> : (
        <div className="table-wrap card">
          <table className="data">
            <thead><tr><th>Name</th><th className="cell-num">Orders</th><th className="cell-num">Total</th></tr></thead>
            <tbody>
              {rows.map((row) => (
                <tr key={String(row.label)}>
                  <td>{String(row.label)}</td>
                  <td className="cell-num">{fmtNum(row.orders)}</td>
                  <td className="cell-num">{fmtMoney(row.total)}</td>
                </tr>
              ))}
              {rows.length === 0 && <tr><td colSpan={3} style={{ textAlign: 'center', padding: 24, color: 'var(--muted)' }}>No sales in this range</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
