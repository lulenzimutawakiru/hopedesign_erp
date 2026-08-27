import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { ErrorBanner, Modal, PageLoader } from '../components/ui';
import { useAuth, can } from '../auth';

type SettingType = 'text' | 'textarea' | 'number' | 'boolean' | 'select' | 'color' | 'url' | 'tel';
type Draft = string | boolean;

interface SettingValue {
  value: string | number | boolean | null;
  default: string | number | boolean | null;
  label: string;
  help: string | null;
  type: SettingType;
  options: string[] | null;
  secret: boolean;
  group: string | null;
  saved: boolean;
}

interface SettingCategory {
  category: string;
  label: string;
  blurb: string;
  meta: { updated_at: string | null; updated_by: string | null };
  settings: Record<string, SettingValue>;
}

interface AuditEntry {
  id: number;
  resource: string;
  action: string;
  metadata: { keys?: string[] } | null;
  old_values: Record<string, unknown> | null;
  new_values: Record<string, unknown> | null;
  created_at: string;
  actor: string | null;
}

const CATEGORY_META: Record<string, { icon: string; cls: string }> = {
  general: { icon: 'G', cls: 'tile-mill' },
  security: { icon: 'S', cls: 'tile-moss' },
  notifications: { icon: 'N', cls: 'tile-brass' },
  qr: { icon: 'QR', cls: 'tile-purple' },
  quality: { icon: 'QC', cls: 'tile-amber' },
  documents: { icon: 'D', cls: 'tile-clay' },
};

const isValidHexColor = (v: string) => /^#[0-9a-fA-F]{6}$/.test(v);

const toDraft = (v: unknown): Draft => (v === null || v === undefined ? '' : (v as Draft));

const sameValue = (a: Draft, b: unknown) => {
  if (typeof a === 'boolean' || typeof b === 'boolean') return a === b;
  return String(a ?? '') === String(b ?? '');
};

const fmtVal = (v: unknown) =>
  v === null || v === undefined || v === '' ? '—' : typeof v === 'boolean' ? (v ? 'Yes' : 'No') : String(v);

const fmtWhen = (v: string | null) => {
  if (!v) return '—';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? v : d.toLocaleString('en-UG', { dateStyle: 'medium', timeStyle: 'short' });
};

function BrandPreviewMark({ navy, teal, size = 42 }: { navy: string; teal: string; size?: number }) {
  return (
    <svg className="brand-preview-mark" viewBox="0 0 40 40" width={size} height={size} aria-hidden="true">
      <rect width="40" height="40" rx="8" fill={navy} />
      <rect x="8" y="8" width="6.2" height="24" rx="1.2" fill="#fff" />
      <rect x="25.8" y="8" width="6.2" height="24" rx="1.2" fill="#fff" />
      <rect x="8" y="17" width="24" height="6" rx="1" fill={teal} />
      <rect x="18.6" y="14.4" width="2.8" height="11.2" rx="0.4" fill="#fff" />
      <rect x="14.4" y="18.6" width="11.2" height="2.8" rx="0.4" fill="#fff" />
    </svg>
  );
}

function CompanyProfilePreview({ drafts }: { drafts: Record<string, Record<string, Draft>> }) {
  const d = drafts.general ?? {};
  const val = (k: string, fallback: string) => {
    const x = d[k];
    return x === undefined || x === null || x === '' ? fallback : String(x);
  };
  const navy = isValidHexColor(val('brand_color', '#1261A0')) ? val('brand_color', '#1261A0') : '#1261A0';
  const teal = isValidHexColor(val('brand_color_secondary', '#00A6A6'))
    ? val('brand_color_secondary', '#00A6A6')
    : '#00A6A6';
  const name = val('company_name', 'Company name');
  const tagline = val('company_tagline', '');
  const email = val('contact_email', '');
  const phone = val('contact_phone', '');
  const website = val('website', '');
  const support = val('support_email', '');
  const logo = /^https?:\/\//i.test(val('logo_url', '').trim()) ? val('logo_url', '').trim() : '';
  const contact = [phone, email, website].filter(Boolean).join(' | ');
  return (
    <section className="card brand-preview-card">
      <div className="card-head">
        <div>
          <h3>Company profile preview</h3>
          <span className="muted" style={{ fontSize: 12 }}>
            Live preview of how your logo, colours and details appear on branded exports.
          </span>
        </div>
        <span className="badge badge-blue">Live</span>
      </div>
      <div className="card-pad">
        <div className="brand-preview-letterhead">
          <div className="brand-preview-lh-row">
            <div className="brand-preview-lh-brand">
              {logo ? (
                <img
                  className="brand-preview-logo"
                  src={logo}
                  alt={`${name} logo`}
                  referrerPolicy="no-referrer"
                  onError={(e) => {
                    e.currentTarget.style.display = 'none';
                  }}
                />
              ) : (
                <BrandPreviewMark navy={navy} teal={teal} />
              )}
              <div>
                <p className="brand-preview-name" style={{ color: navy }}>
                  {name}
                </p>
                {tagline && (
                  <p className="brand-preview-tag" style={{ color: teal }}>
                    {tagline.toUpperCase()}
                  </p>
                )}
                {contact && <p className="brand-preview-contact">{contact}</p>}
                {support && (
                  <p className="brand-preview-contact brand-preview-support">
                    <span className="brand-preview-k">Support</span>
                    {support}
                  </p>
                )}
              </div>
            </div>
            <div className="brand-preview-doc">
              <span className="brand-preview-doc-title">QUOTATION</span>
              <span className="brand-preview-doc-no">No. Q-000123</span>
              <span className="brand-preview-doc-tag">Sample document</span>
            </div>
          </div>
          <div className="brand-preview-rules">
            <span style={{ background: navy }} />
            <span style={{ background: teal }} />
          </div>
          <div className="brand-preview-swatches">
            <span className="brand-preview-swatch">
              <i style={{ background: navy }} /> Primary {navy.toUpperCase()}
            </span>
            <span className="brand-preview-swatch">
              <i style={{ background: teal }} /> Secondary {teal.toUpperCase()}
            </span>
          </div>
          <div className="brand-preview-footer" style={{ background: navy }} />
        </div>
      </div>
    </section>
  );
}

