/**
 * Pure-function tests for the customer-intelligence layer.
 *
 * RFM segmentation, churn/reorder risk, credit risk and next-best-action
 * generation are all side-effect-free and exported precisely so they can be
 * pinned here without a database. The async list/overview functions only wrap
 * SQL + these functions, so this is the meaningful unit surface.
 */
import { describe, it, expect } from 'vitest';
import {
  segmentForScores,
  assignSegments,
  churnRiskLevel,
  creditRiskLevel,
  nextBestActions,
  enrich,
  type CustomerIntelligenceInput,
} from '../src/services/customerIntelligence.js';

function makeInput(overrides: Partial<CustomerIntelligenceInput> = {}): CustomerIntelligenceInput {
  return {
    customerId: 1,
    code: 'C-001',
    name: 'Acme',
    status: 'ACTIVE',
    creditLimit: 0,
    openAr: 0,
    overdueAr: 0,
    days90Plus: 0,
    recencyDays: null,
    orderCount: 0,
    monetary: 0,
    lastOrderDate: null,
    avgIntervalDays: null,
    expiringQuoteNo: null,
    expiringQuoteDate: null,
    ...overrides,
  };
}

describe('segmentForScores', () => {
  it('flags champions on all fours', () => {
    expect(segmentForScores(4, 4, 4)).toBe('CHAMPION');
  });
  it('flags loyal on all threes', () => {
    expect(segmentForScores(3, 3, 3)).toBe('LOYAL');
  });
  it('flags hibernating when valuable but long gone', () => {
    expect(segmentForScores(1, 4, 4)).toBe('HIBERNATING');
  });
  it('flags lost on all lows', () => {
    expect(segmentForScores(1, 1, 1)).toBe('LOST');
  });
  it('flags at-risk when valuable but lapsing (r=2)', () => {
    expect(segmentForScores(2, 4, 3)).toBe('AT_RISK');
  });
  it('flags promising on recent-but-low volume and value', () => {
    expect(segmentForScores(4, 2, 2)).toBe('PROMISING');
  });
  it('falls to lost on the lowest recency before other rules', () => {
    expect(segmentForScores(1, 3, 2)).toBe('LOST');
  });
  it('flags potential loyalist when frequent + recent but low value', () => {
    expect(segmentForScores(3, 4, 2)).toBe('POTENTIAL_LOYALIST');
  });
  it('flags potential loyalist when recent + valuable but low frequency', () => {
    expect(segmentForScores(4, 2, 4)).toBe('POTENTIAL_LOYALIST');
  });
  it('defaults to needs-attention for the mid pack', () => {
    expect(segmentForScores(2, 2, 2)).toBe('NEEDS_ATTENTION');
  });
});

describe('assignSegments', () => {
  it('gives zero-order customers NEW or INACTIVE and no scores', () => {
    const map = assignSegments([
      makeInput({ customerId: 1, status: 'ACTIVE' }),
      makeInput({ customerId: 2, status: 'BLOCKED' }),
      makeInput({ customerId: 3, status: 'INACTIVE' }),
    ]);
    expect(map.get(1)?.segment).toBe('NEW');
    expect(map.get(1)?.recencyScore).toBeNull();
    expect(map.get(2)?.segment).toBe('INACTIVE');
    expect(map.get(3)?.segment).toBe('INACTIVE');
  });

  it('scores the trading set on 1–4 quartiles', () => {
    const map = assignSegments([
      makeInput({ customerId: 1, orderCount: 1, monetary: 1000, recencyDays: 100 }),
      makeInput({ customerId: 2, orderCount: 2, monetary: 2000, recencyDays: 50 }),
      makeInput({ customerId: 3, orderCount: 3, monetary: 3000, recencyDays: 10 }),
      makeInput({ customerId: 4, orderCount: 4, monetary: 4000, recencyDays: 5 }),
    ]);
    for (const id of [1, 2, 3, 4]) {
      const r = map.get(id)!;
      expect(r.recencyScore).toBeGreaterThanOrEqual(1);
      expect(r.recencyScore).toBeLessThanOrEqual(4);
      expect(r.frequencyScore).toBeGreaterThanOrEqual(1);
      expect(r.monetaryScore).toBeGreaterThanOrEqual(1);
    }
    // Most recent + most frequent + most value → champion.
    expect(map.get(4)?.segment).toBe('CHAMPION');
  });
});

