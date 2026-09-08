import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../../api';
import { useAuth, can } from '../../auth';
import { Pager, PageLoader, ErrorBanner } from '../../components/ui';
import {
  HikHead, HikTabs, Rec, toNum, toStr, pickS, pickN,
  statusPill, purposePill, fmtWhen, durLabel,
  empName, empNo, MiniAvatar,
  ATT_STATUS_TONE, APPROVAL_STATUS_TONE, EXCEPTION_STATUS_TONE, SEVERITY_TONE,
  EXCEPTION_TYPE_LABEL, RAW_STATUS_TONE, DEVICE_STATUS_TONE, DEVICE_STATUS_LABEL,
  exportCsv, exportXls, printReport,
} from './shared';
import { Field, Inp, Sel } from './fields';
import { isoToday, isoDaysAgo, monthRange } from './hkutil';

const ATT_MAX_PAGES = 250;
const EV_MAX_PAGES = 120;
const XP_MAX_PAGES = 120;
const DET_PAGE_SIZE = 50;
const REGISTER_CAP = 250;
const EMP_CAP = 300;
const FAILED_CAP = 200;
const EXC_CAP = 250;

const PRESET_OPTIONS = [
  { value: 'today', label: 'Today' },
  { value: '7d', label: 'Last 7 days' },
  { value: '30d', label: 'Last 30 days' },
  { value: 'mtd', label: 'Month to date' },
  { value: 'prevMonth', label: 'Previous month' },
];

const ATT_LABELS: Record<string, string> = {
  PRESENT: 'Present', LATE: 'Late', EARLY_DEPARTURE: 'Early departure', HALF_DAY: 'Half day',
  ABSENT: 'Absent', ON_LEAVE: 'On leave', HOLIDAY: 'Holiday', PENDING: 'Pending', EXCUSED: 'Excused',
};

const APPROVAL_LABELS: Record<string, string> = {
  DRAFT: 'Draft', SUBMITTED: 'Submitted', APPROVED: 'Approved', REJECTED: 'Rejected', ADJUSTED: 'Adjusted',
};

const EXC_STATUS_LABELS: Record<string, string> = {
  OPEN: 'Open', ASSIGNED: 'Assigned', REVIEWING: 'Reviewing',
  RESOLVED: 'Resolved', APPROVED: 'Approved', REJECTED: 'Rejected',
};

const SEVERITY_LABELS: Record<string, string> = {
  INFO: 'Info', WARN: 'Warning', ERROR: 'Error', CRITICAL: 'Critical',
};

const STATUS_LABELS: Record<string, string> = {
  RECEIVED: 'Received', QUEUED: 'Queued', PROCESSING: 'Processing', PROCESSED: 'Processed',
  DUPLICATE: 'Duplicate', FAILED: 'Failed', REJECTED: 'Rejected',
};

const DAILY_HEADERS = ['Date', 'Present', 'Late', 'Absent', 'On leave', 'Holiday', 'Worked', 'Overtime'];
const EMP_HEADERS = ['Employee', 'No', 'Department', 'Days', 'Present', 'Late', 'Absent', 'On leave', 'Holiday', 'Worked', 'Overtime'];
const DETAIL_HEADERS = ['Date', 'Employee', 'Department', 'Check in', 'Check out', 'Worked', 'Late minutes', 'Overtime', 'Status', 'Approval', 'Shift'];
const EVENT_HEADERS = ['Device', 'Total', 'Check in', 'Check out', 'Break', 'Access', 'Denied', 'Other'];
const FAILED_HEADERS = ['Received', 'Device', 'Employee', 'Type', 'Status', 'Attempts', 'Reason'];
const EXCEPTION_HEADERS = ['Type', 'Severity', 'Status', 'Employee', 'Event time', 'Summary', 'Device'];
const DEVICE_HEADERS = ['Device', 'Model', 'Serial', 'Purpose', 'Status', 'Clock drift', 'Last heartbeat', 'Last event', 'Events today', 'Open exceptions'];

type Rpt = {
  att: Rec[];
  attTotal: number;
  attTruncated: boolean;
  ev: Rec[];
  evTruncated: boolean;
  exc: Rec[];
  excTruncated: boolean;
  dev: Rec[];
  devTotal: number;
};

type AttKind = 'present' | 'late' | 'absent' | 'leave' | 'holiday' | 'excused' | 'pending' | 'other';

function isoOf(d: Date): string {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function monthStart(): string {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-01';
}

function prevYm(): string {
  const d = new Date();
  const y = d.getMonth() === 0 ? d.getFullYear() - 1 : d.getFullYear();
  const m = d.getMonth() === 0 ? 12 : d.getMonth();
  return y + '-' + String(m).padStart(2, '0');
}

function nextDay(iso: string): string {
  const d = new Date(iso + 'T00:00:00');
  if (Number.isNaN(d.getTime())) return iso;
  d.setDate(d.getDate() + 1);
  return isoOf(d);
}

function presetRange(preset: string): { from: string; to: string } {
  if (preset === 'today') return { from: isoToday(), to: isoToday() };
  if (preset === '7d') return { from: isoDaysAgo(6), to: isoToday() };
  if (preset === '30d') return { from: isoDaysAgo(29), to: isoToday() };
  if (preset === 'prevMonth') return monthRange(prevYm());
  return { from: monthStart(), to: isoToday() };
}

function clock(v: unknown): string {
  const raw = toStr(v);
  if (!raw) return '-';
  if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(raw)) return raw;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return raw;
  return d.toLocaleTimeString('en-UG', { hour: '2-digit', minute: '2-digit' });
}

function excLabel(raw: unknown): string {
  const s = toStr(raw);
  const up = s.toUpperCase();
  return EXCEPTION_TYPE_LABEL[up] ?? (s ? s.replace(/_/g, ' ') : '-');
}

