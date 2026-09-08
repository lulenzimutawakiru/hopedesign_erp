import LiveBoard from './hikvision/live';
import DevicesView from './hikvision/devices';
import EventsView from './hikvision/events';
import ExceptionsCentre from './hikvision/exceptions';
import AttendanceHome from './hikvision/attendance';
import HealthBoard from './hikvision/health';
import SyncCentre from './hikvision/sync';
import ReportsView from './hikvision/reports';

function parseHk(path: string): { view: string; sub: string | null } {
  const parts = path.split('/').filter(Boolean);
  if (parts[0] !== 'hikvision') return { view: '', sub: null };
  return { view: parts[1] ?? '', sub: parts[2] ?? null };
}

export default function HikvisionFlow({ path }: { path: string }) {
  const { view, sub } = parseHk(path);
  switch (view) {
    case 'devices':
      return <DevicesView />;
    case 'events':
      return <EventsView key={sub === 'failed' ? 'failed' : 'all'} failed={sub === 'failed'} />;
    case 'exceptions':
      return <ExceptionsCentre />;
    case 'attendance':
      return <AttendanceHome />;
    case 'health':
      return <HealthBoard />;
    case 'sync':
      return <SyncCentre />;
    case 'reports':
      return <ReportsView />;
    case '':
    default:
      return <LiveBoard />;
  }
}
