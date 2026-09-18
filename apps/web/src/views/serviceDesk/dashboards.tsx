/**
 * HOPE DESIGN SERVICE DESK - dashboards (spec 24).
 *
 * Four audiences, four payloads. The employee sees only their own tickets and
 * the knowledge meant for them. The agent sees their assignment, the unassigned
 * work, SLA warnings and critical incidents. The manager sees SLA compliance,
 * technician workload, escalations and recurring incidents. The executive sees
 * headline risk, major outages and the service trend.
 *
 * Every figure comes from a server-side aggregate that already applied the
 * caller's ABAC scope, so no one can widen their view by editing a filter in
 * the browser. The lookback window is the only client input and it is clamped
 * server-side to 1..365 days.
 *
 * Priority, status and SLA are never communicated by colour alone: every chip
 * carries a code, a word and a shape.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { itemVisible } from '../../nav';
import { navigate } from '../../router';
import { useAuth } from '../../auth';
import { ErrorBanner, Spinner } from '../../components/ui';
import { Sel } from '../hikvision/fields';
import {
  EmptyRow,
  KpiRow,
  KpiTile,
  Nothing,
  PriorityChip,
  SecCard,
  SdHead,
  SdTabs,
  StatusChip,
  TicketTable,
  fmtAgo,
  fmtDay,
  fmtDur,
  fmtMinutesClock,
  modStyle,
  num,
  s,
  sdApi,
  sdErr,
  subjectOf,
  ticketRef,
  type Rec,
} from '../serviceDeskShared';

type Tab = 'employee' | 'agent' | 'manager' | 'executive';

interface TabDef {
  key: Tab;
  text: string;
  perm: string;
  blurb: string;
}

const TABS: TabDef[] = [
  {
    key: 'employee',
    text: 'Employee',
    perm: 'service_desk.dashboards.employee',
    blurb: 'My tickets, what is waiting on me and the knowledge that may answer it before a ticket is raised.',
  },
  {
    key: 'agent',
    text: 'Service Desk Agent',
    perm: 'service_desk.dashboards.agent',
    blurb: 'My assignment, the unassigned work, SLA warnings and critical incidents, in one working view.',
  },
  {
    key: 'manager',
    text: 'Service Desk Manager',
    perm: 'service_desk.dashboards.manager',
    blurb: 'SLA compliance, resolution time, technician workload, escalations and recurring incidents.',
  },
  {
    key: 'executive',
    text: 'Executive',
    perm: 'service_desk.dashboards.executive',
    blurb: 'Critical incidents, major outages, SLA performance and the service trend across the window.',
  },
];

const WINDOWS: Array<[string, string]> = [
  ['7', 'Last 7 days'],
  ['30', 'Last 30 days'],
  ['90', 'Last 90 days'],
  ['180', 'Last 180 days'],
];

/** The dashboard window only applies to the manager and executive views. */
function windowed(tab: Tab): boolean {
  return tab === 'manager' || tab === 'executive';
}

function asRows(v: unknown): Rec[] {
  return Array.isArray(v) ? (v as Rec[]) : [];
}

function asRec(v: unknown): Rec {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : {};
}

/** A compliance percentage rendered without inventing a value when unpoliced. */
function pctText(v: unknown): string {
  if (v === null || v === undefined || v === '') return '\u2013';
  return num(v) + '%';
}

interface Series {
  key: string;
  text: string;
  color: string;
}

/** Typed inline style helper - bars are drawn from data, never from CSS alone. */
function barStyle(widthPct: number, color: string): CSSProperties {
  return { width: widthPct + '%', background: color };
}

const TREND_COLORS = ['#0E7490', '#FF0000', '#16A34A', '#7C3AED'];

/**
 * A compact ranked bar list. Used for technician load, category mix and the
 * recurring-incident table, where a bar reads faster than a column of numbers.
 */