function driftText(sec: unknown): string {
  const s = toNum(sec, 0);
  if (s === 0) return 'In sync';
  const a = Math.abs(s);
  const m = Math.floor(a / 60);
  const r = Math.round(a % 60);
  const txt = m > 0 ? m + 'm ' + r + 's' : r + 's';
  return s > 0 ? txt + ' behind' : txt + ' ahead';
}

function statusKind(r: Rec): AttKind {
  const s = toStr(r.attendanceStatus).toUpperCase();
  if (s === 'PRESENT' || s === 'EARLY_DEPARTURE' || s === 'HALF_DAY') return 'present';
  if (s === 'LATE') return 'late';
  if (s === 'ABSENT') return 'absent';
  if (s === 'ON_LEAVE') return 'leave';
  if (s === 'HOLIDAY') return 'holiday';
  if (s === 'EXCUSED') return 'excused';
  if (s === 'PENDING') return 'pending';
  return 'other';
}

async function fetchAll(path: string, maxPages: number): Promise<{ rows: Rec[]; total: number; truncated: boolean }> {
  const pageSize = 200;
  const rows: Rec[] = [];
  let total = 0;
  let truncated = false;
  for (let page = 1; page <= maxPages; page += 1) {
    const sep = path.indexOf('?') >= 0 ? '&' : '?';
    const r = await api<{ data: Rec }>(path + sep + 'page=' + page + '&pageSize=' + pageSize);
    const d = r.data ?? {};
    const items = (d.items ?? []) as Rec[];
    rows.push(...items);
    total = toNum(d.total);
    if (items.length === 0) break;
    if (total > 0 && rows.length >= total) break;
    if (page === maxPages) truncated = true;
  }
  return { rows, total: total > 0 ? total : rows.length, truncated };
}

function devRow(d: Rec): Rec {
  return {
    id: toStr(d.id),
    code: pickS(d, 'code', 'deviceCode', 'device_code'),
    name: pickS(d, 'name', 'deviceName', 'device_name'),
    model: pickS(d, 'model', 'modelNumber', 'model_number'),
    serialNumber: pickS(d, 'serialNumber', 'serial_number'),
    ipAddress: pickS(d, 'ipAddress', 'ip_address'),
    branchName: pickS(d, 'branchName', 'branch_name'),
    departmentName: pickS(d, 'departmentName', 'department_name'),
    devicePurpose: pickS(d, 'devicePurpose', 'device_purpose'),
    timezone: pickS(d, 'timezone', 'time_zone'),
    firmwareVersion: pickS(d, 'firmwareVersion', 'firmware_version'),
    connectionStatus: pickS(d, 'connectionStatus', 'connection_status'),
    lastHeartbeatAt: pickS(d, 'lastHeartbeatAt', 'last_heartbeat_at'),
    lastEventAt: pickS(d, 'lastEventAt', 'last_event_at'),
    lastClockDriftSeconds: pickN(d, 'lastClockDriftSeconds', 'last_clock_drift_seconds'),
    eventsToday: pickN(d, 'eventsToday', 'events_today'),
    exceptionsOpen: pickN(d, 'exceptionsOpen', 'exceptions_open'),
  };
}

function StatTile({ label, value, tone, sub }: { label: string; value: unknown; tone?: string; sub?: string }) {
  return (
    <div className="card card-pad" style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <span className="kpi-label">{label}</span>
      <span className="kpi-value" style={tone ? { color: tone } : undefined}>{toNum(value)}</span>
      {sub ? <span className="kpi-sub">{sub}</span> : null}
    </div>
  );
}
type DayAcc = {
  date: string; present: number; late: number; absent: number; leave: number; holiday: number;
  worked: number; overtime: number;
};

type EmpAcc = {
  key: string; name: string; no: string; dept: string;
  days: number; present: number; late: number; absent: number; leave: number; holiday: number;
  worked: number; overtime: number;
};

type DeptAcc = {
  dept: string; people: Set<string>; present: number; late: number; absent: number; leave: number; worked: number;
};

type EvAgg = {
  key: string; name: string; total: number; checkIn: number; checkOut: number; breaks: number;
  access: number; denied: number; other: number;
};

function evCode(raw: unknown): string {
  const up = toStr(raw).toUpperCase();
  if (up === 'CHECK_IN') return 'CHECK_IN';
  if (up === 'CHECK_OUT') return 'CHECK_OUT';
  if (up === 'BREAK_START' || up === 'BREAK_END') return 'BREAK';
  if (up === 'ACCESS_GRANTED') return 'ACCESS';
  if (up === 'ACCESS_DENIED') return 'DENIED';
  return 'OTHER';
}

function empOf(r: Rec): Rec | null {
  const v = r.employee;
  return v && typeof v === 'object' ? (v as Rec) : null;
}

function devOf(e: Rec): Rec | null {
  const v = e.device;
  return v && typeof v === 'object' ? (v as Rec) : null;
}

function normLabel(v: unknown): string {
  const s = toStr(v);
  return s ? s.replace(/_/g, ' ') : '-';
}

function evTypeLabel(v: unknown): string {
  const s = toStr(v);
  return s ? s.replace(/_/g, ' ') : '-';
}

