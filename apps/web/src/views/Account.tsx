import { useEffect, useState } from 'react';
import { useAuth, can } from '../auth';
import { navigate } from '../router';
import { applyPrefs, loadPrefs, savePrefs, type Density, type Prefs, type Theme } from '../prefs';
import { personaLabel, personaOf } from '../work';

function initials(first?: string | null, last?: string | null): string {
  return ((first?.[0] ?? '') + (last?.[0] ?? '') || 'U').toUpperCase();
}

function Seg<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: Array<{ id: T; label: string }>;
  onChange: (v: T) => void;
}) {
  return (
    <div className="account-seg" role="radiogroup">
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          role="radio"
          aria-checked={value === o.id}
          className={'account-seg-btn' + (value === o.id ? ' is-on' : '')}
          onClick={() => onChange(o.id)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export default function Account() {
  const { user, logout } = useAuth();
  const [prefs, setPrefs] = useState<Prefs>(() => loadPrefs());

  useEffect(() => {
    const on = (e: Event) => setPrefs((e as CustomEvent<Prefs>).detail);
    window.addEventListener('hope-prefs', on);
    return () => window.removeEventListener('hope-prefs', on);
  }, []);

  const set = (p: Partial<Prefs>) => setPrefs(savePrefs(p));

  const name = [user?.first_name, user?.last_name].filter(Boolean).join(' ') || 'Signed in';
  const persona = personaLabel(personaOf(user));

  return (
    <div className="page account-page">
      <div className="crumbs">
        <span>Account</span>
      </div>
      <header className="page-head">
        <div>
          <p className="mod-kicker" data-mod="adm">Account</p>
          <h1>Your profile</h1>
          <p className="muted" style={{ margin: '6px 0 0' }}>
            Identity, appearance and sign-in for this session.
          </p>
        </div>
      </header>

      <section className="account-hero">
        <span className="account-avatar account-avatar-lg" aria-hidden>
          {initials(user?.first_name, user?.last_name)}
        </span>
        <div>
          <h2>{name}</h2>
          <p>{user?.email}</p>
          <p className="muted">
            {persona}
            {user?.job_title ? ` · ${user.job_title}` : ''}
          </p>
        </div>
      </section>

      <div className="account-grid">
        <section className="asset-form-sec" id="prefs">
          <div className="asset-form-sec-head">
            <h3>Appearance</h3>
            <p>Stays on this device. Ctrl+S is unchanged.</p>
          </div>
          <div className="account-pref-list">
            <div className="account-pref">
              <div>
                <strong>Theme</strong>
                <span>Light, dark, or match the system.</span>
              </div>
              <Seg<Theme>
                value={prefs.theme}
                onChange={(theme) => set({ theme })}
                options={[
                  { id: 'light', label: 'Light' },
                  { id: 'dark', label: 'Dark' },
                  { id: 'system', label: 'System' },
                ]}
              />
            </div>
            <div className="account-pref">
              <div>
                <strong>Density</strong>
                <span>How tight tables and lists sit.</span>
              </div>
              <Seg<Density>
                value={prefs.density}
                onChange={(density) => set({ density })}
                options={[
                  { id: 'compact', label: 'Compact' },
                  { id: 'comfortable', label: 'Comfortable' },
                  { id: 'spacious', label: 'Spacious' },
                ]}
              />
            </div>
            <div className="account-pref">
              <div>
                <strong>Floor mode</strong>
                <span>Hides chrome for warehouse and plant floors.</span>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={prefs.focusMode}
                className={'setting-switch' + (prefs.focusMode ? ' is-on' : '')}
                onClick={() => set({ focusMode: !prefs.focusMode })}
              >
                <span className="setting-switch-track" />
                <span>{prefs.focusMode ? 'On' : 'Off'}</span>
              </button>
            </div>
          </div>
        </section>

        <section className="asset-form-sec">
          <div className="asset-form-sec-head">
            <h3>This session</h3>
            <p>Bound by RBAC. Switching company needs a new sign-in.</p>
          </div>
          <dl className="account-kv">
            <div><dt>Company</dt><dd>{user?.company_name ?? user?.tenant_name ?? '—'}</dd></div>
            <div><dt>Branch</dt><dd>{user?.branch_name ?? user?.branch_code ?? 'All'}</dd></div>
            <div><dt>Department</dt><dd>{user?.department_name ?? user?.department_code ?? '—'}</dd></div>
            <div><dt>Role</dt><dd>{user?.job_title ?? persona}</dd></div>
          </dl>
        </section>

        <section className="asset-form-sec">
          <div className="asset-form-sec-head">
            <h3>Shortcuts</h3>
          </div>
          <div className="account-links">
            <button type="button" className="account-link" onClick={() => navigate('/work')}>
              <strong>My activity</strong>
              <span>Approvals, drafts and follow-ups</span>
            </button>
            <button type="button" className="account-link" onClick={() => navigate('/account/security')}>
              <strong>Security & MFA</strong>
              <span>Personal email and sign-in codes</span>
            </button>
            {can(user, 'admin.settings.view') && (
              <button type="button" className="account-link" onClick={() => navigate('/settings')}>
                <strong>Organisation settings</strong>
                <span>Branding, security and system defaults</span>
              </button>
            )}
            <button type="button" className="account-link account-link-out" onClick={() => { applyPrefs(prefs); logout(); }}>
              <strong>Sign out</strong>
              <span>End this session on this device</span>
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}
