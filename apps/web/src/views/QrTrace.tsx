import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ApiError, api, fmtDate, fmtNum } from '../api';
import { can, useAuth, type MeUser } from '../auth';
import { describeError } from '../components/errorText';
import { ErrorState } from '../components/states';
import { toast } from '../components/toast';
import { Badge, PageLoader } from '../components/ui';
import { eventLabel, pick, titleCase } from '../helpers';
import { itemVisible } from '../nav';
import { navigate } from '../router';

type Row = Record<string, unknown>;

interface TraceData {
  qr: Row;
  movements: Row[];
  custodyEvents: Row[];
}

interface PackInfo {
  ream: Row | null;
  carton: Row | null;
  members: Row[];
}

interface ChainNode {
  key: string;
  kind: string;
  value: string;
  href?: string | null;
}

const EMPTY_PACK: PackInfo = { ream: null, carton: null, members: [] };

/** Navigation visibility is a UX affordance only; the API remains authoritative. */
function mayOpen(user: MeUser | null, perm: string, module: string): boolean {
  return itemVisible(user, { perm, module });
}

function numOrDash(v: unknown): string {
  return v === null || v === undefined || v === '' ? '-' : fmtNum(v);
}

/**
 * Resolve a QR entity type to a route the signed-in user can actually open.
 * Types with no known destination stay plain text rather than dead links.
 */
function entityHref(user: MeUser | null, entityType: unknown, entityId: unknown): string | null {
  const type = String(entityType ?? '').trim().toUpperCase();
  const raw = entityId === null || entityId === undefined ? '' : String(entityId);
  if (!type || !raw || raw === '0') return null;
  const id = encodeURIComponent(raw);
  switch (type) {
    case 'PRODUCT':
      return mayOpen(user, 'inventory.items.view', 'inventory') ? '/inventory/items/' + id : null;
    case 'RAW_MATERIAL':
      return mayOpen(user, 'inventory.items.view', 'inventory') ? '/inventory/materials/' + id : null;
    case 'CONSUMABLE':
      return mayOpen(user, 'inventory.items.view', 'inventory') ? '/inventory/consumables/' + id : null;
    case 'BATCH': {
      const canTrace =
        mayOpen(user, 'inventory.stock.view', 'inventory') &&
        mayOpen(user, 'inventory.traceability.view', 'inventory');
      if (canTrace) return '/inventory-intel/trace/' + id;
      return mayOpen(user, 'inventory.batches.view', 'inventory') ? '/records/inventory/batches/' + id : null;
    }
    case 'WORK_ORDER':
      return mayOpen(user, 'production.work_orders.view', 'production') ? '/records/production/work_orders/' + id : null;
    case 'MACHINE':
      return mayOpen(user, 'production.machines.view', 'production') ? '/records/production/machines/' + id : null;
    case 'ASSET':
      return mayOpen(user, 'assets.register.view', 'assets') ? '/records/assets/register/' + id : null;
    case 'CUSTOMER':
      return mayOpen(user, 'crm.customers.view', 'crm') ? '/crm/customers/' + id : null;
    case 'BIN':
      return mayOpen(user, 'inventory.bins.view', 'inventory') ? '/records/inventory/bins/' + id : null;
    case 'SECURITY_JOB':
      return mayOpen(user, 'security_printing.jobs.view', 'security_printing') ? '/security-jobs' : null;
    case 'REAM':
    case 'CARTON':
      return mayOpen(user, 'qr.packing.scan', 'security_printing') ? '/packing' : null;
    default:
      return null;
  }
}

