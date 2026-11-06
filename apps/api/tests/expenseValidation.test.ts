import { describe, expect, it } from 'vitest';
import { validateExpenseInput } from '../src/services/expenseValidation.js';

describe('expense input controls', () => {
  it('accepts a complete expense with reconciled line amounts', () => {
    expect(() => validateExpenseInput({
      description: 'Office supplies', amount: 125, categoryId: 1, currency: 'UGX',
      taxAmount: 0, lines: [{ description: 'Paper', quantity: 5, unitCost: 25, amount: 125 }],
    })).not.toThrow();
  });

  it.each([
    [{ description: '', amount: 1, categoryId: 1 }, /Description is required/],
    [{ description: 'Travel', amount: 0, categoryId: 1 }, /greater than zero/],
    [{ description: 'Travel', amount: 1, categoryId: 0 }, /valid expense category/],
    [{ description: 'Travel', amount: 1, categoryId: 1, taxAmount: 2 }, /Tax amount cannot exceed/],
    [{ description: 'Travel', amount: 1, categoryId: 1, currency: 'US' }, /three-letter ISO/],
    [{ description: 'Travel', amount: 1, categoryId: 1, lines: [{ description: 'Taxi', quantity: 2, unitCost: 3, amount: 5 }] }, /quantity multiplied/],
  ])('rejects invalid payload %j', (payload, error) => {
    expect(() => validateExpenseInput(payload as Record<string, unknown>)).toThrow(error);
  });

  it('validates only supplied fields for draft updates', () => {
    expect(() => validateExpenseInput({ payee: 'Taxi' }, true)).not.toThrow();
    expect(() => validateExpenseInput({ amount: -1 }, true)).toThrow(/non-negative/);
  });
});
