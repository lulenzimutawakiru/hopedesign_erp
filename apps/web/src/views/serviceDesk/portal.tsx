import { useCallback, useEffect, useState } from 'react';
import { navigate } from '../../router';
import { ErrorBanner, PageLoader } from '../../components/ui';
import {
  KpiRow,
  KpiTile,
  Nothing,
  PriorityChip,
  SdHead,
  SdTabs,
  SecCard,
  SlaChip,
  StatusChip,
  dash,
  fmtAgo,
  fmtDT,
  isOpenStatus,
  modStyle,
  num,
  s,
  sdApi,
  subjectOf,
  ticketRef,
  type Rec,
} from '../serviceDeskShared';

const MY = '/api/my/service-desk';
const BASE = '/service-desk/t';

interface Summary {
  openTickets?: Rec[];
  recentTickets?: Rec[];
  pendingTickets?: Rec[];
  openCount?: number;
  knowledge?: Rec[];
  myAssets?: Rec[];
  counts?: Rec;
}

function TicketCard({ t }: { t: Rec }) {
  const open = isOpenStatus(t.status);
  return (
    <button type="button" className="sd-tcard" onClick={() => navigate(BASE + '/' + s(t.id))}>
      <div className="sd-tcard-top">
        <b className="td-cell-mono">{ticketRef(t)}</b>
        <PriorityChip value={t.priority} compact />
      </div>
      <p className="sd-tcard-subj">{subjectOf(t)}</p>
      <div className="sd-tcard-foot">
        <StatusChip value={t.status} />
        {open && <SlaChip state={t.sla_resolution_state ?? t.sla_state} title="Resolution SLA" />}
        <span className="muted">{fmtAgo(t.opened_at ?? t.created_at)}</span>
      </div>
    </button>
  );
}

function ArticleCard({ a }: { a: Rec }) {
  const id = s(a.id);
  return (
    <button type="button" className="sd-acard" onClick={() => navigate('/service-desk/knowledge/' + id)}>
      <b>{dash(a.title)}</b>
      <span className="muted">
        {dash(a.category_name)} &middot; {num(a.view_count).toLocaleString()} views
      </span>
      <span className="sd-acard-sum muted">{dash(a.summary ?? a.excerpt)}</span>
    </button>
  );
}

