import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { navigate, useHashQuery } from '../../router';
import { can, useAuth } from '../../auth';
import { ErrorBanner, Modal, Pager, Spinner } from '../../components/ui';
import { ConfirmDialog } from '../../components/os';
import {
  EmptyRow,
  KpiRow,
  KpiTile,
  Nothing,
  SdHead,
  SdTabs,
  SecCard,
  dash,
  fmtAgo,
  fmtDT,
  label,
  modStyle,
  num,
  s,
  sdApi,
  sdErr,
  sdPatch,
  sdPost,
  useSdMeta,
  type Rec,
} from '../serviceDeskShared';
import { Field, Inp, Sel, Txa } from '../hikvision/fields';
import { exportCsv } from '../hikvision/shared';

/* ------------------------------------------------------------------ *
 * Knowledge base presentation (spec 16)
 * ------------------------------------------------------------------ */

const KB_STATUSES = ['DRAFT', 'REVIEW', 'APPROVED', 'PUBLISHED', 'ARCHIVED'] as const;

const KB_STATUS_LABEL: Record<string, string> = {
  DRAFT: 'Draft',
  REVIEW: 'In review',
  APPROVED: 'Approved',
  PUBLISHED: 'Published',
  ARCHIVED: 'Archived',
};

const KB_STATUS_TONE: Record<string, string> = {
  DRAFT: 'draft',
  REVIEW: 'review',
  APPROVED: 'approved',
  PUBLISHED: 'published',
  ARCHIVED: 'archived',
};

function KbStatus({ value }: { value: unknown }) {
  const code = s(value).toUpperCase() || 'DRAFT';
  return (
    <span className={'sd-chip sd-kb-status sd-kb-' + (KB_STATUS_TONE[code] ?? 'draft')}>
      {KB_STATUS_LABEL[code] ?? label(code)}
    </span>
  );
}

function Stars({ value }: { value: unknown }) {
  const v = num(value);
  if (!v) return <span className="muted">No ratings</span>;
  const full = Math.round(v);
  return (
    <span className="sd-stars" title={v.toFixed(2) + ' / 5'}>
      {[1, 2, 3, 4, 5].map((i) => (
        <span key={i} className={i <= full ? 'sd-star on' : 'sd-star'} aria-hidden>
          {'\u2605'}
        </span>
      ))}
      <span className="muted sd-star-num">{v.toFixed(1)}</span>
    </span>
  );
}

const TABS: Array<[string, string]> = [
  ['articles', 'Articles'],
  ['search', 'Search'],
  ['categories', 'Categories'],
  ['dashboard', 'Publishing'],
];

interface ArticleList {
  items: Rec[];
  total: number;
  page: number;
  limit: number;
  offset: number;
}

interface KbDashboard {
  counts?: Rec;
  awaiting_review?: Rec[];
  most_viewed?: Rec[];
  unused_published?: Rec[];
  needs_attention?: Rec[];
  categories?: Rec[];
  permissions?: Rec;
}