function BarList({
  rows,
  labelKey,
  valueKey,
  noteKey,
  format,
}: {
  rows: Rec[];
  labelKey: string;
  valueKey: string;
  noteKey?: string;
  format?: (v: number) => string;
}) {
  if (!rows.length) return <p className="muted" style={{ margin: 0 }}>Nothing to show for this window.</p>;
  let max = 1;
  rows.forEach((r) => {
    const v = num(r[valueKey]);
    if (v > max) max = v;
  });
  return (
    <ul className="sd-barlist">
      {rows.map((r, i) => {
        const v = num(r[valueKey]);
        return (
          <li key={s(r.id) || s(r[labelKey]) || String(i)}>
            <span className="sd-barlist-label" title={s(r[labelKey])}>{s(r[labelKey]) || '\u2013'}</span>
            <span className="sd-barlist-track">
              <span className="sd-barlist-fill" style={barStyle(Math.max(3, Math.round((v / max) * 100)), '#0E7490')} />
            </span>
            <span className="sd-barlist-val td-cell-mono">{format ? format(v) : String(v)}</span>
            {noteKey ? <span className="sd-barlist-note muted">{s(r[noteKey])}</span> : null}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * A multi-series trend chart drawn with plain elements: one row per bucket, one
 * track per series. It degrades to a readable list rather than a blank canvas,
 * which matters on the mobile service desk.
 */
function TrendChart({
  rows,
  labelKey,
  series,
  empty,
}: {
  rows: Rec[];
  labelKey: string;
  series: Series[];
  empty?: string;
}) {
  if (!rows.length) return <p className="muted" style={{ margin: 0 }}>{empty ?? 'No activity in this window.'}</p>;
  let max = 1;
  rows.forEach((r) => {
    series.forEach((sr) => {
      const v = num(r[sr.key]);
      if (v > max) max = v;
    });
  });
  return (
    <div className="sd-trend">
      <div className="sd-trend-legend">
        {series.map((sr) => (
          <span className="sd-trend-key" key={sr.key}>
            <i style={{ background: sr.color }} aria-hidden />{sr.text}
          </span>
        ))}
      </div>
      <div className="sd-trend-rows">
        {rows.map((r, i) => (
          <div className="sd-trend-row" key={s(r[labelKey]) || String(i)}>
            <span className="sd-trend-label">{fmtDay(r[labelKey])}</span>
            <span className="sd-trend-bars">
              {series.map((sr) => {
                const v = num(r[sr.key]);
                return (
                  <span className="sd-trend-track" key={sr.key} title={sr.text + ': ' + v}>
                    <span
                      className="sd-trend-fill"
                      style={barStyle(Math.max(2, Math.round((v / max) * 100)), sr.color)}
                    />
                  </span>
                );
              })}
            </span>
            <span className="sd-trend-val td-cell-mono">{series.map((sr) => num(r[sr.key])).join(' / ')}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Shared shell so each of the four dashboards keeps the same chrome. */
function DashShell({
  tab,
  text,
  blurb,
  days,
  onDays,
  actions,
  children,
}: {
  tab: Tab;
  text: string;
  blurb: string;
  days: string;
  onDays: (v: string) => void;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="page" style={modStyle()}>
      <SdHead
        kicker={'Service desk \u00b7 dashboards'}
        title={text}
        sub={blurb}
        actions={
          <>
            {windowed(tab) ? (
              <Sel
                value={days}
                onChange={onDays}
                options={WINDOWS.map(([v, t]) => ({ value: v, label: t }))}
                placeholder="Last 30 days"
              />
            ) : null}
            {actions}
          </>
        }
      />
      <SdTabs active="dashboard" />
      {children}
    </div>
  );
}
/* ------------------------------------------------------------------ *
 * Employee dashboard
 * ------------------------------------------------------------------ */

function EmployeeDash({ d }: { d: Rec }) {
  const counts = asRec(d.counts);
  const recent = asRows(d.recentTickets);
  const pending = asRows(d.pendingTickets);
  const knowledge = asRows(d.knowledge);
  const assets = asRows(d.myAssets);
  const open = (t: Rec) => navigate('/service-desk/t/' + s(t.id));

  return (
    <>
      <KpiRow>
        <KpiTile label="My open tickets" value={num(counts.open_tickets)} sub="Not yet resolved" />
        <KpiTile
          label="Waiting on me"
          value={num(counts.awaiting_me)}
          sub="Reply needed to continue"
          accent="#B45309"
          tint="rgba(180, 83, 9, 0.12)"
        />
        <KpiTile
          label="Awaiting my confirmation"
          value={num(counts.awaiting_confirmation)}
          sub="Resolved, not yet closed"
          accent="#16A34A"
          tint="rgba(22, 163, 74, 0.12)"
        />
        <KpiTile label="Resolved for me" value={num(counts.resolved_30d)} sub="Last 30 days" />
        <KpiTile label="Raised by me" value={num(counts.raised_30d)} sub="Last 30 days" />
      </KpiRow>

      <div className="grid-2 sd-stack">
        <SecCard
          title="My recent tickets"
          sub="Newest first"
          actions={
            <button className="btn btn-sm" type="button" onClick={() => navigate('/service-desk')}>
              All my tickets
            </button>
          }
        >
          <TicketTable rows={recent} onOpen={open} empty="You have not raised a service ticket yet." />
        </SecCard>

        <SecCard title="Pending requests" sub="Tickets that are waiting on somebody">
          {pending.length === 0 ? (
            <p className="muted" style={{ margin: 0 }}>Nothing is waiting. Your requests are all moving.</p>
          ) : (
            <ul className="sd-link-list">
              {pending.map((t) => (
                <li key={s(t.id)}>
                  <button type="button" className="sd-link-row" onClick={() => open(t)}>
                    <span className="sd-link">{subjectOf(t)}</span>
                    <span className="sd-link-sub muted">
                      <span className="td-cell-mono">{ticketRef(t)}</span>
                      {' \u00b7 updated ' + fmtAgo(t.updated_at ?? t.opened_at)}
                    </span>
                    <StatusChip value={t.status} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </SecCard>
      </div>

      <div className="grid-2 sd-stack">
        <SecCard title="Knowledge that may help" sub="Published articles you are allowed to read">
          {knowledge.length === 0 ? (
            <p className="muted" style={{ margin: 0 }}>No published knowledge yet.</p>
          ) : (
            <ul className="sd-link-list">
              {knowledge.map((a) => (
                <li key={s(a.id)}>
                  <button
                    type="button"
                    className="sd-link-row"
                    onClick={() => navigate('/service-desk/knowledge/' + s(a.id))}
                  >
                    <span className="sd-link">{s(a.title) || '\u2013'}</span>
                    <span className="sd-link-sub muted">
                      {s(a.article_number)}
                      {s(a.category_name) ? ' \u00b7 ' + s(a.category_name) : ''}
                    </span>
                    {num(a.view_count) > 0 ? (
                      <span className="sd-link-sub muted">{num(a.view_count) + ' views'}</span>
                    ) : null}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </SecCard>

        <SecCard title="My assets" sub="Equipment currently assigned to me">
          {assets.length === 0 ? (
            <p className="muted" style={{ margin: 0 }}>No asset is registered against your name.</p>
          ) : (
            <ul className="sd-link-list">
              {assets.map((a, i) => (
                <li key={s(a.asset_id ?? a.id) || String(i)}>
                  <div className="sd-link-row sd-link-static">
                    <span className="sd-link">{s(a.name) || s(a.asset_name) || '\u2013'}</span>
                    <span className="sd-link-sub muted td-cell-mono">
                      {s(a.asset_no) || s(a.asset_number) || '\u2013'}
                    </span>
                    <StatusChip value={a.status} />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </SecCard>
      </div>

      <SecCard title="Need help now?" sub="The three things employees do most">
        <div className="sd-inline-actions">
          <button className="btn btn-primary" type="button" onClick={() => navigate('/service-desk/new')}>
            Create service request
          </button>
          <button className="btn" type="button" onClick={() => navigate('/service-desk/scan')}>
            Scan asset QR
          </button>
          <button className="btn" type="button" onClick={() => navigate('/service-desk/knowledge')}>
            Search knowledge
          </button>
        </div>
      </SecCard>
    </>
  );
}
/* ------------------------------------------------------------------ *
 * Service Desk Agent dashboard
 * ------------------------------------------------------------------ */

const QUEUE_COLS = 5;
const LOAD_COLS = 6;

function AgentDash({ d }: { d: Rec }) {
  const counts = asRec(d.counts);
  const queues = asRows(d.queues);
  const workload = asRows(d.workload);
  const myTickets = asRows(d.myTickets);
  const unassigned = asRows(d.unassigned);
  const warnings = asRows(d.slaWarnings);
  const critical = asRows(d.criticalIncidents);
  const open = (t: Rec) => navigate('/service-desk/tickets/' + s(t.id));
  const list = (query: Record<string, string>) => navigate('/service-desk/tickets', { query });

  return (
    <>
      <KpiRow>
        <KpiTile
          label="Assigned to me"
          value={num(counts.my_tickets)}
          sub="Active work I own"
          onClick={() => list({ filter: 'mine' })}
        />
        <KpiTile
          label="Unassigned"
          value={num(counts.unassigned)}
          sub="Waiting for an owner"
          onClick={() => list({ filter: 'unassigned' })}
        />
        <KpiTile
          label="Critical P1"
          value={num(counts.critical)}
          sub="Highest severity open"
          accent="#FF0000"
          tint="rgba(255, 0, 0, 0.10)"
          onClick={() => list({ priority: 'P1' })}
        />
        <KpiTile
          label="SLA due soon"
          value={num(counts.due_soon)}
          sub="Resolution due within 1 hour"
          accent="#B45309"
          tint="rgba(180, 83, 9, 0.12)"
          onClick={() => list({ filter: 'warning' })}
        />
        <KpiTile
          label="SLA overdue"
          value={num(counts.overdue)}
          sub="Already past the target"
          accent="#FF0000"
          tint="rgba(255, 0, 0, 0.10)"
          onClick={() => list({ filter: 'overdue' })}
        />
        <KpiTile
          label="Response overdue"
          value={num(counts.response_overdue)}
          sub="No first response yet"
          accent="#B45309"
          tint="rgba(180, 83, 9, 0.12)"
        />
        <KpiTile label="Awaiting requester" value={num(counts.pending_requester)} sub="Paused on the employee" />
        <KpiTile
          label="Opened today"
          value={num(counts.opened_today)}
          sub={num(counts.resolved_today) + ' resolved today'}
        />
      </KpiRow>

      <div className="grid-2 sd-stack">
        <SecCard
          title="My assigned tickets"
          sub="Ordered by priority, then by the SLA clock"
          actions={
            <button className="btn btn-sm" type="button" onClick={() => list({ filter: 'mine' })}>
              Open in tickets
            </button>
          }
        >
          <TicketTable rows={myTickets} onOpen={open} empty="Nothing is assigned to you right now." />
        </SecCard>

        <SecCard
          title="Unassigned work"
          sub="Pull from here, or let the queue strategy assign it"
          actions={
            <button className="btn btn-sm" type="button" onClick={() => list({ filter: 'unassigned' })}>
              Open in tickets
            </button>
          }
        >
          <TicketTable rows={unassigned} onOpen={open} empty="Every active ticket has an owner." />
        </SecCard>
      </div>

      <div className="grid-2 sd-stack">
        <SecCard title="SLA warnings" sub="Resolution due within the hour, or an overdue first response">
          <TicketTable rows={warnings} onOpen={open} empty="No ticket is close to breaching its SLA." />
        </SecCard>

        <SecCard title="Critical incidents" sub="Every open P1 regardless of owner">
          <TicketTable rows={critical} onOpen={open} empty="No open critical incident." />
        </SecCard>
      </div>

      <div className="grid-2 sd-stack">
        <SecCard title="Queue load" sub="Where the open work is sitting">
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Queue</th>
                  <th style={{ width: '110px' }}>Strategy</th>
                  <th style={{ width: '90px' }}>Open</th>
                  <th style={{ width: '110px' }}>Unassigned</th>
                  <th style={{ width: '90px' }}>Critical</th>
                </tr>
              </thead>
              <tbody>
                {queues.length === 0 && <EmptyRow cols={QUEUE_COLS}>No queue is configured for this company.</EmptyRow>}
                {queues.map((r) => (
                  <tr key={s(r.id)}>
                    <td>
                      <div className="sd-subj-cell">
                        <span className="sd-subj">{s(r.name) || '\u2013'}</span>
                        <span className="sub muted">
                          {s(r.code)}
                          {r.is_default ? ' \u00b7 default' : ''}
                        </span>
                      </div>
                    </td>
                    <td className="muted">{s(r.assignment_strategy) || '\u2013'}</td>
                    <td className="td-cell-mono">{num(r.open_tickets)}</td>
                    <td className="td-cell-mono">{num(r.unassigned)}</td>
                    <td className="td-cell-mono">{num(r.critical)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </SecCard>

        <SecCard title="Technician workload" sub="Open load per service desk agent">
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Technician</th>
                  <th style={{ width: '80px' }}>Open</th>
                  <th style={{ width: '90px' }}>Critical</th>
                  <th style={{ width: '100px' }}>Pending</th>
                  <th style={{ width: '100px' }}>Overdue</th>
                  <th style={{ width: '110px' }}>Avg fix</th>
                </tr>
              </thead>
              <tbody>
                {workload.length === 0 && <EmptyRow cols={LOAD_COLS}>No service desk agent is provisioned yet.</EmptyRow>}
                {workload.map((r, i) => (
                  <tr key={s(r.user_id) || String(i)}>
                    <td>{s(r.name) || '\u2013'}</td>
                    <td className="td-cell-mono">{num(r.open_tickets)}</td>
                    <td className="td-cell-mono">{num(r.critical_tickets)}</td>
                    <td className="td-cell-mono">{num(r.pending_tickets)}</td>
                    <td className={'td-cell-mono' + (num(r.overdue_tickets) > 0 ? ' sd-danger' : '')}>
                      {num(r.overdue_tickets)}
                    </td>
                    <td className="td-cell-mono">
                      {num(r.avg_resolution_minutes) > 0 ? fmtDur(r.avg_resolution_minutes) : '\u2013'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </SecCard>
      </div>
    </>
  );
}
/* ------------------------------------------------------------------ *
 * Service Desk Manager dashboard
 * ------------------------------------------------------------------ */

const ESC_COLS = 5;
const REC_COLS = 6;

function Facts({ rows }: { rows: Array<[string, ReactNode]> }) {
  return (
    <dl className="sd-facts">
      {rows.map(([k, v]) => (
        <div className="sd-fact" key={k}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function ManagerDash({ d }: { d: Rec }) {
  const counts = asRec(d.counts);
  const sla = asRec(d.sla);
  const rt = asRec(d.resolutionTime);
  const escalations = asRows(d.escalations);
  const recurring = asRows(d.recurringIncidents);
  const trend = asRows(d.trend);
  const workload = asRows(d.workload);
  const drill = (query: Record<string, string>) => navigate('/service-desk/tickets', { query });
  const level = windowedWindow(d);

  const escalationsOut = escalations.reduce((n, r) => n + num(r.open_count), 0);

  return (
    <>
      <KpiRow>
        <KpiTile label="Open tickets" value={num(counts.open_total)} sub={level} onClick={() => drill({ filter: 'active' })} />
        <KpiTile
          label="SLA overdue"
          value={num(counts.overdue)}
          sub="Past the resolution target"
          accent="#FF0000"
          tint="rgba(255, 0, 0, 0.10)"
          onClick={() => drill({ filter: 'overdue' })}
        />
        <KpiTile label="Unassigned" value={num(counts.unassigned)} sub="No owner yet" onClick={() => drill({ filter: 'unassigned' })} />
        <KpiTile
          label="Critical P1"
          value={num(counts.critical)}
          sub="Highest severity open"
          accent="#FF0000"
          tint="rgba(255, 0, 0, 0.10)"
          onClick={() => drill({ priority: 'P1' })}
        />
        <KpiTile label="Escalated" value={num(counts.escalated)} sub={escalationsOut + ' open at a level'} accent="#B45309" tint="rgba(180, 83, 9, 0.12)" />
        <KpiTile label="Response compliance" value={pctText(sla.response_compliance_pct)} sub={num(sla.response_breached) + ' breached'} />
        <KpiTile label="Resolution compliance" value={pctText(sla.resolution_compliance_pct)} sub={num(sla.resolution_breached) + ' breached'} />
        <KpiTile label="Average resolution" value={fmtMinutesClock(rt.avg_minutes)} sub={'Median ' + fmtMinutesClock(rt.median_minutes)} />
      </KpiRow>

      <div className="grid-2 sd-stack">
        <SecCard title="SLA performance" sub="Response and resolution targets over the window">
          <Facts
            rows={[
              ['Tickets tracked', num(sla.tracked)],
              ['Response met', num(sla.response_met)],
              ['Response breached', num(sla.response_breached)],
              ['Resolution met', num(sla.resolution_met)],
              ['Resolution breached', num(sla.resolution_breached)],
              ['Average first response', fmtMinutesClock(rt.avg_first_response_minutes)],
            ]}
          />
        </SecCard>

        <SecCard title="Escalations by level" sub="Where escalations were raised, and how many are still open">
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Level</th>
                  <th style={{ width: '150px' }}>Role</th>
                  <th style={{ width: '90px' }}>Total</th>
                  <th style={{ width: '110px' }}>Still open</th>
                  <th style={{ width: '90px' }}>Share</th>
                </tr>
              </thead>
              <tbody>
                {escalations.length === 0 && <EmptyRow cols={ESC_COLS}>No ticket was escalated in this window.</EmptyRow>}
                {escalations.map((r) => {
                  const total = num(r.total);
                  const share = escalationsOut > 0 ? Math.round((num(r.open_count) / Math.max(1, escalationsOut)) * 100) : 0;
                  return (
                    <tr key={s(r.level)}>
                      <td>
                        <div className="sd-subj-cell">
                          <span className="sd-subj">
                            {'Level ' + num(r.level)}
                          </span>
                          <span className="sub muted">{s(r.level_name)}</span>
                        </div>
                      </td>
                      <td className="muted td-cell-mono">{s(r.role_code) || '\u2013'}</td>
                      <td className="td-cell-mono">{total}</td>
                      <td className={'td-cell-mono' + (num(r.open_count) > 0 ? ' sd-danger' : '')}>{num(r.open_count)}</td>
                      <td className="td-cell-mono">{share + '%'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </SecCard>
      </div>

      <SecCard title="Service trend" sub="Tickets opened against tickets resolved the same day">
        <TrendChart
          rows={trend}
          labelKey="day"
          series={[
            { key: 'opened', text: 'Opened', color: TREND_COLORS[0] },
            { key: 'same_day_resolved', text: 'Resolved same day', color: TREND_COLORS[2] },
          ]}
        />
      </SecCard>

      <div className="grid-2 sd-stack">
        <SecCard
          title="Recurring incidents"
          sub="Three or more incidents in the same subcategory"
          actions={
            <button className="btn btn-sm" type="button" onClick={() => navigate('/service-desk/problems')}>
              Problem management
            </button>
          }
        >
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Category</th>
                  <th>Subcategory</th>
                  <th style={{ width: '90px' }}>Incidents</th>
                  <th style={{ width: '90px' }}>High impact</th>
                  <th style={{ width: '100px' }}>Assets</th>
                  <th style={{ width: '120px' }}>Last seen</th>
                </tr>
              </thead>
              <tbody>
                {recurring.length === 0 && (
                  <EmptyRow cols={REC_COLS}>No repeating incident pattern in this window.</EmptyRow>
                )}
                {recurring.map((r) => (
                  <tr
                    key={s(r.category_id) + ':' + s(r.subcategory_id)}
                    className="sd-ticket-row"
                    tabIndex={0}
                    onClick={() =>
                      drill({
                        categoryId: s(r.category_id),
                        subcategoryId: s(r.subcategory_id),
                        drillLabel: s(r.category_name) + ' / ' + s(r.subcategory_name),
                      })
                    }
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        drill({
                          categoryId: s(r.category_id),
                          subcategoryId: s(r.subcategory_id),
                          drillLabel: s(r.category_name) + ' / ' + s(r.subcategory_name),
                        });
                      }
                    }}
                  >
                    <td>{s(r.category_name) || '\u2013'}</td>
                    <td className="muted">{s(r.subcategory_name) || '\u2013'}</td>
                    <td className="td-cell-mono">{num(r.incidents)}</td>
                    <td className="td-cell-mono">{num(r.high_impact)}</td>
                    <td className="td-cell-mono">{num(r.distinct_assets)}</td>
                    <td className="muted">{fmtAgo(r.last_seen)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </SecCard>

        <SecCard title="Technician load" sub="Open tickets per agent, highest first">
          <BarList rows={workload.slice(0, 12)} labelKey="name" valueKey="open_tickets" noteKey="overdue_tickets" />
          <p className="muted sd-subnote">
            The trailing figure is each technician&apos;s overdue ticket count.
          </p>
        </SecCard>
      </div>
    </>
  );
}

/** "Last N days" label for the KPI sub-line, mirroring the server window. */
function windowedWindow(d: Rec): string {
  const n = num(d.windowDays);
  return n > 0 ? 'Last ' + n + ' days' : 'Current window';
}
/* ------------------------------------------------------------------ *
 * Executive dashboard
 * ------------------------------------------------------------------ */

const OUT_COLS = 7;
const CAT_COLS = 4;

function ExecutiveDash({ d }: { d: Rec }) {
  const headline = asRec(d.headline);
  const sla = asRec(d.sla);
  const outages = asRows(d.majorOutages);
  const trend = asRows(d.trend);
  const byCategory = asRows(d.byCategory);
  const open = (t: Rec) => navigate('/service-desk/tickets/' + s(t.id));
  const level = windowedWindow(d);

  return (
    <>
      <KpiRow>
        <KpiTile
          label="Open critical"
          value={num(headline.open_critical)}
          sub="P1 tickets still open"
          accent="#FF0000"
          tint="rgba(255, 0, 0, 0.10)"
          onClick={() => navigate('/service-desk/tickets', { query: { priority: 'P1' } })}
        />
        <KpiTile label="Open high" value={num(headline.open_high)} sub="P2 tickets still open" />
        <KpiTile label="Open total" value={num(headline.open_total)} sub="All active tickets" />
        <KpiTile label="Escalated" value={num(headline.escalated)} sub="Raised to a higher level" accent="#B45309" tint="rgba(180, 83, 9, 0.12)" />
        <KpiTile
          label="Security incidents"
          value={num(headline.open_security)}
          sub="Open and security classified"
          accent="#FF0000"
          tint="rgba(255, 0, 0, 0.10)"
        />
        <KpiTile label="Opened" value={num(headline.opened_window)} sub={level} />
        <KpiTile label="Resolved" value={num(headline.resolved_window)} sub={level} />
        <KpiTile
          label="Resolution compliance"
          value={pctText(sla.resolution_compliance_pct)}
          sub={num(sla.resolution_breached) + ' breached'}
        />
      </KpiRow>

      <SecCard
        title="Major outages"
        sub="Open tickets whose impact is the whole enterprise"
        actions={
          <button className="btn btn-sm" type="button" onClick={() => navigate('/service-desk/reports')}>
            Service reports
          </button>
        }
      >
        <div className="table-wrap">
          <table className="table sd-ticket-table">
            <thead>
              <tr>
                <th style={{ width: '150px' }}>Ticket</th>
                <th>Subject</th>
                <th style={{ width: '110px' }}>Priority</th>
                <th style={{ width: '140px' }}>Status</th>
                <th style={{ width: '150px' }}>Affected asset</th>
                <th style={{ width: '150px' }}>Owner</th>
                <th style={{ width: '110px' }}>Age</th>
              </tr>
            </thead>
            <tbody>
              {outages.length === 0 && (
                <EmptyRow cols={OUT_COLS}>No enterprise-impact ticket is open. Service is stable.</EmptyRow>
              )}
              {outages.map((t) => (
                <tr
                  key={s(t.id)}
                  className="sd-ticket-row sd-row-critical"
                  tabIndex={0}
                  onClick={() => open(t)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      open(t);
                    }
                  }}
                >
                  <td className="td-cell-mono">{ticketRef(t)}</td>
                  <td>
                    <div className="sd-subj-cell">
                      <span className="sd-subj">{subjectOf(t)}</span>
                      <span className="sub muted">{s(t.impact) ? 'Impact ' + s(t.impact) : ''}</span>
                    </div>
                  </td>
                  <td><PriorityChip value={t.priority} compact /></td>
                  <td><StatusChip value={t.status} /></td>
                  <td>
                    <div className="sd-subj-cell">
                      <span>{s(t.asset_no) || '\u2013'}</span>
                      <span className="sub muted">{s(t.asset_name)}</span>
                    </div>
                  </td>
                  <td className="muted">{s(t.assignee_email) || 'Unassigned'}</td>
                  <td className="muted">{fmtAgo(t.opened_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </SecCard>

      <div className="grid-2 sd-stack">
        <SecCard title="Service trend" sub="Weekly view of demand against delivery">
          <TrendChart
            rows={trend}
            labelKey="week"
            series={[
              { key: 'opened', text: 'Opened', color: TREND_COLORS[0] },
              { key: 'critical', text: 'Critical', color: TREND_COLORS[1] },
              { key: 'resolved', text: 'Resolved', color: TREND_COLORS[2] },
            ]}
          />
        </SecCard>

        <SecCard title="SLA performance" sub="Compliance across every policed ticket in the window">
          <Facts
            rows={[
              ['Resolution compliance', pctText(sla.resolution_compliance_pct)],
              ['Resolutions breached', num(sla.resolution_breached)],
              ['Response compliance', pctText(sla.response_compliance_pct)],
            ]}
          />
          <p className="muted sd-subnote">
            Compliance is calculated server-side from the SLA ledger, not from ticket status.
          </p>
        </SecCard>
      </div>

      <SecCard title="Demand by category" sub="Where the organisation spends its service capacity">
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Category</th>
                <th style={{ width: '120px' }}>Tickets</th>
                <th style={{ width: '120px' }}>Critical</th>
                <th style={{ width: '160px' }}>Average resolution</th>
              </tr>
            </thead>
            <tbody>
              {byCategory.length === 0 && <EmptyRow cols={CAT_COLS}>No ticket was raised in this window.</EmptyRow>}
              {byCategory.map((r, i) => (
                <tr key={s(r.category_name) || String(i)}>
                  <td>{s(r.category_name) || '\u2013'}</td>
                  <td className="td-cell-mono">{num(r.total)}</td>
                  <td className={'td-cell-mono' + (num(r.critical) > 0 ? ' sd-danger' : '')}>{num(r.critical)}</td>
                  <td className="td-cell-mono">
                    {num(r.avg_resolution_minutes) > 0 ? fmtMinutesClock(r.avg_resolution_minutes) : '\u2013'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </SecCard>
    </>
  );
}
/* ------------------------------------------------------------------ *
 * Shell
 * ------------------------------------------------------------------ */

export default function ServiceDeskDashboards() {
  const { user } = useAuth();
  const allowed = useMemo(
    () => TABS.filter((t) => itemVisible(user, { perm: t.perm })).map((t) => t.key),
    [user]
  );
  const [tab, setTab] = useState<Tab>(() => {
    const first = TABS.filter((t) => itemVisible(user, { perm: t.perm }))[0];
    return first ? first.key : 'employee';
  });
  const [days, setDays] = useState('30');
  const [data, setData] = useState<Rec | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const maySee = allowed.indexOf(tab) >= 0;

  const load = useCallback(async () => {
    if (!maySee) {
      setData(null);
      setError(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const suffix = windowed(tab) ? '?days=' + days : '';
      setData(asRec(await sdApi<Rec>('/dashboard/' + tab + suffix)));
    } catch (e) {
      setError(sdErr(e));
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [tab, days, maySee]);

  useEffect(() => {
    void load();
  }, [load]);

  if (allowed.length === 0) {
    return (
      <div className="page" style={modStyle()}>
        <SdHead
          kicker={'Service desk \u00b7 dashboards'}
          title="Dashboards"
          sub="Dashboards are driven by your role and organisational scope."
        />
        <SdTabs active="dashboard" />
        <Nothing text="No dashboard is available for your role. Ask an administrator for a service desk dashboard permission." />
      </div>
    );
  }

  const def = TABS.filter((t) => allowed.indexOf(t.key) >= 0 && t.key === tab)[0]
    ?? TABS.filter((t) => allowed.indexOf(t.key) >= 0)[0];

  return (
    <DashShell
      tab={def.key}
      text={def.text}
      blurb={def.blurb}
      days={days}
      onDays={setDays}
      actions={
        <button className="btn" type="button" onClick={() => void load()}>
          Refresh
        </button>
      }
    >
      <div className="tabs sd-sub-tabs">
        {TABS.filter((t) => allowed.indexOf(t.key) >= 0).map((t) => (
          <button
            key={t.key}
            type="button"
            className={'tab' + (t.key === tab ? ' active' : '')}
            onClick={() => setTab(t.key)}
          >
            {t.text}
          </button>
        ))}
      </div>

      {error ? <ErrorBanner error={error} /> : null}

      {loading ? (
        <div className="table-loading"><Spinner /></div>
      ) : data === null ? (
        <Nothing text="The dashboard did not return any data." />
      ) : tab === 'employee' ? (
        <EmployeeDash d={data} />
      ) : tab === 'agent' ? (
        <AgentDash d={data} />
      ) : tab === 'manager' ? (
        <ManagerDash d={data} />
      ) : (
        <ExecutiveDash d={data} />
      )}
    </DashShell>
  );
}