export default function ServiceDeskPortal() {
  const [data, setData] = useState<Summary | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [tick, setTick] = useState(0);

  const load = useCallback(async () => {
    setError(null);
    try {
      setData(await sdApi<Summary>(MY + '/summary'));
    } catch (e) {
      setError(e);
    }
  }, []);

  useEffect(() => void load(), [load, tick]);

  if (!data && !error) return <PageLoader variant="page" label="Loading your service desk" />;

  const open = data?.openTickets ?? [];
  const recent = data?.recentTickets ?? [];
  const pending = data?.pendingTickets ?? [];
  const knowledge = data?.knowledge ?? [];
  const assets = data?.myAssets ?? [];
  const c = data?.counts ?? {};

  return (
    <div className="page sd-portal" style={modStyle()}>
      <SdHead
        title="My Service Desk"
        kicker="My HOPE DESIGN"
        sub="Report a fault, request a service or follow up on something you already raised. Requests are triaged by the HOPE DESIGN service desk and tracked against an SLA."
        actions={
          <>
            <button className="btn btn-primary sd-primary" onClick={() => navigate('/service-desk/new')}>
              + Create Service Request
            </button>
            <button className="btn" onClick={() => navigate('/service-desk/knowledge')}>
              Knowledge Base
            </button>
          </>
        }
      />
      <SdTabs active="portal" />

      {error ? <ErrorBanner error={error} /> : null}

      <section className="sd-hero" aria-label="Create a request">
        <div>
          <h2>Need help?</h2>
          <p className="muted">
            Tell us what is broken or what you need. Attach a photo if it helps us see the problem
            faster. You will get a ticket number immediately and can track progress here.
          </p>
        </div>
        <div className="sd-hero-actions">
          <button className="btn btn-primary sd-primary" onClick={() => navigate('/service-desk/new')}>
            + Create Service Request
          </button>
          <button className="btn" onClick={() => navigate('/service-desk/scan')}>
            Scan Asset QR
          </button>
        </div>
      </section>

      <KpiRow>
        <KpiTile label="Open tickets" value={num(c.open_tickets ?? data?.openCount)} sub="Being worked on" onClick={() => navigate('/service-desk?filter=open')} />
        <KpiTile label="Awaiting you" value={num(c.awaiting_me)} sub="We replied - over to you" onClick={() => navigate('/service-desk?filter=pending')} />
        <KpiTile label="Awaiting confirmation" value={num(c.awaiting_confirmation)} sub="Confirm the fix" onClick={() => navigate('/service-desk?filter=pending')} />
        <KpiTile label="Resolved (30d)" value={num(c.resolved_30d)} sub="Closed in last 30 days" onClick={() => navigate('/service-desk?filter=resolved')} />
      </KpiRow>

      <div className="sd-portal-grid">
        <SecCard
          title="Open tickets"
          sub="Everything currently in the service desk queue"
          actions={<button className="btn btn-sm" onClick={() => navigate('/service-desk?filter=open')}>View all</button>}
        >
          {open.length === 0 ? (
            <Nothing
              text="You have no open tickets. Everything you raised has been resolved."
              action="Create a request"
              onAction={() => navigate('/service-desk/new')}
            />
          ) : (
            <div className="sd-tcards">
              {open.map((t) => (
                <TicketCard key={s(t.id)} t={t} />
              ))}
            </div>
          )}
        </SecCard>

        <SecCard
          title="Pending requests"
          sub="Waiting on you, a vendor or a third party"
          actions={<button className="btn btn-sm" onClick={() => navigate('/service-desk?filter=pending')}>View all</button>}
        >
          {pending.length === 0 ? (
            <p className="muted" style={{ margin: 0 }}>Nothing is waiting on you right now.</p>
          ) : (
            <div className="sd-tcards">
              {pending.map((t) => (
                <TicketCard key={s(t.id)} t={t} />
              ))}
            </div>
          )}
        </SecCard>
      </div>

      <div className="sd-portal-grid">
        <SecCard
          title="Recently resolved"
          sub="Confirmed and closed in the last 30 days"
          actions={<button className="btn btn-sm" onClick={() => navigate('/service-desk?filter=resolved')}>View all</button>}
        >
          {recent.length === 0 ? (
            <p className="muted" style={{ margin: 0 }}>No recently resolved tickets.</p>
          ) : (
            <div className="table-wrap">
              <table className="table sd-ticket-table">
                <thead>
                  <tr>
                    <th style={{ width: 150 }}>Ticket</th>
                    <th>Subject</th>
                    <th style={{ width: 120 }}>Resolved</th>
                  </tr>
                </thead>
                <tbody>
                  {recent.slice(0, 6).map((t) => (
                    <tr key={s(t.id)} className="sd-ticket-row" onClick={() => navigate(BASE + '/' + s(t.id))}>
                      <td><b className="td-cell-mono">{ticketRef(t)}</b></td>
                      <td>{subjectOf(t)}</td>
                      <td className="muted">{fmtAgo(t.resolved_at ?? t.closed_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </SecCard>

        <SecCard
          title="My assets"
          sub="Equipment assigned to you - scan the tag to raise a ticket against it"
          actions={<button className="btn btn-sm" onClick={() => navigate('/service-desk/scan')}>Scan QR</button>}
        >
          {assets.length === 0 ? (
            <p className="muted" style={{ margin: 0 }}>
              No equipment is currently assigned to you in the asset register.
            </p>
          ) : (
            <ul className="sd-assets">
              {assets.map((a) => (
                <li key={s(a.id)}>
                  <button
                    type="button"
                    className="sd-asset"
                    onClick={() => navigate('/service-desk/scan?code=' + encodeURIComponent(s(a.asset_no ?? a.code)))}
                  >
                    <b className="td-cell-mono">{dash(a.asset_no ?? a.code)}</b>
                    <span>{dash(a.name ?? a.description)}</span>
                    <span className="muted">{dash(a.status ?? a.asset_status)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </SecCard>

        <SecCard
          title="Knowledge articles"
          sub="Answers and how-to guides that may solve this without a ticket"
          actions={<button className="btn btn-sm" onClick={() => navigate('/service-desk/knowledge')}>Browse</button>}
        >
          {knowledge.length === 0 ? (
            <p className="muted" style={{ margin: 0 }}>No published articles yet.</p>
          ) : (
            <div className="sd-acards">
              {knowledge.slice(0, 5).map((a) => (
                <ArticleCard key={s(a.id)} a={a} />
              ))}
            </div>
          )}
        </SecCard>
      </div>

      <p className="muted sd-foot-note">
        Service desk requests are audited. Every view, reply and change is recorded against your user
        account for traceability. Last refreshed {fmtDT(new Date().toISOString())} &middot;{' '}
        <button className="link-btn" onClick={() => setTick((v) => v + 1)}>Refresh</button>
      </p>
    </div>
  );
}