function LogoUploadCard({
  editable,
  logoUrl,
  onApplied,
  showToast,
}: {
  editable: boolean;
  logoUrl: string;
  onApplied: (data: SettingCategory) => void;
  showToast: (kind: 'ok' | 'err', text: string) => void;
}) {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [uploading, setUploading] = useState(false);
  const [removing, setRemoving] = useState(false);

  const upload = async (file: File) => {
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const r = await api<{ data: SettingCategory }>('/api/settings/logo', { method: 'POST', body: fd });
      onApplied(r.data);
      showToast('ok', 'Company logo uploaded');
    } catch (e) {
      showToast('err', e instanceof Error ? e.message : 'Logo upload failed');
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const remove = async () => {
    setRemoving(true);
    try {
      const r = await api<{ data: SettingCategory }>('/api/settings/logo', { method: 'DELETE' });
      onApplied(r.data);
      showToast('ok', 'Company logo removed');
    } catch (e) {
      showToast('err', e instanceof Error ? e.message : 'Could not remove logo');
    } finally {
      setRemoving(false);
    }
  };

  return (
    <section className="card logo-upload-card">
      <div className="card-head">
        <div>
          <h3>Company logo</h3>
          <span className="muted" style={{ fontSize: 12 }}>
            Upload a PNG, JPG, WebP or SVG logo. Used on branded exports and letterheads.
          </span>
        </div>
      </div>
      <div className="card-pad">
        <div className="logo-upload-row">
          <div className="logo-upload-preview">
            {logoUrl ? (
              <img className="brand-preview-logo" src={logoUrl} alt="Company logo" />
            ) : (
              <BrandPreviewMark navy="#1261A0" teal="#00A6A6" />
            )}
          </div>
          {editable ? (
            <div className="logo-upload-actions">
              <input
                ref={fileRef}
                type="file"
                accept="image/png,image/jpeg,image/svg+xml,image/webp"
                hidden
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) upload(f);
                }}
              />
              <button className="btn btn-sm btn-primary" disabled={uploading} onClick={() => fileRef.current?.click()}>
                {uploading ? 'Uploading...' : logoUrl ? 'Replace logo' : 'Upload logo'}
              </button>
              {logoUrl && (
                <button className="btn btn-sm btn-ghost-danger" disabled={removing} onClick={remove}>
                  {removing ? 'Removing...' : 'Remove'}
                </button>
              )}
            </div>
          ) : (
            <span className="muted" style={{ fontSize: 12 }}>
              You need the "Administer settings" permission to change the logo.
            </span>
          )}
        </div>
      </div>
    </section>
  );
}