export default function ReportsView() {
  const { user } = useAuth();
  const canEvents = can(user, 'hikvision.events.view');
  const canExceptions = can(user, 'hikvision.exceptions.view');
  const canHealth = can(user, 'hikvision.health.view');
  const canDevices = can(user, 'hikvision.devices.view');
  const canExport = can(user, 'hr.attendance.export');

  const [from, setFrom] = useState<string>(() => isoToday());
  const [to, setTo] = useState<string>(() => isoToday());
  const [preset, setPreset] = useState('today');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [rpt, setRpt] = useState<Rpt | null>(null);
  const [generatedAt, setGeneratedAt] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const att = await fetchAll('/api/attendance?dateFrom=' + from + '&dateTo=' + to, ATT_MAX_PAGES);
      let ev: { rows: Rec[]; total: number; truncated: boolean } = { rows: [], total: 0, truncated: false };
      if (canEvents) {
        ev = await fetchAll('/api/hikvision/events?dateFrom=' + from + '&dateTo=' + nextDay(to), EV_MAX_PAGES);
      }
      let exc: { rows: Rec[]; total: number; truncated: boolean } = { rows: [], total: 0, truncated: false };
      if (canExceptions) {
        exc = await fetchAll('/api/hikvision/exceptions?dateFrom=' + from + '&dateTo=' + nextDay(to), XP_MAX_PAGES);
      }
      let dev: Rec[] = [];
      let devTotal = 0;
      if (canHealth) {
        const r = await api<{ data: Rec }>('/api/hikvision/health');
        const arr = (((r.data ?? {}).devices ?? []) as Rec[]).map(devRow);
        dev = arr;
        devTotal = arr.length;
      } else if (canDevices) {
        const dd = await fetchAll('/api/hikvision/devices', 10);
        dev = dd.rows.map(devRow);
        devTotal = dd.total;
      }
      setRpt({
        att: att.rows,
        attTotal: att.total,
        attTruncated: att.truncated,
        ev: ev.rows,
        evTruncated: ev.truncated,
        exc: exc.rows,
        excTruncated: exc.truncated,
        dev,
        devTotal,
      });
      setGeneratedAt(new Date().toLocaleTimeString('en-UG', { hour: '2-digit', minute: '2-digit', second: '2-digit' }));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Reports failed to load');
    } finally {
      setLoading(false);
    }
  }, [from, to, canEvents, canExceptions, canHealth, canDevices]);

  useEffect(() => { void load(); }, [load]);

  const att = rpt?.att ?? [];
  const ev = rpt?.ev ?? [];
  const excRows = rpt?.exc ?? [];
  const dev = rpt?.dev ?? [];
  const attTotal = rpt?.attTotal ?? 0;
  const rangeLabel = from === to ? from : from + ' \u2192 ' + to;
  const ready = Boolean(from && to);

  const applyPreset = useCallback((p: string) => {
    setPreset(p);
    const rg = presetRange(p);
    setFrom(rg.from);
    setTo(rg.to);
    setPage(1);
  }, []);

  const resetRange = useCallback(() => {
    setPreset('today');
    setFrom(isoToday());
    setTo(isoToday());
    setQ('');
    setPage(1);
  }, []);

  const days = useMemo<DayAcc[]>(() => {
    const map = new Map<string, DayAcc>();
    for (const r of att) {
      const wd = toStr(r.workDate);
      if (!wd) continue;
      let acc = map.get(wd);
      if (!acc) {
        acc = { date: wd, present: 0, late: 0, absent: 0, leave: 0, holiday: 0, worked: 0, overtime: 0 };
        map.set(wd, acc);
      }
      const kind = statusKind(r);
      if (kind === 'present') acc.present += 1;
      else if (kind === 'late') acc.late += 1;
      else if (kind === 'absent') acc.absent += 1;
      else if (kind === 'leave') acc.leave += 1;
      else if (kind === 'holiday') acc.holiday += 1;
      acc.worked += toNum(r.workedMinutes);
      acc.overtime += toNum(r.overtimeMinutes);
    }
    return Array.from(map.values()).sort((a, b) => (a.date < b.date ? -1 : 1));
  }, [att]);

  const emps = useMemo<EmpAcc[]>(() => {
    const map = new Map<string, EmpAcc>();
    for (const r of att) {
      const emp = empOf(r);
      const name = empName(emp);
      const no = empNo(emp);
      const id = toStr(emp && 'id' in emp ? emp.id : '');
      const key = id || no || name;
      let acc = map.get(key);
      if (!acc) {
        acc = { key, name, no, dept: toStr(r.departmentName), days: 0, present: 0, late: 0, absent: 0, leave: 0, holiday: 0, worked: 0, overtime: 0 };
        map.set(key, acc);
      }
      acc.days += 1;
      const kind = statusKind(r);
      if (kind === 'present') acc.present += 1;
      else if (kind === 'late') acc.late += 1;
      else if (kind === 'absent') acc.absent += 1;
      else if (kind === 'leave') acc.leave += 1;
      else if (kind === 'holiday') acc.holiday += 1;
      acc.worked += toNum(r.workedMinutes);
      acc.overtime += toNum(r.overtimeMinutes);
    }
    return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name)).slice(0, EMP_CAP);
  }, [att]);

  const depts = useMemo<DeptAcc[]>(() => {
    const map = new Map<string, DeptAcc>();
    for (const r of att) {
      const emp = empOf(r);
      const dept = toStr(r.departmentName) || 'Unassigned';
      let acc = map.get(dept);
      if (!acc) {
        acc = { dept, people: new Set<string>(), present: 0, late: 0, absent: 0, leave: 0, worked: 0 };
        map.set(dept, acc);
      }
      acc.people.add(empNo(emp) || empName(emp) || toStr(r.workDate));
      const kind = statusKind(r);
      if (kind === 'present') acc.present += 1;
      else if (kind === 'late') acc.late += 1;
      else if (kind === 'absent') acc.absent += 1;
      else if (kind === 'leave') acc.leave += 1;
      acc.worked += toNum(r.workedMinutes);
    }
    return Array.from(map.values()).sort((a, b) => a.dept.localeCompare(b.dept));
  }, [att]);

  const detailRows = useMemo<Rec[]>(() => {
    const t = q.trim().toLowerCase();
    const rows = att.filter((r) => {
      if (!t) return true;
      const emp = empOf(r);
      const hay = [empName(emp), empNo(emp), toStr(r.departmentName), toStr(r.workDate), toStr(r.shiftCode)]
        .join(' ').toLowerCase();
      return hay.indexOf(t) >= 0;
    });
    return rows.slice().sort((a, b) => (toStr(a.workDate) < toStr(b.workDate) ? -1 : 1));
  }, [att, q]);

  const pageCount = Math.max(1, Math.ceil(detailRows.length / DET_PAGE_SIZE));
  const safePage = Math.min(Math.max(page, 1), pageCount);
  const detPage = detailRows.slice((safePage - 1) * DET_PAGE_SIZE, safePage * DET_PAGE_SIZE);

  const registerRows = useMemo<Rec[]>(() => {
    const out: Rec[] = [];
    for (const r of att) {
      const k = statusKind(r);
      if (k === 'late' || k === 'absent') {
        out.push(r);
        if (out.length >= REGISTER_CAP) break;
      }
    }
    return out;
  }, [att]);

  const failedRows = useMemo<Rec[]>(
    () => ev.filter((e) => toStr(e.processingStatus).toUpperCase() === 'FAILED').slice(0, FAILED_CAP),
    [ev]
  );
  const excCap = useMemo<Rec[]>(() => excRows.slice(0, EXC_CAP), [excRows]);

  const evAgg = useMemo<EvAgg[]>(() => {
    const map = new Map<string, EvAgg>();
    for (const e of ev) {
      const devO = devOf(e);
      const name = pickS(devO, 'name') || pickS(e, 'deviceSerialNumber', 'device_serial_number') || 'Unknown terminal';
      let acc = map.get(name);
      if (!acc) {
        acc = { key: name, name, total: 0, checkIn: 0, checkOut: 0, breaks: 0, access: 0, denied: 0, other: 0 };
        map.set(name, acc);
      }
      acc.total += 1;
      const c = evCode(e.normalizedType || e.eventType);
      if (c === 'CHECK_IN') acc.checkIn += 1;
      else if (c === 'CHECK_OUT') acc.checkOut += 1;
      else if (c === 'BREAK') acc.breaks += 1;
      else if (c === 'ACCESS') acc.access += 1;
      else if (c === 'DENIED') acc.denied += 1;
      else acc.other += 1;
    }
    return Array.from(map.values()).sort((a, b) => b.total - a.total);
  }, [ev]);

  const counts = useMemo(() => {
    let present = 0; let late = 0; let absent = 0; let leave = 0; let holiday = 0;
    for (const r of att) {
      const k = statusKind(r);
      if (k === 'present') present += 1;
      else if (k === 'late') late += 1;
      else if (k === 'absent') absent += 1;
      else if (k === 'leave') leave += 1;
      else if (k === 'holiday') holiday += 1;
    }
    return { present, late, absent, leave, holiday };
  }, [att]);

  const totalWorked = days.reduce((n, d) => n + d.worked, 0);
  const totalOvertime = days.reduce((n, d) => n + d.overtime, 0);
  const openExceptions = excRows.filter((x) => ['OPEN', 'ASSIGNED', 'REVIEWING'].indexOf(toStr(x.status).toUpperCase()) >= 0).length;
  const processedEv = ev.filter((e) => toStr(e.processingStatus).toUpperCase() === 'PROCESSED').length;
  const duplicateEv = ev.filter((e) => toStr(e.processingStatus).toUpperCase() === 'DUPLICATE').length;
  const failedEv = ev.filter((e) => toStr(e.processingStatus).toUpperCase() === 'FAILED').length;
  const devOnline = dev.filter((d) => toStr(d.connectionStatus).toUpperCase() === 'ONLINE').length;
  const devOffline = dev.filter((d) => toStr(d.connectionStatus).toUpperCase() === 'OFFLINE').length;
  const devWarn = dev.filter((d) => toStr(d.connectionStatus).toUpperCase() === 'WARNING').length;

  const statusText = (r: Rec): string =>
    ATT_LABELS[toStr(r.attendanceStatus).toUpperCase()] ?? normLabel(r.attendanceStatus);

  const buildDailyRows = (): unknown[][] =>
    days.map((d) => [d.date, d.present, d.late, d.absent, d.leave, d.holiday, durLabel(d.worked), durLabel(d.overtime)]);

  const buildEmpRows = (): unknown[][] =>
    emps.map((e) => [e.name, e.no, e.dept, e.days, e.present, e.late, e.absent, e.leave, e.holiday, durLabel(e.worked), durLabel(e.overtime)]);

  const buildDetRows = (): unknown[][] =>
    detailRows.map((r) => {
      const emp = empOf(r);
      const appr = APPROVAL_LABELS[toStr(r.approvalStatus).toUpperCase()] ?? normLabel(r.approvalStatus);
      return [
        toStr(r.workDate), empName(emp), toStr(r.departmentName), clock(r.checkIn), clock(r.checkOut),
        durLabel(r.workedMinutes), toNum(r.lateMinutes), toNum(r.overtimeMinutes),
        statusText(r), appr, toStr(r.shiftCode) || '-',
      ];
    });

  const buildRegRows = (): unknown[][] =>
    registerRows.map((r) => {
      const emp = empOf(r);
      return [empName(emp), empNo(emp), toStr(r.departmentName), toStr(r.workDate), statusText(r), toNum(r.lateMinutes), durLabel(r.workedMinutes)];
    });

  const buildEventRows = (): unknown[][] =>
    evAgg.map((a) => [a.name, a.total, a.checkIn, a.checkOut, a.breaks, a.access, a.denied, a.other]);

  const buildFailedRows = (): unknown[][] =>
    failedRows.map((e) => {
      const devO = devOf(e);
      const emp = empOf(e);
      return [
        fmtWhen(e.receivedAt), pickS(devO, 'name') || pickS(e, 'deviceSerialNumber') || 'Terminal',
        emp ? empName(emp) + (empNo(emp) ? ' (' + empNo(emp) + ')' : '') : pickS(e, 'employeeIdentifier') || '-',
        evTypeLabel(e.normalizedType || e.eventType),
        toStr(e.processingStatus), toNum(e.retryCount), toStr(e.lastError),
      ];
    });

  const buildExcRows = (): unknown[][] =>
    excCap.map((x) => {
      const emp = empOf(x);
      const devO = devOf(x);
      return [
        excLabel(x.exceptionType),
        SEVERITY_LABELS[toStr(x.severity).toUpperCase()] ?? normLabel(x.severity),
        EXC_STATUS_LABELS[toStr(x.status).toUpperCase()] ?? normLabel(x.status),
        emp ? empName(emp) + (empNo(emp) ? ' (' + empNo(emp) + ')' : '') : pickS(x, 'employeeIdentifier') || '-',
        fmtWhen(x.eventTime || x.createdAt),
        toStr(x.summary) || excLabel(x.exceptionType),
        pickS(devO, 'name') || 'Terminal',
      ];
    });

  const buildDevRows = (): unknown[][] =>
    dev.map((d) => [
      pickS(d, 'name') || pickS(d, 'code'), pickS(d, 'model'), pickS(d, 'serialNumber'),
      normLabel(pickS(d, 'devicePurpose')), toStr(d.connectionStatus),
      driftText(pickN(d, 'lastClockDriftSeconds')), fmtWhen(d.lastHeartbeatAt), fmtWhen(d.lastEventAt),
      toNum(d.eventsToday), toNum(d.exceptionsOpen),
    ]);

  const exportFile = (kind: string): string => kind + '_' + from + '_' + to + '.csv';

  const hdr = (headers: string[]): JSX.Element => (
    <tr>{headers.map((h) => <th key={h}>{h}</th>)}</tr>
  );

  const EmpCell = ({ r }: { r: Rec }) => {
    const emp = empOf(r);
    return (
      <div className="emp-cell">
        <MiniAvatar name={empName(emp)} />
        <div>
          <strong>{empName(emp)}</strong>
          <span className="muted">{empNo(emp)}{r.departmentName ? ' \u00B7 ' + toStr(r.departmentName) : ''}</span>
        </div>
      </div>
    );
  };

  return (    <div className="page">
      <HikHead
        title="Attendance & Device Reports"
        subtitle="Daily attendance, registers, event volume and device activity across the Hikvision estate."
        actions={
          <span className="muted">Generated {generatedAt || '\u2014'} {'\u2022'} {rangeLabel}</span>
        }
      />
      <HikTabs active="reports" />
      {error ? <ErrorBanner error={error} /> : null}

      <div className="hk-toolbar">
        <Field label="Preset">
          <Sel value={preset} onChange={applyPreset} options={PRESET_OPTIONS} />
        </Field>
        <Field label="From">
          <Inp type="date" value={from} onChange={(v) => { setFrom(v); setPage(1); }} />
        </Field>
        <Field label="To">
          <Inp type="date" value={to} onChange={(v) => { setTo(v); setPage(1); }} />
        </Field>
        <button type="button" className="btn btn-sm" disabled={!ready || loading} onClick={() => void load()}>Apply</button>
        <button type="button" className="btn btn-sm btn-ghost" onClick={resetRange}>Reset</button>
        <span style={{ flex: 1 }} />
        <span className="muted">{attTotal} attendance record{attTotal === 1 ? '' : 's'}</span>
      </div>

      {loading && !rpt ? <PageLoader label="Loading reports..." /> : null}
      {!rpt ? null : (
        <>
          <section className="card card-pad" style={{ marginTop: 14 }}>
            <div className="card-head">
              <h3>Attendance overview</h3>
              <span className="muted">{rangeLabel}</span>
            </div>
            <div className="kpi-grid hk-kpi-6">
              <StatTile label="Records" value={attTotal} tone="var(--ok)" sub="In selected range" />
              <StatTile label="Present" value={counts.present} tone="var(--ok)" sub="Incl. early / half day" />
              <StatTile label="Late" value={counts.late} tone="var(--warn)" sub="Late arrivals" />
              <StatTile label="Absent" value={counts.absent} tone="var(--danger)" sub="No attendance" />
              <StatTile label="On leave" value={counts.leave} tone="var(--brand)" sub="Approved leave" />
              <StatTile label="Holiday" value={counts.holiday} sub="Public holiday" />
              <StatTile label="Worked minutes" value={totalWorked} tone="var(--ok)" sub={durLabel(totalWorked)} />
              <StatTile label="Overtime minutes" value={totalOvertime} tone="var(--brand)" sub={durLabel(totalOvertime)} />
            </div>
          </section>

          <section className="card card-pad" style={{ marginTop: 14 }}>
            <div className="card-head">
              <h3>Daily attendance summary</h3>
              <div className="head-actions">
                {canExport ? (
                  <>
                    <button type="button" className="btn btn-sm" onClick={() => exportCsv(exportFile('daily_summary'), DAILY_HEADERS, buildDailyRows())}>CSV</button>
                    <button type="button" className="btn btn-sm" onClick={() => exportXls('daily_summary_' + from + '_' + to + '.xls', 'Daily attendance summary', DAILY_HEADERS, buildDailyRows())}>Excel</button>
                    <button type="button" className="btn btn-sm btn-ghost" onClick={() => printReport('Daily attendance summary', rangeLabel, DAILY_HEADERS, buildDailyRows())}>Print</button>
                  </>
                ) : null}
              </div>
            </div>
            {days.length === 0 ? (
              <div className="empty-state"><h3>No daily summaries</h3><p>No attendance records exist for {rangeLabel}. Adjust the date range and apply again.</p></div>
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead>{hdr(DAILY_HEADERS)}</thead>
                  <tbody>
                    {days.map((d) => (
                      <tr key={d.date}>
                        <td>{d.date}</td>
                        <td>{d.present}</td>
                        <td>{d.late > 0 ? <span className="badge badge-amber">{d.late}</span> : <span className="muted">0</span>}</td>
                        <td>{d.absent > 0 ? <span className="badge badge-red">{d.absent}</span> : <span className="muted">0</span>}</td>
                        <td>{d.leave}</td>
                        <td>{d.holiday}</td>
                        <td>{durLabel(d.worked)}</td>
                        <td>{d.overtime > 0 ? durLabel(d.overtime) : <span className="muted">-</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>          <section className="card card-pad" style={{ marginTop: 14 }}>
            <div className="card-head">
              <h3>Employee attendance summary</h3>
              <div className="head-actions">
                {canExport ? (
                  <>
                    <button type="button" className="btn btn-sm" onClick={() => exportCsv(exportFile('employee_summary'), EMP_HEADERS, buildEmpRows())}>CSV</button>
                    <button type="button" className="btn btn-sm" onClick={() => exportXls('employee_summary_' + from + '_' + to + '.xls', 'Employee attendance summary', EMP_HEADERS, buildEmpRows())}>Excel</button>
                  </>
                ) : null}
              </div>
            </div>
            {emps.length === 0 ? (
              <div className="empty-state"><h3>No employee summaries</h3><p>Employees only appear once attendance records exist in the selected range.</p></div>
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead>{hdr(EMP_HEADERS)}</thead>
                  <tbody>
                    {emps.map((e) => (
                      <tr key={e.key}>
                        <td>
                          <div className="emp-cell">
                            <MiniAvatar name={e.name} />
                            <div><strong>{e.name}</strong>{e.no ? <span className="muted">{e.no}</span> : null}</div>
                          </div>
                        </td>
                        <td>{e.no || <span className="muted">-</span>}</td>
                        <td>{e.dept || <span className="muted">-</span>}</td>
                        <td>{e.days}</td>
                        <td>{e.present}</td>
                        <td>{e.late > 0 ? <span className="badge badge-amber">{e.late}</span> : <span className="muted">0</span>}</td>
                        <td>{e.absent > 0 ? <span className="badge badge-red">{e.absent}</span> : <span className="muted">0</span>}</td>
                        <td>{e.leave}</td>
                        <td>{e.holiday}</td>
                        <td>{durLabel(e.worked)}</td>
                        <td>{e.overtime > 0 ? durLabel(e.overtime) : <span className="muted">-</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {emps.length >= EMP_CAP ? <p className="muted" style={{ marginTop: 8 }}>Showing the first {EMP_CAP} employees. Narrow the date range for a full breakdown.</p> : null}
          </section>

          <section className="card card-pad" style={{ marginTop: 14 }}>
            <div className="card-head">
              <h3>Department attendance</h3>
              <div className="head-actions">
                {canExport ? (
                  <button type="button" className="btn btn-sm" onClick={() => exportCsv(exportFile('department_summary'), ['Department', 'Employees', 'Present', 'Late', 'Absent', 'On leave', 'Worked'], depts.map((d) => [d.dept, d.people.size, d.present, d.late, d.absent, d.leave, durLabel(d.worked)]))}>CSV</button>
                ) : null}
              </div>
            </div>
            {depts.length === 0 ? (
              <div className="empty-state"><h3>No department data</h3><p>Department totals are derived from attendance records in the selected range.</p></div>
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead>{hdr(['Department', 'Employees', 'Present', 'Late', 'Absent', 'On leave', 'Worked'])}</thead>
                  <tbody>
                    {depts.map((d) => (
                      <tr key={d.dept}>
                        <td><strong>{d.dept}</strong></td>
                        <td>{d.people.size}</td>
                        <td>{d.present}</td>
                        <td>{d.late > 0 ? <span className="badge badge-amber">{d.late}</span> : <span className="muted">0</span>}</td>
                        <td>{d.absent > 0 ? <span className="badge badge-red">{d.absent}</span> : <span className="muted">0</span>}</td>
                        <td>{d.leave}</td>
                        <td>{durLabel(d.worked)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="card card-pad" style={{ marginTop: 14 }}>
            <div className="card-head">
              <h3>Late arrival & absenteeism register</h3>
              <div className="head-actions">
                {canExport && registerRows.length > 0 ? (
                  <button type="button" className="btn btn-sm" onClick={() => exportCsv(exportFile('late_absence_register'), ['Employee', 'No', 'Date', 'Status', 'Department', 'Late minutes', 'Worked'], buildRegRows())}>CSV</button>
                ) : null}
              </div>
            </div>
            {registerRows.length === 0 ? (
              <div className="empty-state"><h3>No late arrivals or absences</h3><p>Everyone in the selected range attended on time.</p></div>
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead>{hdr(['Employee', 'No', 'Date', 'Status', 'Department', 'Late minutes', 'Worked'])}</thead>
                  <tbody>
                    {registerRows.map((r) => {
                      const emp = empOf(r);
                      return (
                        <tr key={toStr(r.id) + '|' + toStr(r.workDate)}>
                          <td>
                            <div className="emp-cell">
                              <MiniAvatar name={empName(emp)} />
                              <div><strong>{empName(emp)}</strong><span className="muted">{empNo(emp)}</span></div>
                            </div>
                          </td>
                          <td>{empNo(emp) || <span className="muted">-</span>}</td>
                          <td>{toStr(r.workDate)}</td>
                          <td>{statusPill(r.attendanceStatus, ATT_STATUS_TONE, ATT_LABELS)}</td>
                          <td>{toStr(r.departmentName) || <span className="muted">-</span>}</td>
                          <td>{toNum(r.lateMinutes) > 0 ? <span className="badge badge-amber">{toNum(r.lateMinutes)}m</span> : <span className="muted">-</span>}</td>
                          <td>{durLabel(r.workedMinutes)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            {registerRows.length >= REGISTER_CAP ? <p className="muted" style={{ marginTop: 8 }}>Register capped at {REGISTER_CAP} rows. Narrow the date range for the complete list.</p> : null}
          </section>

          <section className="card card-pad" style={{ marginTop: 14 }}>
            <div className="card-head">
              <h3>Attendance detail register</h3>
              <div className="head-actions">
                <Field label="Search">
                  <Inp value={q} onChange={(v) => { setQ(v); setPage(1); }} placeholder="Employee, department, date..." />
                </Field>
                {canExport ? (
                  <button type="button" className="btn btn-sm" onClick={() => exportCsv(exportFile('attendance_detail'), DETAIL_HEADERS, buildDetRows())}>CSV</button>
                ) : null}
              </div>
            </div>
            {detailRows.length === 0 ? (
              <div className="empty-state"><h3>No attendance detail</h3><p>No records matched {q ? 'the search for "' + q + '"' : 'the selected range'}.</p></div>
            ) : (
              <>
                <div className="table-wrap" style={{ marginTop: 14 }}>
                  <table className="table">
                    <thead>{hdr(DETAIL_HEADERS)}</thead>
                    <tbody>
                      {detPage.map((r) => (
                        <tr key={toStr(r.id) + '|' + toStr(r.workDate)}>
                          <td>{toStr(r.workDate)}</td>
                          <td><EmpCell r={r} /></td>
                          <td>{toStr(r.departmentName) || <span className="muted">-</span>}</td>
                          <td>{clock(r.checkIn)}</td>
                          <td>{clock(r.checkOut)}</td>
                          <td>{durLabel(r.workedMinutes)}</td>
                          <td>{toNum(r.lateMinutes) > 0 ? <span className="badge badge-amber">{toNum(r.lateMinutes)}m</span> : <span className="muted">-</span>}</td>
                          <td>{toNum(r.overtimeMinutes) > 0 ? <span className="badge badge-green">{toNum(r.overtimeMinutes)}m</span> : <span className="muted">-</span>}</td>
                          <td>{statusPill(r.attendanceStatus, ATT_STATUS_TONE, ATT_LABELS)}</td>
                          <td>{statusPill(r.approvalStatus, APPROVAL_STATUS_TONE, APPROVAL_LABELS)}</td>
                          <td><span className="muted">{toStr(r.shiftCode) || '-'}</span></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <Pager page={safePage} pageSize={DET_PAGE_SIZE} total={detailRows.length} onPage={setPage} />
              </>
            )}
          </section>          {canEvents ? (
            <section className="card card-pad" style={{ marginTop: 14 }}>
              <div className="card-head">
                <h3>Event volume by device</h3>
                <div className="head-actions">
                  {canExport ? (
                    <button type="button" className="btn btn-sm" onClick={() => exportCsv(exportFile('event_volume'), EVENT_HEADERS, buildEventRows())}>CSV</button>
                  ) : null}
                </div>
              </div>
              <div className="kpi-grid hk-kpi-6" style={{ marginBottom: 14 }}>
                <StatTile label="Events in range" value={ev.length} tone="var(--ok)" sub="Normalized events" />
                <StatTile label="Processed" value={processedEv} tone="var(--ok)" sub="Into attendance" />
                <StatTile label="Duplicates" value={duplicateEv} tone="var(--warn)" sub="Preserved, marked" />
                <StatTile label="Failed" value={failedEv} tone="var(--danger)" sub="Require review" />
              </div>
              {evAgg.length === 0 ? (
                <div className="empty-state"><h3>No event volume</h3><p>No normalized events were returned for the selected range.</p></div>
              ) : (
                <div className="table-wrap">
                  <table className="table">
                    <thead>{hdr(EVENT_HEADERS)}</thead>
                    <tbody>
                      {evAgg.map((a) => (
                        <tr key={a.key}>
                          <td><strong>{a.name}</strong></td>
                          <td>{a.total}</td>
                          <td>{a.checkIn}</td>
                          <td>{a.checkOut}</td>
                          <td>{a.breaks}</td>
                          <td>{a.access}</td>
                          <td>{a.denied > 0 ? <span className="badge badge-red">{a.denied}</span> : <span className="muted">0</span>}</td>
                          <td>{a.other}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          ) : null}

          {canEvents ? (
            <section className="card card-pad" style={{ marginTop: 14 }}>
              <div className="card-head">
                <h3>Failed events register</h3>
                <div className="head-actions">
                  {canExport && failedRows.length > 0 ? (
                    <button type="button" className="btn btn-sm" onClick={() => exportCsv(exportFile('failed_events'), FAILED_HEADERS, buildFailedRows())}>CSV</button>
                  ) : null}
                </div>
              </div>
              {failedRows.length === 0 ? (
                <div className="empty-state"><h3>No failed events</h3><p>No events failed processing in the selected range. Failures land on the Failed Events tab for retry or reprocess.</p></div>
              ) : (
                <div className="table-wrap">
                  <table className="table">
                    <thead>{hdr(FAILED_HEADERS)}</thead>
                    <tbody>
                      {failedRows.map((e) => {
                        const id = toStr(e.id);
                        const devO = devOf(e);
                        const emp = empOf(e);
                        return (
                          <tr key={id}>
                            <td><span className="muted">{fmtWhen(e.receivedAt)}</span></td>
                            <td>{pickS(devO, 'name') || pickS(e, 'deviceSerialNumber') || 'Terminal'}</td>
                            <td>{emp ? <span>{empName(emp)}<span className="muted"> ({empNo(emp) || 'no no.'})</span></span> : <span className="muted">{pickS(e, 'employeeIdentifier') || '-'}</span>}</td>
                            <td>{evTypeLabel(e.normalizedType || e.eventType)}</td>
                            <td>{statusPill(e.processingStatus, RAW_STATUS_TONE, STATUS_LABELS)}</td>
                            <td>{toNum(e.retryCount)}x</td>
                            <td style={{ maxWidth: 260 }}>{toStr(e.lastError) ? <span className="muted" title={toStr(e.lastError)}>{toStr(e.lastError).slice(0, 60)}</span> : <span className="muted">-</span>}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
              {failedRows.length >= FAILED_CAP ? <p className="muted" style={{ marginTop: 8 }}>Register capped at {FAILED_CAP} rows. Review the Failed Events tab for the full queue.</p> : null}
            </section>
          ) : null}

          {canExceptions ? (
            <section className="card card-pad" style={{ marginTop: 14 }}>
              <div className="card-head">
                <h3>Attendance exception register</h3>
                <div className="head-actions">
                  <span className="muted">{openExceptions} open</span>
                  {canExport && excCap.length > 0 ? (
                    <button type="button" className="btn btn-sm" onClick={() => exportCsv(exportFile('exceptions'), EXCEPTION_HEADERS, buildExcRows())}>CSV</button>
                  ) : null}
                </div>
              </div>
              {excCap.length === 0 ? (
                <div className="empty-state"><h3>No exceptions</h3><p>No attendance exceptions were raised in the selected range.</p></div>
              ) : (
                <div className="table-wrap">
                  <table className="table">
                    <thead>{hdr(EXCEPTION_HEADERS)}</thead>
                    <tbody>
                      {excCap.map((x) => {
                        const id = toStr(x.id);
                        const emp = empOf(x);
                        const devO = devOf(x);
                        return (
                          <tr key={id}>
                            <td><span className="badge badge-neutral">{excLabel(x.exceptionType)}</span></td>
                            <td>{statusPill(x.severity, SEVERITY_TONE, SEVERITY_LABELS)}</td>
                            <td>{statusPill(x.status, EXCEPTION_STATUS_TONE, EXC_STATUS_LABELS)}</td>
                            <td>{emp ? <span>{empName(emp)}<span className="muted"> ({empNo(emp) || 'no no.'})</span></span> : <span className="muted">{pickS(x, 'employeeIdentifier') || '-'}</span>}</td>
                            <td><span className="muted">{fmtWhen(x.eventTime || x.createdAt)}</span></td>
                            <td style={{ maxWidth: 300 }}>{toStr(x.summary) || excLabel(x.exceptionType)}</td>
                            <td>{pickS(devO, 'name') || 'Terminal'}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
              {excCap.length >= EXC_CAP ? <p className="muted" style={{ marginTop: 8 }}>Register capped at {EXC_CAP} rows. Use the Exceptions centre for the full worklist.</p> : null}
            </section>
          ) : null}

          {dev.length > 0 ? (
            <section className="card card-pad" style={{ marginTop: 14 }}>
              <div className="card-head">
                <h3>Device activity report</h3>
                <div className="head-actions">
                  <span className="muted">{devOnline} online {'\u2022'} {devOffline} offline {'\u2022'} {devWarn} warning</span>
                  {canExport ? (
                    <button type="button" className="btn btn-sm" onClick={() => exportCsv(exportFile('device_activity'), DEVICE_HEADERS, buildDevRows())}>CSV</button>
                  ) : null}
                </div>
              </div>
              <div className="table-wrap">
                <table className="table">
                  <thead>{hdr(DEVICE_HEADERS)}</thead>
                  <tbody>
                    {dev.map((d) => (
                      <tr key={toStr(d.id) || toStr(d.serialNumber)}>
                        <td>
                          <strong>{pickS(d, 'name') || pickS(d, 'code')}</strong>
                          {pickS(d, 'ipAddress') ? <div className="muted" style={{ fontSize: 11.5 }}>{pickS(d, 'ipAddress')}</div> : null}
                        </td>
                        <td>{pickS(d, 'model') || <span className="muted">-</span>}</td>
                        <td><span className="muted" style={{ fontFamily: 'var(--mono)', fontSize: 11.5 }}>{pickS(d, 'serialNumber') || '-'}</span></td>
                        <td>{purposePill(pickS(d, 'devicePurpose'))}</td>
                        <td>{statusPill(pickS(d, 'connectionStatus'), DEVICE_STATUS_TONE, DEVICE_STATUS_LABEL)}</td>
                        <td>{driftText(pickN(d, 'lastClockDriftSeconds'))}</td>
                        <td><span className="muted">{fmtWhen(d.lastHeartbeatAt)}</span></td>
                        <td><span className="muted">{fmtWhen(d.lastEventAt)}</span></td>
                        <td>{toNum(d.eventsToday)}</td>
                        <td>{toNum(d.exceptionsOpen) > 0 ? <span className="badge badge-amber">{toNum(d.exceptionsOpen)}</span> : <span className="muted">0</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          ) : null}

          {rpt.attTruncated || rpt.evTruncated || rpt.excTruncated ? (
            <div className="notice-banner" style={{ marginTop: 14 }}>
              Some datasets exceed the report fetch limit{'\u00A0'}{'\u2014'} counts are based on the loaded window. Narrow the date range for a complete register.
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}