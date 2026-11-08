import { useEffect, useMemo, useState } from 'react';
import { api, fmtMoney, fmtNum, EntityMeta, ListResult } from '../../api';
import { useAuth, can } from '../../auth';
import { Badge, ErrorBanner, Modal, PageLoader } from '../../components/ui';
import { JsonForm, FormSection, SelectOption } from '../../components/JsonForm';
import { EFRIS_UNITS_OF_MEASURE } from '../../data/efrisUnitsOfMeasure';

type Rec = Record<string, unknown>;
const n = (v: unknown) => Number(v ?? 0);

interface ProductOptions {
  units: { id: number; code: string; name: string }[];
  categories: { id: number; code: string; name: string }[];
  suppliers: { id: number; code: string; name: string }[];
}

/** Fixed enum options drawn from the products table CHECK constraints. */
const ENUM_OPTIONS: Record<string, SelectOption[]> = {
  type: [
    { value: 'REAM', label: 'Ream' },
    { value: 'SHEET', label: 'Sheet' },
    { value: 'FINISHED_GOODS', label: 'Finished goods' },
    { value: 'SECURITY_ITEM', label: 'Security paper' },
  ],
  securityClassification: [
    { value: 'NONE', label: 'None' },
    { value: 'RESTRICTED', label: 'Restricted' },
    { value: 'CONFIDENTIAL', label: 'Confidential' },
    { value: 'SECRET', label: 'Secret' },
  ],
  valuationMethod: [
    { value: 'FIFO', label: 'FIFO' },
    { value: 'WEIGHTED_AVERAGE', label: 'Weighted average' },
  ],
  abcClass: [
    { value: 'A', label: 'A' },
    { value: 'B', label: 'B' },
    { value: 'C', label: 'C' },
  ],
  xyzClass: [
    { value: 'X', label: 'X' },
    { value: 'Y', label: 'Y' },
    { value: 'Z', label: 'Z' },
  ],
  efrisRegistrationStatus: [
    { value: 'UNMAPPED', label: 'Unmapped' },
    { value: 'MAPPED', label: 'Mapped' },
    { value: 'SUBMITTED', label: 'Submitted' },
    { value: 'REGISTERED', label: 'Registered' },
    { value: 'EXCLUDED', label: 'Excluded' },
  ],
};

/** Static selects that don't need fetched lookup data (enums + official EFRIS UOM codes). */
const STATIC_SELECTS: Record<string, SelectOption[]> = {
  ...ENUM_OPTIONS,
  efrisUnitOfMeasure: EFRIS_UNITS_OF_MEASURE,
};

/** Field groups — anything not listed falls into a collapsed "More options". */
const SECTIONS: FormSection[] = [
  {
    title: 'Identity',
    defaultOpen: true,
    fields: ['code', 'name', 'sku', 'barcode', 'gtin', 'internalCode', 'brand', 'productFamily', 'variantName', 'description'],
  },
  {
    title: 'Classification & pricing',
    defaultOpen: true,
    fields: ['type', 'categoryId', 'unitId', 'securityClassification', 'valuationMethod', 'standardPrice', 'standardCost'],
  },
  {
    title: 'Paper specifications',
    defaultOpen: true,
    fields: ['gsm', 'widthMm', 'rollLengthM', 'rollDiameterMm', 'sheetsPerReam', 'reamWeightKg', 'weightPerUnit', 'lotSize'],
  },
  {
    title: 'Stock & replenishment',
    defaultOpen: true,
    fields: ['reorderPoint', 'safetyStock', 'leadTimeDays', 'moq', 'eoq', 'maxStock', 'abcClass', 'xyzClass', 'preferredSupplierId', 'countryOfOrigin', 'cycleCountFrequencyDays'],
  },
  {
    title: 'Traceability & tracking',
    defaultOpen: false,
    fields: ['isTracked', 'isSerialized', 'batchControlled', 'lotControlled', 'serialControlled', 'expiryControlled', 'inspectionRequired', 'isRfidEnabled', 'shelfLifeDays', 'storageRequirements', 'hazardClass'],
  },
  {
    title: 'EFRIS / URA registration',
    defaultOpen: false,
    description: 'Filled from the URA goods catalogue. Registration status is only ever confirmed by an operator, never auto-derived.',
    fields: ['efrisGoodsCode', 'efrisUnitOfMeasure', 'efrisGoodsCategoryId', 'efrisGoodsCategoryName', 'efrisGoodsName', 'efrisRegistrationStatus', 'efrisRegisteredAt'],
  },
];

/**
 * Sellable product catalogue — full CRUD for the finished goods the company
 * sells. Backed by the `inventory/products` resource, which the API already
 * scopes to finished goods only (reams, sheets, finished goods and security
 * paper); raw materials, packaging and consumables are procurement-only and
 * never appear here.
 */
