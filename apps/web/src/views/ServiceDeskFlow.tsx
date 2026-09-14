import { navigate } from '../router';
import { Nothing, num } from './serviceDeskShared';

import ServiceDeskPortal from './serviceDesk/portal';
import ServiceDeskCreate from './serviceDesk/create';
import TicketDetail from './serviceDesk/ticket';
import ServiceDeskTickets from './serviceDesk/tickets';
import ServiceDeskWorkspace from './serviceDesk/workspace';
import ServiceDeskQueues from './serviceDesk/queues';
import ServiceDeskKnowledge from './serviceDesk/knowledge';
import ServiceDeskProblems from './serviceDesk/problems';
import ServiceDeskChanges from './serviceDesk/changes';
import ServiceDeskAccess from './serviceDesk/access';
import ServiceDeskScan from './serviceDesk/scan';
import ServiceDeskReports from './serviceDesk/reports';
import ServiceDeskConfig from './serviceDesk/config';
import ServiceDeskDashboards from './serviceDesk/dashboards';

function parseSd(path: string): { view: string; sub: string | null } {
  const parts = path.split('/').filter(Boolean);
  if (parts[0] !== 'service-desk') return { view: '', sub: null };
  return { view: parts[1] ?? '', sub: parts[2] ?? null };
}

function MissingRecord({ what }: { what: string }) {
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <p className="mod-kicker" data-mod="service-desk">Service desk</p>
          <h1>Not found</h1>
        </div>
      </div>
      <Nothing
        text={'That ' + what + ' reference is missing or invalid.'}
        action="Back to service desk"
        onAction={() => navigate('/service-desk')}
      />
    </div>
  );
}

export default function ServiceDeskFlow({ path }: { path: string }) {
  const { view, sub } = parseSd(path);
  const id = num(sub);
  const okId = id > 0;

  switch (view) {
    case 'new':
      return <ServiceDeskCreate />;
    case 't':
      return okId ? <TicketDetail id={id} agent={false} /> : <MissingRecord what="ticket" />;
    case 'tickets':
      if (sub === null) return <ServiceDeskTickets />;
      return okId ? <TicketDetail id={id} agent /> : <MissingRecord what="ticket" />;
    case 'workspace':
      return <ServiceDeskWorkspace />;
    case 'queues':
      return <ServiceDeskQueues />;
    case 'knowledge':
      return <ServiceDeskKnowledge id={okId ? id : null} />;
    case 'problems':
      return <ServiceDeskProblems id={okId ? id : null} />;
    case 'changes':
      if (sub === null) return <ServiceDeskChanges />;
      if (sub === 'new') return <ServiceDeskChanges create />;
      return okId ? <ServiceDeskChanges id={id} /> : <MissingRecord what="change" />;
    case 'access':
      return <ServiceDeskAccess />;
    case 'scan':
      return <ServiceDeskScan />;
    case 'reports':
      return <ServiceDeskReports />;
    case 'config':
      return <ServiceDeskConfig />;
    case 'dashboard':
      return <ServiceDeskDashboards />;
    case '':
    default:
      return <ServiceDeskPortal />;
  }
}