describe('churnRiskLevel', () => {
  it('treats no history as low', () => {
    const r = churnRiskLevel(makeInput());
    expect(r.level).toBe('LOW');
    expect(r.reason).toMatch(/No purchase history/);
  });
  it('keeps a recent single purchase low', () => {
    const r = churnRiskLevel(makeInput({ orderCount: 1, recencyDays: 30 }));
    expect(r.level).toBe('LOW');
  });
  it('flags a stale single purchase as going quiet after 90d', () => {
    const r = churnRiskLevel(makeInput({ orderCount: 1, recencyDays: 120 }));
    expect(r.level).toBe('MEDIUM');
  });
  it('is low when on cadence', () => {
    const r = churnRiskLevel(makeInput({ orderCount: 4, recencyDays: 25, avgIntervalDays: 30 }));
    expect(r.level).toBe('LOW');
    expect(r.expectedReorderDays).toBe(30);
  });
  it('is medium when modestly past cadence', () => {
    const r = churnRiskLevel(makeInput({ orderCount: 4, recencyDays: 40, avgIntervalDays: 30 }));
    expect(r.level).toBe('MEDIUM');
    expect(r.overdueDays).toBe(10);
  });
  it('is high when more than a full cycle overdue', () => {
    const r = churnRiskLevel(makeInput({ orderCount: 4, recencyDays: 75, avgIntervalDays: 30 }));
    expect(r.level).toBe('HIGH');
  });
});

describe('creditRiskLevel', () => {
  it('treats a blocked account as critical', () => {
    const r = creditRiskLevel(makeInput({ status: 'BLOCKED' }));
    expect(r.level).toBe('CRITICAL');
  });
  it('treats an inactive account as critical', () => {
    const r = creditRiskLevel(makeInput({ status: 'INACTIVE' }));
    expect(r.level).toBe('CRITICAL');
  });
  it('flags over-limit exposure as high', () => {
    const r = creditRiskLevel(makeInput({ creditLimit: 1000, openAr: 1500 }));
    expect(r.level).toBe('HIGH');
    expect(r.reasons).toContain('Over credit limit');
  });
  it('flags 90+ day AR as high even without over-limit', () => {
    const r = creditRiskLevel(makeInput({ days90Plus: 500, overdueAr: 900 }));
    expect(r.level).toBe('HIGH');
  });
  it('flags plain overdue AR as watch', () => {
    const r = creditRiskLevel(makeInput({ overdueAr: 200 }));
    expect(r.level).toBe('MEDIUM');
  });
  it('is healthy otherwise', () => {
    const r = creditRiskLevel(makeInput({ openAr: 10 }));
    expect(r.level).toBe('LOW');
    expect(r.label).toBe('Healthy');
  });
});

describe('nextBestActions', () => {
  const base = makeInput();
  const rfm = assignSegments([base]).get(1)!;
  const low = churnRiskLevel(base);
  const credit = creditRiskLevel(base);

  it('prioritises collecting overdue AR', () => {
    const actions = nextBestActions(makeInput({ overdueAr: 500 }), rfm, low, credit);
    expect(actions[0].type).toBe('collect');
    expect(actions[0].href).toBe('/finance/ar');
  });
  it('re-engages a high churn customer', () => {
    const churn = churnRiskLevel(makeInput({ orderCount: 4, recencyDays: 75, avgIntervalDays: 30 }));
    const actions = nextBestActions(base, rfm, churn, credit);
    expect(actions.some((a) => a.type === 'reengage')).toBe(true);
  });
  it('flags a critical credit review', () => {
    const c = creditRiskLevel(makeInput({ status: 'BLOCKED' }));
    const actions = nextBestActions(base, rfm, low, c);
    expect(actions.some((a) => a.type === 'credit')).toBe(true);
  });
  it('follows up an expiring quotation', () => {
    const actions = nextBestActions(makeInput({ expiringQuoteNo: 'Q-9', expiringQuoteDate: '2026-11-10' }), rfm, low, credit);
    expect(actions.some((a) => a.type === 'quote')).toBe(true);
  });
  it('nurtures a zero-history account when nothing else applies', () => {
    const actions = nextBestActions(base, rfm, low, credit);
    expect(actions.some((a) => a.type === 'nurture')).toBe(true);
  });
  it('never returns more than three actions', () => {
    const hot = makeInput({ overdueAr: 500, status: 'BLOCKED', orderCount: 4, recencyDays: 75, avgIntervalDays: 30, expiringQuoteNo: 'Q-1' });
    const r = assignSegments([hot]).get(1)!;
    const c = churnRiskLevel(hot);
    const cr = creditRiskLevel(hot);
    expect(nextBestActions(hot, r, c, cr).length).toBeLessThanOrEqual(3);
  });
});

describe('enrich', () => {
  it('attaches rfm, churn, credit and actions to every row', () => {
    const rows = [
      makeInput({ customerId: 1, orderCount: 3, recencyDays: 5, monetary: 9000 }),
      makeInput({ customerId: 2 }),
    ];
    const out = enrich(rows);
    expect(out).toHaveLength(2);
    for (const e of out) {
      expect(e.rfm.segment).toBeTruthy();
      expect(['LOW', 'MEDIUM', 'HIGH']).toContain(e.churn.level);
      expect(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).toContain(e.credit.level);
      expect(Array.isArray(e.actions)).toBe(true);
    }
  });
});
