import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import ApprovalHistory, { type ApprovalHistoryRow } from './ApprovalHistory';

function row(overrides: Partial<ApprovalHistoryRow> = {}): ApprovalHistoryRow {
  return {
    task_id: 1,
    entity_type: 'sales.orders',
    entity_id: 42,
    entity_code: 'SO-001',
    step_name: 'Manager',
    status: 'APPROVED',
    instance_status: 'EXECUTION_PENDING',
    ...overrides,
  };
}

describe('ApprovalHistory distinct states', () => {
  it('surfaces the workflow instance status alongside the task decision', () => {
    render(<ApprovalHistory rows={[row()]} />);

    // Task decision is title-cased; instance lifecycle status is a distinct badge.
    expect(screen.getByText('Approved')).toBeInTheDocument();
    expect(screen.getByText('EXECUTION PENDING')).toBeInTheDocument();
  });

  it('does not repeat the instance status when it matches the decision', () => {
    render(<ApprovalHistory rows={[row({ status: 'APPROVED', instance_status: 'APPROVED' })]} />);

    expect(screen.getAllByText('Approved')).toHaveLength(1);
    expect(screen.queryByText('APPROVED')).not.toBeInTheDocument();
  });
});
