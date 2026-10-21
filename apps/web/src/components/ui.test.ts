import { describe, expect, it } from 'vitest';
import { statusMeta } from './ui';

describe('statusMeta', () => {
  it('tones the workflow instance lifecycle states distinctly', () => {
    expect(statusMeta('RUNNING').kind).toBe('progress');
    expect(statusMeta('EXECUTION_PENDING').kind).toBe('pending');
    expect(statusMeta('ESCALATED').kind).toBe('critical');
    expect(statusMeta('SUBMITTED').kind).toBe('pending');
    expect(statusMeta('APPROVED').kind).toBe('ok');
    expect(statusMeta('EXECUTED').kind).toBe('ok');
    expect(statusMeta('REJECTED').kind).toBe('reject');
  });

  it('falls back to a neutral badge for an unrecognised state', () => {
    expect(statusMeta('SOMETHING_NEW').kind).toBe('neutral');
  });

  it('is case-insensitive and strips underscores from the label', () => {
    expect(statusMeta('execution_pending').kind).toBe('pending');
    expect(statusMeta('execution_pending').label).toBe('execution pending');
  });
});
