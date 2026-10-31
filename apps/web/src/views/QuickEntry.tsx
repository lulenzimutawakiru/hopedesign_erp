import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../api';
import { navigate } from '../router';
import { pick } from '../helpers';
import { ErrorBanner } from '../components/ui';
import EntityPicker from '../components/EntityPicker';
import { toast } from '../components/toast';
import { isOnline, listOfflineEntries, queueOfflineEntry, removeOfflineEntry } from '../offlineDrafts';

type Rec = Record<string, unknown>;
type EntryType = 'RECEIPT' | 'ISSUE' | 'TRANSFER';

interface Line {
  key: string;
  productId: number | '';
  label: string;
  quantity: number;
  unitCost: number;
  expiryDate: string;
  batchId: number | '';
  binId: number | '';
}

const TYPE_BY_SLUG: Record<string, EntryType> = { receive: 'RECEIPT', issue: 'ISSUE', transfer: 'TRANSFER' };
const TYPE_VERB: Record<EntryType, string> = { RECEIPT: 'received', ISSUE: 'issued', TRANSFER: 'transferred' };
const TYPE_LABEL: Record<EntryType, string> = { RECEIPT: 'Receive', ISSUE: 'Issue', TRANSFER: 'Transfer' };

// Module-level so EntityPicker's effect deps stay stable across renders.
const mapItemRow = (r: Rec) => ({
  value: String(r.id),
  label: `${pick(r, 'code')} · ${pick(r, 'name')}`,
  hint: pick<string>(r, 'type'),
});

