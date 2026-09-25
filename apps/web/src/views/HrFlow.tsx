import RecruitmentFlow from './RecruitmentFlow';
import OnboardingFlow from './OnboardingFlow';
import WorkforcePlanning from './WorkforcePlanning';
import LeaveFlow from './LeaveFlow';
import ContractFlow from './ContractFlow';
import EmployeeIdentity from './EmployeeIdentity';
import HcmOps from './HcmOps';
import { PayrollCalendar, PayrollDesk, StatutoryCompliance } from './PayrollFlow';
import MyPayroll from './MyPayroll';
import { EmployeeList, EmployeeDesk } from './HrEmployees';
import { HcmBoard } from './HrHcmBoard';
import { EmployeeComposer, EmployeeEditor } from './HrEmployeeEditor';
import { OffCycleComposer, OffCycleDesk, OffCycleList } from './HrOffCycle';
import { FinalSettlementDesk, FinalSettlementList } from './HrFinalSettlement';
import { ArrearsComposer, ArrearsList } from './HrArrears';
import { OffboardingComposer, OffboardingDesk, OffboardingList } from './HrOffboarding';
import { PayrollCommandCentre, PayrollComposer, PayrollList } from './HrPayrollCentre';
import { AttendanceDesk, ExceptionsCentre, PeopleBoard } from './HrPeopleDesks';

/**
 * People (HR) flow router. Keeps only path dispatch and the thin LeaveFlow
 * wrapper; every desk it routes to now lives in its own view module.
 */
function parsePeople(path: string): { view: string; id: string | null; sub: string | null } {
  const parts = path.split('/').filter(Boolean);
  if (parts[0] !== 'people') return { view: 'board', id: null, sub: null };
  return { view: parts[1] ?? 'board', id: parts[2] ?? null, sub: parts[3] ?? null };
}

export default function HrFlow({ path }: { path: string }) {
  const { view, id, sub } = parsePeople(path);
  if (view === 'employees' && id === 'new') return <EmployeeComposer />;
  if (view === 'employees' && id && sub === 'edit') return <EmployeeEditor id={Number(id)} />;
  if (view === 'employees' && id) return <EmployeeDesk id={Number(id)} />;
  if (view === 'employees') return <EmployeeList />;
  if (view === 'employee-ids') return <EmployeeIdentity path={path} />;
  if (view === 'leave') return <LeaveDesk path={path} />;
  if (view === 'attendance') return <AttendanceDesk />;
  if (view === 'contracts') return <ContractFlow path={path} />;
  if (view === 'payroll-calendar') return <PayrollCalendar />;
  if (view === 'statutory-compliance') return <StatutoryCompliance />;
  if (view === 'my-payroll') return <MyPayroll />;
  if (view === 'payrolls' && id === 'new') return <PayrollComposer />;
  if (view === 'payrolls' && id === 'runs') return <PayrollList />;
  if (view === 'payrolls' && id) return <PayrollDesk id={Number(id)} />;
  if (view === 'payrolls') return <PayrollCommandCentre />;
  if (view === 'final-settlements' && id) return <FinalSettlementDesk id={Number(id)} />;
  if (view === 'final-settlements') return <FinalSettlementList />;
  if (view === 'off-cycle' && id === 'new') return <OffCycleComposer />;
  if (view === 'off-cycle' && id) return <OffCycleDesk id={Number(id)} />;
  if (view === 'off-cycle') return <OffCycleList />;
  if (view === 'arrears' && id === 'new') return <ArrearsComposer />;
  if (view === 'arrears') return <ArrearsList />;
  if (view === 'hcm') return <HcmBoard />;
  if (view === 'offboardings' && id === 'new') return <OffboardingComposer />;
  if (view === 'offboardings' && id) return <OffboardingDesk id={Number(id)} />;
  if (view === 'offboardings') return <OffboardingList />;
  if (view === 'exceptions') return <ExceptionsCentre />;
  if (view === 'requisitions' || view === 'vacancies' || view === 'recruitment' || view === 'candidates') return <RecruitmentFlow path={path} />;
  if (view === 'onboarding' || view === 'onboardings') return <OnboardingFlow path={path} />;
  if (view === 'org' || view === 'positions' || view === 'workforce' || view === 'workforce-plans' || view === 'scenarios') return <WorkforcePlanning path={path} />;
  if (['loans', 'advances', 'payments', 'performance', 'training', 'benefits', 'relations', 'time', 'me'].includes(view)) return <HcmOps path={path} />;
  return <PeopleBoard />;
}

function LeaveDesk({ path }: { path: string }) {
  return <LeaveFlow path={path} />;
}
