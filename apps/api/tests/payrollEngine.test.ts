import { describe, it, expect } from 'vitest';
import {
  toIsoDate,
  overlapCalendarDays,
  prorateEmployment,
  prorateBasic,
  resolveComponentAmount,
  emptyVariablePay,
} from '../src/services/payrollEngine.js';

describe('payroll engine: date helpers', () => {
  it('normalizes dates to ISO strings', () => {
    expect(toIsoDate(null)).toBeNull();
    expect(toIsoDate(undefined)).toBeNull();
    expect(toIsoDate('')).toBeNull();
    expect(toIsoDate('2027-09-15T00:00:00Z')).toBe('2027-09-15');
    expect(toIsoDate('2027-09-15 12:30:00')).toBe('2027-09-15');
    expect(toIsoDate(new Date('2027-09-15T12:00:00Z'))).toBe('2027-09-15');
    expect(toIsoDate('not-a-date')).toBeNull();
    expect(toIsoDate('2027-9-5')).toBeNull();
  });

  it('counts inclusive calendar-day overlaps', () => {
    expect(overlapCalendarDays('2027-09-01', '2027-09-30', '2027-09-01', '2027-09-30')).toBe(30);
    expect(overlapCalendarDays('2027-09-01', '2027-09-20', '2027-09-10', '2027-09-30')).toBe(11);
    expect(overlapCalendarDays('2027-09-01', '2027-09-30', '2027-09-15', '2027-09-20')).toBe(6);
    expect(overlapCalendarDays('2027-08-01', '2027-08-31', '2027-09-01', '2027-09-30')).toBe(0);
    expect(overlapCalendarDays('2027-09-01', '2027-09-15', '2027-09-16', '2027-09-30')).toBe(0);
    expect(overlapCalendarDays('2027-09-20', '2027-09-10', '2027-09-01', '2027-09-30')).toBe(0);
  });
});

describe('payroll engine: employment proration', () => {
  it('pays the full period when no hire or termination bounds apply', () => {
    const pr = prorateEmployment(null, null, '2027-09-01', '2027-09-30');
    expect(pr).toEqual({ periodDays: 30, workDays: 30, unpaidDays: 0, payableDays: 30, factor: 1 });
  });

  it('prorates a mid-period hire from the hire date', () => {
    const pr = prorateEmployment('2027-09-10', null, '2027-09-01', '2027-09-30');
    expect(pr.workDays).toBe(21);
    expect(pr.payableDays).toBe(21);
    expect(pr.factor).toBeCloseTo(0.7);
  });

  it('prorates a termination to the termination date', () => {
    const pr = prorateEmployment(null, '2027-09-15', '2027-09-01', '2027-09-30');
    expect(pr.workDays).toBe(15);
    expect(pr.payableDays).toBe(15);
    expect(pr.factor).toBeCloseTo(0.5);
  });

  it('bounds the employment window by both hire and termination', () => {
    const pr = prorateEmployment('2027-09-05', '2027-09-20', '2027-09-01', '2027-09-30');
    expect(pr.workDays).toBe(16);
    expect(pr.payableDays).toBe(16);
  });

  it('ignores hire dates before the period and terminations after it', () => {
    const pr = prorateEmployment('2027-08-01', '2027-12-31', '2027-09-01', '2027-09-30');
    expect(pr.workDays).toBe(30);
    expect(pr.factor).toBe(1);
  });

  it('caps unpaid leave at the work days actually in period', () => {
    const capped = prorateEmployment(null, null, '2027-09-01', '2027-09-30', 40);
    expect(capped.unpaidDays).toBe(30);
    expect(capped.payableDays).toBe(0);
    expect(capped.factor).toBe(0);
    const partial = prorateEmployment(null, null, '2027-09-01', '2027-09-30', 5);
    expect(partial.unpaidDays).toBe(5);
    expect(partial.payableDays).toBe(25);
    expect(partial.factor).toBeCloseTo(25 / 30);
  });

  it('never returns a negative payable amount', () => {
    const pr = prorateEmployment('2027-10-01', null, '2027-09-01', '2027-09-30');
    expect(pr.workDays).toBe(0);
    expect(pr.payableDays).toBe(0);
    expect(pr.factor).toBe(0);
  });
});

describe('payroll engine: prorated basic pay', () => {
  it('keeps full-period basic pay unchanged when no leave is taken', () => {
    const pr = prorateEmployment(null, null, '2027-09-01', '2027-09-30');
    expect(prorateBasic(3000000, pr)).toBe(3000000);
  });

  it('deducts one-thirtieth per unpaid day', () => {
    const pr = prorateEmployment(null, null, '2027-09-01', '2027-09-30', 5);
    expect(prorateBasic(3000000, pr)).toBe(2500000);
  });

  it('scales the entitlement for mid-period hires', () => {
    const pr = prorateEmployment('2027-09-10', null, '2027-09-01', '2027-09-30');
    expect(prorateBasic(3000000, pr)).toBe(2100000);
  });

  it('rounds percentages to two decimals', () => {
    const pr = prorateEmployment(null, null, '2027-09-01', '2027-09-30', 10);
    expect(prorateBasic(200000, pr)).toBe(133333.33);
  });

  it('never returns a negative basic', () => {
    const pr = prorateEmployment('2027-10-01', null, '2027-09-01', '2027-09-30', 0);
    expect(prorateBasic(100000, pr)).toBe(0);
  });
});

describe('payroll engine: component amounts', () => {
  const base = (over: Partial<import('../src/services/payrollEngine.js').PayrollComponent> = {}) => ({
    componentId: 1,
    code: 'TST',
    name: 'Test',
    type: 'EARNING' as const,
    category: 'ALLOWANCE',
    isTaxable: true,
    isBenefitInKind: false,
    calculationType: 'FIXED',
    value: 100000,
    ...over,
  });

  it('prorates fixed amounts by the employment factor', () => {
    expect(resolveComponentAmount(base(), 3000000, 1)).toBe(100000);
    expect(resolveComponentAmount(base(), 3000000, 0.5)).toBe(50000);
  });

  it('resolves percentages against prorated basic', () => {
    expect(resolveComponentAmount(base({ calculationType: 'PERCENTAGE', value: 10 }), 2100000, 1)).toBe(210000);
  });

  it('skips FORMULA components (pre-computed by HCM actions)', () => {
    expect(resolveComponentAmount(base({ calculationType: 'FORMULA' }), 3000000, 1)).toBe(0);
  });

  it('treats missing calculation type as FIXED and zero value as zero', () => {
    expect(resolveComponentAmount(base({ calculationType: undefined, value: 0 }), 3000000, 1)).toBe(0);
  });

  it('returns an empty variable-pay bucket for employees with no records', () => {
    expect(emptyVariablePay()).toEqual({
      overtime: 0,
      bonuses: 0,
      commissions: 0,
      earnings: [],
      deductions: [],
      benefitsEmployee: 0,
      benefitsEmployer: 0,
      benefitsTaxable: 0,
    });
  });
});
