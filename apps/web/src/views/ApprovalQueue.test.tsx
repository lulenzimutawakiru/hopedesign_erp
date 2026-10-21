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