function FooterLogoUploadCard({
  editable,
  footerLogoUrl,
  onApplied,
  showToast,
}: {
  editable: boolean;
  footerLogoUrl: string;
  onApplied: (data: SettingCategory) => void;
  showToast: (kind: 'ok' | 'err', text: string) => void;
}) {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [uploading, setUploading] = useState(false);
  const [removing, setRemoving] = useState(false);

  const upload = async (file: File) => {
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const r = await api<{ data: SettingCategory }>('/api/settings/footer-logo', { method: 'POST', body: fd });
      onApplied(r.data);
      showToast('ok', 'Footer logo uploaded');
    } catch (e) {
      showToast('err', e instanceof Error ? e.message : 'Footer logo upload failed');
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const remove = async () => {
    setRemoving(true);
    try {
      const r = await api<{ data: SettingCategory }>('/api/settings/footer-logo', { method: 'DELETE' });
      onApplied(r.data);
      showToast('ok', 'Footer logo removed');
    } catch (e) {
      showToast('err', e instanceof Error ? e.message : 'Could not remove footer logo');
    } finally {
      setRemoving(false);
    }
  };

  return (
    <section className="card logo-upload-card">
      <div className="card-head">
        <div>
          <h3>Footer logo</h3>
          <span className="muted" style={{ fontSize: 12 }}>
            Upload a PNG or JPG logo shown separately in the footer of branded exports and letterheads.
          </span>
        </div>
      </div>
      <div className="card-pad">
        <div className="logo-upload-row">
          <div className="logo-upload-preview">
            {footerLogoUrl ? (
              <img className="brand-preview-logo" src={footerLogoUrl} alt="Footer logo" />
            ) : (
              <span className="muted" style={{ fontSize: 12 }}>No footer logo</span>
            )}
          </div>
          {editable ? (
            <div className="logo-upload-actions">
              <input
                ref={fileRef}
                type="file"
                accept="image/png,image/jpeg,.png,.jpg,.jpeg"
                hidden
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) upload(f);
                }}
              />
              <button className="btn btn-sm btn-primary" disabled={uploading} onClick={() => fileRef.current?.click()}>
                {uploading ? 'Uploading...' : footerLogoUrl ? 'Replace footer logo' : 'Upload footer logo'}
              </button>
              {footerLogoUrl && (
                <button className="btn btn-sm btn-ghost-danger" disabled={removing} onClick={remove}>
                  {removing ? 'Removing...' : 'Remove'}
                </button>
              )}
            </div>
          ) : (
            <span className="muted" style={{ fontSize: 12 }}>
              You need the "Administer settings" permission to change the footer logo.
            </span>
          )}
        </div>
      </div>
    </section>
  );
}

function FaviconUploadCard({
  editable,
  faviconUrl,
  onApplied,
  showToast,
}: {
  editable: boolean;
  faviconUrl: string;
  onApplied: (data: SettingCategory) => void;
  showToast: (kind: 'ok' | 'err', text: string) => void;
}) {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [uploading, setUploading] = useState(false);
  const [removing, setRemoving] = useState(false);

  const upload = async (file: File) => {
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const r = await api<{ data: SettingCategory }>('/api/settings/favicon', { method: 'POST', body: fd });
      onApplied(r.data);
      showToast('ok', 'Favicon uploaded');
    } catch (e) {
      showToast('err', e instanceof Error ? e.message : 'Favicon upload failed');
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const remove = async () => {
    setRemoving(true);
    try {
      const r = await api<{ data: SettingCategory }>('/api/settings/favicon', { method: 'DELETE' });
      onApplied(r.data);
      showToast('ok', 'Favicon removed');
    } catch (e) {
      showToast('err', e instanceof Error ? e.message : 'Could not remove favicon');
    } finally {
      setRemoving(false);
    }
  };

  return (
    <section className="card logo-upload-card">
      <div className="card-head">
        <div>
          <h3>Browser tab icon (favicon)</h3>
          <span className="muted" style={{ fontSize: 12 }}>
            Upload an SVG, PNG or ICO icon shown in the browser tab. Applies app-wide after reload.
          </span>
        </div>
      </div>
      <div className="card-pad">
        <div className="logo-upload-row">
          <div className="logo-upload-preview">
            {faviconUrl ? (
              <img className="favicon-preview-img" src={faviconUrl} alt="Favicon" />
            ) : (
              <span className="muted" style={{ fontSize: 12 }}>No custom favicon</span>
            )}
          </div>
          {editable ? (
            <div className="logo-upload-actions">
              <input
                ref={fileRef}
                type="file"
                accept="image/svg+xml,image/png,image/x-icon,.ico"
                hidden
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) upload(f);
                }}
              />
              <button className="btn btn-sm btn-primary" disabled={uploading} onClick={() => fileRef.current?.click()}>
                {uploading ? 'Uploading...' : faviconUrl ? 'Replace favicon' : 'Upload favicon'}
              </button>
              {faviconUrl && (
                <button className="btn btn-sm btn-ghost-danger" disabled={removing} onClick={remove}>
                  {removing ? 'Removing...' : 'Remove'}
                </button>
              )}
            </div>
          ) : (
            <span className="muted" style={{ fontSize: 12 }}>
              You need the "Administer settings" permission to change the favicon.
            </span>
          )}
        </div>
      </div>
    </section>
  );
}

