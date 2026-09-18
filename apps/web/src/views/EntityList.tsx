import { useCallback, useEffect, useRef, useState } from 'react';
import { api, EntityMeta, ListResult } from '../api';
import { DataTable, type DataTableQuery } from '../components/DataTable';
import { JsonForm } from '../components/JsonForm';
import { SupplierForm } from '../components/SupplierForm';
import { ErrorBanner, Modal, PageLoader } from '../components/ui';
import { navigate, RouteMatch, useHashQuery } from '../router';
import { moduleLabel } from '../helpers';
import { pushRecent } from '../prefs';
import { useAuth, can } from '../auth';
import { loadListState, saveListState } from '../listState';

const DEFAULT_PAGE_SIZE = 25;

export default function EntityList({ route }: { route: RouteMatch }) {
  const module = route.segments[1];
  const resource = route.segments[2];
  const base = `/api/${module}/${resource}`;
  const listPath = `/records/${module}/${resource}`;
  const { user } = useAuth();
  const urlQuery = useHashQuery();

  const [meta, setMeta] = useState<EntityMeta | null>(null);
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [total, setTotal] = useState(0);
  const [metaError, setMetaError] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [busy, setBusy] = useState(false);

  // The query object is the source of truth for what the server returns: page,
  // page size, search term and sort all round-trip through /api/:module/:resource.
  // A deep link wins, otherwise the last view state for this register is restored.
  const [query, setQuery] = useState<DataTableQuery>(() => {
    const restored = loadListState(listPath);
    const urlPage = Number(urlQuery.get('page'));
    const page = Number.isFinite(urlPage) && urlPage > 0 ? urlPage : restored?.page ?? 1;
    const dir = urlQuery.get('dir') ?? restored?.dir;
    return {
      page: Number.isFinite(page) && page > 0 ? page : 1,
      pageSize: DEFAULT_PAGE_SIZE,
      q: urlQuery.get('q') ?? restored?.q ?? '',
      sort: urlQuery.get('sort') ?? restored?.sort ?? null,
      order: dir === 'asc' ? 'asc' : 'desc',
    };
  });

  const loadMeta = useCallback(async () => {
    const r = await api<{ data: EntityMeta }>(`/api/meta/entities/${module}/${resource}`);
    setMeta(r.data);
  }, [module, resource]);

  useEffect(() => {
    setMetaError('');
    loadMeta().catch((e) => setMetaError(e instanceof Error ? e.message : 'Failed to load entity'));
  }, [loadMeta]);

  // Only the newest request may write state, so a slow early response cannot
  // overwrite a newer page. Bumping the ticket on unmount retires in-flight work.
  const requestRef = useRef(0);
  useEffect(() => () => { requestRef.current += 1; }, []);

  const load = useCallback(async (q: DataTableQuery) => {
    const params = new URLSearchParams({ page: String(q.page), pageSize: String(q.pageSize) });
    if (q.q.trim()) params.set('q', q.q.trim());
    if (q.sort) {
      params.set('sort', q.sort);
      params.set('order', q.order);
    }
    const ticket = ++requestRef.current;
    setBusy(true);
    try {
      const r = await api<ListResult>(`${base}?${params.toString()}`);
      if (ticket !== requestRef.current) return;
      setRows(r.data);
      setTotal(r.pagination?.total ?? r.count ?? r.data.length);
      setError('');
    } catch (e) {
      if (ticket !== requestRef.current) return;
      setError(e instanceof Error ? e.message : 'Failed to load records');
    } finally {
      if (ticket === requestRef.current) setBusy(false);
    }
  }, [base]);

  useEffect(() => { void load(query); }, [load, query]);

  const updateQuery = useCallback((next: Partial<DataTableQuery>) => {
    setQuery((cur) => {
      const changesResultSet = 'q' in next || 'sort' in next || 'order' in next;
      return { ...cur, ...next, page: next.page ?? (changesResultSet ? 1 : cur.page) };
    });
  }, []);

  // The toolbar owns the single search box for this register. Typing is debounced so
  // a search is one server request per pause rather than one per keystroke.
  const [term, setTerm] = useState(() => query.q);
  useEffect(() => {
    setTerm((cur) => (cur === query.q ? cur : query.q));
  }, [query.q]);
  useEffect(() => {
    if (term === query.q) return;
    const t = window.setTimeout(() => updateQuery({ q: term, page: 1 }), 350);
    return () => window.clearTimeout(t);
  }, [term, query.q, updateQuery]);

  // Keep the register link shareable. The table debounces the search term, so this
  // runs on committed queries only and uses replaceState to avoid history spam.
  const urlSeeded = useRef(false);
  useEffect(() => {
    if (!urlSeeded.current) { urlSeeded.current = true; return; }
    const q: Record<string, string> = {};
    if (query.q.trim()) q.q = query.q.trim();
    if (query.page > 1) q.page = String(query.page);
    if (query.sort) { q.sort = query.sort; q.dir = query.order; }
    navigate(listPath, { replace: true, query: q });
  }, [listPath, query]);

  useEffect(() => {
    saveListState(listPath, {
      q: query.q,
      page: query.page,
      sort: query.sort ?? undefined,
      dir: query.order,
      scrollY: window.scrollY,
    });
  }, [listPath, query]);

  const create = async (values: Record<string, unknown>) => {
    await api(base, { method: 'POST', body: JSON.stringify(values) });
    setShowCreate(false);
    updateQuery({ q: '', page: 1 });
  };

  const createSupplier = async (supplier: Record<string, unknown>) => {
    setShowCreate(false);
    setNotice(`Supplier ${String(supplier.code ?? '')} created - it is now available in procurement forms.`);
    updateQuery({ q: '', page: 1 });
  };

  if (metaError && !meta) return <ErrorBanner error={metaError} />;
  if (!meta) return <PageLoader variant="page" label="Loading entity…" />;

  const canCreate = can(user, `${module}.${resource}.create`);
  const searchHint = meta.searchable.length ? meta.searchable.join(', ') : 'any field';

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>{meta.label}s</h1>
          <p className="muted">{moduleLabel(module)} · open a row to act. Status is workflow, not a field.</p>
        </div>
        <div className="head-actions">
          {canCreate && (
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
          type="search"
          placeholder={`Search all records by ${searchHint}`}
          aria-label={`Search all ${meta.label.toLowerCase()}s`}
          value={term}
          onChange={(e) => setTerm(e.target.value)}
        />
        {query.q && <button className="btn" onClick={() => { setTerm(''); updateQuery({ q: '', page: 1 }); }}>Clear search</button>}
        <button className="btn" onClick={() => navigate('/qr/scan')}>QR Scan</button>
        <button className="btn" onClick={() => navigate('/approvals')}>Approvals</button>
        {busy && rows.length > 0 && <span className="muted" role="status" aria-live="polite">Updating…</span>}
      </div>

      {error && rows.length > 0 && <ErrorBanner error={error} />}
      {notice && <div className="notice-banner">{notice}</div>}
      <DataTable
        meta={meta}
        rows={rows}
        loading={busy && rows.length === 0}
        error={rows.length === 0 ? error : undefined}
        onRetry={() => void load(query)}
        onOpen={(id) => {
          pushRecent(`${listPath}/${id}`, `${meta.label} #${id}`);
          navigate(`${listPath}/${id}`);
        }}
        onCreate={canCreate ? () => setShowCreate(true) : undefined}
        server={{ query, total, onQuery: updateQuery, hideSearch: true }}
      />

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
