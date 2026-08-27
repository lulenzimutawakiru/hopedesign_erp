import { useCallback, useEffect, useState } from 'react';
import { api, EntityMeta, ListResult } from '../api';
import { DataTable } from '../components/DataTable';
import { JsonForm } from '../components/JsonForm';
import { SupplierForm } from '../components/SupplierForm';
import { ErrorBanner, Modal, PageLoader } from '../components/ui';
import { navigate, RouteMatch, useHashQuery } from '../router';
import { moduleLabel } from '../helpers';
import { pushRecent } from '../prefs';
import { useAuth, can } from '../auth';
import { loadListState, saveListState } from '../listState';

export default function EntityList({ route }: { route: RouteMatch }) {
  const module = route.segments[1];
  const resource = route.segments[2];
  const base = `/api/${module}/${resource}`;
  const { user } = useAuth();

  const [meta, setMeta] = useState<EntityMeta | null>(null);
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize] = useState(40);
  const query = useHashQuery();
  const restored = loadListState(`/records/${module}/${resource}`);
  const [q, setQ] = useState(query.get('q') || restored?.q || '');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  const loadMeta = useCallback(async () => {
    const r = await api<{ data: EntityMeta }>(`/api/meta/entities/${module}/${resource}`);
    setMeta(r.data);
  }, [module, resource]);

  const loadPage = useCallback(async (p: number, append: boolean) => {
    const params = new URLSearchParams({ page: String(p), pageSize: String(pageSize) });
    if (q.trim()) params.set('q', q.trim());
    if (append) setLoadingMore(true);
    else setBusy(true);
    try {
      const r = await api<ListResult>(`${base}?${params.toString()}`);
      setRows((prev) => (append ? [...prev, ...r.data] : r.data));
      setTotal(r.pagination?.total ?? r.count ?? r.data.length);
      setPage(p);
    } finally {
      setBusy(false);
      setLoadingMore(false);
    }
  }, [base, pageSize, q]);

  useEffect(() => {
    loadMeta().catch((e) => setError(e instanceof Error ? e.message : 'Failed to load entity'));
  }, [loadMeta]);

  useEffect(() => {
    if (!meta) return;
    loadPage(1, false).catch((e) => setError(e instanceof Error ? e.message : 'Failed to load records'));
  }, [loadPage, meta]);

  useEffect(() => {
    saveListState(`/records/${module}/${resource}`, { q, page, scrollY: window.scrollY });
  }, [module, resource, q, page]);

  const loadMore = useCallback(() => {
    if (loadingMore || busy || rows.length >= total) return;
    void loadPage(page + 1, true);
  }, [busy, loadPage, loadingMore, page, rows.length, total]);

  const create = async (values: Record<string, unknown>) => {
    await api(`${base}`, { method: 'POST', body: JSON.stringify(values) });
    setShowCreate(false);
    setQ('');
    await loadPage(1, false);
  };

  const createSupplier = async (supplier: Record<string, unknown>) => {
    setShowCreate(false);
    setQ('');
    setNotice(`Supplier ${String(supplier.code ?? '')} created - it is now available in procurement forms.`);
    await loadPage(1, false);
  };

  if (error && !meta) return <ErrorBanner error={error} />;
  if (!meta) return <PageLoader label="Loading entity…" />;

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>{meta.label}s</h1>
          <p className="muted">{moduleLabel(module)} · open a row to act. Status is workflow, not a field.</p>
        </div>
        <div className="head-actions">
          {can(user, `${module}.${resource}.create`) && (
            <button className="btn btn-primary" onClick={() => {
              setNotice('');
              if (module === 'production' && resource === 'work_orders') navigate('/plant/new');
              else setShowCreate(true);
            }}>+ New {meta.label}</button>
          )}
        </div>
      </header>

      <div className="toolbar">
        <input
          className="search-input"
          placeholder={`Search ${meta.searchable.join(', ') || 'records'}…`}
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <button className="btn" onClick={() => navigate(`/qr/scan`)}>QR Scan</button>
        <button className="btn" onClick={() => navigate('/approvals')}>Approvals</button>
      </div>

      {error && <ErrorBanner error={error} />}
      {notice && <div className="notice-banner">{notice}</div>}
      {busy ? <PageLoader label="Loading records…" /> : (
        <DataTable
          meta={meta}
          rows={rows}
          onOpen={(id) => { pushRecent(`/records/${module}/${resource}/${id}`, `${meta.label} #${id}`); navigate(`/records/${module}/${resource}/${id}`); }}
          onCreate={can(user, `${module}.${resource}.create`) ? () => setShowCreate(true) : undefined}
          hasMore={rows.length < total}
          loadingMore={loadingMore}
          onLoadMore={loadMore}
        />
      )}
      <p className="muted" style={{ textAlign: 'right' }}>{rows.length} of {total}</p>

      {showCreate && (
        <Modal title={`New ${meta.label}`} onClose={() => setShowCreate(false)} wide>
          {module === 'procurement' && resource === 'suppliers' ? (
            <SupplierForm onCancel={() => setShowCreate(false)} onCreated={createSupplier} />
          ) : (
            <JsonForm meta={meta} onSubmit={create} onCancel={() => setShowCreate(false)} submitLabel="Create" />
          )}
        </Modal>
      )}
    </div>
  );
}