export default function ServiceDeskKnowledge({ id }: { id?: number | null }) {
  const q = useHashQuery();
  const meta = useSdMeta();
  const { user } = useAuth();

  const [tab, setTab] = useState<string>(() => {
    const t = s(q.get('tab'));
    return TABS.some(([k]) => k === t) ? t : 'articles';
  });
  const [articleId, setArticleId] = useState<number | null>(id ?? null);

  useEffect(() => {
    const t = s(q.get('tab'));
    if (t && TABS.some(([k]) => k === t)) setTab(t);
  }, [q]);

  useEffect(() => {
    setArticleId(id ?? null);
  }, [id]);

  const openArticle = useCallback((next: number | null) => {
    setArticleId(next);
    navigate(next ? '/service-desk/knowledge/' + String(next) : '/service-desk/knowledge');
  }, []);

  if (articleId) {
    return (
      <div className="page sd-page" style={modStyle()}>
        <SdHead title="Knowledge article" kicker="Knowledge base" />
        <SdTabs active="knowledge" />
        <ArticleDetail id={articleId} onBack={() => openArticle(null)} />
      </div>
    );
  }

  return (
    <div className="page sd-page" style={modStyle()}>
      <SdHead
        title="Knowledge base"
        kicker="Service desk"
        sub="How-to guides and resolutions agents can attach to tickets. Draft → review → publish."
      />
      <SdTabs active="knowledge" />
      <nav className="spend-tabs" aria-label="Knowledge sections">
        {TABS.map(([key, text]) => (
          <button
            key={key}
            type="button"
            className={'spend-tab' + (key === tab ? ' is-on' : '')}
            onClick={() => {
              setTab(key);
              navigate('/service-desk/knowledge?tab=' + key);
            }}
          >
            {text}
          </button>
        ))}
      </nav>
      {meta.error ? <ErrorBanner error={meta.error} /> : null}
      {tab === 'articles' && <ArticlesList onOpen={openArticle} canCreate={can(user, 'service_desk.knowledge.create')} />}
      {tab === 'search' && <KnowledgeSearch onOpen={openArticle} />}
      {tab === 'categories' && <CategoriesTab />}
      {tab === 'dashboard' && <PublishingTab onOpen={openArticle} />}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Articles list
 * ------------------------------------------------------------------ */

function ArticlesList({ onOpen, canCreate }: { onOpen: (id: number) => void; canCreate: boolean }) {
  const q = useHashQuery();
  const { user } = useAuth();
  const [status, setStatus] = useState(s(q.get('status')));
  const [categoryId, setCategoryId] = useState(s(q.get('categoryId')));
  const [search, setSearch] = useState(s(q.get('search')));
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [data, setData] = useState<ArticleList | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [tick, setTick] = useState(0);
  const [categories, setCategories] = useState<Rec[]>([]);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    sdApi<Rec[]>('/api/service-desk/knowledge/categories')
      .then((r) => setCategories(Array.isArray(r) ? r : []))
      .catch(() => setCategories([]));
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    const params = new URLSearchParams();
    params.set('page', String(page));
    params.set('limit', String(pageSize));
    if (status) params.set('status', status);
    if (categoryId) params.set('categoryId', categoryId);
    if (search.trim()) params.set('search', search.trim());
    try {
      const res = await sdApi<ArticleList>('/api/service-desk/knowledge/articles?' + params.toString());
      setData(res);
    } catch (e) {
      setError(sdErr(e));
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [page, pageSize, status, categoryId, search]);

  useEffect(() => {
    void load();
  }, [load, tick]);

  const rows = data?.items ?? [];
  const total = num(data?.total);

  const handleExport = useCallback(() => {
    exportCsv(
      'knowledge-articles',
      ['Article', 'Title', 'Category', 'Status', 'Version', 'Views', 'Helpful', 'Not helpful', 'Rating', 'Updated'],
      rows.map((a) => [
        s(a.article_number),
        s(a.title),
        s(a.category_name),
        s(a.status),
        num(a.current_version),
        num(a.view_count),
        num(a.helpful_count),
        num(a.not_helpful_count),
        a.rating_average === null || a.rating_average === undefined ? '' : num(a.rating_average).toFixed(2),
        s(a.updated_at),
      ]),
    );
  }, [rows]);

  const canManage = can(user, 'service_desk.knowledge.manage');

  return (
    <>
      <SecCard
        title="Articles"
        sub={total + ' article(s) in the current view'}
        actions={
          <>
            <button className="btn btn-sm" onClick={handleExport} disabled={rows.length === 0}>
              Export
            </button>
            {canCreate ? (
              <button className="btn btn-primary btn-sm" onClick={() => setCreating(true)}>
                + New article
              </button>
            ) : null}
          </>
        }
      >
        <div className="filter-bar sd-kb-filters">
          <input
            className="hk-input"
            placeholder="Search title, summary or keywords"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void load();
            }}
          />
          <select
            className="hk-select"
            value={categoryId}
            onChange={(e) => {
              setCategoryId(e.target.value);
              setPage(1);
            }}
          >
            <option value="">All categories</option>
            {categories.map((c) => (
              <option key={s(c.id)} value={s(c.id)}>
                {s(c.name)}
              </option>
            ))}
          </select>
          <div className="chips sd-chip-row">
            <button
              className={status === '' ? 'chip active' : 'chip'}
              onClick={() => {
                setStatus('');
                setPage(1);
              }}
            >
              All statuses
            </button>
            {KB_STATUSES.map((st) => (
              <button
                key={st}
                className={status === st ? 'chip active' : 'chip'}
                onClick={() => {
                  setStatus(st);
                  setPage(1);
                }}
              >
                {KB_STATUS_LABEL[st]}
              </button>
            ))}
          </div>
          <button className="btn btn-sm" onClick={() => setTick((n) => n + 1)}>
            Refresh
          </button>
        </div>

        {error ? <ErrorBanner error={error} /> : null}
        {loading && !data ? (
          <div className="card-pad">
            <Spinner />
          </div>
        ) : rows.length === 0 ? (
          <Nothing
            text={
              search || status || categoryId
                ? 'Nothing matches those filters. Clear search or pick All statuses.'
                : 'No articles yet. Write the first how-to so agents can attach it to tickets.'
            }
            action={canCreate && !search && !status && !categoryId ? '+ New article' : undefined}
            onAction={canCreate ? () => setCreating(true) : undefined}
          />
        ) : (
          <div className="table-wrap">
            <table className="table sd-kb-table">
              <thead>
                <tr>
                  <th style={{ width: '150px' }}>Article</th>
                  <th>Title</th>
                  <th style={{ width: '160px' }}>Category</th>
                  <th style={{ width: '120px' }}>Status</th>
                  <th style={{ width: '90px' }}>Version</th>
                  <th style={{ width: '150px' }}>Rating</th>
                  <th style={{ width: '120px' }}>Usage</th>
                  <th style={{ width: '110px' }}>Updated</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((a) => (
                  <tr
                    key={s(a.id)}
                    className="sd-ticket-row"
                    tabIndex={0}
                    onClick={() => onOpen(num(a.id))}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        onOpen(num(a.id));
                      }
                    }}
                  >
                    <td className="td-cell-mono">{s(a.article_number)}</td>
                    <td>
                      <div className="sd-subj-cell">
                        <span className="sd-subj">{s(a.title)}</span>
                        <span className="sub muted">{s(a.summary) || 'No summary'}</span>
                      </div>
                    </td>
                    <td>{dash(a.category_name)}</td>
                    <td>
                      <KbStatus value={a.status} />
                    </td>
                    <td className="muted">v{num(a.current_version) || 1}</td>
                    <td>
                      <Stars value={a.rating_average} />
                    </td>
                    <td className="muted">
                      {num(a.view_count)} views / {num(a.ticket_usage_count)} tickets
                    </td>
                    <td className="muted">{fmtAgo(a.updated_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {rows.length > 0 && (
          <div className="table-foot">
            <Pager
              page={page}
              pageSize={pageSize}
              total={total}
              onPage={setPage}
              onPageSize={(n) => {
                setPageSize(n);
                setPage(1);
              }}
            />
          </div>
        )}
      </SecCard>

      {creating && (
        <ArticleEditor
          categories={categories}
          onClose={() => setCreating(false)}
          onSaved={(newId) => {
            setCreating(false);
            setTick((n) => n + 1);
            if (newId) onOpen(newId);
          }}
          canManage={canManage}
        />
      )}
    </>
  );
}

/* ------------------------------------------------------------------ *
 * Search
 * ------------------------------------------------------------------ */

function KnowledgeSearch({ onOpen }: { onOpen: (id: number) => void }) {
  const [term, setTerm] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [data, setData] = useState<{ items: Rec[]; total: number } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [categories, setCategories] = useState<Rec[]>([]);

  useEffect(() => {
    sdApi<Rec[]>('/api/service-desk/knowledge/categories')
      .then((r) => setCategories(Array.isArray(r) ? r : []))
      .catch(() => setCategories([]));
  }, []);

  const run = useCallback(async () => {
    if (!term.trim()) {
      setData(null);
      return;
    }
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams();
      params.set('term', term.trim());
      params.set('limit', '40');
      if (categoryId) params.set('categoryId', categoryId);
      const res = await sdApi<{ items: Rec[]; total: number }>('/api/service-desk/knowledge/search?' + params.toString());
      setData({ items: Array.isArray(res.items) ? res.items : [], total: num(res.total) });
    } catch (e) {
      setError(sdErr(e));
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [term, categoryId]);

  return (
    <SecCard title="Search the knowledge base" sub="Full text search across published and draft articles.">
      <div className="filter-bar">
        <input
          className="hk-input"
          placeholder="e.g. printer offline, VPN, Hikvision terminal"
          value={term}
          onChange={(e) => setTerm(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void run();
          }}
        />
        <select className="hk-select" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
          <option value="">All categories</option>
          {categories.map((c) => (
            <option key={s(c.id)} value={s(c.id)}>
              {s(c.name)}
            </option>
          ))}
        </select>
        <button className="btn btn-primary btn-sm" onClick={() => void run()} disabled={loading}>
          {loading ? 'Searching' : 'Search'}
        </button>
      </div>
      {error ? <ErrorBanner error={error} /> : null}
      {!data && !loading && <Nothing text="Enter a search term to find knowledge articles." />}
      {data && data.items.length === 0 && <Nothing text={'No articles matched "' + term + '".'} />}
      {data && data.items.length > 0 && (
        <ul className="sd-kb-results">
          {data.items.map((a) => (
            <li key={s(a.id)}>
              <button className="sd-kb-result" onClick={() => onOpen(num(a.id))}>
                <span className="sd-kb-result-head">
                  <b>{s(a.title)}</b>
                  <KbStatus value={a.status} />
                </span>
                <span className="sub muted sd-kb-result-meta">
                  {s(a.article_number)} - {dash(a.category_name)} - {num(a.view_count)} views
                </span>
                <span className="sd-kb-result-body">{s(a.summary) || s(a.body).slice(0, 260)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </SecCard>
  );
}

/* ------------------------------------------------------------------ *
 * Categories
 * ------------------------------------------------------------------ */

function CategoriesTab() {
  const { user } = useAuth();
  const canManage = can(user, 'service_desk.knowledge.manage');
  const [rows, setRows] = useState<Rec[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [tick, setTick] = useState(0);
  const [editing, setEditing] = useState<Rec | null>(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await sdApi<Rec[]>('/api/service-desk/knowledge/categories?includeInactive=true');
      setRows(Array.isArray(res) ? res : []);
    } catch (e) {
      setError(sdErr(e));
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, tick]);

  const roots = useMemo(() => rows.filter((r) => !r.parent_id), [rows]);
  const childrenOf = (id: unknown) => rows.filter((r) => s(r.parent_id) === s(id));

  const flat: Array<{ node: Rec; depth: number }> = [];
  const walk = (c: Rec, depth: number) => {
    flat.push({ node: c, depth });
    childrenOf(c.id).forEach((k) => walk(k, depth + 1));
  };
  roots.forEach((c) => walk(c, 0));

  const renderRow = (c: Rec, depth: number): ReactNode => (
    <>
      <tr key={s(c.id)}>
        <td style={{ paddingLeft: 12 + depth * 20 }}>
          <div className="sd-subj-cell">
            <span className="sd-subj">
              {s(c.icon) ? s(c.icon) + ' ' : ''}
              {s(c.name)}
            </span>
            <span className="sub muted td-cell-mono">{s(c.code)}</span>
          </div>
        </td>
        <td className="muted">{dash(c.description)}</td>
        <td>{num(c.published_articles)}</td>
        <td>
          {c.is_active === false ? (
            <span className="sd-chip sd-kb-archived">Inactive</span>
          ) : (
            <span className="sd-chip sd-kb-published">Active</span>
          )}
        </td>
        <td className="muted">{num(c.sort_order)}</td>
        <td>
          {canManage && (
            <div className="row-actions">
              <button className="link-btn" onClick={() => setEditing(c)}>
                Edit
              </button>
            </div>
          )}
        </td>
      </tr>
      {childrenOf(c.id).map((k) => renderRow(k, depth + 1))}
    </>
  );

  return (
    <SecCard
      title="Knowledge categories"
      sub="Categories group articles and drive recommendations on tickets."
      actions={
        canManage ? (
          <button className="btn btn-primary btn-sm" onClick={() => setCreating(true)}>
            + New category
          </button>
        ) : undefined
      }
    >
      {error ? <ErrorBanner error={error} /> : null}
      {loading && rows.length === 0 ? (
        <div className="card-pad">
          <Spinner />
        </div>
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Category</th>
                <th>Description</th>
                <th style={{ width: '110px' }}>Published</th>
                <th style={{ width: '110px' }}>State</th>
                <th style={{ width: '80px' }}>Order</th>
                <th style={{ width: '90px' }} />
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && <EmptyRow cols={6}>No knowledge categories have been configured.</EmptyRow>}
              {flat.map(({ node, depth }) => renderRow(node, depth))}
            </tbody>
          </table>
        </div>
      )}
      {(creating || editing) && (
        <CategoryEditor
          row={editing}
          options={rows}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
          onSaved={() => {
            setCreating(false);
            setEditing(null);
            setTick((n) => n + 1);
          }}
        />
      )}
    </SecCard>
  );
}

function CategoryEditor({
  row,
  options,
  onClose,
  onSaved,
}: {
  row: Rec | null;
  options: Rec[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [code, setCode] = useState(s(row?.code));
  const [name, setName] = useState(s(row?.name));
  const [description, setDescription] = useState(s(row?.description));
  const [icon, setIcon] = useState(s(row?.icon));
  const [parentId, setParentId] = useState(s(row?.parent_id));
  const [sortOrder, setSortOrder] = useState(String(num(row?.sort_order)));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const save = async () => {
    setBusy(true);
    setError('');
    try {
      const payload: Rec = {
        name: name.trim(),
        description: description.trim() || null,
        icon: icon.trim() || null,
        parentId: parentId ? Number(parentId) : null,
        sortOrder: sortOrder ? Number(sortOrder) : 0,
      };
      if (!row) payload.code = code.trim();
      if (row) {
        await sdPatch('/api/service-desk/knowledge/categories/' + s(row.id), payload);
      } else {
        await sdPost('/api/service-desk/knowledge/categories', payload);
      }
      onSaved();
    } catch (e) {
      setError(sdErr(e));
    } finally {
      setBusy(false);
    }
  };

  const parents = options.filter((o) => s(o.id) !== s(row?.id) && !o.parent_id);

  return (
    <Modal
      title={row ? 'Edit knowledge category' : 'New knowledge category'}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={() => void save()} disabled={busy || !name.trim() || (!row && !code.trim())}>
            {busy ? 'Saving' : 'Save category'}
          </button>
        </>
      }
    >
      <div className="sd-form-grid">
        {!row && (
          <Field label="Code" req hint="Uppercase identifier, e.g. NETWORK">
            <Inp value={code} onChange={setCode} placeholder="NETWORK" />
          </Field>
        )}
        <Field label="Name" req>
          <Inp value={name} onChange={setName} placeholder="Network" />
        </Field>
        <Field label="Parent category" hint="Leave blank for a top level category.">
          <Sel
            value={parentId}
            onChange={setParentId}
            options={[{ value: '', label: 'None (top level)' }].concat(parents.map((p) => ({ value: s(p.id), label: s(p.name) })))}
          />
        </Field>
        <Field label="Icon" hint="Optional glyph or short label.">
          <Inp value={icon} onChange={setIcon} placeholder="NET" />
        </Field>
        <Field label="Sort order">
          <Inp value={sortOrder} onChange={setSortOrder} placeholder="0" />
        </Field>
        <Field label="Description">
          <Txa value={description} onChange={setDescription} rows={3} placeholder="What belongs in this category?" />
        </Field>
      </div>
      <FormErrorText msg={error} />
    </Modal>
  );
}

function FormErrorText({ msg }: { msg: string }) {
  if (!msg) return null;
  return <p className="sd-form-error">{msg}</p>;
}

/* ------------------------------------------------------------------ *
 * Publishing dashboard
 * ------------------------------------------------------------------ */

function PublishingTab({ onOpen }: { onOpen: (id: number) => void }) {
  const { user } = useAuth();
  const [data, setData] = useState<KbDashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [tick, setTick] = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await sdApi<KbDashboard>('/api/service-desk/knowledge/dashboard');
      setData(res);
    } catch (e) {
      setError(sdErr(e));
      setData(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, tick]);

  if (loading && !data) {
    return (
      <SecCard title="Publishing" sub="Article lifecycle health across the knowledge base.">
        <div className="card-pad">
          <Spinner />
        </div>
      </SecCard>
    );
  }

  const counts = data?.counts ?? {};
  const perms = data?.permissions ?? {};
  const awaiting = data?.awaiting_review ?? [];
  const viewed = data?.most_viewed ?? [];
  const unused = data?.unused_published ?? [];
  const attention = data?.needs_attention ?? [];
  const cats = data?.categories ?? [];

  return (
    <>
      {error ? <ErrorBanner error={error} /> : null}
      <KpiRow>
        <KpiTile label="Draft" value={num(counts.draft)} onClick={() => navigate('/service-desk/knowledge?tab=articles&status=DRAFT')} />
        <KpiTile label="In review" value={num(counts.review)} onClick={() => navigate('/service-desk/knowledge?tab=articles&status=REVIEW')} />
        <KpiTile label="Approved" value={num(counts.approved)} onClick={() => navigate('/service-desk/knowledge?tab=articles&status=APPROVED')} />
        <KpiTile label="Published" value={num(counts.published)} onClick={() => navigate('/service-desk/knowledge?tab=articles&status=PUBLISHED')} />
        <KpiTile label="Archived" value={num(counts.archived)} onClick={() => navigate('/service-desk/knowledge?tab=articles&status=ARCHIVED')} />
        <KpiTile label="Total articles" value={num(counts.total)} />
      </KpiRow>

      <div className="grid-2 sd-kb-dash">
        <SecCard
          title="Awaiting review"
          sub="Articles submitted for review that still need a decision."
          actions={
            <button className="btn btn-sm" onClick={() => setTick((n) => n + 1)}>
              Refresh
            </button>
          }
        >
          {awaiting.length === 0 ? (
            <Nothing text="Nothing is waiting for review." />
          ) : (
            <ul className="sd-kb-list">
              {awaiting.map((a) => (
                <li key={s(a.id)}>
                  <button className="sd-kb-link" onClick={() => onOpen(num(a.id))}>
                    <b>{s(a.title)}</b>
                    <span className="sub muted">
                      {s(a.article_number)} - {s(a.author_email) || 'unknown author'} - {fmtAgo(a.updated_at)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </SecCard>

        <SecCard title="Needs attention" sub="Published articles rated poorly by employees.">
          {attention.length === 0 ? (
            <Nothing text="No poorly rated published articles." />
          ) : (
            <ul className="sd-kb-list">
              {attention.map((a) => (
                <li key={s(a.id)}>
                  <button className="sd-kb-link" onClick={() => onOpen(num(a.id))}>
                    <b>{s(a.title)}</b>
                    <span className="sub muted">
                      {num(a.helpful_count)} helpful / {num(a.not_helpful_count)} not helpful - rating{' '}
                      {num(a.rating_average).toFixed(2)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </SecCard>

        <SecCard title="Most viewed" sub="Where employees are looking for help.">
          {viewed.length === 0 ? (
            <Nothing text="No article views recorded yet." />
          ) : (
            <ul className="sd-kb-list">
              {viewed.map((a) => (
                <li key={s(a.id)}>
                  <button className="sd-kb-link" onClick={() => onOpen(num(a.id))}>
                    <b>{s(a.title)}</b>
                    <span className="sub muted">
                      {num(a.view_count)} views - linked to {num(a.ticket_usage_count)} ticket(s) - rating{' '}
                      {num(a.rating_average).toFixed(2)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </SecCard>

        <SecCard title="Unused published articles" sub="Published but never viewed. Candidates for review or archival.">
          {unused.length === 0 ? (
            <Nothing text="Every published article has been viewed at least once." />
          ) : (
            <ul className="sd-kb-list">
              {unused.map((a) => (
                <li key={s(a.id)}>
                  <button className="sd-kb-link" onClick={() => onOpen(num(a.id))}>
                    <b>{s(a.title)}</b>
                    <span className="sub muted">
                      Published {fmtAgo(a.published_at)} - {num(a.view_count)} views
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </SecCard>
      </div>

      <SecCard title="Coverage by category" sub="Published articles against total articles per category.">
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Category</th>
                <th style={{ width: '140px' }}>Published</th>
                <th style={{ width: '140px' }}>Total</th>
                <th style={{ width: '160px' }}>Coverage</th>
              </tr>
            </thead>
            <tbody>
              {cats.length === 0 && <EmptyRow cols={4}>No knowledge categories have been configured.</EmptyRow>}
              {cats.map((c) => (
                <tr key={s(c.id)}>
                  <td>{s(c.name)}</td>
                  <td>{num(c.published)}</td>
                  <td>{num(c.total)}</td>
                  <td>
                    <div className="sd-mini-meter">
                      <span style={{ width: Math.round((num(c.published) / Math.max(1, num(c.total))) * 100) + '%' }} />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </SecCard>

      <p className="muted sd-kb-perm-note">
        Your publishing capabilities: author {perms.author ? 'yes' : 'no'}, approve {perms.approve ? 'yes' : 'no'}, publish{' '}
        {perms.publish ? 'yes' : 'no'}, archive {perms.archive ? 'yes' : 'no'}, manage categories{' '}
        {perms.manage_categories ? 'yes' : 'no'}. Signed in as {s(user?.first_name)} {s(user?.last_name)}.
      </p>
    </>
  );
}

/* ------------------------------------------------------------------ *
 * Article detail
 * ------------------------------------------------------------------ */

interface VersionRow {
  id?: number;
  version?: number;
  title?: string;
  summary?: string | null;
  change_note?: string | null;
  status?: string;
  created_at?: string;
  created_by?: number;
  created_by_email?: string | null;
}

function ArticleDetail({ id, onBack }: { id: number; onBack: () => void }) {
  const { user } = useAuth();
  const [row, setRow] = useState<Rec | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [tick, setTick] = useState(0);
  const [busy, setBusy] = useState('');
  const [note, setNote] = useState('');
  const [actionError, setActionError] = useState('');
  const [editing, setEditing] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [diff, setDiff] = useState<Rec | null>(null);
  const [diffVersion, setDiffVersion] = useState<number | null>(null);
  const [categories, setCategories] = useState<Rec[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await sdApi<Rec>('/api/service-desk/knowledge/articles/' + String(id) + '?countView=false');
      setRow(res);
    } catch (e) {
      setError(sdErr(e));
      setRow(null);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load, tick]);

  useEffect(() => {
    sdApi<Rec[]>('/api/service-desk/knowledge/categories')
      .then((r) => setCategories(Array.isArray(r) ? r : []))
      .catch(() => setCategories([]));
  }, []);

  const act = useCallback(
    async (step: string, payload: Rec) => {
      setBusy(step);
      setActionError('');
      try {
        await sdPost('/api/service-desk/knowledge/articles/' + String(id) + '/' + step, payload);
        setNote('');
        setTick((n) => n + 1);
      } catch (e) {
        setActionError(sdErr(e));
      } finally {
        setBusy('');
      }
    },
    [id],
  );

  const openDiff = useCallback(
    async (version: number) => {
      setDiffVersion(version);
      setDiff(null);
      try {
        const res = await sdApi<Rec>(
          '/api/service-desk/knowledge/articles/' + String(id) + '/versions/' + String(version) + '/diff',
        );
        setDiff(res);
      } catch (e) {
        setActionError(sdErr(e));
      }
    },
    [id],
  );

  if (loading && !row) {
    return (
      <SecCard title="Article">
        <div className="card-pad">
          <Spinner />
        </div>
      </SecCard>
    );
  }

  if (!row) {
    return (
      <SecCard
        title="Article not available"
        actions={
          <button className="btn btn-sm" onClick={onBack}>
            Back to articles
          </button>
        }
      >
        {error ? <ErrorBanner error={error} /> : <Nothing text="The knowledge article could not be loaded." />}
      </SecCard>
    );
  }

  const status = s(row.status).toUpperCase();
  const perms = (row.permissions ?? {}) as Rec;
  const versions = (Array.isArray(row.versions) ? row.versions : []) as VersionRow[];
  const feedback = Array.isArray(row.feedback) ? (row.feedback as Rec[]) : [];
  const linked = Array.isArray(row.linked_tickets) ? (row.linked_tickets as Rec[]) : [];
  const keywords = Array.isArray(row.keywords) ? (row.keywords as unknown[]) : [];
  const canUpdate = Boolean(perms.update);
  const canApprove = Boolean(perms.approve);
  const canPublish = Boolean(perms.publish);
  const canArchive = Boolean(perms.archive);
  const isAuthor = s(row.author_user_id) === s(user?.id);

  return (
    <>
      <SdHead
        title={s(row.title)}
        kicker={'Knowledge article ' + s(row.article_number)}
        sub={s(row.summary) || undefined}
        actions={
          <>
            <button className="btn btn-sm" onClick={onBack}>
              Back
            </button>
            {canUpdate ? (
              <button className="btn btn-sm" onClick={() => setEditing(true)}>
                Edit
              </button>
            ) : null}
            {(status === 'DRAFT' || status === 'ARCHIVED') && (canUpdate || isAuthor) ? (
              <button className="btn btn-primary btn-sm" disabled={busy !== ''} onClick={() => void act('submit', { note: note || undefined })}>
                Submit for review
              </button>
            ) : null}
            {status === 'REVIEW' && canApprove ? (
              <button className="btn btn-primary btn-sm" disabled={busy !== ''} onClick={() => void act('approve', { note: note || undefined })}>
                Approve
              </button>
            ) : null}
            {status === 'APPROVED' && canPublish ? (
              <button className="btn btn-primary btn-sm" disabled={busy !== ''} onClick={() => void act('publish', { note: note || undefined })}>
                Publish
              </button>
            ) : null}
            {status === 'PUBLISHED' && canArchive ? (
              <button className="btn btn-sm" onClick={() => setArchiving(true)}>
                Archive
              </button>
            ) : null}
            {status === 'ARCHIVED' && canUpdate ? (
              <button className="btn btn-sm" disabled={busy !== ''} onClick={() => void act('restore', { note: note || undefined })}>
                Restore to draft
              </button>
            ) : null}
          </>
        }
      />

      {actionError ? <ErrorBanner error={actionError} /> : null}

      <div className="grid-side sd-kb-detail">
        <div className="sd-kb-main">
          <SecCard title="Article body">
            <div className="sd-kb-article-body">{s(row.body)}</div>
            {keywords.length > 0 && (
              <div className="sd-kb-keywords">
                {keywords.map((k, i) => (
                  <span key={String(i) + s(k)} className="sd-chip sd-kb-keyword">
                    {s(k)}
                  </span>
                ))}
              </div>
            )}
          </SecCard>

          <SecCard
            title="Version history"
            sub={versions.length + ' version(s) recorded. Editing a published article creates a new draft version.'}
          >
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th style={{ width: '80px' }}>Version</th>
                    <th>Title</th>
                    <th style={{ width: '120px' }}>Status</th>
                    <th>Change note</th>
                    <th style={{ width: '150px' }}>By</th>
                    <th style={{ width: '120px' }}>When</th>
                    <th style={{ width: '90px' }} />
                  </tr>
                </thead>
                <tbody>
                  {versions.length === 0 && <EmptyRow cols={7}>No versions recorded.</EmptyRow>}
                  {versions.map((v) => (
                    <tr key={s(v.id) + '-' + s(v.version)}>
                      <td className="td-cell-mono">v{num(v.version) || 1}</td>
                      <td>{s(v.title)}</td>
                      <td>
                        <KbStatus value={v.status} />
                      </td>
                      <td className="muted">{dash(v.change_note)}</td>
                      <td className="muted">{dash(v.created_by_email)}</td>
                      <td className="muted">{fmtAgo(v.created_at)}</td>
                      <td>
                        <button className="link-btn" onClick={() => void openDiff(num(v.version) || 1)}>
                          Compare
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </SecCard>

          <FeedbackPanel id={id} feedback={feedback} onChanged={() => setTick((n) => n + 1)} />
        </div>

        <aside className="sd-kb-side">
          <SecCard title="Article facts">
            <dl className="sd-facts">
              <Fact k="Status" v={<KbStatus value={row.status} />} />
              <Fact k="Article" v={<span className="td-cell-mono">{s(row.article_number)}</span>} />
              <Fact k="Category" v={dash(row.category_name)} />
              <Fact k="Version" v={'v' + (num(row.current_version) || 1)} />
              <Fact k="Author" v={dash(row.author_email)} />
              <Fact k="Owner" v={dash(row.owner_email)} />
              <Fact k="Classification" v={label(row.data_classification)} />
              <Fact k="Created" v={fmtDT(row.created_at)} />
              <Fact k="Updated" v={fmtDT(row.updated_at)} />
              <Fact k="Reviewed" v={fmtDT(row.reviewed_at)} />
              <Fact k="Approved" v={fmtDT(row.approved_at)} />
              <Fact k="Published" v={fmtDT(row.published_at)} />
              <Fact k="Views" v={num(row.view_count)} />
              <Fact k="Rating" v={<Stars value={row.rating_average} />} />
              <Fact k="Linked tickets" v={num(row.ticket_usage_count)} />
            </dl>
          </SecCard>

          <SecCard title="Linked tickets" sub="Service tickets that reference this article.">
            {linked.length === 0 ? (
              <Nothing text="No tickets link to this article yet." />
            ) : (
              <ul className="sd-kb-list">
                {linked.map((t) => (
                  <li key={s(t.id)}>
                    <button className="sd-kb-link" onClick={() => navigate('/service-desk/tickets/' + s(t.ticket_id))}>
                      <b className="td-cell-mono">{s(t.ticket_number)}</b>
                      <span className="sub muted">{s(t.subject)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </SecCard>

          {(canApprove || canPublish || canArchive) && (
            <SecCard title="Transition note" sub="Optional note recorded against the next lifecycle action.">
              <Txa value={note} onChange={setNote} rows={3} placeholder="Reason or review comment" />
            </SecCard>
          )}
        </aside>
      </div>

      {editing && (
        <ArticleEditor
          row={row}
          categories={categories}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            setTick((n) => n + 1);
          }}
          canManage={can(user, 'service_desk.knowledge.manage')}
        />
      )}

      {archiving && (
        <ConfirmDialog
          title="Archive article"
          body="Archived articles are hidden from employees but remain available to service desk staff. Provide a reason for the audit trail."
          confirmLabel="Archive article"
          danger
          onCancel={() => setArchiving(false)}
          onConfirm={async (reason) => {
            setArchiving(false);
            await act('archive', { reason: reason || 'Archived', note: reason || undefined });
          }}
        />
      )}

      {diffVersion !== null && (
        <Modal title={'Compare v' + String(diffVersion) + ' with current'} onClose={() => setDiffVersion(null)} wide>
          {!diff ? (
            <Spinner />
          ) : (
            <div className="sd-kb-diff">
              <DiffBlock label={'Version ' + String(diffVersion) + ' - title'} value={s(diff.title)} />
              <DiffBlock label="Current - title" value={s((diff.current as Rec | undefined)?.title)} />
              <DiffBlock label={'Version ' + String(diffVersion) + ' - summary'} value={s(diff.summary)} />
              <DiffBlock label="Current - summary" value={s((diff.current as Rec | undefined)?.summary)} />
              <DiffBlock label={'Version ' + String(diffVersion) + ' - body'} value={s(diff.body)} />
              <DiffBlock label="Current - body" value={s((diff.current as Rec | undefined)?.body)} />
            </div>
          )}
        </Modal>
      )}
    </>
  );
}

function DiffBlock({ label: text, value }: { label: string; value: string }) {
  return (
    <div className="sd-kb-diff-block">
      <h4>{text}</h4>
      <pre>{value || '(empty)'}</pre>
    </div>
  );
}

function Fact({ k, v }: { k: string; v: ReactNode }) {
  return (
    <>
      <dt>{k}</dt>
      <dd>{v}</dd>
    </>
  );
}

/* ------------------------------------------------------------------ *
 * Feedback
 * ------------------------------------------------------------------ */

function FeedbackPanel({ id, feedback, onChanged }: { id: number; feedback: Rec[]; onChanged: () => void }) {
  const [mine, setMine] = useState<Rec | null>(null);
  const [helpful, setHelpful] = useState<boolean | null>(null);
  const [rating, setRating] = useState(0);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');

  useEffect(() => {
    let alive = true;
    sdApi<Rec | null>('/api/service-desk/knowledge/articles/' + String(id) + '/my-feedback')
      .then((r) => {
        if (!alive || !r) return;
        setMine(r);
        setHelpful(typeof r.is_helpful === 'boolean' ? r.is_helpful : null);
        setRating(num(r.rating));
        setComment(s(r.comment));
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [id]);

  const submit = async () => {
    if (helpful === null && rating === 0) {
      setError('Choose helpful or not helpful, or give a rating.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await sdPost('/api/service-desk/knowledge/articles/' + String(id) + '/feedback', {
        isHelpful: helpful === null ? undefined : helpful,
        rating: rating || undefined,
        comment: comment.trim() || undefined,
      });
      setSaved('Thank you - your feedback has been recorded.');
      onChanged();
    } catch (e) {
      setError(sdErr(e));
    } finally {
      setBusy(false);
    }
  };

  const avg = num(feedback.reduce((acc, f) => acc + num(f.rating), 0) / Math.max(1, feedback.filter((f) => num(f.rating) > 0).length));

  return (
    <SecCard
      title="Article feedback"
      sub={
        feedback.length === 0
          ? 'No feedback recorded yet.'
          : feedback.length + ' response(s), average rating ' + (avg ? avg.toFixed(2) : 'n/a') + '.'
      }
    >
      <div className="sd-kb-feedback-form">
        <div className="chips">
          <button className={helpful === true ? 'chip active' : 'chip'} onClick={() => setHelpful(true)}>
            Helpful
          </button>
          <button className={helpful === false ? 'chip active' : 'chip'} onClick={() => setHelpful(false)}>
            Not helpful
          </button>
        </div>
        <div className="sd-rating-row" role="group" aria-label="Rating out of five">
          {[1, 2, 3, 4, 5].map((n) => (
            <button
              key={n}
              type="button"
              className={n <= rating ? 'sd-star-btn on' : 'sd-star-btn'}
              onClick={() => setRating(n === rating ? 0 : n)}
              aria-pressed={n <= rating}
              title={String(n) + ' of 5'}
            >
              {'\u2605'}
            </button>
          ))}
          <span className="muted">{rating ? rating + ' / 5' : 'No rating'}</span>
        </div>
        <Txa value={comment} onChange={setComment} rows={3} placeholder="Anything that would make this article better?" />
        <div className="sd-kb-feedback-actions">
          <button className="btn btn-primary btn-sm" onClick={() => void submit()} disabled={busy}>
            {busy ? 'Sending' : mine ? 'Update my feedback' : 'Send feedback'}
          </button>
          {saved && <span className="sd-saved">{saved}</span>}
        </div>
        <FormErrorText msg={error} />
      </div>

      {feedback.length > 0 && (
        <ul className="sd-kb-feedback-list">
          {feedback.map((f) => (
            <li key={s(f.id)}>
              <div className="sd-kb-feedback-head">
                <b>{[s(f.first_name), s(f.last_name)].filter(Boolean).join(' ') || s(f.user_email) || 'Employee'}</b>
                <span className={'sd-chip ' + (f.is_helpful === false ? 'sd-kb-archived' : 'sd-kb-published')}>
                  {f.is_helpful === false ? 'Not helpful' : f.is_helpful === true ? 'Helpful' : 'Rating only'}
                </span>
                {num(f.rating) > 0 && <Stars value={f.rating} />}
                <span className="muted sub">{fmtAgo(f.created_at)}</span>
              </div>
              {s(f.comment) && <p className="sd-kb-feedback-comment">{s(f.comment)}</p>}
            </li>
          ))}
        </ul>
      )}
    </SecCard>
  );
}

/* ------------------------------------------------------------------ *
 * Article editor
 * ------------------------------------------------------------------ */

function ArticleEditor({
  row,
  categories,
  onClose,
  onSaved,
  canManage,
}: {
  row?: Rec | null;
  categories: Rec[];
  onClose: () => void;
  onSaved: (newId?: number) => void;
  canManage: boolean;
}) {
  const editing = Boolean(row);
  const [title, setTitle] = useState(s(row?.title));
  const [summary, setSummary] = useState(s(row?.summary));
  const [body, setBody] = useState(s(row?.body));
  const [categoryId, setCategoryId] = useState(s(row?.category_id));
  const [keywords, setKeywords] = useState(Array.isArray(row?.keywords) ? (row?.keywords as unknown[]).map((k) => s(k)).join(', ') : '');
  const [classification, setClassification] = useState(s(row?.data_classification) || 'INTERNAL');
  const [audience, setAudience] = useState(Array.isArray(row?.audience_roles) ? (row?.audience_roles as unknown[]).map((k) => s(k)).join(', ') : '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const save = async () => {
    setBusy(true);
    setError('');
    try {
      const kw = keywords
        .split(',')
        .map((k) => k.trim())
        .filter(Boolean);
      const au = audience
        .split(',')
        .map((k) => k.trim())
        .filter(Boolean);
      if (editing && row) {
        await sdPatch('/api/service-desk/knowledge/articles/' + s(row.id), {
          title: title.trim(),
          summary: summary.trim() || null,
          body,
          categoryId: categoryId ? Number(categoryId) : null,
          dataClassification: classification,
          keywords: kw,
          audienceRoles: au.length ? au : null,
        });
        onSaved();
      } else {
        const res = await sdPost<Rec>('/api/service-desk/knowledge/articles', {
          title: title.trim(),
          summary: summary.trim() || undefined,
          body,
          categoryId: categoryId ? Number(categoryId) : undefined,
          dataClassification: classification,
          keywords: kw,
          audienceRoles: au.length ? au : undefined,
        });
        onSaved(num(res.id) || undefined);
      }
    } catch (e) {
      setError(sdErr(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={editing ? 'Edit article ' + s(row?.article_number) : 'New knowledge article'}
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={() => void save()} disabled={busy || !title.trim() || !body.trim()}>
            {busy ? 'Saving' : editing ? 'Save article' : 'Create draft'}
          </button>
        </>
      }
    >
      <div className="sd-form-grid">
        <Field label="Title" req>
          <Inp value={title} onChange={setTitle} placeholder="How to reconnect a Hikvision attendance terminal" />
        </Field>
        <Field label="Category">
          <Sel
            value={categoryId}
            onChange={setCategoryId}
            options={[{ value: '', label: 'Uncategorised' }].concat(categories.map((c) => ({ value: s(c.id), label: s(c.name) })))}
          />
        </Field>
        <Field label="Summary" hint="One or two lines shown in search results.">
          <Inp value={summary} onChange={setSummary} placeholder="Short description" />
        </Field>
        <Field label="Classification">
          <Sel
            value={classification}
            onChange={setClassification}
            options={['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED'].map((v) => ({ value: v, label: v }))}
          />
        </Field>
        <Field label="Keywords" hint="Comma separated. Used by ticket recommendations.">
          <Inp value={keywords} onChange={setKeywords} placeholder="hikvision, terminal, attendance" />
        </Field>
        {canManage && (
          <Field label="Audience roles" hint="Comma separated role codes. Leave blank for everyone.">
            <Inp value={audience} onChange={setAudience} placeholder="it_support_agent, employee_self_service" />
          </Field>
        )}
        <Field label="Body" req hint="Plain text or markdown. Rendered as written.">
          <Txa value={body} onChange={setBody} rows={16} placeholder="Step by step guidance..." />
        </Field>
      </div>
      <FormErrorText msg={error} />
    </Modal>
  );
}