/** Build the lineage from what the API actually returned. Nothing is invented. */
function buildChain(
  user: MeUser | null,
  qr: Row,
  qrCode: string,
  data: TraceData,
  custodyVisible: boolean,
): ChainNode[] {
  const entityType = String(pick(qr, 'entityType', 'entity_type') ?? '').trim().toUpperCase();
  const entityId = pick(qr, 'entityId', 'entity_id');
  const productName = pick(qr, 'productName', 'product_name');
  const batchId = pick(qr, 'batchId', 'batch_id');
  const batchNo = pick(qr, 'batchNo', 'batch_no');
  const productIsEntity =
    entityType === 'PRODUCT' || entityType === 'RAW_MATERIAL' || entityType === 'CONSUMABLE';

  const nodes: ChainNode[] = [{ key: 'qr', kind: 'QR code', value: qrCode }];

  if (productName) {
    nodes.push({
      key: 'product',
      kind: 'Product',
      value: String(productName),
      href: productIsEntity ? entityHref(user, entityType, entityId) : null,
    });
  }

  if (batchNo) {
    nodes.push({
      key: 'batch',
      kind: 'Batch',
      value: String(batchNo),
      href: batchId === null || batchId === undefined ? null : entityHref(user, 'BATCH', batchId),
    });
  }

  if (entityType && !productIsEntity && entityType !== 'BATCH') {
    const href = entityHref(user, entityType, entityId);
    if (href) {
      nodes.push({ key: 'entity', kind: titleCase(entityType), value: '#' + String(entityId ?? ''), href });
    }
  }

  const firstMove = data.movements.length > 0 ? data.movements[0] : {};
  const warehouseCode =
    pick(qr, 'warehouseCode', 'warehouse_code') ?? pick(firstMove, 'warehouseCode', 'warehouse_code');
  if (warehouseCode) {
    nodes.push({
      key: 'warehouse',
      kind: 'Warehouse',
      value: String(warehouseCode),
      href: mayOpen(user, 'inventory.warehouses.view', 'inventory') ? '/inventory/warehouses' : null,
    });
  }

  if (data.movements.length > 0) {
    nodes.push({ key: 'movements', kind: 'Inventory movements', value: String(data.movements.length) });
  }

  if (custodyVisible && data.custodyEvents.length > 0) {
    nodes.push({ key: 'custody', kind: 'Custody events', value: String(data.custodyEvents.length) });
  }

  return nodes;
}

function Kv({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="kv">
      <span className="kv-k">{label}</span>
      <span className="kv-v">{children}</span>
    </div>
  );
}

function ChainList({ nodes }: { nodes: ChainNode[] }) {
  if (nodes.length === 0) {
    return <p className="muted" style={{ padding: 12 }}>No lineage information available.</p>;
  }
  return (
    <div className="related-list">
      {nodes.map((n) => {
        const href = n.href;
        const label = (
          <span>
            <span className="muted">{n.kind}</span> <span className="cell-mono">{n.value}</span>
          </span>
        );
        return href ? (
          <button key={n.key} className="related-item" onClick={() => navigate(href)}>
            {label}
            <span className="muted" aria-hidden>›</span>
          </button>
        ) : (
          <div key={n.key} className="related-item">{label}</div>
        );
      })}
    </div>
  );
}