function SignatureUploadCard({
  editable,
  signatureUrl,
  onApplied,
  showToast,
}: {
  editable: boolean;
  signatureUrl: string;
  onApplied: (data: SettingCategory) => void;
  showToast: (kind: 'ok' | 'err', text: string) => void;
}) {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [uploading, setUploading] = useState(false);
  const [removing, setRemoving] = useState(false);

  const upload = async (file: File) => {
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const r = await api<{ data: SettingCategory }>('/api/settings/signature', { method: 'POST', body: fd });
      onApplied(r.data);
      showToast('ok', 'Signature image uploaded');
    } catch (e) {
      showToast('err', e instanceof Error ? e.message : 'Signature upload failed');
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const remove = async () => {
    setRemoving(true);
    try {
      const r = await api<{ data: SettingCategory }>('/api/settings/signature', { method: 'DELETE' });
      onApplied(r.data);
      showToast('ok', 'Signature image removed');
    } catch (e) {
      showToast('err', e instanceof Error ? e.message : 'Could not remove signature image');
    } finally {
      setRemoving(false);
    }
  };

  return (
    <section className="card logo-upload-card">
      <div className="card-head">
        <div>
          <h3>Document signature image</h3>
          <span className="muted" style={{ fontSize: 12 }}>
            Upload a PNG or JPG of the authorised signature shown on auto-signed documents (invoices, contracts, certificates).
          </span>
        </div>
      </div>
      <div className="card-pad">
        <div className="logo-upload-row">
          <div className="logo-upload-preview">
            {signatureUrl ? (
              <img className="signature-preview-img" src={signatureUrl} alt="Document signature" />
            ) : (
              <span className="muted" style={{ fontSize: 12 }}>No signature image</span>
            )}
          </div>
          {editable ? (
            <div className="logo-upload-actions">
              <input
                ref={fileRef}
                type="file"
                accept="image/png,image/jpeg,.png,.jpg,.jpeg"
                hidden
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) upload(f);
                }}
              />
              <button className="btn btn-sm btn-primary" disabled={uploading} onClick={() => fileRef.current?.click()}>
                {uploading ? 'Uploading...' : signatureUrl ? 'Replace signature' : 'Upload signature'}
              </button>
              {signatureUrl && (
                <button className="btn btn-sm btn-ghost-danger" disabled={removing} onClick={remove}>
                  {removing ? 'Removing...' : 'Remove'}
                </button>
              )}
            </div>
          ) : (
            <span className="muted" style={{ fontSize: 12 }}>
              You need the "Administer settings" permission to change the signature image.
            </span>
          )}
        </div>
      </div>
    </section>
  );
}

