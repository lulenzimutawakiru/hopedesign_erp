import { useEffect, useState } from 'react';
import { api, fmtDate } from '../api';
import { Badge, ErrorBanner, PageLoader } from '../components/ui';
import { pick } from '../helpers';
import { navigate } from '../router';

interface TraceData {
  qr: Record<string, unknown>;
  movements: Record<string, unknown>[];
  custodyEvents: Record<string, unknown>[];
}

export default function QrTrace({ code }: { code: string }) {
  const [data, setData] = useState<TraceData | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api<{ data: TraceData }>(`/api/qr/traceability/${encodeURIComponent(code)}`)
      .then((r) => setData(r.data))
      .catch((e) => setError(e instanceof Error ? e.message : 'QR trace failed'));
  }, [code]);

  if (error) return <ErrorBanner error={error} />;
  if (!data) return <PageLoader label="Tracing QR…" />;

  const qr = data.qr;

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>QR Traceability</h1>
          <p className="muted cell-mono">{code}</p>
        </div>
        {['AUTHENTIC', 'VERIFIED'].includes(String(pick(qr, 'status') ?? '').toUpperCase()) && (
          <div className="scan-verified" style={{ margin: 0 }}>
            <div className="verify-mark">✓ QR VERIFIED</div>
            <div className="verify-code">{code}</div>
          </div>
        )}
      </header>

      <ol className="trace-chain" aria-label="Product journey">
        {['Supplier', 'Raw material', 'GRN', 'Warehouse', 'Machine', 'Production', 'QC', 'Finished goods', 'Customer'].map((n) => (
          <li key={n}><span>{n}</span></li>
        ))}
      </ol>

      <section className="card">
        <div className="card-head"><h3>QR Identity</h3><Badge value={pick(qr, 'status')} /></div>
        <dl className="detail-list">
          <div className="detail-row"><dt>Entity</dt><dd>{String(pick(qr, 'entity_type', 'entityType') ?? '-')} #{String(pick(qr, 'entity_id', 'entityId') ?? '-')}</dd></div>
          <div className="detail-row"><dt>Product</dt><dd>{String(pick(qr, 'product_name', 'productName') ?? pick(qr, 'product_code', 'productCode') ?? '-')}</dd></div>
          <div className="detail-row"><dt>Batch</dt><dd>{String(pick(qr, 'batch_no', 'batchNo') ?? '-')}</dd></div>
          <div className="detail-row"><dt>Created</dt><dd>{fmtDate(pick(qr, 'created_at', 'createdAt'))}</dd></div>
          <div className="detail-row"><dt>First scan</dt><dd>{fmtDate(pick(qr, 'first_scanned_at', 'firstScannedAt'))}</dd></div>
          <div className="detail-row"><dt>Last scan</dt><dd>{fmtDate(pick(qr, 'last_scanned_at', 'lastScannedAt'))}</dd></div>
          <div className="detail-row"><dt>Scan count</dt><dd>{String(pick(qr, 'scan_count', 'scanCount') ?? '0')}</dd></div>
        </dl>
        <div className="flow-actions">
          <button className="btn btn-primary" onClick={() => navigate(`/records/${String(pick(qr, 'entity_type', 'entityType') ?? '').split('.')[0]}/${String(pick(qr, 'entity_type', 'entityType') ?? '').split('.')[1]}/${String(pick(qr, 'entity_id', 'entityId') ?? 0)}`)}>
            Open linked record
          </button>
          <button className="btn" onClick={() => navigate('/qr/scan')}>Scan another</button>
        </div>
      </section>

      <section className="card">
        <div className="card-head"><h3>Inventory Movements</h3></div>
        <div className="timeline">
          {data.movements.length === 0 && <p className="muted">No movements recorded.</p>}
          {data.movements.map((m) => (
            <div className="timeline-item" key={String(m.id)}>
              <div className="timeline-dot" />
              <div className="timeline-body">
                <div className="timeline-title"><Badge value={pick(m, 'movement_type', 'movementType')} /></div>
                <div className="timeline-meta">
                  {fmtDate(pick(m, 'moved_at', 'movedAt'))} · {String(pick(m, 'warehouse_name', 'warehouseName') ?? pick(m, 'warehouse_code', 'warehouseCode') ?? '')}
                  {' '}· qty {String(pick(m, 'quantity', 'qty') ?? '')}
                </div>
              </div>
            </div>
          ))}
        </div>
      </section>

      {data.custodyEvents.length > 0 && (
        <section className="card">
          <div className="card-head"><h3>Secure Custody Events</h3></div>
          <div className="timeline">
            {data.custodyEvents.map((ev, i) => (
              <div className="timeline-item" key={i}>
                <div className="timeline-dot" />
                <div className="timeline-body">
                  <div className="timeline-title"><Badge value={pick(ev, 'event_type', 'eventType')} /></div>
                  <div className="timeline-meta">{fmtDate(pick(ev, 'occurred_at', 'occurredAt'))} · {String(pick(ev, 'actor_name', 'actorName') ?? '')}</div>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
