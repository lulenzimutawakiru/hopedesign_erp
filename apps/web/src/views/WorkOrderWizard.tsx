import { useEffect, useState } from 'react';
import { api, fmtMoney, fmtNum, ListResult } from '../api';
import { ErrorBanner } from '../components/ui';
import { Breadcrumbs } from '../components/os';
import { pick } from '../helpers';
import { navigate } from '../router';

type Rec = Record<string, unknown>;

const STEPS = [
  { id: 'product', label: 'Product' },
  { id: 'quantity', label: 'Quantity' },
  { id: 'bom', label: 'BOM' },
  { id: 'routing', label: 'Routing' },
  { id: 'machine', label: 'Machine' },
  { id: 'materials', label: 'Materials' },
  { id: 'schedule', label: 'Schedule' },
  { id: 'review', label: 'Review' },
  { id: 'submit', label: 'Submit' },
];

interface Setup {
  product: Rec;
  boms: Rec[];
  routings: Rec[];
  machines: Rec[];
  materials: Rec[];
  operations: Rec[];
  selectedBomId: number | null;
  selectedRoutingId: number | null;
}

export default function WorkOrderWizard() {
  const [step, setStep] = useState(0);
  const [products, setProducts] = useState<Rec[]>([]);
  const [q, setQ] = useState('');
  const [product, setProduct] = useState<Rec | null>(null);
  const [qty, setQty] = useState('1000');
  const [bomId, setBomId] = useState<string>('');
  const [routingId, setRoutingId] = useState<string>('');
  const [machineId, setMachineId] = useState<string>('');
  const [priority, setPriority] = useState('MEDIUM');
  const [startDate, setStartDate] = useState(new Date().toISOString().slice(0, 10));
  const [dueDate, setDueDate] = useState('');
  const [notes, setNotes] = useState('');
  const [setup, setSetup] = useState<Setup | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams({ pageSize: '30' });
    if (q.trim()) params.set('q', q.trim());
    api<ListResult>(`/api/inventory/items?${params}`)
      .then((r) => setProducts(r.data))
      .catch(() => setProducts([]));
  }, [q]);

  const loadSetup = async (pid: number, quantity: number, b?: string, rt?: string) => {
    const params = new URLSearchParams({ quantity: String(quantity || 1) });
    if (b) params.set('bomId', b);
    if (rt) params.set('routingId', rt);
    const r = await api<{ data: Setup }>(`/api/ops/production/products/${pid}/setup?${params}`);
    setSetup(r.data);
    if (!b && r.data.selectedBomId) setBomId(String(r.data.selectedBomId));
    if (!rt && r.data.selectedRoutingId) setRoutingId(String(r.data.selectedRoutingId));
  };

  const next = async () => {
    setError('');
    if (step === 0 && !product) { setError('Pick a product'); return; }
    if (step === 1 && !(Number(qty) > 0)) { setError('Quantity must be positive'); return; }
    if (step === 1 && product) {
      try { await loadSetup(Number(product.id), Number(qty)); } catch (e) { setError(e instanceof Error ? e.message : 'Could not load BOM'); return; }
    }
    if (step === 2 && product) {
      try { await loadSetup(Number(product.id), Number(qty), bomId, routingId); } catch { /* keep */ }
    }
    if (step === 3 && product) {
      try { await loadSetup(Number(product.id), Number(qty), bomId, routingId); } catch { /* keep */ }
    }
    if (step < STEPS.length - 1) setStep((s) => s + 1);
  };

  const submit = async (andSubmit: boolean) => {
    if (!product) return;
    setBusy(true); setError('');
    try {
      const created = await api<{ data: { workOrderId: number; woNo: string } }>('/api/ops/production/work-orders', {
        method: 'POST',
        body: JSON.stringify({
          productId: Number(product.id),
          quantity: Number(qty),
          bomId: bomId || null,
          routingId: routingId || null,
          machineId: machineId || null,
          priority,
          startDate: startDate || null,
          dueDate: dueDate || null,
          notes: notes || null,
        }),
      });
      if (andSubmit) {
        await api(`/api/ops/production/work-orders/${created.data.workOrderId}/submit`, { method: 'POST', body: '{}' });
      }
      navigate(`/operator/${created.data.workOrderId}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page">
      <Breadcrumbs items={[{ label: 'Plant', href: '/plant' }, { label: 'New work order' }]} />
      <header className="page-head">
        <div>
          <h1>Create work order</h1>
          <p className="muted">Nine steps. Each one is validated before you move on. You can go back without losing the draft.</p>
        </div>
      </header>

      <ol className="pipeline" aria-label="Wizard progress">
        {STEPS.map((s, i) => (
          <li key={s.id} className={`pipeline-step ${i < step ? 'done' : ''} ${i === step ? 'current' : ''}`}>
            <span className="pipeline-dot">{i + 1}</span>
            <span>{s.label}</span>
          </li>
        ))}
      </ol>

      {error && <ErrorBanner error={error} />}

      <section className="card card-pad">
        {step === 0 && (
          <>
            <h3>1 · Product</h3>
            <input className="search-input" placeholder="Search catalogue…" value={q} onChange={(e) => setQ(e.target.value)} />
            <div className="wizard-list">
              {products.map((p) => (
                <button key={String(p.id)} className={`wizard-choice ${Number(product?.id) === Number(p.id) ? 'on' : ''}`} onClick={() => setProduct(p)}>
                  <span className="cell-mono">{String(pick(p, 'code'))}</span>
                  <strong>{String(pick(p, 'name'))}</strong>
                </button>
              ))}
            </div>
          </>
        )}
        {step === 1 && (
          <>
            <h3>2 · Quantity</h3>
            <p className="muted">{String(pick(product ?? {}, 'code'))} · {String(pick(product ?? {}, 'name'))}</p>
            <label className="field field-required">
              <span>How many to make</span>
              <input className="op-qty" inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value)} />
            </label>
          </>
        )}
        {step === 2 && (
          <>
            <h3>3 · Bill of materials</h3>
            <select value={bomId} onChange={(e) => setBomId(e.target.value)}>
              <option value="">No BOM — labour only</option>
              {(setup?.boms ?? []).map((b) => (
                <option key={String(b.id)} value={String(b.id)}>{String(pick(b, 'code'))} v{String(pick(b, 'version'))} {pick(b, 'isActive') ? '' : '(inactive)'}</option>
              ))}
            </select>
            <p className="muted">Materials will explode from this BOM at the next step.</p>
          </>
        )}
        {step === 3 && (
          <>
            <h3>4 · Routing</h3>
            <select value={routingId} onChange={(e) => setRoutingId(e.target.value)}>
              <option value="">No routing</option>
              {(setup?.routings ?? []).map((r) => (
                <option key={String(r.id)} value={String(r.id)}>{String(pick(r, 'code'))} · {String(pick(r, 'name'))}</option>
              ))}
            </select>
            <ul className="muted">
              {(setup?.operations ?? []).map((op) => (
                <li key={String(op.seq)}>Op {String(op.seq)} {String(op.name)} · {fmtNum(op.runMin)} min run</li>
              ))}
            </ul>
          </>
        )}
        {step === 4 && (
          <>
            <h3>5 · Machine</h3>
            <div className="wizard-list">
              <button className={`wizard-choice ${machineId === '' ? 'on' : ''}`} onClick={() => setMachineId('')}>Unassigned</button>
              {(setup?.machines ?? []).map((m) => (
                <button key={String(m.id)} className={`wizard-choice ${machineId === String(m.id) ? 'on' : ''}`} onClick={() => setMachineId(String(m.id))}>
                  <span className="cell-mono">{String(m.code)}</span>
                  <strong>{String(m.name)}</strong>
                  <span className="muted">{String(m.status)}</span>
                </button>
              ))}
            </div>
          </>
        )}
        {step === 5 && (
          <>
            <h3>6 · Materials (preview)</h3>
            <p className="muted">These quantities will be reserved on the work order. They are not issued until a storekeeper issues them.</p>
            <table className="data">
              <thead><tr><th>Component</th><th className="cell-num">Required</th><th className="cell-num">Cost</th></tr></thead>
              <tbody>
                {(setup?.materials ?? []).map((m) => (
                  <tr key={String(m.productId)}>
                    <td><span className="cell-mono">{String(m.productCode)}</span> {String(m.productName)}</td>
                    <td className="cell-num">{fmtNum(m.requiredQty)}</td>
                    <td className="cell-num">{fmtMoney(Number(m.unitCost) * Number(m.requiredQty))}</td>
                  </tr>
                ))}
                {(setup?.materials ?? []).length === 0 && <tr><td colSpan={3} className="muted">No BOM lines.</td></tr>}
              </tbody>
            </table>
          </>
        )}
        {step === 6 && (
          <>
            <h3>7 · Schedule</h3>
            <div className="form-grid">
              <label className="field"><span>Priority</span>
                <select value={priority} onChange={(e) => setPriority(e.target.value)}>
                  <option>LOW</option><option>MEDIUM</option><option>HIGH</option><option>URGENT</option>
                </select>
              </label>
              <label className="field"><span>Start</span><input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} /></label>
              <label className="field"><span>Due</span><input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} /></label>
              <label className="field" style={{ gridColumn: '1 / -1' }}><span>Notes</span><textarea value={notes} onChange={(e) => setNotes(e.target.value)} /></label>
            </div>
          </>
        )}
        {step === 7 && (
          <>
            <h3>8 · Review</h3>
            <dl className="detail-list">
              <div className="detail-row"><dt>Product</dt><dd>{String(pick(product ?? {}, 'code'))} · {String(pick(product ?? {}, 'name'))}</dd></div>
              <div className="detail-row"><dt>Quantity</dt><dd>{fmtNum(qty)}</dd></div>
              <div className="detail-row"><dt>BOM</dt><dd>{bomId || 'None'}</dd></div>
              <div className="detail-row"><dt>Routing</dt><dd>{routingId || 'None'}</dd></div>
              <div className="detail-row"><dt>Machine</dt><dd>{machineId || 'Unassigned'}</dd></div>
              <div className="detail-row"><dt>Window</dt><dd>{startDate || '—'} → {dueDate || '—'}</dd></div>
              <div className="detail-row"><dt>Materials</dt><dd>{setup?.materials.length ?? 0} lines</dd></div>
            </dl>
          </>
        )}
        {step === 8 && (
          <>
            <h3>9 · Submit</h3>
            <p>Create a DRAFT work order, or create and send it into the release workflow now.</p>
            <div className="quick-actions">
              <button className="btn" disabled={busy} onClick={() => submit(false)}>Save draft</button>
              <button className="btn btn-primary" disabled={busy} onClick={() => submit(true)}>{busy ? 'Working…' : 'Create and submit'}</button>
            </div>
          </>
        )}
      </section>

      <div className="head-actions" style={{ marginTop: 12 }}>
        <button className="btn" disabled={step === 0} onClick={() => setStep((s) => Math.max(0, s - 1))}>Back</button>
        {step < STEPS.length - 1 && <button className="btn btn-primary" onClick={() => void next()}>Continue</button>}
      </div>
    </div>
  );
}