export default function Settings() {
  const { user } = useAuth();
  const editable = can(user, 'admin.settings.update');
  const [cats, setCats] = useState<SettingCategory[] | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Record<string, Draft>>>({});
  const [active, setActive] = useState('general');
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [savingAll, setSavingAll] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [error, setError] = useState('');
  const [toast, setToast] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});
  const [auditOpen, setAuditOpen] = useState(false);
  const [resetTarget, setResetTarget] = useState<{ category: string | null; all: boolean } | null>(null);
  const toastTimer = useRef<number | null>(null);

  const showToast = useCallback((kind: 'ok' | 'err', text: string) => {
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    setToast({ kind, text });
    toastTimer.current = window.setTimeout(() => setToast(null), 4200);
  }, []);

  const load = useCallback(async () => {
    const r = await api<{ data: SettingCategory[] }>('/api/settings');
    setCats(r.data);
    const d: Record<string, Record<string, Draft>> = {};
    for (const cat of r.data) {
      const row: Record<string, Draft> = {};
      for (const [key, s] of Object.entries(cat.settings)) row[key] = toDraft(s.value);
      d[cat.category] = row;
    }
    setDrafts(d);
  }, []);

  useEffect(() => {
    load().catch((e) => setError(e instanceof Error ? e.message : 'Failed to load settings'));
  }, [load]);

  useEffect(() => () => { if (toastTimer.current) window.clearTimeout(toastTimer.current); }, []);

  const dirtyCats = useMemo(() => {
    if (!cats) return new Set<string>();
    const set = new Set<string>();
    for (const cat of cats) {
      const d = drafts[cat.category] ?? {};
      if (Object.keys(cat.settings).some((k) => !sameValue(d[k], cat.settings[k].value))) set.add(cat.category);
    }
    return set;
  }, [cats, drafts]);

  const dirtyTotal = dirtyCats.size;
  const dirtyKeys = useMemo(() => {
    const n: Record<string, number> = {};
    if (!cats) return n;
    for (const cat of cats) {
      const d = drafts[cat.category] ?? {};
      n[cat.category] = Object.keys(cat.settings).filter((k) => !sameValue(d[k], cat.settings[k].value)).length;
    }
    return n;
  }, [cats, drafts]);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q || !cats) return null;
    const out: { cat: SettingCategory; key: string; setting: SettingValue }[] = [];
    for (const cat of cats) {
      for (const [key, s] of Object.entries(cat.settings)) {
        const hay = [s.label, s.help ?? '', key, cat.label, String(s.value ?? '')].join(' ').toLowerCase();
        if (hay.includes(q)) out.push({ cat, key, setting: s });
      }
    }
    return out;
  }, [query, cats]);

  const setValue = (cat: string, key: string, v: Draft) => {
    setDrafts((prev) => ({ ...prev, [cat]: { ...(prev[cat] ?? {}), [key]: v } }));
  };

  const resetDraft = (cat: string) => {
    if (!cats) return;
    const row: Record<string, Draft> = {};
    for (const [key, s] of Object.entries(cats.find((c) => c.category === cat)!.settings)) row[key] = toDraft(s.value);
    setDrafts((prev) => ({ ...prev, [cat]: row }));
  };

  const discardAll = () => {
    if (!cats) return;
    const d: Record<string, Record<string, Draft>> = {};
    for (const cat of cats) {
      const row: Record<string, Draft> = {};
      for (const [key, s] of Object.entries(cat.settings)) row[key] = toDraft(s.value);
      d[cat.category] = row;
    }
    setDrafts(d);
    showToast('ok', 'Discarded all unsaved changes');
  };

  const UPLOAD_MANAGED_KEYS = new Set(['logo_url', 'favicon_url', 'signature_url', 'footer_logo_url']);
  const buildValues = (cat: SettingCategory) => {
    const d = drafts[cat.category] ?? {};
    const values: Record<string, string | number | boolean> = {};
    for (const [key, s] of Object.entries(cat.settings)) {
      if (UPLOAD_MANAGED_KEYS.has(key)) continue;
      if (s.type === 'boolean') values[key] = Boolean(d[key]);
      else if (s.type === 'number') values[key] = Number(d[key] === '' ? 0 : d[key]);
      else values[key] = String(d[key] ?? '');
    }
    return values;
  };

  const patchCategory = useCallback(
    async (cat: SettingCategory): Promise<boolean> => {
      const r = await api<{ data: SettingCategory }>('/api/settings', {
        method: 'PATCH',
        body: JSON.stringify({ category: cat.category, values: buildValues(cat) }),
      });
      setCats((prev) => (prev ? prev.map((c) => (c.category === cat.category ? r.data : c)) : prev));
      const row: Record<string, Draft> = {};
      for (const [key, s] of Object.entries(r.data.settings)) row[key] = toDraft(s.value);
      setDrafts((prev) => ({ ...prev, [cat.category]: row }));
      return true;
    },
    [drafts, cats]
  );

  const onLogoApplied = useCallback((data: SettingCategory) => {
    setDrafts((prev) => {
      const g = prev.general ?? {};
      const row: Record<string, Draft> = { ...g };
      for (const [key, s] of Object.entries(data.settings)) {
        if (key === 'logo_url' || key === 'favicon_url' || key === 'signature_url' || key === 'footer_logo_url') row[key] = toDraft(s.value);
      }
      return { ...prev, general: row };
    });
    setCats((prev) => (prev ? prev.map((c) => (c.category === 'general' ? data : c)) : prev));
  }, []);

  const save = async (cat: SettingCategory) => {
    setError('');
    setBusy((b) => ({ ...b, [cat.category]: true }));
    try {
      await patchCategory(cat);
      showToast('ok', `${cat.label} saved`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save settings');
      showToast('err', e instanceof Error ? e.message : 'Failed to save settings');
    } finally {
      setBusy((b) => ({ ...b, [cat.category]: false }));
    }
  };

  const saveAll = async () => {
    if (!cats) return;
    setError('');
    setSavingAll(true);
    let saved = 0;
    let failed = 0;
    for (const cat of cats) {
      if (!dirtyCats.has(cat.category)) continue;
      try {
        await patchCategory(cat);
        saved += 1;
      } catch {
        failed += 1;
      }
    }
    setSavingAll(false);
    if (failed === 0) showToast('ok', `Saved ${saved} categor${saved === 1 ? 'y' : 'ies'}`);
    else showToast('err', `Saved ${saved}, failed ${failed}`);
  };

  const doReset = async () => {
    if (!resetTarget) return;
    setResetting(true);
    setError('');
    try {
      await api('/api/settings/reset', {
        method: 'POST',
        body: JSON.stringify(resetTarget.all ? { all: true } : { category: resetTarget.category }),
      });
      await load();
      const label = resetTarget.all
        ? 'All settings'
        : cats?.find((c) => c.category === resetTarget.category)?.label ?? resetTarget.category;
      showToast('ok', `${label} reset to defaults`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to reset settings');
      showToast('err', e instanceof Error ? e.message : 'Failed to reset settings');
    } finally {
      setResetting(false);
      setResetTarget(null);
    }
  };

  const openAudit = async () => {
    setAuditOpen(true);
  };

  if (!cats) return <PageLoader label="Loading settings..." />;

  const activeCat = cats.find((c) => c.category === active) ?? cats[0];

  const renderRow = (cat: SettingCategory, key: string, s: SettingValue) => {
    const draft = drafts[cat.category]?.[key];
    const isDirty = !sameValue(draft, s.value);
    const offDefault = !sameValue(draft, s.default);
    const isSecret = s.secret && !revealed[key];
    return (
      <div className={isDirty ? 'setting-row dirty' : 'setting-row'} key={key}>
        <div className="setting-info">
          <div className="setting-label">
            <span>{s.label}</span>
            {s.secret && <span className="badge badge-purple">Secret</span>}
            {s.saved ? <span className="badge badge-green">Custom</span> : <span className="badge badge-neutral">Default</span>}
          </div>
          {s.help && <small className="muted">{s.help}</small>}
        </div>
        <div className="setting-control">
          {s.type === 'boolean' ? (
            <label className="check">
              <input
                type="checkbox"
                disabled={!editable}
                checked={Boolean(draft)}
                onChange={(e) => setValue(cat.category, key, e.target.checked)}
              />
              <span>{draft ? 'Enabled' : 'Disabled'}</span>
            </label>
          ) : s.type === 'select' ? (
            <select
              disabled={!editable}
              value={String(draft ?? '')}
              onChange={(e) => setValue(cat.category, key, e.target.value)}
            >
              {(s.options ?? []).map((o) => (
                <option key={o} value={o}>{o}</option>
              ))}
            </select>
          ) : s.type === 'textarea' ? (
            <textarea
              disabled={!editable}
              rows={2}
              value={String(draft ?? '')}
              onChange={(e) => setValue(cat.category, key, e.target.value)}
            />
          ) : s.type === 'color' ? (
            <span className="setting-color-wrap">
              <span
                className="setting-swatch"
                style={{ background: isValidHexColor(String(draft ?? '')) ? String(draft ?? '') : 'transparent' }}
                aria-hidden
              />
              <input
                type="color"
                disabled={!editable}
                value={isValidHexColor(String(draft ?? '')) ? String(draft ?? '') : '#1261A0'}
                onChange={(e) => setValue(cat.category, key, e.target.value)}
              />
              <input
                type="text"
                className="setting-color-text"
                disabled={!editable}
                value={String(draft ?? '')}
                placeholder="#RRGGBB"
                onChange={(e) => setValue(cat.category, key, e.target.value)}
              />
            </span>
          ) : (
            <span className="setting-input-wrap">
              <input
                type={
                  s.type === 'number' ? 'number' :
                  s.type === 'url' ? 'url' :
                  s.type === 'tel' ? 'tel' :
                  isSecret ? 'password' : 'text'
                }
                disabled={!editable}
                value={String(draft ?? '')}
                onChange={(e) => setValue(cat.category, key, e.target.value)}
              />
              {s.secret && editable && (
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  onClick={() => setRevealed((prev) => ({ ...prev, [key]: !prev[key] }))}
                >
                  {revealed[key] ? 'Hide' : 'Show'}
                </button>
              )}
            </span>
          )}
          {editable && offDefault && (
            <button
              type="button"
              className="btn btn-sm btn-ghost setting-reset"
              title="Reset this setting to its default"
              onClick={() => setValue(cat.category, key, toDraft(s.default))}
            >
              ↺ Default
            </button>
          )}
        </div>
      </div>
    );
  };

  const renderCategoryCard = (cat: SettingCategory) => {
    const isDirty = dirtyCats.has(cat.category);
    const entries = Object.entries(cat.settings);
    type Section = { title: string | null; rows: [string, SettingValue][] };
    const sections: Section[] = [];
    const byTitle = new Map<string | null, Section>();
    for (const entry of entries) {
      const title = entry[1].group ?? null;
      let sec = byTitle.get(title);
      if (!sec) {
        sec = { title, rows: [] };
        byTitle.set(title, sec);
        sections.push(sec);
      }
      sec.rows.push(entry);
    }
    const hasSections = sections.some((s) => s.title !== null);
    return (
      <section className="card" key={cat.category}>
        <div className="card-head">
          <div>
            <h3>{cat.label}</h3>
            {cat.meta.updated_by && (
              <span className="muted" style={{ fontSize: 12 }}>
                Last changed by {cat.meta.updated_by} · {fmtWhen(cat.meta.updated_at)}
              </span>
            )}
          </div>
          <div className="head-actions">
            {isDirty && <span className="badge badge-amber">{dirtyKeys[cat.category]} unsaved</span>}
            {editable && (
              <>
                <button className="btn btn-sm" disabled={!isDirty} onClick={() => resetDraft(cat.category)}>Discard</button>
                <button
                  className="btn btn-sm btn-danger btn-ghost-danger"
                  disabled={busy[cat.category]}
                  onClick={() => setResetTarget({ category: cat.category, all: false })}
                >
                  Reset defaults
                </button>
                <button
                  className="btn btn-sm btn-primary"
                  disabled={Boolean(busy[cat.category]) || !isDirty}
                  onClick={() => save(cat)}
                >
                  {busy[cat.category] ? 'Saving...' : 'Save'}
                </button>
              </>
            )}
          </div>
        </div>
        <div className="card-pad">
          {hasSections ? (
            <div className="setting-sections">
              {sections.map((sec) => (
                <div className="setting-section" key={sec.title ?? '__default'}>
                  {sec.title && (
                    <div className="setting-section-head">
                      <h4>{sec.title}</h4>
                      <span className="badge badge-neutral">{sec.rows.length}</span>
                    </div>
                  )}
                  <div className="setting-list">
                    {sec.rows.map(([key, s]) => renderRow(cat, key, s))}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="setting-list">
              {entries.map(([key, s]) => renderRow(cat, key, s))}
            </div>
          )}
        </div>
      </section>
    );
  };

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Settings</h1>
          <p className="muted">
            Tenant and company preferences for documents, security, notifications, QR codes, quality and records.
            Changes are applied immediately and audited.
          </p>
        </div>
        <div className="head-actions">
          <div className="global-search">
            <input
              className="search-input"
              placeholder="Search settings…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <button className="btn btn-sm btn-ghost" onClick={openAudit}>Audit log</button>
        </div>
      </header>

      {error && <ErrorBanner error={error} />}
      {!editable && (
        <div className="notice-banner">
          <span>Read-only view. Ask an administrator with Settings update permission to change these values.</span>
        </div>
      )}

      <div className="settings-layout">
        <nav className="settings-nav" aria-label="Settings categories">
          {cats.map((cat) => {
            const isDirty = dirtyCats.has(cat.category);
            const isActive = !query && active === cat.category;
            const meta = CATEGORY_META[cat.category];
            const custom = Object.values(cat.settings).filter((s) => s.saved).length;
            return (
              <button
                key={cat.category}
                className={isActive ? 'settings-nav-item active' : 'settings-nav-item'}
                onClick={() => { setActive(cat.category); setQuery(''); }}
                title={cat.blurb}
              >
                <span className={`settings-nav-tile ${meta?.cls ?? 'tile-neutral'}`}>{meta?.icon ?? cat.label.slice(0, 2)}</span>
                <span className="settings-nav-body">
                  <span className="settings-nav-label">{cat.label}</span>
                  <span className="settings-nav-meta">{custom > 0 ? `${custom} custom` : 'Defaults'}</span>
                </span>
                {isDirty && <span className="settings-dot" title="Unsaved changes" />}
              </button>
            );
          })}
        </nav>

        <div className="settings-main">
          {matches ? (
            matches.length === 0 ? (
              <div className="card">
                <div className="empty-state">
                  <h3>No matching settings</h3>
                  <p className="muted">Try a different search term.</p>
                </div>
              </div>
            ) : (
              (() => {
                const grouped = new Map<string, { cat: SettingCategory; items: { key: string; setting: SettingValue }[] }>();
                for (const m of matches) {
                  if (!grouped.has(m.cat.category)) grouped.set(m.cat.category, { cat: m.cat, items: [] });
                  grouped.get(m.cat.category)!.items.push({ key: m.key, setting: m.setting });
                }
                return (
                  <>
                    <div className="muted" style={{ marginBottom: 10 }}>
                      {matches.length} match{matches.length === 1 ? '' : 'es'} across {grouped.size} categor{grouped.size === 1 ? 'y' : 'ies'}
                    </div>
                    {Array.from(grouped.values()).map(({ cat, items }) => (
                      <section className="card" key={cat.category}>
                        <div className="card-head">
                          <h3>{cat.label}</h3>
                          <span className="badge badge-neutral">{items.length}</span>
                        </div>
                        <div className="card-pad">
                          <div className="setting-list">
                            {items.map(({ key, setting }) => renderRow(cat, key, setting))}
                          </div>
                        </div>
                      </section>
                    ))}
                  </>
                );
              })()
            )
          ) : (
            <div className="stack">
              <div className="muted" style={{ fontSize: 13 }}>
                {activeCat.blurb}
              </div>
              {activeCat.category === 'general' && (
                <>
                  <LogoUploadCard
                    editable={editable}
                    logoUrl={/^https?:\/\//i.test(String(drafts.general?.logo_url ?? '').trim()) ? String(drafts.general?.logo_url ?? '').trim() : ''}
                    onApplied={onLogoApplied}
                    showToast={showToast}
                  />
                  <FooterLogoUploadCard
                    editable={editable}
                    footerLogoUrl={/^https?:\/\//i.test(String(drafts.general?.footer_logo_url ?? '').trim()) ? String(drafts.general?.footer_logo_url ?? '').trim() : ''}
                    onApplied={onLogoApplied}
                    showToast={showToast}
                  />
                  <FaviconUploadCard
                    editable={editable}
                    faviconUrl={/^https?:\/\//i.test(String(drafts.general?.favicon_url ?? '').trim()) ? String(drafts.general?.favicon_url ?? '').trim() : ''}
                    onApplied={onLogoApplied}
                    showToast={showToast}
                  />
                  <SignatureUploadCard
                    editable={editable}
                    signatureUrl={/^https?:\/\//i.test(String(drafts.general?.signature_url ?? '').trim()) ? String(drafts.general?.signature_url ?? '').trim() : ''}
                    onApplied={onLogoApplied}
                    showToast={showToast}
                  />
                  <CompanyProfilePreview drafts={drafts} />
                </>
              )}
              {renderCategoryCard(activeCat)}
            </div>
          )}
        </div>
      </div>

      {editable && dirtyTotal > 0 && (
        <div className="settings-bar">
          <span className="muted">
            {dirtyTotal} categor{dirtyTotal === 1 ? 'y' : 'ies'} with unsaved changes — save to apply and record them in the audit log.
          </span>
          <div className="head-actions">
            <button className="btn btn-sm" onClick={discardAll}>Discard all</button>
            <button className="btn btn-sm btn-primary" disabled={savingAll} onClick={saveAll}>
              {savingAll ? 'Saving…' : `Save all (${dirtyTotal})`}
            </button>
          </div>
        </div>
      )}

      {auditOpen && <AuditModal cats={cats} onClose={() => setAuditOpen(false)} />}

      {resetTarget && (
        <Modal
          title={resetTarget.all ? 'Reset all settings' : `Reset ${resetTarget.category ? cats.find((c) => c.category === resetTarget.category)?.label ?? '' : ''}`}
          onClose={() => setResetTarget(null)}
          footer={
            <>
              <button className="btn btn-sm" onClick={() => setResetTarget(null)}>Cancel</button>
              <button className="btn btn-sm btn-danger" disabled={resetting} onClick={doReset}>
                {resetting ? 'Resetting…' : 'Confirm reset'}
              </button>
            </>
          }
        >
          <p>
            {resetTarget.all
              ? 'Every custom setting will be removed and all categories will fall back to their defaults. This cannot be undone and is recorded in the audit log.'
              : 'Custom values in this category will be removed and it will fall back to defaults. This cannot be undone and is recorded in the audit log.'}
          </p>
        </Modal>
      )}

      {toast && (
        <div
          className="toast"
          style={{ background: toast.kind === 'err' ? 'var(--clay)' : 'var(--moss)', color: '#fff' }}
        >
          {toast.text}
        </div>
      )}
    </div>
  );
}

function AuditModal({ cats, onClose }: { cats: SettingCategory[]; onClose: () => void }) {
  const [rows, setRows] = useState<AuditEntry[] | null>(null);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [err, setErr] = useState('');

  const catLabel = (resource: string) => {
    const id = resource.replace(/^settings\.?/, '') || 'all';
    return cats.find((c) => c.category === id)?.label ?? id;
  };

  useEffect(() => {
    let alive = true;
    setRows(null);
    api<{ data: AuditEntry[]; pagination: { page: number; pageSize: number; total: number } }>(
      `/api/settings/audit?page=${page}&pageSize=50`
    )
      .then((r) => { if (alive) { setRows(r.data); setTotal(r.pagination.total); } })
      .catch((e) => { if (alive) setErr(e instanceof Error ? e.message : 'Failed to load audit log'); });
    return () => { alive = false; };
  }, [page]);

  return (
    <Modal title="Settings audit log" onClose={onClose} wide footer={
      <div className="pager">
        <span>Page {page} of {Math.max(1, Math.ceil(total / 50))} · {total} change{total === 1 ? '' : 's'}</span>
        <button className="btn btn-sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>‹ Prev</button>
        <button className="btn btn-sm" disabled={page >= Math.max(1, Math.ceil(total / 50))} onClick={() => setPage((p) => p + 1)}>Next ›</button>
      </div>
    }>
      {err && <ErrorBanner error={err} />}
      {!rows && !err && <PageLoader label="Loading audit log..." />}
      {rows && rows.length === 0 && (
        <div className="empty-state">
          <h3>No changes yet</h3>
          <p className="muted">Settings saves and resets will appear here.</p>
        </div>
      )}
      {rows && rows.length > 0 && (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>When</th>
                <th>Actor</th>
                <th>Category</th>
                <th>Action</th>
                <th>Changes</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const keys = r.metadata?.keys ?? Object.keys(r.new_values ?? {});
                return (
                  <tr key={r.id}>
                    <td style={{ whiteSpace: 'nowrap' }}>{fmtWhen(r.created_at)}</td>
                    <td>{r.actor ?? '—'}</td>
                    <td>{catLabel(r.resource)}</td>
                    <td><span className={r.action === 'reset' ? 'badge badge-warn' : 'badge badge-blue'}>{r.action}</span></td>
                    <td>
                      {keys.map((k) => (
                        <div key={k} className="audit-diff">
                          <span className="audit-key">{k}</span>
                          <span className="audit-old">{fmtVal(r.old_values?.[k])}</span>
                          <span className="audit-arrow">→</span>
                          <span className="audit-new">{fmtVal(r.new_values?.[k])}</span>
                        </div>
                      ))}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  );
}
