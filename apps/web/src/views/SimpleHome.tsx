import { useEffect, useState } from 'react';
import { api } from '../api';
import { useAuth } from '../auth';
import { navigate } from '../router';
import { savePrefs } from '../prefs';
import { useCompanyProfile } from '../company';
import { greetingFor, personaLabel, personaOf } from '../work';
import { Notice } from '../components/ui';
import { visibleSimpleApps, visibleSimpleTasks } from '../simpleMode';

/**
 * Simple Mode home — an app launcher in the familiar modern-ERP style
 * (Sales, Manufacturing, Accounting, Inventory, Payroll, Employees, Time Off,
 * Purchase, Dashboards) mapped onto Natex's real modules, plus a short
 * "do quickly" row of everyday actions. A factory worker who has never used a
 * computer should be able to read the greeting, see what is waiting on them,
 * and tap one big tile to get to work.
 *
 * Every app and task is filtered by the same permissions as the rest of the
 * app, so this screen shows only what the signed-in person is allowed to do.
 */
export default function SimpleHome() {
  const { user, logout } = useAuth();
  const company = useCompanyProfile();
  const [toDo, setToDo] = useState<number | null>(null);
  const [toApprove, setToApprove] = useState<number | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    api<{ data: { exceptionCount?: number } }>('/api/dashboard/work')
      .then((r) => { if (alive) setToDo(r.data?.exceptionCount ?? 0); })
      .catch(() => undefined);
    api<{ count: number }>('/api/approvals/pending-count')
      .then((r) => { if (alive) setToApprove(r.count); })
      .catch(() => undefined);
    return () => { alive = false; };
  }, []);

  const first = user?.first_name ?? 'there';
  const area = personaLabel(personaOf(user));
  const apps = visibleSimpleApps(user);
  const tasks = visibleSimpleTasks(user);
  const today = new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const brand = company.name && company.name !== 'Company' ? company.name : 'Natex Cloud';

  const goFullView = () => {
    savePrefs({ simpleMode: false });
    navigate('/dashboard');
  };

  return (
    <div className="simple-home">
      <header className="simple-topbar">
        <div className="simple-brand" aria-label={brand}>
          <span className="simple-brand-mark" aria-hidden="true">◆</span>
          <span>{brand}</span>
        </div>
        <div className="simple-topbar-actions">
          <span className="simple-lang" title="English is the only language configured for this deployment">
            🌍 English
          </span>
          <button type="button" className="btn btn-ghost" onClick={() => setHelpOpen((v) => !v)} aria-expanded={helpOpen}>
            ❓ Help
          </button>
          <button type="button" className="btn btn-ghost" onClick={goFullView}>
            Full view
          </button>
          <button type="button" className="btn btn-ghost" onClick={logout}>
            Log out
          </button>
        </div>
      </header>

      <main className="simple-main">
        {helpOpen && (
          <Notice>
            Need help? Tap any big tile to open that area of the system. If you are not sure what to do,
            ask your supervisor — your name and job appear here so you always know you are signed in as yourself.
          </Notice>
        )}

        <section className="simple-hero">
          <div className="simple-greet">
            <div className="eyebrow">{area}</div>
            <h1>{greetingFor()}, {first}.</h1>
            <p className="muted">{today}</p>
          </div>
          <div className="simple-counts">
            <button type="button" className="simple-count" onClick={() => navigate('/work')}>
              <b>{toDo ?? '–'}</b>
              <span>To do</span>
            </button>
            <button type="button" className="simple-count" onClick={() => navigate('/approvals')}>
              <b>{toApprove ?? '–'}</b>
              <span>To approve</span>
            </button>
          </div>
        </section>

        {apps.length > 0 && (
          <>
            <h2 className="simple-section-title">Apps</h2>
            <div className="simple-app-grid">
              {apps.map((a) => (
                <button key={a.id} type="button" className="simple-app" onClick={() => navigate(a.href)}>
                  <span className="simple-app-icon" aria-hidden="true">{a.icon}</span>
                  <span className="simple-app-text">
                    <strong>{a.name}</strong>
                    <span>{a.hint}</span>
                  </span>
                </button>
              ))}
            </div>
          </>
        )}

        {tasks.length > 0 && (
          <>
            <h2 className="simple-section-title">Do quickly</h2>
            <div className="simple-task-grid">
              {tasks.map((t) => (
                <button key={t.id} type="button" className="simple-task" onClick={() => navigate(t.href)}>
                  <span className="simple-task-icon" aria-hidden="true">{t.icon}</span>
                  <span className="simple-task-text">
                    <strong>{t.label}</strong>
                    <span>{t.hint}</span>
                  </span>
                </button>
              ))}
            </div>
          </>
        )}

        {apps.length === 0 && tasks.length === 0 && (
          <p className="empty-state">
            Nothing is assigned to your role yet. Ask your manager to set up your access.
          </p>
        )}
      </main>
    </div>
  );
}
