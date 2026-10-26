/**
 * ISO/IEC 27001:2022 Annex A and the ISO 9001:2015 clauses this ERP operates.
 *
 * The rows come from GET /api/ops/compliance/iso. That route reads the
 * assessment in the API and does not accept a status change: a control is
 * implemented only when the code says so.
 */
import { Fragment, useEffect, useMemo, useState, type FormEvent } from 'react';
import { api } from '../api';
import { navigate } from '../router';
import { ErrorBanner } from '../components/ui';
import { EmptyState, Skeleton } from '../components/os';

type Status = 'implemented' | 'partial' | 'planned';

type Evidence = { path: string; note: string };

type Control = {
  framework: string;
  code: string;
  title: string;
  theme: string;
  status: Status;
  owner: string;
  implementation: string;
  evidence: Evidence[];
  gap: string | null;
};

type Summary = {
  framework: string;
  implemented: number;
  partial: number;
  planned: number;
  total: number;
};

type Register = {
  assessedOn: string;
  disclaimer: string;
  summary: Summary[];
  controls: Control[];
};

const STATUS_LABEL: Record<Status, string> = {
  implemented: 'Implemented',
  partial: 'Partial',
  planned: 'Planned',
};

function statusClass(status: Status): string {
  if (status === 'implemented') return 'badge badge-green';
  if (status === 'partial') return 'badge badge-amber';
  return 'badge';
}

export default function ComplianceIso() {
  const [register, setRegister] = useState<Register | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [framework, setFramework] = useState('');
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [eventTitle, setEventTitle] = useState('');
  const [eventNote, setEventNote] = useState('');
  const [eventMsg, setEventMsg] = useState('');

  useEffect(() => {
    let alive = true;
    setLoading(true);
    api<{ data: Register }>('/api/ops/compliance/iso')
      .then((body) => { if (alive) setRegister(body.data); })
      .catch((err: unknown) => { if (alive) setError(err instanceof Error ? err.message : String(err)); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []);

  const controls = useMemo(() => {
    const rows = register?.controls ?? [];
    const needle = q.trim().toLowerCase();
    return rows.filter((row) => {
      if (framework && !row.framework.toLowerCase().includes(framework)) return false;
      if (status && row.status !== status) return false;
      if (!needle) return true;
      const hay = `${row.code} ${row.title} ${row.theme} ${row.owner} ${row.implementation} ${row.gap ?? ''}`.toLowerCase();
      return hay.includes(needle);
    });
  }, [register, framework, status, q]);

  async function reportEvent(e: FormEvent) {
    e.preventDefault();
    setEventMsg('');
    setError('');
    try {
      await api('/api/ops/compliance/security-events', {
        method: 'POST',
        body: JSON.stringify({ title: eventTitle, description: eventNote }),
      });
      setEventTitle('');
      setEventNote('');
      setEventMsg('Security event recorded.');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="mod-kicker" data-mod="adm">Compliance</p>
          <h1>ISO register</h1>
          <p className="muted">
            ISO/IEC 27001:2022 Annex A, and the ISO 9001:2015 clauses this ERP already operates.
            Assessed {register?.assessedOn ?? '…'}.
          </p>
        </div>
        <button className="btn btn-sm btn-ghost" type="button" onClick={() => navigate('/compliance')}>
          Data protection
        </button>
      </header>

      {error && <ErrorBanner error={error} />}

      {register && (
        <div className="notice-banner" role="note">{register.disclaimer}</div>
      )}

      {loading && <Skeleton />}

      {register && (
        <>
          <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12, marginBottom: 16 }}>
            {register.summary.map((row) => (
              <section key={row.framework} className="card" style={{ padding: 12 }}>
                <p className="muted" style={{ margin: 0 }}>{row.framework}</p>
                <p style={{ margin: '6px 0' }}><b>{row.total}</b> controls</p>
                <p className="muted" style={{ margin: 0 }}>
                  {row.implemented} implemented · {row.partial} partial · {row.planned} planned
                </p>
              </section>
            ))}
          </div>

          <div className="filter-bar" style={{ marginBottom: 12 }}>
            <input
              className="search-input"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search code, title, owner"
              aria-label="Search the register"
            />
            <select aria-label="Framework" value={framework} onChange={(e) => setFramework(e.target.value)}>
              <option value="">Both frameworks</option>
              <option value="27001">ISO/IEC 27001:2022</option>
              <option value="9001">ISO 9001:2015</option>
            </select>
            <select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">Any status</option>
              <option value="implemented">Implemented</option>
              <option value="partial">Partial</option>
              <option value="planned">Planned</option>
            </select>
          </div>

          {controls.length === 0 ? (
            <EmptyState title="No controls match" body="Clear the search or choose a different status." />
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table className="data">
                <thead>
                  <tr>
                    <th>Code</th>
                    <th>Control</th>
                    <th>Status</th>
                    <th>Owner</th>
                  </tr>
                </thead>
                <tbody>
                  {controls.map((row) => {
                    const key = `${row.framework}:${row.code}`;
                    const shown = open === key;
                    return (
                      <Fragment key={key}>
                        <tr className="row-click" onClick={() => setOpen(shown ? null : key)}>
                          <td style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>{row.code}</td>
                          <td>
                            <div>{row.title}</div>
                            <div className="muted">{row.theme}</div>
                          </td>
                          <td><span className={statusClass(row.status)}>{STATUS_LABEL[row.status]}</span></td>
                          <td>{row.owner}</td>
                        </tr>
                        {shown && (
                          <tr className="row-detail">
                            <td colSpan={4}>
                              <p style={{ marginTop: 0 }}>{row.implementation}</p>
                              {row.gap && <p><b>Gap.</b> {row.gap}</p>}
                              {row.evidence.length > 0 && (
                                <ul style={{ margin: 0, paddingLeft: 18 }}>
                                  {row.evidence.map((item) => (
                                    <li key={item.path}>
                                      <code>{item.path}</code>
                                      <span className="muted"> — {item.note}</span>
                                    </li>
                                  ))}
                                </ul>
                              )}
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          <section className="card" style={{ padding: 16, marginTop: 16 }}>
            <h2 style={{ marginTop: 0 }}>Report a security event</h2>
            <p className="muted">Anyone signed in can report. The security administrator decides whether it is an incident.</p>
            <form onSubmit={reportEvent} style={{ display: 'grid', gap: 8, maxWidth: 520 }}>
              <input
                aria-label="Event title"
                value={eventTitle}
                onChange={(e) => setEventTitle(e.target.value)}
                placeholder="What happened"
                required
              />
              <textarea
                aria-label="Event description"
                value={eventNote}
                onChange={(e) => setEventNote(e.target.value)}
                placeholder="What you saw"
                rows={3}
              />
              <button className="btn btn-sm" type="submit">Report</button>
            </form>
            {eventMsg && <p>{eventMsg}</p>}
          </section>
        </>
      )}
    </div>
  );
}