export default function SalesProducts() {
  const { user } = useAuth();
  const [meta, setMeta] = useState<EntityMeta | null>(null);
  const [options, setOptions] = useState<ProductOptions | null>(null);
  const [rows, setRows] = useState<Rec[]>([]);
  const [error, setError] = useState('');
  const [q, setQ] = useState('');
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Rec | null>(null);

  const canCreate = can(user, 'inventory.items.create');
  const canEdit = can(user, 'inventory.items.update');

  useEffect(() => {
    api<{ data: EntityMeta }>('/api/meta/entities/inventory/products')
      .then((r) => setMeta(r.data))
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load product form'));
  }, []);

  useEffect(() => {
    api<{ data: ProductOptions }>('/api/ops/inventory/product-options')
      .then((r) => setOptions(r.data))
      .catch(() => {/* options are non-critical; the form still works with raw inputs */});
  }, []);

  useEffect(() => {
    api<ListResult>('/api/inventory/products?pageSize=200')
      .then((r) => setRows(Array.isArray(r.data) ? r.data : []))
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load products'));
  }, []);

  const filtered = useMemo(() => {
    if (!q.trim()) return rows;
    const s = q.trim().toLowerCase();
    return rows.filter((r) => `${r.code} ${r.name}`.toLowerCase().includes(s));
  }, [rows, q]);

  const selects = useMemo<Record<string, SelectOption[]>>(() => {
    if (!options) return STATIC_SELECTS;
    return {
      ...STATIC_SELECTS,
      unitId: options.units.map((u) => ({ value: u.id, label: `${u.code} — ${u.name}` })),
      categoryId: options.categories.map((c) => ({ value: c.id, label: c.name })),
      preferredSupplierId: options.suppliers.map((s) => ({ value: s.id, label: s.name })),
    };
  }, [options]);

  const reload = () =>
    api<ListResult>('/api/inventory/products?pageSize=200')
      .then((r) => setRows(Array.isArray(r.data) ? r.data : []))
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to reload products'));

  const submit = (id: number | null) => async (values: Record<string, unknown>) => {
    await api(`/api/inventory/products${id ? `/${id}` : ''}`, {
      method: id ? 'PATCH' : 'POST',
      body: JSON.stringify(values),
    });
    setCreating(false);
    setEditing(null);
    await reload();
  };

  if (!meta && error) return <ErrorBanner error={error} />;
  if (!meta) return <PageLoader variant="page" label="Loading products…" />;

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="mod-kicker" data-mod="sales">Sales</p>
          <h1>Products</h1>
          <p className="muted">Sellable finished goods — list price, cost and gross margin.</p>
        </div>
        {canCreate && (
          <div className="head-actions">
            <button className="btn btn-primary" onClick={() => setCreating(true)}>+ New product</button>
          </div>
        )}
      </header>
      <div className="toolbar">
        <input className="search-input" placeholder="Search products…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search products" />
        <span className="muted">{filtered.length} products</span>
      </div>
      {error && <ErrorBanner error={error} />}
      <div className="table-wrap card">
        <table className="data">
          <thead>
            <tr>
              <th>Code</th>
              <th>Name</th>
              <th>Type</th>
              <th className="cell-num">List price</th>
              <th className="cell-num">Cost</th>
              <th className="cell-num">Margin</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((r) => {
              const price = n(r.standardPrice);
              const cost = n(r.standardCost);
              const margin = price > 0 ? ((price - cost) / price) * 100 : null;
              return (
                <tr
                  key={String(r.id)}
                  className={canEdit ? 'row-click' : undefined}
                  onClick={canEdit ? () => setEditing(r) : undefined}
                  title={canEdit ? 'Edit product' : undefined}
                >
                  <td className="cell-mono">{String(r.code)}</td>
                  <td>{String(r.name)}</td>
                  <td><Badge value={r.type} /></td>
                  <td className="cell-num">{fmtMoney(price)}</td>
                  <td className="cell-num">{fmtMoney(cost)}</td>
                  <td className="cell-num">{margin != null ? `${fmtNum(Math.round(margin))}%` : '—'}</td>
                </tr>
              );
            })}
            {filtered.length === 0 && <tr><td className="muted" colSpan={6}>No products match “{q}”.</td></tr>}
          </tbody>
        </table>
      </div>
      <p className="muted" style={{ marginTop: 12 }}>Only finished goods are sold. Raw materials, packaging and consumables are managed under Inventory and never appear in sales.</p>

      {creating && (
        <Modal title="New product" onClose={() => setCreating(false)} wide>
          <JsonForm meta={meta} sections={SECTIONS} selects={selects} onSubmit={submit(null)} onCancel={() => setCreating(false)} submitLabel="Create" />
        </Modal>
      )}
      {editing && (
        <Modal title={`Edit ${String(editing.code)}`} onClose={() => setEditing(null)} wide>
          <JsonForm meta={meta} sections={SECTIONS} selects={selects} initial={editing} onSubmit={submit(Number(editing.id))} onCancel={() => setEditing(null)} submitLabel="Save" />
        </Modal>
      )}
    </div>
  );
}
