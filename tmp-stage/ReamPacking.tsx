import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { ErrorBanner, PageLoader } from '../components/ui';
import { pick } from '../helpers';

interface ProductRow {
  id: number;
  code?: string;
  name?: string;
  type?: string;
  [key: string]: unknown;
}

interface ReamGeneratedRow {
  id: number;
  reamNo?: string;
  qrId?: number;
  code?: string;
  secret?: string;
  payload?: string;
  [key: string]: unknown;
}

interface CartonResult {
  cartonId?: number;
  cartonNo?: string;
  qrId?: number;
  code?: string;
  secret?: string;
  payload?: string;
  reams?: { reamId: number; reamNo: string; qrId: number; code: string }[];
  [key: string]: unknown;
}

interface SpooledLabel {
  id: number;
  labelNo: string;
  code: string;
  imageDataUrl?: string;
  [key: string]: unknown;
}

interface SpoolResult {
  jobNo: string;
  jobId: number;
  labels: SpooledLabel[];
}

const REAMS_PER_CARTON = 5;
const str = (v: unknown) => (v === null || v === undefined ? '' : String(v));
const num = (v: unknown) => Number(v ?? 0);

export default function ReamPacking() {
  const [products, setProducts] = useState<ProductRow[]>([]);
  const [productId, setProductId] = useState<number>(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Generate reams
  const [count, setCount] = useState(5);
  const [generated, setGenerated] = useState<ReamGeneratedRow[]>([]);
  const [genError, setGenError] = useState('');
  const [genBusy, setGenBusy] = useState(false);

  // Ream label printing
  const [spool, setSpool] = useState<SpoolResult | null>(null);
  const [spoolError, setSpoolError] = useState('');
  const [spoolBusy, setSpoolBusy] = useState(false);

  // Packing line
  const [scanned, setScanned] = useState<{ code: string; reamNo: string; status: string }[]>([]);
  const [scanInput, setScanInput] = useState('');
  const [scanError, setScanError] = useState('');
  const [scanBusy, setScanBusy] = useState(false);
  const [carton, setCarton] = useState<CartonResult | null>(null);
  const [sealBusy, setSealBusy] = useState(false);
  const [sealError, setSealError] = useState('');

  useEffect(() => {
    api<{ data: ProductRow[] }>('/api/inventory/items?pageSize=100')
      .then((r) => {
        const reams = (r.data ?? []).filter((p) => str(p.type) === 'REAM');
        setProducts(reams);
        if (reams.length > 0) setProductId(num(reams[0].id));
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load ream products'))
      .finally(() => setLoading(false));
  }, []);

  const reamProducts = useMemo(() => products, [products]);
  const selectedProduct = reamProducts.find((p) => num(p.id) === productId);

  const generate = async () => {
    if (!productId || genBusy) return;
    setGenBusy(true);
    setGenError('');
    setSpool(null);
    try {
      const r = await api<{ data: ReamGeneratedRow[] }>('/api/qr/reams/generate', {
        method: 'POST',
        body: JSON.stringify({ productId, count: Math.max(1, Math.min(100, count)) }),
      });
      setGenerated(r.data ?? []);
    } catch (e) {
      setGenError(e instanceof Error ? e.message : 'Generation failed');
    } finally {
      setGenBusy(false);
    }
  };

  const printReamLabels = async () => {
    if (generated.length === 0 || spoolBusy) return;
    setSpoolBusy(true);
    setSpoolError('');
    try {
      const items = generated.map((g) => ({ qrId: num(g.qrId), payload: str(g.payload) }));
      const r = await api<{ data: SpoolResult }>('/api/qr/labels/spool', {
        method: 'POST',
        body: JSON.stringify({ items }),
      });
      setSpool(r.data ?? null);
    } catch (e) {
      setSpoolError(e instanceof Error ? e.message : 'Spool failed');
    } finally {
      setSpoolBusy(false);
    }
  };

  const scanReam = async (raw: string) => {
    const code = raw.trim();
    if (!code || scanBusy) return;
    setScanBusy(true);
    setScanError('');
    setScanInput('');
    try {
      if (scanned.some((s) => s.code === code)) {
        setScanError('Ream already scanned into this carton');
        return;
      }
      if (scanned.length >= REAMS_PER_CARTON) {
        setScanError(`A carton holds exactly ${REAMS_PER_CARTON} reams - seal it first`);
        return;
      }
      const r = await api<{ data: { result: string; ream: { reamNo?: string; status?: string } } }>(
        '/api/qr/packing/scan',
        { method: 'POST', body: JSON.stringify({ code }) }
      );
      if (r.data?.result !== 'AUTHENTIC') {
        setScanError(`Scan not authentic: ${str(r.data?.result)}`);
        return;
      }
      setScanned((prev) => [
        ...prev,
        { code, reamNo: str(r.data?.ream?.reamNo ?? code), status: str(r.data?.ream?.status ?? '') },
      ]);
    } catch (e) {
      setScanError(e instanceof Error ? e.message : 'Scan failed');
    } finally {
      setScanBusy(false);
    }
  };

  const seal = async () => {
    if (scanned.length !== REAMS_PER_CARTON || !productId || sealBusy) return;
    setSealBusy(true);
    setSealError('');
    try {
      const r = await api<{ data: CartonResult }>('/api/qr/packing/seal', {
        method: 'POST',
        body: JSON.stringify({ productId, reamCodes: scanned.map((s) => s.code) }),
      });
      setCarton(r.data ?? null);
      setScanned([]);
    } catch (e) {
      setSealError(e instanceof Error ? e.message : 'Sealing failed');
    } finally {
      setSealBusy(false);
    }
  };

  const printCartonLabel = async () => {
    if (!carton || spoolBusy) return;
    setSpoolBusy(true);
    setSpoolError('');
    try {
      const r = await api<{ data: SpoolResult }>('/api/qr/labels/spool', {
        method: 'POST',
        body: JSON.stringify({ items: [{ qrId: num(carton.qrId), payload: str(carton.payload) }] }),
      });
      setSpool(r.data ?? null);
    } catch (e) {
      setSpoolError(e instanceof Error ? e.message : 'Spool failed');
    } finally {
      setSpoolBusy(false);
    }
  };

  if (loading) return <PageLoader label="Loading ream products..." />;
  if (error) return <ErrorBanner error={error} />;

  const readyToSeal = scanned.length === REAMS_PER_CARTON;

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Ream Packing</h1>
          <p className="muted">Generate unique ream QRs, pack 5 reams into one carton and seal it.</p>
        </div>
      </header>

      <section className="card">
        <div className="card-head"><h3>1 · Product</h3></div>
        <label className="field">
          <span>Ream product</span>
          <select value={productId} onChange={(e) => setProductId(num(e.target.value))}>
            {reamProducts.map((p) => (
              <option key={num(p.id)} value={num(p.id)}>
                {str(p.code)} · {str(p.name)}
              </option>
            ))}
          </select>
        </label>
        {selectedProduct && (
          <p className="muted">
            {str(selectedProduct.name)} · {str(pick(selectedProduct, 'gsm'))} gsm ·{' '}
            {str(pick(selectedProduct, 'sheetsPerReam', 'sheets_per_ream'))} sheets/ream
          </p>
        )}
      </section>

      <section className="card">
        <div className="card-head"><h3>2 · Generate ream QRs</h3></div>
        <div className="grid-2">
          <label className="field">
            <span>Number of reams (1–100)</span>
            <input type="number" min={1} max={100} value={count} onChange={(e) => setCount(num(e.target.value))} />
          </label>
          <div className="field">
            <span>&nbsp;</span>
            <button className="btn btn-primary" disabled={!productId || genBusy} onClick={() => void generate()}>
              {genBusy ? 'Generating...' : 'Generate reams'}
            </button>
          </div>
        </div>
        {genError && <div className="alert alert-error">{genError}</div>}
        {generated.length > 0 && (
          <>
            <p className="muted">Generated {generated.length} unique ream QR(s). Each carries a secret payload - print the labels, then scan them on the packing line.</p>
            <div className="table-wrap" style={{ marginTop: 8 }}>
              <table className="table">
                <thead>
                  <tr><th>Ream</th><th>QR code</th><th>Payload</th></tr>
                </thead>
                <tbody>
                  {generated.slice(0, 10).map((g) => (
                    <tr key={num(g.id)}>
                      <td className="cell-mono">{str(g.reamNo)}</td>
                      <td className="cell-mono">{str(g.code)}</td>
                      <td className="cell-mono" title="Secret payload - printed on the label only">{str(g.payload).split('|')[0]}|•••</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flow-actions" style={{ marginTop: 10 }}>
              <button className="btn btn-primary" disabled={spoolBusy} onClick={() => void printReamLabels()}>
                {spoolBusy ? 'Spooling...' : 'Print ream labels (Niimbot)'}
              </button>
            </div>
          </>
        )}
      </section>

      <section className="card">
        <div className="card-head"><h3>3 · Packing line</h3></div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void scanReam(scanInput);
          }}
        >
          <label className="field">
            <span>Scan ream QR ({scanned.length}/{REAMS_PER_CARTON})</span>
            <input
              value={scanInput}
              onChange={(e) => setScanInput(e.target.value)}
              placeholder="Scan or type the ream QR code"
              autoFocus
            />
          </label>
          {scanError && <div className="alert alert-error">{scanError}</div>}
          <button className="btn btn-primary" disabled={!scanInput.trim() || scanBusy}>
            {scanBusy ? 'Scanning...' : 'Scan ream'}
          </button>
        </form>

        {scanned.length > 0 && (
          <div className="table-wrap" style={{ marginTop: 12 }}>
            <table className="table">
              <thead>
                <tr><th>#</th><th>Ream</th><th>QR code</th><th>Status</th></tr>
              </thead>
              <tbody>
                {scanned.map((s, i) => (
                  <tr key={s.code}>
                    <td>{i + 1}</td>
                    <td className="cell-mono">{s.reamNo}</td>
                    <td className="cell-mono">{s.code}</td>
                    <td>{s.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="flow-actions" style={{ marginTop: 12 }}>
          <button className="btn btn-primary" disabled={!readyToSeal || sealBusy} onClick={() => void seal()}>
            {sealBusy ? 'Sealing...' : `Seal carton (${REAMS_PER_CARTON} reams)`}
          </button>
          <button
            className="btn btn-ghost"
            disabled={scanned.length === 0}
            onClick={() => {
              setScanned([]);
              setScanError('');
            }}
          >
            Clear
          </button>
        </div>
        {sealError && <div className="alert alert-error" style={{ marginTop: 8 }}>{sealError}</div>}

        {carton && (
          <div className="scan-verified" style={{ marginTop: 16 }}>
            <div className="verify-mark">✔ CARTON SEALED</div>
            <dl className="detail-list">
              <div className="detail-row"><dt>Carton no</dt><dd className="cell-mono">{str(carton.cartonNo ?? carton.carton_no)}</dd></div>
              <div className="detail-row"><dt>Carton QR</dt><dd className="cell-mono">{str(carton.code)}</dd></div>
              <div className="detail-row"><dt>Payload</dt><dd className="cell-mono">{str(carton.payload)}</dd></div>
              <div className="detail-row"><dt>Reams</dt><dd>{Array.isArray(carton.reams) ? carton.reams.length : REAMS_PER_CARTON}</dd></div>
            </dl>
            <div className="flow-actions">
              <button className="btn btn-primary" disabled={spoolBusy} onClick={() => void printCartonLabel()}>
                {spoolBusy ? 'Spooling...' : 'Print carton label (Niimbot)'}
              </button>
            </div>
          </div>
        )}
      </section>

      {spool && (
        <section className="card">
          <div className="card-head"><h3>Niimbot print spool</h3><span className="cell-mono">{spool.jobNo}</span></div>
          {spoolError && <div className="alert alert-error">{spoolError}</div>}
          <p className="muted">
            {spool.labels.length} label(s) queued. A bridge daemon polls <code>GET /api/qr/labels/spool</code>, prints on the
            Niimbot, then acknowledges each label.
          </p>
          {spool.labels[0]?.imageDataUrl && (
            <img
              src={spool.labels[0].imageDataUrl}
              alt={`Label preview ${spool.labels[0].code}`}
              style={{ maxWidth: 240, border: '1px solid var(--border)', borderRadius: 8, marginTop: 8 }}
            />
          )}
        </section>
      )}
    </div>
  );
}