const mapBatchRow = (r: Rec) => {
  const batchNo = String(pick(r, 'batchNo', 'batch_no') ?? '');
  const lotNo = String(pick(r, 'lotNo', 'lot_no') ?? '');
  return {
    value: String(r.id),
    label: [batchNo, lotNo].filter(Boolean).join(' / ') || String(r.id),
    hint: `qty ${String(pick(r, 'quantity') ?? 0)}`,
  };
};

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function uuid(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  } catch {
    // fall through to the shim below
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

function newLine(): Line {
  return {
    key: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    productId: '',
    label: '',
    quantity: 1,
    unitCost: 0,
    expiryDate: '',
    batchId: '',
    binId: '',
  };
}

/**
 * Quick stock entry — a unified receive / issue / transfer document that posts
 * in a few steps. Submission is idempotent on `clientToken`, so a retried
 * "Post now" never double-posts; entries made while offline are queued locally
 * and replayed verbatim when the network returns.
 */
export default function QuickEntry({ initial }: { initial?: string | null }) {
  const initialType: EntryType = initial ? TYPE_BY_SLUG[initial] ?? 'RECEIPT' : 'RECEIPT';
  const [entryType, setEntryType] = useState<EntryType>(initialType);
  const [warehouses, setWarehouses] = useState<Rec[]>([]);
  const [bins, setBins] = useState<Rec[]>([]);
  const [warehouseId, setWarehouseId] = useState('');
  const [toWarehouseId, setToWarehouseId] = useState('');
  const [referenceNo, setReferenceNo] = useState('');
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<Line[]>([newLine()]);
  const [clientToken, setClientToken] = useState(() => uuid());
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState(() => listOfflineEntries());

  useEffect(() => {
    api<{ data: Rec[] }>('/api/ops/inventory/warehouses')
      .then((r) => {
        const ws = Array.isArray(r.data) ? r.data : [];
        setWarehouses(ws);
        if (ws.length === 1) setWarehouseId(String(ws[0].id));
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!warehouseId) { setBins([]); return; }
    api<{ data: Rec[] }>(`/api/ops/inventory/bins?warehouseId=${warehouseId}`)
      .then((r) => setBins(Array.isArray(r.data) ? r.data : []))
      .catch(() => setBins([]));
  }, [warehouseId]);

  const syncPending = useCallback(async () => {
    const queue = listOfflineEntries();
    for (const e of queue) {
      try {
        await api('/api/ops/inventory/entries', { method: 'POST', body: JSON.stringify(e.payload) });
        removeOfflineEntry(e.id);
      } catch (err) {
        if (err instanceof ApiError) {
          // Permanently rejected (validation / conflict / cancelled) — surface
          // it rather than retrying forever.
          removeOfflineEntry(e.id);
          toast.error('Offline entry not synced', { body: `${e.summary} — ${err.message}` });
        } else {
          break; // still offline; retry on the next online event
        }
      }
    }
    setPending(listOfflineEntries());
  }, []);

  useEffect(() => {
    setPending(listOfflineEntries());
    const onOnline = () => { void syncPending(); };
    const onOffline = () => setPending(listOfflineEntries());
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, [syncPending]);

  const addLine = useCallback(() => setLines((p) => [...p, newLine()]), []);

  const reset = () => {
    setLines([newLine()]);
    setReferenceNo('');
    setNotes('');
    setClientToken(uuid());
    setError('');
  };

  const payload = () => ({
    entryType,
    warehouseId: warehouseId ? Number(warehouseId) : null,
    toWarehouseId: entryType === 'TRANSFER' && toWarehouseId ? Number(toWarehouseId) : null,
    referenceNo: referenceNo.trim() || null,
    notes: notes.trim() || null,
    clientToken,
    lines: lines
      .filter((l) => l.productId && l.quantity > 0)
      .map((l) => ({
        productId: Number(l.productId),
        quantity: l.quantity,
        unitCost: l.unitCost || 0,
        expiryDate: l.expiryDate.trim() || null,
        batchId: l.batchId ? Number(l.batchId) : null,
        binId: l.binId ? Number(l.binId) : null,
      })),
  });

  const submit = async (action: 'draft' | 'post') => {
    setError('');
    if (!warehouseId) { setError(entryType === 'TRANSFER' ? 'Choose a source warehouse' : 'Choose a warehouse'); return; }
    if (entryType === 'TRANSFER' && !toWarehouseId) { setError('Choose a destination warehouse'); return; }
    if (entryType === 'TRANSFER' && toWarehouseId === warehouseId) { setError('Source and destination warehouses must differ'); return; }
    const body = payload();
    if (body.lines.length === 0) { setError('Add at least one item line'); return; }
    setBusy(true);
    try {
      const r = await api<{ data: { entryId: number; entryNo: string; status: string } }>('/api/ops/inventory/entries', {
        method: 'POST',
        body: JSON.stringify(action === 'post' ? { ...body, action: 'submit' } : body),
      });
      const entryNo = r.data.entryNo;
      const lineNote = `${body.lines.length} line${body.lines.length === 1 ? '' : 's'}`;
      if (action === 'post') {
        toast.success(`Stock ${TYPE_VERB[entryType]}`, { body: `${entryNo} · ${lineNote}` });
        reset();
      } else {
        toast.success('Draft saved', { body: `${entryNo} · ${lineNote}` });
      }
    } catch (e) {
      if (e instanceof ApiError) {
        setError(e.message);
      } else {
        // Network failure — persist locally and replay once back online.
        const summary = `${entryType} · ${body.lines.length} line${body.lines.length === 1 ? '' : 's'}`;
        queueOfflineEntry({
          id: clientToken,
          entryType,
          summary,
          payload: action === 'post' ? { ...body, action: 'submit' } : body,
          createdAt: Date.now(),
        });
        setPending(listOfflineEntries());
        toast.warning('Saved offline', { body: `${summary} — will sync when online` });
        reset();
      }
    } finally {
      setBusy(false);
    }
  };

  const isReceipt = entryType === 'RECEIPT';
  const typeHint =
    entryType === 'RECEIPT' ? 'Stock into a warehouse — goods received, production output, returns.'
    : entryType === 'ISSUE' ? 'Stock out of a warehouse — issue to production, scrap, sales.'
    : 'Move stock from one warehouse to another.';

  const filledLines = lines.filter((l) => !!l.productId);
  const totalQty = lines.reduce((s, l) => s + (l.productId ? num(l.quantity) : 0), 0);
  const lineCount = filledLines.length;
  const colSpan = isReceipt ? 7 : 5;

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <button className="btn btn-sm" onClick={() => navigate('/inventory/stock')}>Back</button>
          <h1>Quick stock entry</h1>
          <p className="muted">{typeHint}</p>
        </div>
        <div className="head-actions">
          <button className="btn" onClick={() => navigate('/inventory/stock')}>Cancel</button>
          <button className="btn" disabled={busy} onClick={() => submit('draft')}>{busy ? 'Saving…' : 'Save draft'}</button>
          <button className="btn btn-primary" disabled={busy} onClick={() => submit('post')}>
            {busy ? 'Posting…' : entryType === 'TRANSFER' ? 'Post transfer' : `Post ${TYPE_VERB[entryType]}`}
          </button>
        </div>
      </header>

      <div className="tabs" role="tablist" aria-label="Entry type" style={{ marginBottom: 16 }}>
        {(['RECEIPT', 'ISSUE', 'TRANSFER'] as EntryType[]).map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={entryType === t}
            className={entryType === t ? 'tab active' : 'tab'}
            onClick={() => setEntryType(t)}
          >
            {TYPE_LABEL[t]}
          </button>
        ))}
      </div>

      {error && <ErrorBanner error={error} />}

      {pending.length > 0 && (
        <div className="card card-pad" style={{ marginBottom: 12 }}>
          <div className="card-head" style={{ marginBottom: 8 }}>
            <h3>Pending offline entries</h3>
            <button className="btn btn-sm" disabled={!isOnline()} onClick={() => { void syncPending(); }}>Sync now</button>
          </div>
          <ul className="muted" style={{ margin: 0, paddingLeft: 18 }}>
            {pending.map((e) => <li key={e.id}>{e.summary}</li>)}
          </ul>
        </div>
      )}

      <section className="card card-pad">
        <div className="form-grid">
          {entryType === 'TRANSFER' ? (
            <>
              <div className="field field-required">
                <label>From warehouse</label>
                <select value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
                  <option value="">Select…</option>
                  {warehouses.map((w) => <option key={String(w.id)} value={String(w.id)}>{String(pick(w, 'code'))} · {String(pick(w, 'name'))}</option>)}
                </select>
              </div>
              <div className="field field-required">
                <label>To warehouse</label>
                <select value={toWarehouseId} onChange={(e) => setToWarehouseId(e.target.value)}>
                  <option value="">Select…</option>
                  {warehouses.map((w) => <option key={String(w.id)} value={String(w.id)}>{String(pick(w, 'code'))} · {String(pick(w, 'name'))}</option>)}
                </select>
              </div>
            </>
          ) : (
            <div className="field field-required">
              <label>Warehouse</label>
              <select value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
                <option value="">Select…</option>
                {warehouses.map((w) => <option key={String(w.id)} value={String(w.id)}>{String(pick(w, 'code'))} · {String(pick(w, 'name'))}</option>)}
              </select>
            </div>
          )}
          <div className="field">
            <label>Reference</label>
            <input value={referenceNo} onChange={(e) => setReferenceNo(e.target.value)} placeholder="Delivery note, work order, etc." />
          </div>
          <div className="field" style={{ gridColumn: '1 / -1' }}>
            <label>Notes</label>
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>
        </div>
      </section>

      <section className="card">
        <div className="card-head">
          <h3>Items</h3>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <span className="hint">{lineCount} line{lineCount === 1 ? '' : 's'}{lineCount > 0 ? ` · ${totalQty} total` : ''}</span>
            <button className="btn btn-sm" onClick={addLine}>+ Line</button>
          </div>
        </div>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Item</th>
                <th className="cell-num">Qty</th>
                <th>Batch / lot</th>
                <th>Bin</th>
                {isReceipt && <th className="cell-num">Unit cost</th>}
                {isReceipt && <th>Expiry</th>}
                <th />
              </tr>
            </thead>
            <tbody>
              {lines.map((l, i) => {
                const isLast = i === lines.length - 1;
                const enterAddsLine = isLast ? (e: React.KeyboardEvent<HTMLInputElement>) => {
                  if (e.key === 'Enter') { e.preventDefault(); addLine(); }
                } : undefined;
                return (
                  <tr key={l.key}>
                    <td>
                      <EntityPicker
                        endpoint="/api/inventory/items"
                        mapRow={mapItemRow}
                        value={l.productId ? String(l.productId) : ''}
                        initialLabel={l.label || undefined}
                        placeholder="Search item…"
                        autoFocus={i === 0}
                        onChange={(v, o) => setLines((p) => p.map((x) => x.key === l.key ? { ...x, productId: v ? Number(v) : '', label: o?.label ?? '' } : x))}
                      />
                    </td>
                    <td><input className="cell-input" type="number" min={0} value={l.quantity} onKeyDown={enterAddsLine} onChange={(e) => setLines((p) => p.map((x) => x.key === l.key ? { ...x, quantity: num(e.target.value) } : x))} /></td>
                    <td>
                      <EntityPicker
                        endpoint="/api/inventory/batches"
                        mapRow={mapBatchRow}
                        value={l.batchId ? String(l.batchId) : ''}
                        placeholder="Batch…"
                        onChange={(v) => setLines((p) => p.map((x) => x.key === l.key ? { ...x, batchId: v ? Number(v) : '' } : x))}
                      />
                    </td>
                    <td>
                      <select className="cell-input" value={l.binId ? String(l.binId) : ''} onChange={(e) => setLines((p) => p.map((x) => x.key === l.key ? { ...x, binId: e.target.value ? Number(e.target.value) : '' } : x))}>
                        <option value="">—</option>
                        {bins.map((b) => <option key={String(b.id)} value={String(b.id)}>{String(pick(b, 'code'))}</option>)}
                      </select>
                    </td>
                    {isReceipt && <td><input className="cell-input" type="number" min={0} step="0.01" value={l.unitCost} onKeyDown={enterAddsLine} onChange={(e) => setLines((p) => p.map((x) => x.key === l.key ? { ...x, unitCost: num(e.target.value) } : x))} /></td>}
                    {isReceipt && <td><input className="cell-input" type="date" value={l.expiryDate} onKeyDown={enterAddsLine} onChange={(e) => setLines((p) => p.map((x) => x.key === l.key ? { ...x, expiryDate: e.target.value } : x))} /></td>}
                    <td>
                      <button className="btn btn-sm" disabled={lines.length === 1} onClick={() => setLines((p) => (p.length === 1 ? p : p.filter((x) => x.key !== l.key)))}>
                        Remove
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={colSpan}>
                  <button className="btn btn-sm" onClick={addLine}>+ Add line</button>
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      </section>
    </div>
  );
}
