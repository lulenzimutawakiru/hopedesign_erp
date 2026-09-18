import { useCallback, useEffect, useState } from 'react';
import { navigate } from '../../router';
import { can, useAuth } from '../../auth';
import { ErrorBanner, Modal, Spinner } from '../../components/ui';
import {
  KpiRow,
  KpiTile,
  SdHead,
  SdTabs,
  SecCard,
  fmtDay,
  label,
  modStyle,
  num,
  s,
  sdApi,
  sdErr,
  useSdMeta,
  type Rec,
} from '../serviceDeskShared';

const STRATEGY_HINT: Record<string, string> = {
  MANUAL: 'A dispatcher picks the technician. The reason is mandatory and audited.',
  ROUND_ROBIN: 'Tickets rotate through the available members in order, so the load evens out.',
  LOAD_BALANCED: 'The least loaded available technician wins, weighted by open ticket count.',
  SKILL_BASED: 'The technician holding the matching skill for the category gets the ticket.',
  TEAM: 'The ticket lands on a team and the team lead distributes it.',
  QUEUE: 'The ticket waits in the queue until someone claims it.',
};

interface Row {
  id: number;
  code: string;
  name: string;
  assignment_strategy: string;
  team_id: number | null;
  target_response_minutes: number | null;
  target_resolution_minutes: number | null;
  max_open_tickets: number | null;
  is_default: boolean;
  is_active: boolean;
  open_tickets: number;
  team_size: number;
  unassigned?: number;
  critical?: number;
}

