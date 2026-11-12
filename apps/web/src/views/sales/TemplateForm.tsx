import { useEffect, useState } from 'react';
import { api, fmtNum } from '../../api';
import { useAuth, can } from '../../auth';
import { navigate } from '../../router';
import { pick } from '../../helpers';
import { ErrorBanner, PageLoader } from '../../components/ui';
import { toast } from '../../components/toast';
import type { LineKind } from './odooSales';

type Rec = Record<string, unknown>;

interface TemplateLine {
  key: string;
  lineKind: LineKind;
  productId: number | '';
  description: string;
  quantity: number;
  unitPrice: number;
  discountPercent: number;
}

function num(v: unknown, fallback = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function nextKey(): string {
  return `t-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function blank(kind: LineKind = 'PRODUCT'): TemplateLine {
  return { key: nextKey(), lineKind: kind, productId: '', description: '', quantity: kind === 'PRODUCT' ? 1 : 0, unitPrice: 0, discountPercent: 0 };
}

function Lookup({
  valueLabel,
  onPick,
  disabled,
}: {
  valueLabel: string;
  onPick: (row: Rec) => void;
  disabled?: boolean;
}) {
  const [q, setQ] = useState(valueLabel);
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<Rec[]>([]);
  useEffect(() => { setQ(valueLabel); }, [valueLabel]);
  useEffect(() => {
    if (!open || disabled) return;
    const t = setTimeout(() => {
      const params = new URLSearchParams({ pageSize: '12' });
      if (q.trim() && q !== valueLabel) params.set('q', q.trim());
      api<{ data: Rec[] }>(`/api/ops/sales/products?${params.toString()}`)
        .then((r) => setRows(r.data ?? []))
        .catch(() => setRows([]));
    }, 180);
    return () => clearTimeout(t);
  }, [disabled, open, q, valueLabel]);
  return (
    <div className="lookup">
      <input
        value={q}
        disabled={disabled}
        placeholder="Search a product…"
        onFocus={() => setOpen(true)}
        onChange={(e) => { setQ(e.target.value); setOpen(true); }}
        onBlur={() => setTimeout(() => setOpen(false), 180)}
      />
      {open && !disabled && (
        <div className="lookup-menu">
          {rows.map((row) => (
            <button key={String(row.id)} type="button" className="lookup-item" onMouseDown={(e) => e.preventDefault()} onClick={() => { onPick(row); setOpen(false); }}>
              {`${pick(row, 'code') ?? ''} · ${pick(row, 'name') ?? ''}`}
            </button>
          ))}
          {rows.length === 0 && <div className="search-hint">No matches</div>}
        </div>
      )}
    </div>
  );
}

export default function TemplateForm({ id }: { id: number | null }) {
  const { user } = useAuth();
  const [loading, setLoading] = useState(id != null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [name, setName] = useState('');
  const [validityDays, setValidityDays] = useState<number | ''>(30);
  const [notes, setNotes] = useState('');
  const [active, setActive] = useState(true);
  const [lines, setLines] = useState<TemplateLine[]>([blank()]);
  const editable = id == null ? can(user, 'sales.templates.create') : can(user, 'sales.templates.update');

  useEffect(() => {
    if (id == null) return;
    api<{ data: { template: Rec; lines: Rec[] } }>(`/api/ops/sales/templates/${id}`)
      .then((r) => {
        const template = r.data.template;
        setName(String(template.name ?? ''));
        setValidityDays(template.validityDays != null && template.validityDays !== '' ? num(template.validityDays) : '');
        setNotes(String(template.notes ?? ''));
        setActive(template.active !== false);
        const copied = (r.data.lines ?? []).map((line) => {
          const raw = String(line.lineKind ?? 'PRODUCT').toUpperCase();
          const lineKind: LineKind = raw === 'SECTION' || raw === 'NOTE' ? raw : 'PRODUCT';
          return {
            key: `saved-${String(line.id ?? nextKey())}`,
            lineKind,
            productId: line.productId != null ? num(line.productId) : '',
            description: String(line.description ?? line.productName ?? ''),
            quantity: lineKind === 'PRODUCT' ? num(line.quantity, 1) : 0,
            unitPrice: num(line.unitPrice),
            discountPercent: num(line.discountPercent),
          } satisfies TemplateLine;
        });
        setLines(copied.length ? copied : [blank()]);
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not load the template'))
      .finally(() => setLoading(false));
  }, [id]);

  const save = async () => {
    const payloadLines = lines
      .filter((line) => line.lineKind !== 'PRODUCT' || line.productId !== '')
      .map((line) => ({
        lineKind: line.lineKind,
        productId: line.lineKind === 'PRODUCT' ? Number(line.productId) : null,
        description: line.description.trim(),
        quantity: line.lineKind === 'PRODUCT' ? Number(line.quantity) : 0,
        unitPrice: line.lineKind === 'PRODUCT' ? Number(line.unitPrice) : 0,
        discountPercent: line.lineKind === 'PRODUCT' ? Number(line.discountPercent) || 0 : 0,
      }));
    if (!name.trim()) { setError('Template name is required'); return; }
    if (!payloadLines.some((line) => line.lineKind === 'PRODUCT')) { setError('Add at least one product'); return; }
    setBusy(true);
    setError('');
    try {
      const body = {
        name: name.trim(),
        validityDays: validityDays === '' ? null : Number(validityDays),
        notes: notes || null,
        active,
        lines: payloadLines,
      };
      const r = await api<{ data: { templateId: number } }>(id == null ? '/api/ops/sales/templates' : `/api/ops/sales/templates/${id}`, {
        method: id == null ? 'POST' : 'PUT',
        body: JSON.stringify(body),
      });
      toast.success('Quotation template saved');
      if (id == null) navigate(`/sales/templates/${r.data.templateId}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save the template');
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <PageLoader variant="page" label="Opening quotation template…" />;

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <button className="btn btn-sm" type="button" onClick={() => navigate('/sales/templates')}>Back</button>
          <p className="mod-kicker" data-mod="sales">Sales</p>
          <h1>{id == null ? 'New quotation template' : name || 'Quotation template'}</h1>
          <p className="muted">A template fills the lines, notes, and validity of a new quotation.</p>
        </div>
        {editable && <button className="btn btn-primary" type="button" disabled={busy} onClick={save}>Save</button>}
      </header>
      {error && <ErrorBanner error={error} />}
      <section className="card card-pad">
        <div className="form-grid">
          <label className="field field-required"><span>Name</span><input value={name} disabled={!editable} onChange={(e) => setName(e.target.value)} /></label>
          <label className="field">
            <span>Validity (days)</span>
            <input type="number" min={0} max={365} value={validityDays} disabled={!editable} onChange={(e) => setValidityDays(e.target.value === '' ? '' : Number(e.target.value))} />
          </label>
        </div>
        <label className="check">
          <input type="checkbox" checked={active} disabled={!editable} onChange={(e) => setActive(e.target.checked)} /> Active
        </label>
        <label className="field">
          <span>Notes</span>
          <textarea rows={3} value={notes} disabled={!editable} onChange={(e) => setNotes(e.target.value)} />
        </label>
      </section>
      <section className="card">
        <div className="card-head">
          <h3>Lines</h3>
          {editable && (
            <div className="mini-buttons">
              <button className="btn btn-sm" type="button" onClick={() => setLines((prev) => [...prev, blank()])}>Add a product</button>
              <button className="btn btn-sm" type="button" onClick={() => setLines((prev) => [...prev, blank('SECTION')])}>Add a section</button>
              <button className="btn btn-sm" type="button" onClick={() => setLines((prev) => [...prev, blank('NOTE')])}>Add a note</button>
            </div>
          )}
        </div>
        <div className="table-wrap">
          <table className="data sale-lines">
            <thead>
              <tr><th>Product</th><th className="cell-num">Quantity</th><th className="cell-num">Unit price</th><th className="cell-num">Disc %</th><th /></tr>
            </thead>
            <tbody>
              {lines.map((line) => {
                if (line.lineKind !== 'PRODUCT') {
                  return (
                    <tr key={line.key} className={line.lineKind === 'SECTION' ? 'sale-section' : 'sale-note'}>
                      <td colSpan={4}>
                        <input value={line.description} disabled={!editable} placeholder={line.lineKind === 'SECTION' ? 'Section title' : 'Note'} onChange={(e) => setLines((prev) => prev.map((row) => row.key === line.key ? { ...row, description: e.target.value } : row))} />
                      </td>
                      <td>{editable && <button className="btn btn-sm" type="button" onClick={() => setLines((prev) => prev.filter((row) => row.key !== line.key))}>Remove</button>}</td>
                    </tr>
                  );
                }
                return (
                  <tr key={line.key}>
                    <td>
                      <Lookup
                        valueLabel={line.description}
                        disabled={!editable}
                        onPick={(row) => setLines((prev) => prev.map((item) => item.key === line.key ? {
                          ...item,
                          productId: num(row.id),
                          description: String(pick(row, 'name') ?? ''),
                          unitPrice: num(pick(row, 'standardPrice', 'standard_price'), item.unitPrice),
                        } : item))}
                      />
                    </td>
                    <td><input className="cell-input" type="number" min={0} disabled={!editable} value={line.quantity} onChange={(e) => setLines((prev) => prev.map((row) => row.key === line.key ? { ...row, quantity: num(e.target.value) } : row))} /></td>
                    <td><input className="cell-input" type="number" min={0} disabled={!editable} value={line.unitPrice} onChange={(e) => setLines((prev) => prev.map((row) => row.key === line.key ? { ...row, unitPrice: num(e.target.value) } : row))} /></td>
                    <td><input className="cell-input" type="number" min={0} disabled={!editable} value={line.discountPercent} onChange={(e) => setLines((prev) => prev.map((row) => row.key === line.key ? { ...row, discountPercent: num(e.target.value) } : row))} /></td>
                    <td>{editable && <button className="btn btn-sm" type="button" onClick={() => setLines((prev) => prev.filter((row) => row.key !== line.key))}>Remove</button>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="muted" style={{ padding: '0 16px 12px' }}>{fmtNum(lines.filter((line) => line.lineKind === 'PRODUCT' && line.productId !== '').length)} product lines</p>
      </section>
    </div>
  );
}