export default function QrTrace({ code }: { code: string }) {
  const { user } = useAuth();
  const [data, setData] = useState<TraceData | null>(null);
  const [pack, setPack] = useState<PackInfo>(EMPTY_PACK);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const reqRef = useRef(0);

  const load = useCallback(() => {
    const token = reqRef.current + 1;
    reqRef.current = token;
    setLoading(true);
    setError(null);
    api<{ data: TraceData }>('/api/qr/traceability/' + encodeURIComponent(code))
      .then((r) => {
        if (reqRef.current !== token) return;
        setData(r.data);
      })
      .catch((e) => {
        if (reqRef.current !== token) return;
        setError(e);
      })
      .finally(() => {
        if (reqRef.current === token) setLoading(false);
      });
  }, [code]);

  useEffect(() => {
    setData(null);
    setPack(EMPTY_PACK);
    load();
  }, [code, load]);

  const entityType = data ? String(pick(data.qr, 'entityType', 'entity_type') ?? '').trim().toUpperCase() : '';
  const custodyVisible = entityType === 'SECURITY_JOB';

  // Ream/carton detail is an enrichment: the main trace must stand on its own.
  useEffect(() => {
    setPack(EMPTY_PACK);
    if (entityType !== 'REAM' && entityType !== 'CARTON') return;
    const perm = entityType === 'REAM' ? 'qr.reams.view' : 'qr.cartons.view';
    if (!can(user, perm)) return;
    let alive = true;
    const path =
      entityType === 'REAM'
        ? '/api/qr/reams/' + encodeURIComponent(code)
        : '/api/qr/cartons/' + encodeURIComponent(code);
    api<{ data: Row }>(path)
      .then((r) => {
        if (!alive) return;
        const row = r.data ?? null;
        if (!row) return;
        if (entityType === 'REAM') {
          setPack({ ream: row, carton: null, members: [] });
        } else {
          const members = Array.isArray(row.members) ? (row.members as Row[]) : [];
          setPack({ ream: null, carton: row, members });
        }
      })
      .catch((e) => {
        if (!alive) return;
        if (e instanceof ApiError && e.status === 404) return;
        toast.fromError('Could not load the packing record', e);
      });
    return () => {
      alive = false;
    };
  }, [entityType, code, user]);

  if (error) {
    return (
      <div className="page">
        <header className="page-head">
          <div>
            <p className="mod-kicker" data-mod="sec">Secure print</p>
            <h1>QR traceability</h1>
            <p className="muted cell-mono">{code}</p>
          </div>
        </header>
        <ErrorState title="Trace unavailable" message={describeError(error)} onRetry={load} />
      </div>
    );
  }

  if (loading || !data) return <PageLoader variant="page" label="Tracing QR…" />;

  const qr = data.qr;
  const qrCode = String(pick(qr, 'qrCode', 'qr_code') ?? code);
  const entityIdText = pick(qr, 'entityId', 'entity_id');
  const entityTypeLabel = entityType ? titleCase(entityType) : '-';
  const entityLink = entityHref(user, entityType, entityIdText);
  const scanCount = Number(pick(qr, 'scanCount', 'scan_count') ?? 0);
  const firstScanAt = pick(qr, 'firstScanAt', 'first_scan_at');
  const nodes = buildChain(user, qr, qrCode, data, custodyVisible);

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="mod-kicker" data-mod="sec">Secure print</p>
          <h1>QR traceability</h1>
          <p className="muted"><span className="cell-mono">{qrCode}</span></p>
        </div>
        <div className="head-actions">
          {entityLink ? (
            <button className="btn btn-primary" onClick={() => navigate(entityLink)}>
              Open {entityTypeLabel}
            </button>
          ) : null}
          <button className="btn" onClick={() => navigate('/qr/scan')}>Scan another</button>
        </div>
      </header>

      {scanCount > 0 && (
        <div className="scan-verified">
          <div className="verify-mark">SCAN RECORD</div>
          <div className="verify-code">{qrCode}</div>
          <p className="muted" style={{ margin: '6px 0 0' }}>
            {fmtNum(scanCount)} scan(s) on record · First recorded scan {fmtDate(firstScanAt)}
          </p>
        </div>
      )}

      <section className="card">
        <div className="card-head">
          <h3>QR identity</h3>
          <Badge value={pick(qr, 'qrStatus', 'qr_status')} />
        </div>
        <div className="card-pad">
          <div className="kv-grid">
            <Kv label="Entity">
              {entityTypeLabel === '-' ? '-' : entityTypeLabel + ' #' + String(entityIdText ?? '-')}
            </Kv>
            <Kv label="Product">
              {String(pick(qr, 'productName', 'product_name') ?? pick(qr, 'productId', 'product_id') ?? '-')}
            </Kv>
            <Kv label="Batch">{String(pick(qr, 'batchNo', 'batch_no') ?? '-')}</Kv>
            <Kv label="Warehouse">{String(pick(qr, 'warehouseCode', 'warehouse_code') ?? '-')}</Kv>
            <Kv label="Generated">{fmtDate(pick(qr, 'generatedAt', 'generated_at'))}</Kv>
            <Kv label="First scan">{fmtDate(firstScanAt)}</Kv>
            <Kv label="Last scan">{fmtDate(pick(qr, 'lastScanAt', 'last_scan_at'))}</Kv>
            <Kv label="Scans">{numOrDash(pick(qr, 'scanCount', 'scan_count'))}</Kv>
          </div>
        </div>
      </section>

      <section className="card">
        <div className="card-head"><h3>Traceability chain</h3></div>
        <ChainList nodes={nodes} />
      </section>

      {pack.ream && (
        <section className="card">
          <div className="card-head">
            <h3>Ream record</h3>
            <Badge value={pick(pack.ream, 'status')} />
          </div>
          <div className="card-pad">
            <div className="kv-grid">
              <Kv label="Ream no">{String(pick(pack.ream, 'reamNo', 'ream_no') ?? '-')}</Kv>
              <Kv label="Product">
                {String(
                  pick(pack.ream, 'productName', 'product_name') ??
                    pick(pack.ream, 'productCode', 'product_code') ??
                    '-',
                )}
              </Kv>
              <Kv label="Batch">{String(pick(pack.ream, 'batchNo', 'batch_no') ?? '-')}</Kv>
              <Kv label="Sheets">{numOrDash(pick(pack.ream, 'sheets'))}</Kv>
              <Kv label="GSM">{String(pick(pack.ream, 'gsm') ?? '-')}</Kv>
              <Kv label="Size">{String(pick(pack.ream, 'size') ?? '-')}</Kv>
              <Kv label="Carton">{String(pick(pack.ream, 'cartonNo', 'carton_no') ?? '-')}</Kv>
              <Kv label="Packed">{fmtDate(pick(pack.ream, 'packedAt', 'packed_at'))}</Kv>
            </div>
          </div>
        </section>
      )}

      {pack.carton && (
        <section className="card">
          <div className="card-head">
            <h3>Carton record</h3>
            <Badge value={pick(pack.carton, 'status')} />
          </div>
          <div className="card-pad">
            <div className="kv-grid">
              <Kv label="Carton no">{String(pick(pack.carton, 'cartonNo', 'carton_no') ?? '-')}</Kv>
              <Kv label="Product">
                {String(
                  pick(pack.carton, 'productName', 'product_name') ??
                    pick(pack.carton, 'productCode', 'product_code') ??
                    '-',
                )}
              </Kv>
              <Kv label="Batch">{String(pick(pack.carton, 'batchNo', 'batch_no') ?? '-')}</Kv>
              <Kv label="Reams">{numOrDash(pick(pack.carton, 'reamCount', 'ream_count'))}</Kv>
              <Kv label="Created">{fmtDate(pick(pack.carton, 'createdAt', 'created_at'))}</Kv>
            </div>
          </div>
          {pack.members.length > 0 && (
            <div className="card-pad">
              <table className="mini-table">
                <thead>
                  <tr>
                    <th scope="col">Seq</th>
                    <th scope="col">Ream</th>
                    <th scope="col">QR code</th>
                    <th scope="col">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {pack.members.map((m, i) => (
                    <tr key={String(pick(m, 'reamId', 'ream_id') ?? pick(m, 'code') ?? i)}>
                      <td>{String(pick(m, 'seq') ?? '-')}</td>
                      <td className="cell-mono">{String(pick(m, 'reamNo', 'ream_no') ?? '-')}</td>
                      <td className="cell-mono">{String(pick(m, 'code') ?? '-')}</td>
                      <td><Badge value={pick(m, 'reamStatus', 'ream_status')} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      <section className="card">
        <div className="card-head">
          <h3>Inventory movements</h3>
          <span className="muted">{data.movements.length}</span>
        </div>
        <div className="card-pad">
          <div className="timeline">
            {data.movements.length === 0 && (
              <p className="muted">No inventory movements recorded for this code.</p>
            )}
            {data.movements.map((m, i) => {
              const warehouse =
                pick(m, 'warehouseName', 'warehouse_name') ?? pick(m, 'warehouseCode', 'warehouse_code');
              const qty = pick(m, 'quantity');
              const ref = pick(m, 'referenceCode', 'reference_code');
              return (
                <div className="timeline-item" key={String(pick(m, 'id') ?? i)}>
                  <span className="timeline-dot" aria-hidden />
                  <div className="timeline-body">
                    <div className="timeline-title">
                      <span>{eventLabel(pick(m, 'movementType', 'movement_type')) || 'Movement'}</span>
                      <Badge value={pick(m, 'status')} />
                    </div>
                    <div className="timeline-meta">
                      {fmtDate(pick(m, 'createdAt', 'created_at'))}
                      {warehouse ? ' · ' + String(warehouse) : ''}
                      {qty === null || qty === undefined ? '' : ' · Qty ' + fmtNum(qty)}
                      {ref ? ' · ' + String(ref) : ''}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {custodyVisible && (
        <section className="card">
          <div className="card-head">
            <h3>Secure custody events</h3>
            <span className="muted">{data.custodyEvents.length}</span>
          </div>
          <div className="card-pad">
            <div className="timeline">
              {data.custodyEvents.length === 0 && (
                <p className="muted">No custody events recorded for this job.</p>
              )}
              {data.custodyEvents.map((ev, i) => {
                const from = pick(ev, 'fromLocation', 'from_location');
                const to = pick(ev, 'toLocation', 'to_location');
                const step = from && to ? String(from) + ' → ' + String(to) : String(from ?? to ?? '');
                const actor = pick(ev, 'actorName', 'actor_name');
                const notes = pick(ev, 'notes');
                return (
                  <div className="timeline-item" key={String(pick(ev, 'id') ?? i)}>
                    <span className="timeline-dot" aria-hidden />
                    <div className="timeline-body">
                      <div className="timeline-title">
                        {eventLabel(pick(ev, 'eventType', 'event_type')) || 'Custody event'}
                      </div>
                      <div className="timeline-meta">
                        {fmtDate(pick(ev, 'occurredAt', 'occurred_at'))}
                        {actor ? ' · ' + String(actor) : ''}
                        {step ? ' · ' + step : ''}
                      </div>
                      {notes ? <div className="timeline-meta">{String(notes)}</div> : null}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </section>
      )}
    </div>
  );
}
