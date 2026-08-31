import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { api, fmtDate, getToken } from '../api';
import { useAuth, can } from '../auth';
import { navigate, useHashQuery } from '../router';
import { Badge, ErrorBanner, Modal, PageLoader, Pager } from '../components/ui';
import { pick, titleCase } from '../helpers';

type Rec = Record<string, unknown>;

const CATEGORIES = [
  'POLICY', 'PROCEDURE', 'WORK_INSTRUCTION', 'FORM', 'TEMPLATE', 'MANUAL', 'GUIDELINE',
  'CONTRACT', 'REPORT', 'CERTIFICATE', 'SPECIFICATION', 'DRAWING', 'TRAINING_MATERIAL',
  'QUALITY_RECORD', 'REGULATORY', 'OTHER',
];
const CLASSIFICATIONS = ['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED'];
const STATUSES = ['DRAFT', 'IN_REVIEW', 'APPROVED', 'RELEASED', 'ARCHIVED', 'OBSOLETE'];

function parseDoc(path: string): { view: string; id: string | null } {
  const parts = path.split('/').filter(Boolean);
  if (parts[0] !== 'documents') return { view: 'command', id: null };
  return { view: parts[1] ?? 'command', id: parts[2] ?? null };
}

function fmtBytes(v: unknown): string {
  const n = Number(v ?? 0);
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function catLabel(c: unknown): string {
  return titleCase(String(c ?? '').replace(/_/g, ' '));
}

function trunc(s: unknown, n = 90): string {
  const t = String(s ?? '');
  return t.length > n ? t.slice(0, n) + '…' : t;
}

function fmtInt(v: unknown): string {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n.toLocaleString() : String(v ?? '');
}

function hasFile(d: Rec): boolean {
  const sp = pick(d, 'storagePath', 'storage_path');
  const fs = Number(pick(d, 'fileSize', 'file_size') ?? 0);
  return !!sp && fs > 0;
}
function DocTabs({ active }: { active: string }) {
  const { user } = useAuth();
  const tabs: { id: string; label: string; href: string; perm: string }[] = [
    { id: 'command', label: 'Dashboard', href: '/documents', perm: 'documents.command.view' },
    { id: 'library', label: 'Library', href: '/documents/library', perm: 'documents.view' },
    { id: 'folders', label: 'Folders', href: '/documents/folders', perm: 'documents.folders.manage' },
    { id: 'approvals', label: 'Approvals', href: '/documents/approvals', perm: 'documents.approve' },
    { id: 'audit', label: 'Activity', href: '/documents/audit', perm: 'documents.command.view' },
    { id: 'settings', label: 'Settings', href: '/documents/settings', perm: 'documents.settings.manage' },
  ].filter((t) => can(user, t.perm));
  return (
    <div className="doc-tabs">
      {tabs.map((t) => (
        <button key={t.id} className={'tab' + (t.id === active ? ' active' : '')} onClick={() => navigate(t.href)}>
          {t.label}
        </button>
      ))}
    </div>
  );
}

function DocHead({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="page-head">
      <div>
        <p className="mod-kicker" data-mod="doc">Document Management</p>
        <h1>{title}</h1>
        {subtitle ? <p className="muted">{subtitle}</p> : null}
      </div>
      {actions ? <div className="head-actions">{actions}</div> : null}
    </header>
  );
}

function Kpi({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: string }) {
  return (
    <div className="kpi-card">
      <span className="kpi-label">{label}</span>
      <span className={'kpi-value' + (tone ? ` ${tone}` : '')}>{value}</span>
      {sub ? <span className="kpi-sub">{sub}</span> : null}
    </div>
  );
}
function CommandView() {
  const { user } = useAuth();
  const [data, setData] = useState<Rec | null>(null);
  const [err, setErr] = useState('');
  const load = useCallback(async () => {
    try {
      const r = await api<{ data: Rec }>('/api/ops/documents/command');
      setData(r.data);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not load the document command center');
    }
  }, []);
  useEffect(() => { void load(); }, [load]);
  if (err) return <div className="card card-pad"><ErrorBanner error={err} /></div>;
  if (!data) return <PageLoader label="Loading document command center…" />;
  const k = (data.kpis ?? {}) as Rec;
  const pending = (data.pendingReview ?? []) as Rec[];
  const activity = (data.activity ?? []) as Rec[];
  const cats = (data.categories ?? []) as Rec[];
  const first = String(pick((user as unknown as Rec), 'firstName', 'first_name') ?? '');
  const hour = new Date().getHours();
  const greet = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  return (
    <>
      <DocHead
        title={`${greet}${first ? `, ${first}` : ''}`}
        subtitle="Document Management command center — what needs your attention"
        actions={
          can(user, 'documents.create') ? (
            <button className="btn btn-primary" onClick={() => navigate('/documents/library', { query: { new: 1 } })}>
              + New Document
            </button>
          ) : undefined
        }
      />
      <DocTabs active="command" />
      <div className="kpi-grid">
        <Kpi label="Total Documents" value={fmtInt(k.totalDocuments)} />
        <Kpi label="Released" value={fmtInt(k.released)} tone="kpi-ok" />
        <Kpi label="Pending Review" value={fmtInt(k.pendingReview)} tone={Number(k.pendingReview) > 0 ? 'kpi-warn' : ''} />
        <Kpi label="Drafts" value={fmtInt(k.drafts)} />
        <Kpi label="Archived / Obsolete" value={fmtInt(k.archived)} />
        <Kpi label="Storage Used" value={fmtBytes(k.storageBytes)} />
        <Kpi label="Expiring Soon" value={fmtInt(k.expiringSoon)} tone={Number(k.expiringSoon) > 0 ? 'kpi-warn' : ''} />
        <Kpi label="Folders" value={fmtInt(k.folders)} />
      </div>
      <div className="grid-2">
        <section className="card card-pad">
          <div className="card-head">
            <h3>Pending Review</h3>
            {Number(k.pendingReview) > 0 ? <Badge value={`${k.pendingReview} waiting`} /> : null}
          </div>
          {pending.length === 0 ? (
            <div className="empty-state">
              <p>No documents awaiting review.</p>
              {can(user, 'documents.create') ? (
                <button className="btn btn-primary" onClick={() => navigate('/documents/library', { query: { new: 1 } })}>
                  Create a Document
                </button>
              ) : null}
            </div>
          ) : (
            <div className="doc-list">
              {pending.map((d) => (
                <button key={String(pick(d, 'id'))} className="doc-notif" onClick={() => navigate(`/documents/library/${pick(d, 'id')}`)}>
                  <div className="doc-notif-top">
                    <span className="doc-notif-code cell-mono">{String(pick(d, 'code') ?? '')}</span>
                    <Badge value={pick(d, 'classification')} />
                  </div>
                  <span className="doc-notif-title">{trunc(pick(d, 'title'), 70)}</span>
                  <span className="doc-notif-meta">
                    {catLabel(pick(d, 'category'))} · {String(pick(d, 'folderName', 'folder_name') ?? 'Unfiled')}
                    {pick(d, 'submittedAt', 'submitted_at') ? <> · Submitted {fmtDate(pick(d, 'submittedAt', 'submitted_at'))}</> : null}
                  </span>
                  {pick(d, 'submissionNote', 'submission_note') ? (
                    <span className="doc-act-comment">{trunc(pick(d, 'submissionNote', 'submission_note'), 120)}</span>
                  ) : null}
                  <span className="doc-notif-actions">
                    <span className="btn btn-sm btn-primary">Review</span>
                  </span>
                </button>
              ))}
            </div>
          )}
        </section>
        <section className="card card-pad">
          <div className="card-head">
            <h3>Quick Actions</h3>
          </div>
          <div className="doc-list">
            <button className="doc-quick" onClick={() => navigate('/documents/library', { query: { new: 1 } })}>
              <span>
                <span className="doc-quick-label">Create Document</span>
                <span className="doc-sub">New controlled document</span>
              </span>
            </button>
            <button className="doc-quick" onClick={() => navigate('/documents/library')}>
              <span>
                <span className="doc-quick-label">Browse Library</span>
                <span className="doc-sub">Search all controlled documents</span>
              </span>
            </button>
            <button className="doc-quick" onClick={() => navigate('/documents/approvals')}>
              <span>
                <span className="doc-quick-label">Approvals</span>
                <span className="doc-sub">{fmtInt(k.pendingReview)} documents awaiting review</span>
              </span>
            </button>
            <button className="doc-quick" onClick={() => navigate('/documents/folders')}>
              <span>
                <span className="doc-quick-label">Manage Folders</span>
                <span className="doc-sub">{fmtInt(k.folders)} folders</span>
              </span>
            </button>
          </div>
          <div className="card-head" style={{ marginTop: 18 }}>
            <h3>Categories</h3>
          </div>
          <div className="doc-chips">
            {cats.map((c) => (
              <button
                key={String(pick(c, 'category'))}
                className="doc-chip"
                onClick={() => navigate('/documents/library', { query: { category: String(pick(c, 'category') ?? '') } })}
              >
                {catLabel(pick(c, 'category'))}
                <span className="doc-chip-count">{fmtInt(pick(c, 'count'))}</span>
              </button>
            ))}
          </div>
        </section>
      </div>
      <section className="card card-pad">
        <div className="card-head">
          <h3>Recent Activity</h3>
        </div>
        {activity.length === 0 ? (
          <div className="empty-state">
            <p>No review activity recorded yet.</p>
          </div>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Action</th>
                  <th>Document</th>
                  <th>Comment</th>
                  <th>Reviewer</th>
                  <th>Date</th>
                </tr>
              </thead>
              <tbody>
                {activity.map((a) => (
                  <tr key={String(pick(a, 'id'))}>
                    <td><Badge value={pick(a, 'action')} /></td>
                    <td>
                      <span className="cell-main">{String(pick(a, 'documentCode', 'document_code') ?? '')}</span>
                      <span className="cell-sub">{trunc(pick(a, 'documentTitle', 'document_title'), 60)}</span>
                    </td>
                    <td className="muted">{pick(a, 'comment') ? trunc(pick(a, 'comment'), 60) : '—'}</td>
                    <td>{String(pick(a, 'reviewerName', 'reviewer_name') ?? '—')}</td>
                    <td className="cell-mono">{fmtDate(pick(a, 'createdAt', 'created_at'))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

function CreateDocModal({
  folders,
  onClose,
  onCreated,
}: {
  folders: Rec[];
  onClose: () => void;
  onCreated: (id: number) => void;
}) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [folderId, setFolderId] = useState('');
  const [category, setCategory] = useState('POLICY');
  const [classification, setClassification] = useState('INTERNAL');
  const [tags, setTags] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const submit = async () => {
    if (busy) return;
    if (!title.trim()) {
      setErr('Document title is required');
      return;
    }
    setBusy(true);
    setErr('');
    try {
      const r = await api<{ data: Rec }>('/api/ops/documents', {
        method: 'POST',
        body: JSON.stringify({
          title: title.trim(),
          description: description.trim() || undefined,
          folderId: folderId ? Number(folderId) : undefined,
          category,
          classification,
          tags: tags.split(',').map((t) => t.trim()).filter(Boolean),
        }),
      });
      onCreated(Number((r.data as Rec).id));
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not create the document');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title="New Document"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy} onClick={() => void submit()}>
            {busy ? 'Creating…' : 'Create Document'}
          </button>
        </>
      }
    >
      {err ? <ErrorBanner error={err} /> : null}
      <div className="form-grid">
        <label className="field field-required">
          <span className="field-label">Title</span>
          <input className="search-input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. NATEX A4 Quality Inspection Procedure" />
        </label>
        <label className="field">
          <span className="field-label">Description</span>
          <textarea className="search-input" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
        </label>
        <label className="field">
          <span className="field-label">Folder</span>
          <select className="search-input" value={folderId} onChange={(e) => setFolderId(e.target.value)}>
            <option value="">— No folder —</option>
            {folders.map((f) => (
              <option key={String(pick(f, 'id'))} value={String(pick(f, 'id'))}>{String(pick(f, 'name') ?? '')}</option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="field-label">Category</span>
          <select className="search-input" value={category} onChange={(e) => setCategory(e.target.value)}>
            {CATEGORIES.map((c) => <option key={c} value={c}>{catLabel(c)}</option>)}
          </select>
        </label>
        <label className="field">
          <span className="field-label">Classification</span>
          <select className="search-input" value={classification} onChange={(e) => setClassification(e.target.value)}>
            {CLASSIFICATIONS.map((c) => <option key={c} value={c}>{titleCase(c)}</option>)}
          </select>
        </label>
        <label className="field">
          <span className="field-label">Tags (comma separated)</span>
          <input className="search-input" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="quality, natex, sop" />
        </label>
      </div>
    </Modal>
  );
}
function LibraryView() {
  const { user } = useAuth();
  const q = useHashQuery();
  const folderId = q.get('folderId') ?? '';
  const category = q.get('category') ?? '';
  const status = q.get('status') ?? '';
  const classification = q.get('classification') ?? '';
  const search = q.get('q') ?? '';
  const page = Math.max(1, Number(q.get('page')) || 1);
  const [searchInput, setSearchInput] = useState(search);
  const [rows, setRows] = useState<Rec[]>([]);
  const [folders, setFolders] = useState<Rec[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showCreate, setShowCreate] = useState(Boolean(q.get('new')));
  const pageSize = 15;

  useEffect(() => { setSearchInput(search); }, [search]);
  useEffect(() => { setShowCreate(Boolean(q.get('new'))); }, [q]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError('');
    const params = new URLSearchParams();
    if (folderId) params.set('folderId', folderId);
    if (category) params.set('category', category);
    if (status) params.set('status', status);
    if (classification) params.set('classification', classification);
    if (search) params.set('q', search);
    params.set('page', String(page));
    params.set('pageSize', String(pageSize));
    api<{ data: { rows: Rec[]; pagination: { page: number; pageSize: number; total: number } } }>(
      `/api/ops/documents?${params.toString()}`
    )
      .then((r) => {
        if (alive) {
          setRows(r.data.rows ?? []);
          setTotal(r.data.pagination?.total ?? 0);
        }
      })
      .catch((e) => {
        if (alive) setError(e instanceof Error ? e.message : 'Could not load documents');
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => { alive = false; };
  }, [folderId, category, status, classification, search, page]);

  useEffect(() => {
    let alive = true;
    api<{ data: Rec[] }>('/api/ops/documents/folders')
      .then((r) => { if (alive) setFolders(r.data ?? []); })
      .catch(() => { /* sidebar is optional */ });
    return () => { alive = false; };
  }, []);

  const setListQuery = (next: { folderId?: string; category?: string; status?: string; classification?: string; q?: string; page?: number }) => {
    navigate('/documents/library', {
      replace: true,
      query: {
        folderId: next.folderId !== undefined ? next.folderId : folderId,
        category: next.category !== undefined ? next.category : category,
        status: next.status !== undefined ? next.status : status,
        classification: next.classification !== undefined ? next.classification : classification,
        q: next.q !== undefined ? next.q : search,
        page: next.page !== undefined ? next.page : page,
      },
    });
  };

  const applySearch = () => setListQuery({ q: searchInput.trim(), page: 1 });
  return (
    <>
      <DocHead
        title="Document Library"
        subtitle="Browse, search and manage all controlled documents"
        actions={
          can(user, 'documents.create') ? (
            <button className="btn btn-primary" onClick={() => setShowCreate(true)}>+ New Document</button>
          ) : undefined
        }
      />
      <DocTabs active="library" />
      {showCreate ? (
        <CreateDocModal
          folders={folders}
          onClose={() => { setShowCreate(false); navigate('/documents/library', { replace: true }); }}
          onCreated={(id) => { setShowCreate(false); navigate(`/documents/library/${id}`); }}
        />
      ) : null}
      <div className="doc-lib-layout">
        <aside className="doc-folder-tree">
          <div className="doc-folder-tree-head">Folders</div>
          <button className={'doc-folder' + (!folderId ? ' active' : '')} onClick={() => setListQuery({ folderId: '', page: 1 })}>
            <span className="doc-folder-row">
              <span>All Documents</span>
              <span className="doc-folder-count">{fmtInt(total)}</span>
            </span>
          </button>
          {folders.map((f) => (
            <button
              key={String(pick(f, 'id'))}
              className={'doc-folder' + (folderId === String(pick(f, 'id')) ? ' active' : '')}
              onClick={() => setListQuery({ folderId: String(pick(f, 'id')), page: 1 })}
            >
              <span className="doc-folder-row">
                <span>{String(pick(f, 'name') ?? '')}</span>
                <span className="doc-folder-count">{fmtInt(pick(f, 'documentCount', 'document_count'))}</span>
              </span>
            </button>
          ))}
        </aside>
        <div className="doc-lib-main">
          <div className="filter-row">
            <input
              className="search-input"
              placeholder="Search documents…"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') applySearch(); }}
            />
            <select className="search-input" value={category} onChange={(e) => setListQuery({ category: e.target.value, page: 1 })}>
              <option value="">All Categories</option>
              {CATEGORIES.map((c) => <option key={c} value={c}>{catLabel(c)}</option>)}
            </select>
            <select className="search-input" value={status} onChange={(e) => setListQuery({ status: e.target.value, page: 1 })}>
              <option value="">All Statuses</option>
              {STATUSES.map((s) => <option key={s} value={s}>{titleCase(s.replace('_', ' '))}</option>)}
            </select>
            <select className="search-input" value={classification} onChange={(e) => setListQuery({ classification: e.target.value, page: 1 })}>
              <option value="">All Classifications</option>
              {CLASSIFICATIONS.map((c) => <option key={c} value={c}>{titleCase(c)}</option>)}
            </select>
            <button className="btn btn-sm" onClick={applySearch}>Search</button>
          </div>
          {loading ? (
            <PageLoader label="Loading documents…" />
          ) : error ? (
            <ErrorBanner error={error} />
          ) : rows.length === 0 ? (
            <div className="empty-state">
              <p>No documents match the current filters.</p>
              <button className="btn btn-primary" onClick={() => setListQuery({ folderId: '', category: '', status: '', classification: '', q: '', page: 1 })}>
                Clear Filters
              </button>
            </div>
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Code</th>
                    <th>Title</th>
                    <th>Folder</th>
                    <th>Category</th>
                    <th>Status</th>
                    <th>Classification</th>
                    <th>Ver</th>
                    <th>Updated</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((d) => (
                    <tr key={String(pick(d, 'id'))} className="row-click" onClick={() => navigate(`/documents/library/${pick(d, 'id')}`)}>
                      <td className="cell-mono">{String(pick(d, 'code') ?? '')}</td>
                      <td>
                        <span className="cell-main">{trunc(pick(d, 'title'), 60)}</span>
                        {Array.isArray(pick(d, 'tags')) && (pick(d, 'tags') as unknown[]).length > 0 ? (
                          <span className="cell-sub">{String((pick(d, 'tags') as unknown[]).slice(0, 3).join(', '))}</span>
                        ) : null}
                      </td>
                      <td className="muted">{String(pick(d, 'folderName', 'folder_name') ?? '') || '—'}</td>
                      <td><Badge value={pick(d, 'category')} /></td>
                      <td><Badge value={pick(d, 'status')} /></td>
                      <td><Badge value={pick(d, 'classification')} /></td>
                      <td className="cell-mono">v{String(pick(d, 'versionCount', 'version_count') ?? pick(d, 'version') ?? 1)}</td>
                      <td className="cell-mono">{fmtDate(pick(d, 'updatedAt', 'updated_at'))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <Pager page={page} pageSize={pageSize} total={total} onPage={(p) => setListQuery({ page: p })} />
            </div>
          )}
        </div>
      </div>
    </>
  );
}
function UploadModal({ id, onClose, onDone }: { id: number; onClose: () => void; onDone: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [changeNote, setChangeNote] = useState('');
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const submit = async () => {
    if (busy) return;
    if (!file) {
      setErr('Select a file to upload');
      return;
    }
    setBusy(true);
    setErr('');
    try {
      const fd = new FormData();
      fd.append('file', file);
      if (changeNote.trim()) fd.append('changeNote', changeNote.trim());
      if (title.trim()) fd.append('title', title.trim());
      await api(`/api/ops/documents/${id}/upload`, { method: 'POST', body: fd });
      onDone();
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not upload the file');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title="Upload New Version"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy} onClick={() => void submit()}>
            {busy ? 'Uploading…' : 'Upload File'}
          </button>
        </>
      }
    >
      {err ? <ErrorBanner error={err} /> : null}
      <div className="form-grid">
        <label className="field field-required">
          <span className="field-label">File</span>
          <input type="file" className="search-input" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        </label>
        <label className="field">
          <span className="field-label">Change Note</span>
          <textarea className="search-input" rows={2} value={changeNote} onChange={(e) => setChangeNote(e.target.value)} placeholder="What changed in this version?" />
        </label>
        <label className="field">
          <span className="field-label">New Title (optional)</span>
          <input className="search-input" value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <p className="muted" style={{ fontSize: 12.5 }}>Uploading a file creates a new document version. The previous version is retained for audit and traceability.</p>
      </div>
    </Modal>
  );
}
function EditDocModal({ doc, folders, onClose, onSaved }: { doc: Rec; folders: Rec[]; onClose: () => void; onSaved: () => void }) {
  const [title, setTitle] = useState(String(pick(doc, 'title') ?? ''));
  const [description, setDescription] = useState(String(pick(doc, 'description') ?? ''));
  const [folderId, setFolderId] = useState(String(pick(doc, 'folderId', 'folder_id') ?? ''));
  const [category, setCategory] = useState(String(pick(doc, 'category') ?? 'POLICY'));
  const [classification, setClassification] = useState(String(pick(doc, 'classification') ?? 'INTERNAL'));
  const [tags, setTags] = useState(Array.isArray(pick(doc, 'tags')) ? (pick(doc, 'tags') as unknown[]).join(', ') : '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const submit = async () => {
    if (busy) return;
    if (!title.trim()) {
      setErr('Document title is required');
      return;
    }
    setBusy(true);
    setErr('');
    try {
      await api(`/api/ops/documents/${pick(doc, 'id')}`, {
        method: 'PATCH',
        body: JSON.stringify({
          title: title.trim(),
          description: description.trim() || undefined,
          folderId: folderId ? Number(folderId) : undefined,
          category,
          classification,
          tags: tags.split(',').map((t) => t.trim()).filter(Boolean),
        }),
      });
      onSaved();
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not save the document');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title="Edit Document"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy} onClick={() => void submit()}>
            {busy ? 'Saving…' : 'Save Changes'}
          </button>
        </>
      }
    >
      {err ? <ErrorBanner error={err} /> : null}
      <div className="form-grid">
        <label className="field field-required">
          <span className="field-label">Title</span>
          <input className="search-input" value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <label className="field">
          <span className="field-label">Description</span>
          <textarea className="search-input" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
        </label>
        <label className="field">
          <span className="field-label">Folder</span>
          <select className="search-input" value={folderId} onChange={(e) => setFolderId(e.target.value)}>
            <option value="">— No folder —</option>
            {folders.map((f) => (
              <option key={String(pick(f, 'id'))} value={String(pick(f, 'id'))}>{String(pick(f, 'name') ?? '')}</option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="field-label">Category</span>
          <select className="search-input" value={category} onChange={(e) => setCategory(e.target.value)}>
            {CATEGORIES.map((c) => <option key={c} value={c}>{catLabel(c)}</option>)}
          </select>
        </label>
        <label className="field">
          <span className="field-label">Classification</span>
          <select className="search-input" value={classification} onChange={(e) => setClassification(e.target.value)}>
            {CLASSIFICATIONS.map((c) => <option key={c} value={c}>{titleCase(c)}</option>)}
          </select>
        </label>
        <label className="field">
          <span className="field-label">Tags (comma separated)</span>
          <input className="search-input" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="quality, natex, sop" />
        </label>
      </div>
    </Modal>
  );
}
function ReviewModal({
  id,
  code,
  action,
  label,
  commentRequired,
  onClose,
  onDone,
}: {
  id: number;
  code: string;
  action: string;
  label: string;
  commentRequired: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const canSave = !commentRequired || comment.trim().length > 0;
  const submit = async () => {
    if (busy || !canSave) return;
    setBusy(true);
    setErr('');
    try {
      await api(`/api/ops/documents/${id}/review`, {
        method: 'POST',
        body: JSON.stringify({ action, comment: comment.trim() || undefined }),
      });
      onDone();
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not complete the review action');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={`${label} — ${code}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy || !canSave} onClick={() => void submit()}>
            {busy ? 'Saving…' : label}
          </button>
        </>
      }
    >
      {err ? <ErrorBanner error={err} /> : null}
      <div className="form-grid">
        <label className={'field' + (commentRequired ? ' field-required' : '')}>
          <span className="field-label">Comment</span>
          <textarea
            className="search-input"
            rows={3}
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder={commentRequired ? 'A comment is required for this action' : 'Optional comment'}
            autoFocus
          />
        </label>
      </div>
    </Modal>
  );
}
function DetailView({ id }: { id: number }) {
  const { user } = useAuth();
  const [doc, setDoc] = useState<Rec | null>(null);
  const [versions, setVersions] = useState<Rec[]>([]);
  const [reviews, setReviews] = useState<Rec[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [review, setReview] = useState<{ action: string; label: string; commentRequired: boolean } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [downloadErr, setDownloadErr] = useState('');

  const load = useCallback(async () => {
    try {
      const r = await api<{ data: { document: Rec; versions: Rec[]; reviews: Rec[] } }>(`/api/ops/documents/${id}`);
      setDoc(r.data.document ?? null);
      setVersions(r.data.versions ?? []);
      setReviews(r.data.reviews ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the document');
    } finally {
      setLoading(false);
    }
  }, [id]);
  useEffect(() => { void load(); }, [load, reload]);

  const downloadFile = async () => {
    setDownloadErr('');
    try {
      const res = await fetch(`/api/ops/documents/${id}/file?download=1`, {
        headers: getToken() ? { Authorization: `Bearer ${getToken()}` } : undefined,
      });
      if (!res.ok) throw new Error('Could not download the file');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = String(pick(doc ?? {}, 'fileName', 'file_name') ?? 'document');
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      setDownloadErr(e instanceof Error ? e.message : 'Could not download the file');
    }
  };

  const doDelete = async () => {
    if (deleteBusy) return;
    setDeleteBusy(true);
    try {
      await api(`/api/ops/documents/${id}`, { method: 'DELETE' });
      navigate('/documents/library');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not delete the document');
      setDeleteBusy(false);
    }
  };

  const status = String(pick(doc ?? {}, 'status') ?? '');
  const actions: { key: string; label: string; action: string; commentRequired: boolean }[] = [];
  if (status === 'DRAFT') actions.push({ key: 'submit', label: 'Submit for Review', action: 'SUBMITTED', commentRequired: false });
  if (status === 'IN_REVIEW') {
    actions.push({ key: 'approve', label: 'Approve', action: 'APPROVED', commentRequired: false });
    actions.push({ key: 'request', label: 'Request Changes', action: 'REQUEST_CHANGES', commentRequired: true });
    actions.push({ key: 'reject', label: 'Reject', action: 'REJECTED', commentRequired: true });
    actions.push({ key: 'release', label: 'Release', action: 'RELEASED', commentRequired: false });
  }
  if (status === 'APPROVED') actions.push({ key: 'release', label: 'Release', action: 'RELEASED', commentRequired: false });
  const isTerminal = status === 'ARCHIVED' || status === 'OBSOLETE';
  const [folders, setFolders] = useState<Rec[]>([]);
  useEffect(() => {
    let alive = true;
    api<{ data: Rec[] }>('/api/ops/documents/folders')
      .then((r) => { if (alive) setFolders(r.data ?? []); })
      .catch(() => { /* folder list is optional here */ });
    return () => { alive = false; };
  }, []);
  return (
    <>
      <DocHead
        title={doc ? String(pick(doc, 'title') ?? 'Document') : 'Document'}
        subtitle={doc ? `${String(pick(doc, 'code') ?? '')} · ${catLabel(pick(doc, 'category'))}` : undefined}
        actions={
          doc ? (
            <>
              {hasFile(doc) && can(user, 'documents.download') ? (
                <button className="btn" onClick={() => void downloadFile()}>Download</button>
              ) : null}
              {can(user, 'documents.upload') ? (
                <button className="btn" onClick={() => setUploadOpen(true)}>+ New Version</button>
              ) : null}
              {can(user, 'documents.edit') ? (
                <button className="btn" onClick={() => setEditOpen(true)}>Edit</button>
              ) : null}
              {actions.map((a) => (
                <button key={a.key} className="btn btn-primary" onClick={() => setReview({ action: a.action, label: a.label, commentRequired: a.commentRequired })}>
                  {a.label}
                </button>
              ))}
              {can(user, 'documents.approve') && !isTerminal ? (
                <button className="btn" onClick={() => setReview({ action: 'ARCHIVED', label: 'Archive', commentRequired: false })}>Archive</button>
              ) : null}
              {can(user, 'documents.approve') && isTerminal ? (
                <button className="btn" onClick={() => setReview({ action: 'RESTORED', label: 'Restore', commentRequired: false })}>Restore</button>
              ) : null}
              {can(user, 'documents.delete') ? (
                <button className="btn btn-danger" onClick={() => setConfirmDelete(true)}>Delete</button>
              ) : null}
            </>
          ) : undefined
        }
      />
      <DocTabs active="library" />
      {downloadErr ? <div style={{ marginBottom: 10 }}><ErrorBanner error={downloadErr} /></div> : null}
      {uploadOpen ? <UploadModal id={id} onClose={() => setUploadOpen(false)} onDone={() => setReload((n) => n + 1)} /> : null}
      {editOpen ? (
        <EditDocModal doc={doc ?? {}} folders={folders} onClose={() => setEditOpen(false)} onSaved={() => setReload((n) => n + 1)} />
      ) : null}
      {review ? (
        <ReviewModal
          id={id}
          code={String(pick(doc ?? {}, 'code') ?? '')}
          action={review.action}
          label={review.label}
          commentRequired={review.commentRequired}
          onClose={() => setReview(null)}
          onDone={() => setReload((n) => n + 1)}
        />
      ) : null}
      {confirmDelete ? (
        <Modal
          title="Delete Document"
          onClose={() => setConfirmDelete(false)}
          footer={
            <>
              <button className="btn" onClick={() => setConfirmDelete(false)}>Cancel</button>
              <button className="btn btn-danger" disabled={deleteBusy} onClick={() => void doDelete()}>
                {deleteBusy ? 'Deleting…' : 'Delete Document'}
              </button>
            </>
          }
        >
          <p>Are you sure you want to delete {String(pick(doc ?? {}, 'code') ?? '')}? This action can be reversed by an administrator.</p>
        </Modal>
      ) : null}
      {loading ? (
        <PageLoader label="Loading document…" />
      ) : error ? (
        <ErrorBanner error={error} />
      ) : !doc ? (
        <div className="empty-state"><p>Document not found.</p></div>
      ) : (
        <>
          <div className="card card-pad" style={{ marginBottom: 14 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
              <span className="cell-mono" style={{ fontSize: 13 }}>{String(pick(doc, 'code') ?? '')}</span>
              <Badge value={pick(doc, 'status')} />
              <Badge value={pick(doc, 'classification')} />
              <span className="muted">Version {String(pick(doc, 'version') ?? 1)}</span>
            </div>
            {pick(doc, 'description') ? <p style={{ marginBottom: 12 }}>{String(pick(doc, 'description'))}</p> : null}
            <div className="doc-info-grid">
              <div className="doc-info-item"><span className="doc-info-label">Folder</span><span className="doc-info-value">{String(pick(doc, 'folderName', 'folder_name') ?? '') || '—'}</span></div>
              <div className="doc-info-item"><span className="doc-info-label">Category</span><span className="doc-info-value">{catLabel(pick(doc, 'category'))}</span></div>
              <div className="doc-info-item"><span className="doc-info-label">Owner</span><span className="doc-info-value">{String(pick(doc, 'ownerName', 'owner_name') ?? '—')}</span></div>
              <div className="doc-info-item"><span className="doc-info-label">Created By</span><span className="doc-info-value">{String(pick(doc, 'createdByName', 'created_by_name') ?? '—')}</span></div>
              <div className="doc-info-item"><span className="doc-info-label">Created</span><span className="doc-info-value">{fmtDate(pick(doc, 'createdAt', 'created_at'))}</span></div>
              <div className="doc-info-item"><span className="doc-info-label">Updated</span><span className="doc-info-value">{fmtDate(pick(doc, 'updatedAt', 'updated_at'))}</span></div>
              <div className="doc-info-item"><span className="doc-info-label">File Size</span><span className="doc-info-value">{fmtBytes(pick(doc, 'fileSize', 'file_size'))}</span></div>
              <div className="doc-info-item"><span className="doc-info-label">Retention Until</span><span className="doc-info-value">{fmtDate(pick(doc, 'retentionUntil', 'retention_until'))}</span></div>
              {Array.isArray(pick(doc, 'tags')) && (pick(doc, 'tags') as unknown[]).length > 0 ? (
                <div className="doc-info-item">
                  <span className="doc-info-label">Tags</span>
                  <span className="doc-info-value">{(pick(doc, 'tags') as unknown[]).join(', ')}</span>
                </div>
              ) : null}
              {pick(doc, 'isTemplate') ? <div className="doc-info-item"><span className="doc-info-label">Template</span><span className="doc-info-value">Yes</span></div> : null}
            </div>
          </div>
          <div className="grid-2">
            <section className="card card-pad">
              <div className="card-head"><h3>Versions</h3></div>
              {versions.length === 0 ? (
                <div className="empty-state">
                  <p>No file versions uploaded yet. Upload the first file to enable downloads and change tracking.</p>
                  {can(user, 'documents.upload') ? (
                    <button className="btn btn-primary" onClick={() => setUploadOpen(true)}>Upload File</button>
                  ) : null}
                </div>
              ) : (
                <div className="table-wrap">
                  <table className="data">
                    <thead>
                      <tr>
                        <th>Version</th>
                        <th>File</th>
                        <th>Size</th>
                        <th>Change Note</th>
                        <th>Uploaded By</th>
                        <th>Date</th>
                      </tr>
                    </thead>
                    <tbody>
                      {versions.map((v) => (
                        <tr key={String(pick(v, 'id'))}>
                          <td className="cell-mono">v{String(pick(v, 'version') ?? '')}</td>
                          <td>
                            <span className="cell-main">{trunc(pick(v, 'fileName', 'file_name'), 40)}</span>
                            <span className="cell-sub">{String(pick(v, 'fileType', 'file_type') ?? '')}</span>
                          </td>
                          <td className="cell-mono">{fmtBytes(pick(v, 'fileSize', 'file_size'))}</td>
                          <td className="muted">{pick(v, 'changeNote', 'change_note') ? trunc(pick(v, 'changeNote', 'change_note'), 60) : '—'}</td>
                          <td>{String(pick(v, 'uploadedByName', 'uploaded_by_name') ?? '—')}</td>
                          <td className="cell-mono">{fmtDate(pick(v, 'createdAt', 'created_at'))}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
            <section className="card card-pad">
              <div className="card-head"><h3>Review History</h3></div>
              {reviews.length === 0 ? (
                <div className="empty-state"><p>No review actions recorded yet.</p></div>
              ) : (
                <div className="doc-list">
                  {reviews.map((rv) => (
                    <div key={String(pick(rv, 'id'))} className="doc-notif" style={{ cursor: 'default' }}>
                      <div className="doc-notif-top">
                        <Badge value={pick(rv, 'action')} />
                        <span className="cell-mono">{fmtDate(pick(rv, 'createdAt', 'created_at'))}</span>
                      </div>
                      {pick(rv, 'comment') ? <span className="doc-act-comment">{String(pick(rv, 'comment'))}</span> : null}
                      <span className="doc-notif-meta">By {String(pick(rv, 'reviewerName', 'reviewer_name') ?? '—')}</span>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </div>
        </>
      )}
    </>
  );
}
function ApprovalsView() {
  const { user } = useAuth();
  const [pending, setPending] = useState<Rec[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const [review, setReview] = useState<{ id: number; code: string; action: string; label: string; commentRequired: boolean } | null>(null);
  const load = useCallback(async () => {
    try {
      const r = await api<{ data: Rec }>('/api/ops/documents/command');
      setPending((r.data.pendingReview ?? []) as Rec[]);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load approvals');
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void load(); }, [load, reload]);
  const openReview = (d: Rec, action: string, label: string, commentRequired: boolean) =>
    setReview({ id: Number(pick(d, 'id')), code: String(pick(d, 'code') ?? ''), action, label, commentRequired });
  return (
    <>
      <DocHead title="Document Approvals" subtitle="Review and approve controlled documents" />
      <DocTabs active="approvals" />
      {review ? (
        <ReviewModal
          id={review.id}
          code={review.code}
          action={review.action}
          label={review.label}
          commentRequired={review.commentRequired}
          onClose={() => setReview(null)}
          onDone={() => setReload((n) => n + 1)}
        />
      ) : null}
      {loading ? (
        <PageLoader label="Loading approvals…" />
      ) : error ? (
        <ErrorBanner error={error} />
      ) : pending.length === 0 ? (
        <div className="empty-state">
          <p>No documents are awaiting your review.</p>
          <button className="btn btn-primary" onClick={() => navigate('/documents/library')}>Browse Library</button>
        </div>
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Code</th>
                <th>Document</th>
                <th>Category</th>
                <th>Folder</th>
                <th>Classification</th>
                <th>Submitted</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {pending.map((d) => (
                <tr key={String(pick(d, 'id'))}>
                  <td className="cell-mono">{String(pick(d, 'code') ?? '')}</td>
                  <td>
                    <span className="cell-main">{trunc(pick(d, 'title'), 60)}</span>
                    {pick(d, 'submissionNote', 'submission_note') ? (
                      <span className="cell-sub">{trunc(pick(d, 'submissionNote', 'submission_note'), 80)}</span>
                    ) : null}
                  </td>
                  <td><Badge value={pick(d, 'category')} /></td>
                  <td className="muted">{String(pick(d, 'folderName', 'folder_name') ?? '') || '—'}</td>
                  <td><Badge value={pick(d, 'classification')} /></td>
                  <td className="cell-mono">{fmtDate(pick(d, 'submittedAt', 'submitted_at'))}</td>
                  <td>
                    <div className="row-actions">
                      {can(user, 'documents.approve') ? (
                        <>
                          <button className="btn btn-sm btn-primary" onClick={() => openReview(d, 'APPROVED', 'Approve', false)}>Approve</button>
                          <button className="btn btn-sm" onClick={() => openReview(d, 'RELEASED', 'Release', false)}>Release</button>
                          <button className="btn btn-sm" onClick={() => openReview(d, 'REQUEST_CHANGES', 'Request Changes', true)}>Changes</button>
                          <button className="btn btn-sm btn-danger" onClick={() => openReview(d, 'REJECTED', 'Reject', true)}>Reject</button>
                        </>
                      ) : null}
                      <button className="btn btn-sm" onClick={() => navigate(`/documents/library/${pick(d, 'id')}`)}>Review</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
function AuditView() {
  const [activity, setActivity] = useState<Rec[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    try {
      const r = await api<{ data: Rec }>('/api/ops/documents/command');
      setActivity((r.data.activity ?? []) as Rec[]);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load activity');
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);
  return (
    <>
      <DocHead title="Document Activity" subtitle="Audit trail of review actions across the document library" />
      <DocTabs active="audit" />
      {loading ? (
        <PageLoader label="Loading activity…" />
      ) : error ? (
        <ErrorBanner error={error} />
      ) : activity.length === 0 ? (
        <div className="empty-state">
          <p>No review activity recorded yet.</p>
        </div>
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Action</th>
                <th>Document</th>
                <th>Comment</th>
                <th>Reviewer</th>
                <th>Date</th>
              </tr>
            </thead>
            <tbody>
              {activity.map((a) => (
                <tr key={String(pick(a, 'id'))} className="row-click" onClick={() => a.documentId ? navigate(`/documents/library/${pick(a, 'documentId', 'document_id')}`) : undefined}>
                  <td><Badge value={pick(a, 'action')} /></td>
                  <td>
                    <span className="cell-main">{String(pick(a, 'documentCode', 'document_code') ?? '')}</span>
                    <span className="cell-sub">{trunc(pick(a, 'documentTitle', 'document_title'), 60)}</span>
                  </td>
                  <td className="muted">{pick(a, 'comment') ? trunc(pick(a, 'comment'), 60) : '—'}</td>
                  <td>{String(pick(a, 'reviewerName', 'reviewer_name') ?? '—')}</td>
                  <td className="cell-mono">{fmtDate(pick(a, 'createdAt', 'created_at'))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
function FoldersView() {
  const { user } = useAuth();
  const [folders, setFolders] = useState<Rec[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const [showCreate, setShowCreate] = useState(false);
  useEffect(() => {
    let alive = true;
    api<{ data: Rec[] }>('/api/ops/documents/folders')
      .then((r) => { if (alive) setFolders(r.data ?? []); })
      .catch((e) => { if (alive) setError(e instanceof Error ? e.message : 'Could not load folders'); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [reload]);
  return (
    <>
      <DocHead
        title="Document Folders"
        subtitle="Organise controlled documents into folders"
        actions={can(user, 'documents.folders.manage') ? (
          <button className="btn btn-primary" onClick={() => setShowCreate(true)}>+ New Folder</button>
        ) : undefined}
      />
      <DocTabs active="folders" />
      {showCreate ? <CreateFolderModal onClose={() => setShowCreate(false)} onDone={() => setReload((n) => n + 1)} /> : null}
      {loading ? (
        <PageLoader label="Loading folders…" />
      ) : error ? (
        <ErrorBanner error={error} />
      ) : folders.length === 0 ? (
        <div className="empty-state">
          <p>No folders yet. Create folders to organise your document library.</p>
          <button className="btn btn-primary" onClick={() => setShowCreate(true)}>Create Folder</button>
        </div>
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Code</th>
                <th>Name</th>
                <th>Description</th>
                <th>Documents</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {folders.map((f) => (
                <tr key={String(pick(f, 'id'))} className="row-click" onClick={() => navigate('/documents/library', { query: { folderId: String(pick(f, 'id')) } })}>
                  <td className="cell-mono">{String(pick(f, 'code') ?? '')}</td>
                  <td className="cell-main">{String(pick(f, 'name') ?? '')}</td>
                  <td className="muted">{trunc(pick(f, 'description'), 70)}</td>
                  <td><Badge value={String(pick(f, 'documentCount', 'document_count') ?? 0)} /></td>
                  <td className="cell-mono">{fmtDate(pick(f, 'createdAt', 'created_at'))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function CreateFolderModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const submit = async () => {
    if (busy) return;
    if (!name.trim()) {
      setErr('Folder name is required');
      return;
    }
    setBusy(true);
    setErr('');
    try {
      await api('/api/ops/documents/folders', {
        method: 'POST',
        body: JSON.stringify({ code: code.trim() || undefined, name: name.trim(), description: description.trim() || undefined }),
      });
      onDone();
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not create the folder');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title="New Folder"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy} onClick={() => void submit()}>
            {busy ? 'Creating…' : 'Create Folder'}
          </button>
        </>
      }
    >
      {err ? <ErrorBanner error={err} /> : null}
      <div className="form-grid">
        <label className="field">
          <span className="field-label">Code</span>
          <input className="search-input" value={code} onChange={(e) => setCode(e.target.value)} placeholder="e.g. QMS, HR, FIN" />
        </label>
        <label className="field field-required">
          <span className="field-label">Name</span>
          <input className="search-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Quality Management System" />
        </label>
        <label className="field">
          <span className="field-label">Description</span>
          <textarea className="search-input" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
        </label>
      </div>
    </Modal>
  );
}
function DocSettingRow({ item, onSaved }: { item: Rec; onSaved: () => void }) {
  const raw = pick(item, 'value');
  const value = (raw && typeof raw === 'object' ? raw : { value: String(raw ?? '') }) as Rec;
  const [json, setJson] = useState(JSON.stringify(value, null, 2));
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const keys = Object.keys(value);
  const simpleText = keys.length === 1 && keys[0] === 'value' && typeof value.value === 'string';
  const simpleBool = keys.length === 1 && keys[0] === 'enabled' && typeof value.enabled === 'boolean';
  const label = titleCase(String(pick(item, 'key') ?? '')).replace(/_/g, ' ');
  const save = async (next: Rec) => {
    if (busy) return;
    setBusy(true);
    setErr('');
    try {
      await api('/api/ops/documents/settings', {
        method: 'PUT',
        body: JSON.stringify({
          items: [{ category: pick(item, 'category'), key: pick(item, 'key'), value: next }],
        }),
      });
      setDirty(false);
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not save the setting');
    } finally {
      setBusy(false);
    }
  };
  const parseJson = (): Rec | null => {
    try {
      const parsed = JSON.parse(json) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('expected an object');
      return parsed as Rec;
    } catch {
      setErr('Value must be valid JSON (an object)');
      return null;
    }
  };
  return (
    <div className="doc-setting">
      <div className="doc-setting-main">
        <span className="doc-setting-name">{label}</span>
        <span className="muted" style={{ fontSize: 11.5 }}>{String(pick(item, 'key') ?? '')}</span>
        {err ? <span className="badge badge-red">{err}</span> : null}
      </div>
      <div className="doc-setting-main">
        {simpleText ? (
          <input
            className="search-input"
            value={String(value.value ?? '')}
            onChange={(e) => { setJson(JSON.stringify({ value: e.target.value }, null, 2)); setDirty(true); }}
          />
        ) : simpleBool ? (
          <label className="check-line">
            <input
              type="checkbox"
              checked={!!value.enabled}
              onChange={(e) => { setJson(JSON.stringify({ enabled: e.target.checked }, null, 2)); setDirty(true); }}
            />
            Enabled
          </label>
        ) : (
          <textarea
            className="search-input doc-setting-json"
            rows={4}
            value={json}
            onChange={(e) => { setJson(e.target.value); setDirty(true); }}
          />
        )}
        {dirty ? (
          <div className="doc-setting-actions">
            <button className="btn btn-sm btn-primary" onClick={() => { const next = parseJson(); if (next) void save(next); }} disabled={busy}>
              {busy ? 'Saving…' : 'Save'}
            </button>
            <button className="btn btn-sm btn-ghost" onClick={() => { setJson(JSON.stringify(value, null, 2)); setDirty(false); setErr(''); }}>
              Cancel
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
function SettingsView() {
  const [groups, setGroups] = useState<Map<string, Rec[]>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const ORDER = ['RETENTION', 'CLASSIFICATION', 'STORAGE', 'NAMING', 'WORKFLOW'];
  useEffect(() => {
    let alive = true;
    api<{ data: Rec[] }>('/api/ops/documents/settings')
      .then((r) => {
        if (!alive) return;
        const rows = r.data ?? [];
        const map = new Map<string, Rec[]>();
        for (const row of rows) {
          const cat = String(pick(row, 'category') ?? 'GENERAL');
          map.set(cat, [...(map.get(cat) ?? []), row]);
        }
        setGroups(map);
      })
      .catch((e) => { if (alive) setError(e instanceof Error ? e.message : 'Could not load settings'); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [reload]);
  const cats = [...groups.keys()].sort((a, b) => {
    const ia = ORDER.indexOf(a);
    const ib = ORDER.indexOf(b);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });
  return (
    <>
      <DocHead title="Document Settings" subtitle="Retention, classification, storage and workflow configuration" />
      <DocTabs active="settings" />
      {loading ? (
        <PageLoader label="Loading settings…" />
      ) : error ? (
        <ErrorBanner error={error} />
      ) : cats.length === 0 ? (
        <div className="empty-state"><p>No document settings configured.</p></div>
      ) : (
        <div className="grid-2">
          {cats.map((cat) => (
            <section key={cat} className="card card-pad">
              <div className="card-head"><h3>{titleCase(cat.replace(/_/g, ' '))}</h3></div>
              {(groups.get(cat) ?? []).map((item) => (
                <DocSettingRow key={String(pick(item, 'id') ?? pick(item, 'key'))} item={item} onSaved={() => setReload((n) => n + 1)} />
              ))}
            </section>
          ))}
        </div>
      )}
    </>
  );
}
export default function DocumentsFlow({ path }: { path: string }) {
  const { view, id } = parseDoc(path);
  switch (view) {
    case 'library':
      return id ? <DetailView id={Number(id)} /> : <LibraryView />;
    case 'folders':
      return <FoldersView />;
    case 'approvals':
      return <ApprovalsView />;
    case 'audit':
      return <AuditView />;
    case 'settings':
      return <SettingsView />;
    default:
      return <CommandView />;
  }
}