export default function ServiceDeskQueues() {
  const { user } = useAuth();
  const meta = useSdMeta();
  const [tab, setTab] = useState<'queues' | 'sla' | 'escalation' | 'teams' | 'calendars'>('queues');
  const [queues, setQueues] = useState<Row[]>([]);
  const [summary, setSummary] = useState<Rec | null>(null);
  const [policies, setPolicies] = useState<Rec[]>([]);
  const [levels, setLevels] = useState<Rec[]>([]);
  const [rules, setRules] = useState<Rec[]>([]);
  const [teams, setTeams] = useState<Rec[]>([]);
  const [skills, setSkills] = useState<Rec[]>([]);
  const [calendars, setCalendars] = useState<Rec[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [tick, setTick] = useState(0);
  const [team, setTeam] = useState<Rec | null>(null);
  const [members, setMembers] = useState<Rec[]>([]);
  const [membersBusy, setMembersBusy] = useState(false);
  const [cal, setCal] = useState<Rec | null>(null);
  const [holidays, setHolidays] = useState<Rec[]>([]);
  const [holidayBusy, setHolidayBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const soft = async <T,>(p: string, fallback: T): Promise<T> => {
      try {
        return await sdApi<T>(p);
      } catch {
        return fallback;
      }
    };
    try {
      const [qz, sum, pol, lv, rl, tm, sk, cl] = await Promise.all([
        soft<Row[]>('/api/service-desk/queues', []),
        soft<Rec>('/api/service-desk/queues/summary', {}),
        soft<{ rows: Rec[] }>('/api/service-desk/sla/policies?limit=100', { rows: [] }),
        soft<Rec[]>('/api/service-desk/escalation/levels', []),
        soft<Rec[]>('/api/service-desk/escalation/rules', []),
        soft<{ items: Rec[] }>('/api/service-desk/teams?limit=100', { items: [] }),
        soft<{ rows: Rec[] }>('/api/service-desk/skills?limit=100', { rows: [] }),
        soft<{ rows: Rec[] }>('/api/service-desk/calendars?limit=100', { rows: [] }),
      ]);
      const counts = new Map<number, Rec>();
      const sq = Array.isArray(sum?.queues) ? sum.queues : [];
      for (const q of sq) counts.set(Number(q.id), q);
      setQueues(
        (Array.isArray(qz) ? qz : []).map((q) => {
          const c = counts.get(Number(q.id));
          return c ? { ...q, unassigned: num(c.unassigned), critical: num(c.critical) } : q;
        })
      );
      setSummary(sum);
      setPolicies(pol?.rows ?? []);
      setLevels(Array.isArray(lv) ? lv : []);
      setRules(Array.isArray(rl) ? rl : []);
      setTeams(tm?.items ?? []);
      setSkills(sk?.rows ?? []);
      setCalendars(cl?.rows ?? []);
      setError('');
    } catch (e) {
      setError(sdErr(e));
    } finally {
      setLoading(false);
    }
  }, [tick]);

  useEffect(() => void load(), [load]);

  const openTeam = async (t: Rec) => {
    setTeam(t);
    setMembers([]);
    setMembersBusy(true);
    try {
      const res = await sdApi<Rec[] | { items: Rec[] }>('/api/service-desk/teams/' + s(t.id) + '/members');
      setMembers(Array.isArray(res) ? res : res?.items ?? []);
    } catch (e) {
      setError(sdErr(e));
    } finally {
      setMembersBusy(false);
    }
  };

  const openCalendar = async (c: Rec) => {
    setCal(c);
    setHolidays([]);
    setHolidayBusy(true);
    try {
      const res = await sdApi<Rec[] | { items: Rec[] }>(
        '/api/service-desk/calendars/' + s(c.id) + '/holidays?limit=200',
      );
      setHolidays(Array.isArray(res) ? res : res?.items ?? []);
    } catch (e) {
      setError(sdErr(e));
    } finally {
      setHolidayBusy(false);
    }
  };

  const counts = (summary?.counts ?? {}) as Rec;
  const strategies = meta.meta?.assignmentStrategies ?? Object.keys(STRATEGY_HINT);
  const canConfig = can(user, 'service_desk.sla.manage');

  const TABS: Array<[typeof tab, string]> = [
    ['queues', 'Queues'],
    ['sla', 'SLA policies'],
    ['escalation', 'Escalation'],
    ['teams', 'Teams & skills'],
    ['calendars', 'Business hours'],
  ];

  return (
    <div className="page" style={modStyle()}>
      <SdHead
        title="Queues, teams & escalation"
        kicker="Service desk"
        sub="Where work lands and who owns it. Queues carry the routing strategy and targets, teams carry the people, skills drive skill-based routing, and the escalation ladder decides who gets woken up."
        actions={
          <>
            <button className="btn" onClick={() => setTick((v) => v + 1)} disabled={loading}>
              {loading ? <Spinner /> : 'Refresh'}
            </button>
            {canConfig && (
              <button className="btn" onClick={() => navigate('/service-desk/config')}>
                Configuration
              </button>
            )}
          </>
        }
      />
      <SdTabs active="queues" />

      <KpiRow>
        <KpiTile label="Queues" value={queues.length} sub={num(counts.open_total) + ' open tickets'} />
        <KpiTile
          label="Unassigned"
          value={num(counts.unassigned)}
          sub="Waiting for an owner"
          onClick={() => navigate('/service-desk/workspace?view=unassigned')}
        />
        <KpiTile label="Escalated" value={num(counts.escalated)} sub={levels.length + ' escalation levels'} />
        <KpiTile label="Teams" value={teams.length} sub={skills.length + ' skills defined'} />
        <KpiTile label="SLA policies" value={policies.length} sub={calendars.length + ' business calendars'} />
        <KpiTile
          label="Due soon"
          value={num(counts.due_soon)}
          sub={num(counts.overdue) + ' overdue'}
          onClick={() => navigate('/service-desk/workspace?view=warning')}
        />
      </KpiRow>

      {error ? <ErrorBanner error={error} /> : null}

      <div className="tabs sd-sub-tabs">
        {TABS.map(([k, text]) => (
          <button key={k} className={k === tab ? 'tab active' : 'tab'} onClick={() => setTab(k)}>
            {text}
          </button>
        ))}
      </div>

      {tab === 'queues' && (
        <>
          <SecCard
            title="Assignment model"
            sub="Every strategy below is enforced server-side. Manual assignment and reassignment always require a reason, and the reason is written to the audit trail."
          >
            <div className="sd-strategy-grid">
              {strategies.map((k) => (
                <article key={k} className="sd-strategy">
                  <h4>{label(k)}</h4>
                  <p className="muted">{STRATEGY_HINT[k] ?? 'Routing strategy supported by the assignment engine.'}</p>
                </article>
              ))}
            </div>
            <div className="sd-flow" aria-label="Assignment flow">
              {['Employee reports the issue', 'Ticket classified', 'Routed to the queue', 'Assignment engine picks an owner', 'Technician assigned'].map(
                (step, i) => (
                  <span key={step} className="sd-flow-step">
                    <b>{i + 1}</b>
                    {step}
                  </span>
                ),
              )}
            </div>
          </SecCard>

          <SecCard title="Queues" sub="Open a queue in the workspace to work it. Targets here are the fallback when no SLA policy matches.">
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th style={{ width: 190 }}>Queue</th>
                    <th style={{ width: 150 }}>Strategy</th>
                    <th style={{ width: 130 }}>Response</th>
                    <th style={{ width: 130 }}>Resolution</th>
                    <th style={{ width: 90 }}>Open</th>
                    <th style={{ width: 90 }}>Unassigned</th>
                    <th style={{ width: 90 }}>Critical</th>
                    <th style={{ width: 110 }}>Max open</th>
                    <th style={{ width: 110 }} />
                  </tr>
                </thead>
                <tbody>
                  {queues.length === 0 && (
                    <tr>
                      <td colSpan={9} className="sd-empty-cell">
                        {loading ? 'Loading\u2026' : 'No queues are configured for your scope.'}
                      </td>
                    </tr>
                  )}
                  {queues.map((qq) => (
                    <tr key={s(qq.id)}>
                      <td>
                        <b>{s(qq.name)}</b>
                        <div className="sub muted td-cell-mono">
                          {s(qq.code)}
                          {qq.is_default ? ' \u00b7 default' : ''}
                          {qq.is_active ? '' : ' \u00b7 inactive'}
                        </div>
                      </td>
                      <td>
                        <span className="chip">{label(qq.assignment_strategy)}</span>
                      </td>
                      <td className="td-cell-mono">{qq.target_response_minutes ? qq.target_response_minutes + 'm' : '\u2013'}</td>
                      <td className="td-cell-mono">{qq.target_resolution_minutes ? qq.target_resolution_minutes + 'm' : '\u2013'}</td>
                      <td>{num(qq.open_tickets)}</td>
                      <td>{num(qq.unassigned)}</td>
                      <td>{num(qq.critical)}</td>
                      <td className="muted">{qq.max_open_tickets ? num(qq.max_open_tickets) : 'unlimited'}</td>
                      <td>
                        <button
                          className="btn btn-sm"
                          onClick={() => navigate('/service-desk/workspace?view=queue&queueId=' + s(qq.id))}
                        >
                          Work queue
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </SecCard>
        </>
      )}
      {tab === 'sla' && (
        <SecCard
          title="SLA policies"
          sub="Impact plus urgency sets the priority; the policy attached to that priority sets the clocks. Business calendars decide whether the clock runs 24x7 or only during working hours."
        >
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th style={{ width: 150 }}>Policy</th>
                  <th style={{ width: 90 }}>Priority</th>
                  <th>Applies to</th>
                  <th style={{ width: 110 }}>Response</th>
                  <th style={{ width: 110 }}>Resolution</th>
                  <th style={{ width: 100 }}>Warning</th>
                  <th style={{ width: 120 }}>Clock</th>
                  <th style={{ width: 90 }}>Pause</th>
                </tr>
              </thead>
              <tbody>
                {policies.length === 0 && (
                  <tr>
                    <td colSpan={8} className="sd-empty-cell">
                      {loading ? 'Loading\u2026' : 'No SLA policies in your scope.'}
                    </td>
                  </tr>
                )}
                {policies.map((p) => (
                  <tr key={s(p.id)} className={p.is_active ? undefined : 'sd-row-muted'}>
                    <td>
                      <b className="td-cell-mono">{s(p.code)}</b>
                      <div className="sub muted">{s(p.name)}</div>
                    </td>
                    <td>
                      <span className="chip">{s(p.priority) || 'Any'}</span>
                    </td>
                    <td className="muted">
                      {s(p.category_name) || 'All categories'}
                      {s(p.department_name) ? ' \u00b7 ' + s(p.department_name) : ''}
                      {s(p.ticket_type) ? ' \u00b7 ' + label(p.ticket_type) : ''}
                    </td>
                    <td className="td-cell-mono">{fmtClock(p.response_minutes)}</td>
                    <td className="td-cell-mono">{fmtClock(p.resolution_minutes)}</td>
                    <td className="td-cell-mono muted">{fmtClock(p.warning_minutes)}</td>
                    <td className="muted">
                      {label(p.time_basis)}
                      {s(p.calendar_name) ? ' \u00b7 ' + s(p.calendar_name) : ''}
                    </td>
                    <td>{p.pause_on_pending ? 'Yes' : 'No'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </SecCard>
      )}

      {tab === 'escalation' && (
        <>
          <SecCard
            title="Escalation levels"
            sub="The ladder an unresolved ticket climbs. Levels map to roles, never to named individuals, so the ladder survives staff changes."
          >
            <div className="sd-ladder">
              {levels.map((l) => (
                <article key={s(l.id)} className="sd-ladder-step">
                  <span className="sd-ladder-num">{num(l.level)}</span>
                  <div>
                    <b>{s(l.name)}</b>
                    <div className="sub muted td-cell-mono">
                      {s(l.code)}
                      {s(l.role_code) ? ' \u00b7 ' + s(l.role_code) : ''}
                    </div>
                    {s(l.description) && <p className="muted sd-ladder-note">{s(l.description)}</p>}
                  </div>
                  {l.is_active ? null : <span className="chip">inactive</span>}
                </article>
              ))}
              {levels.length === 0 && <p className="muted">{loading ? 'Loading\u2026' : 'No escalation levels defined.'}</p>}
            </div>
          </SecCard>

          <SecCard
            title="Escalation rules"
            sub="Rules are evaluated per category and priority. The trigger says whether the clock measures time without a first response, time without a resolution, or the SLA warning point."
          >
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th style={{ width: 170 }}>Rule</th>
                    <th style={{ width: 110 }}>Priority</th>
                    <th>Category</th>
                    <th style={{ width: 130 }}>Trigger</th>
                    <th style={{ width: 100 }}>After</th>
                    <th style={{ width: 90 }}>Level</th>
                    <th>Notifies</th>
                    <th style={{ width: 80 }}>Active</th>
                  </tr>
                </thead>
                <tbody>
                  {rules.length === 0 && (
                    <tr>
                      <td colSpan={8} className="sd-empty-cell">
                        {loading ? 'Loading\u2026' : 'No escalation rules configured.'}
                      </td>
                    </tr>
                  )}
                  {rules.map((r) => (
                    <tr key={s(r.id)}>
                      <td>
                        <b>{s(r.name)}</b>
                        <div className="sub muted td-cell-mono">{s(r.code)}</div>
                      </td>
                      <td>
                        <span className="chip">{s(r.priority) || 'Any'}</span>
                      </td>
                      <td className="muted">{s(r.category_name) || 'All categories'}</td>
                      <td className="muted">{label(r.trigger_on)}</td>
                      <td className="td-cell-mono">{fmtClock(r.after_minutes)}</td>
                      <td>
                        <span className="chip">{num(r.level)}</span>
                        <div className="sub muted">{s(r.level_name) || s(r.level_code)}</div>
                      </td>
                      <td className="muted">
                        {(Array.isArray(r.notify_roles) ? (r.notify_roles as unknown[]) : []).map((x) => s(x)).join(', ') || '\u2013'}
                      </td>
                      <td>{r.is_active ? 'Yes' : 'No'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </SecCard>
        </>
      )}

      {tab === 'teams' && (
        <>
          <SecCard
            title="Teams"
            sub="A team is a named group of technicians that can own a queue. Open a team to see its roster."
          >
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Team</th>
                    <th style={{ width: 150 }}>Code</th>
                    <th style={{ width: 120 }}>Members</th>
                    <th style={{ width: 120 }}>Status</th>
                    <th style={{ width: 110 }} />
                  </tr>
                </thead>
                <tbody>
                  {teams.length === 0 && (
                    <tr>
                      <td colSpan={5} className="sd-empty-cell">
                        {loading ? 'Loading\u2026' : 'No teams defined yet.'}
                      </td>
                    </tr>
                  )}
                  {teams.map((t) => (
                    <tr key={s(t.id)}>
                      <td>
                        <b>{s(t.name)}</b>
                        {s(t.description) && <div className="sub muted">{s(t.description)}</div>}
                      </td>
                      <td className="td-cell-mono">{s(t.code)}</td>
                      <td>{num(t.member_count ?? t.team_size)}</td>
                      <td>{t.is_active === false ? <span className="chip">inactive</span> : 'Active'}</td>
                      <td>
                        <button className="btn btn-sm" onClick={() => void openTeam(t)}>
                          View roster
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </SecCard>

          <SecCard
            title="Skills"
            sub="Skill-based routing matches a ticket to the technician who holds the skill the category needs."
          >
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Skill</th>
                    <th style={{ width: 160 }}>Code</th>
                    <th style={{ width: 160 }}>Category</th>
                    <th style={{ width: 120 }}>Holders</th>
                    <th style={{ width: 110 }}>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {skills.length === 0 && (
                    <tr>
                      <td colSpan={5} className="sd-empty-cell">
                        {loading ? 'Loading\u2026' : 'No skills defined yet.'}
                      </td>
                    </tr>
                  )}
                  {skills.map((k) => (
                    <tr key={s(k.id)}>
                      <td>
                        <b>{s(k.name)}</b>
                        {s(k.description) && <div className="sub muted">{s(k.description)}</div>}
                      </td>
                      <td className="td-cell-mono">{s(k.code)}</td>
                      <td className="muted">{s(k.category_name) || '\u2013'}</td>
                      <td>{num(k.holder_count)}</td>
                      <td>{k.is_active === false ? <span className="chip">inactive</span> : 'Active'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </SecCard>
        </>
      )}

      {tab === 'calendars' && (
        <SecCard
          title="Business hours"
          sub="A calendar defines the working week, the working day and the public holidays. SLA clocks that are not 24x7 only tick inside these windows."
        >
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Calendar</th>
                  <th style={{ width: 170 }}>Timezone</th>
                  <th style={{ width: 170 }}>Working days</th>
                  <th style={{ width: 130 }}>Hours</th>
                  <th style={{ width: 110 }}>Holidays</th>
                  <th style={{ width: 100 }}>Policies</th>
                  <th style={{ width: 110 }} />
                </tr>
              </thead>
              <tbody>
                {calendars.length === 0 && (
                  <tr>
                    <td colSpan={7} className="sd-empty-cell">
                      {loading ? 'Loading\u2026' : 'No business calendars defined.'}
                    </td>
                  </tr>
                )}
                {calendars.map((c) => {
                  const days = Array.isArray(c.working_days) ? (c.working_days as unknown[]) : [];
                  return (
                    <tr key={s(c.id)}>
                      <td>
                        <b>{s(c.name)}</b>
                        <div className="sub muted td-cell-mono">
                          {s(c.code)}
                          {c.is_default ? ' \u00b7 default' : ''}
                        </div>
                      </td>
                      <td className="muted">{s(c.timezone)}</td>
                      <td className="muted">{days.length ? days.map((d) => s(d).slice(0, 3)).join(', ') : 'Every day'}</td>
                      <td className="td-cell-mono">
                        {c.is_24x7 ? '24 \u00d7 7' : s(c.work_start).slice(0, 5) + ' \u2013 ' + s(c.work_end).slice(0, 5)}
                      </td>
                      <td>{num(c.holiday_count)}</td>
                      <td>{num(c.policy_count)}</td>
                      <td>
                        <button className="btn btn-sm" onClick={() => void openCalendar(c)}>
                          Holidays
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </SecCard>
      )}

      {team && (
        <Modal title={'Team roster \u2013 ' + s(team.name)} onClose={() => setTeam(null)}>
          {membersBusy && <Spinner />}
          {!membersBusy && members.length === 0 && <p className="muted">No members on this team yet.</p>}
          {!membersBusy && members.length > 0 && (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Member</th>
                    <th style={{ width: 180 }}>Role</th>
                    <th style={{ width: 140 }}>Shift</th>
                  </tr>
                </thead>
                <tbody>
                  {members.map((m) => (
                    <tr key={s(m.user_id ?? m.id)}>
                      <td>
                        <b>{s(m.name ?? m.full_name ?? m.username)}</b>
                        <div className="sub muted">{s(m.email)}</div>
                      </td>
                      <td className="muted">{label(m.role_code ?? m.team_role)}</td>
                      <td className="muted">{s(m.shift) || '\u2013'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="sd-inline-actions">
            <button
              className="btn"
              onClick={() => {
                const id = s(team.id);
                setTeam(null);
                navigate('/service-desk/workspace?view=queue&queueId=' + id);
              }}
            >
              Work this queue
            </button>
          </div>
        </Modal>
      )}

      {cal && (
        <Modal title={'Holidays \u2013 ' + s(cal.name)} onClose={() => setCal(null)}>
          {holidayBusy && <Spinner />}
          {!holidayBusy && holidays.length === 0 && <p className="muted">No holidays recorded on this calendar.</p>}
          {!holidayBusy && holidays.length > 0 && (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th style={{ width: 160 }}>Date</th>
                    <th>Name</th>
                    <th style={{ width: 120 }}>Recurring</th>
                  </tr>
                </thead>
                <tbody>
                  {holidays.map((h, i) => (
                    <tr key={s(h.id ?? i)}>
                      <td className="td-cell-mono">{fmtDay(h.holiday_date ?? h.date)}</td>
                      <td>{s(h.name ?? h.title)}</td>
                      <td className="muted">{h.is_recurring ? 'Yes' : 'No'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Modal>
      )}
    </div>
  );
}

function fmtClock(mins: unknown): string {
  const v = num(mins);
  if (v <= 0) return '\u2013';
  if (v < 60) return v + 'm';
  const h = v / 60;
  if (h < 24) return (Number.isInteger(h) ? h : Math.round(h * 10) / 10) + 'h';
  const d = h / 24;
  return (Number.isInteger(d) ? d : Math.round(d * 10) / 10) + 'd';
}
