import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import ApprovalQueue, { type ApprovalRow } from './ApprovalQueue';

const row = {
  task_id: 1,
  entity_type: 'sales.orders',
  entity_id: 42,
  entity_code: 'SO-001',
  step_name: 'Manager',
  submitted_at: '2026-10-21T10:00:00Z',
  actionable: true,
} as ApprovalRow;

describe('ApprovalQueue decision safety', () => {
  it('does not approve when Enter is pressed in the note field', async () => {
    const onDecide = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(<ApprovalQueue rows={[row]} onDecide={onDecide} />);

    await user.click(screen.getByTitle('Add a note'));
    await user.type(screen.getByRole('textbox', { name: 'Decision note' }), 'looks fine');
    await user.keyboard('{Enter}');

    expect(onDecide).not.toHaveBeenCalled();
  });

  it('approves only via the explicit Approve button and carries the note', async () => {
    const onDecide = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(<ApprovalQueue rows={[row]} onDecide={onDecide} />);

    await user.click(screen.getByTitle('Add a note'));
    await user.type(screen.getByRole('textbox', { name: 'Decision note' }), 'looks fine');
    await user.keyboard('{Enter}'); // dismiss the note editor without deciding
    await user.click(screen.getByRole('button', { name: 'Approve' }));

    expect(onDecide).toHaveBeenCalledTimes(1);
    expect(onDecide).toHaveBeenCalledWith(row, 'APPROVED', 'looks fine');
  });
});

describe('ApprovalQueue bulk approve and status surfacing', () => {
  it('bulk approves only the selected actionable rows after a confirm step', async () => {
    const onDecide = vi.fn().mockResolvedValue(undefined);
    const onBulkDecide = vi.fn().mockResolvedValue(undefined);
    const rows: ApprovalRow[] = [
      { task_id: 1, entity_code: 'A-1', step_name: 'Manager', actionable: true },
      { task_id: 2, entity_code: 'A-2', step_name: 'Manager', actionable: true },
      { task_id: 3, entity_code: 'A-3', step_name: 'Manager', actionable: false, blocked_reason: 'EARLIER_STEP_PENDING' },
    ];
    const user = userEvent.setup();
    render(<ApprovalQueue rows={rows} onDecide={onDecide} onBulkDecide={onBulkDecide} />);

    await user.click(screen.getByLabelText('Select all actionable'));
    await user.click(screen.getByRole('button', { name: 'Approve 2' }));
    await user.click(screen.getByRole('button', { name: 'Confirm' }));

    expect(onBulkDecide).toHaveBeenCalledTimes(1);
    const [batch, decision] = onBulkDecide.mock.calls[0] as [ApprovalRow[], string, string];
    expect(decision).toBe('APPROVED');
    expect(batch.map((r) => r.task_id)).toEqual([1, 2]);
    expect(onDecide).not.toHaveBeenCalled();
  });

  it('flags escalated and delegated (acting) rows without bulk controls when onBulkDecide is absent', () => {
    const { container } = render(
      <ApprovalQueue
        rows={[
          { task_id: 1, entity_code: 'E-1', step_name: 'Manager', status: 'ESCALATED', actionable: true },
          {
            task_id: 2,
            entity_code: 'E-2',
            step_name: 'Manager',
            acting_role_name: 'Finance Manager',
            delegator_name: 'Alice Oyo',
            delegation_code: 'DEL-9',
            actionable: true,
          },
        ]}
        onDecide={vi.fn().mockResolvedValue(undefined)}
      />
    );
    expect(container.querySelector('.queue-escalated-chip')?.textContent).toContain('Escalated');
    expect(container.querySelector('.queue-acting-chip')?.textContent).toContain('Acting as Finance Manager');
    expect(container.querySelector('.queue-acting-chip')?.textContent).toContain('Alice Oyo');
    expect(container.querySelector('.queue-row-check')).toBeNull();
  });
});
