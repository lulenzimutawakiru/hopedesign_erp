import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { EntityMeta } from '../api';
import { JsonForm } from './JsonForm';

const meta = {
  table: 'widgets',
  module: 'inventory',
  resource: 'widgets',
  label: 'Widget',
  entityType: null,
  codeColumn: null,
  statusColumn: null,
  searchable: [],
  qrEntityType: null,
  writable: ['name', 'attributes'],
  columns: [
    { name: 'name', camel: 'name', dataType: 'text', nullable: false, hasDefault: false, writable: true },
    { name: 'attributes', camel: 'attributes', dataType: 'jsonb', nullable: true, hasDefault: false, writable: true },
  ],
} as unknown as EntityMeta;

describe('JsonForm structured-field validation', () => {
  it('blocks submit and shows an error when a jsonb field is not valid JSON', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<JsonForm meta={meta} onSubmit={onSubmit} onCancel={() => {}} />);

    fireEvent.change(screen.getByLabelText('Attributes'), { target: { value: 'not valid json' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(screen.getByText(/not valid JSON/i)).toBeInTheDocument());
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('parses a valid jsonb value into an object on submit', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<JsonForm meta={meta} onSubmit={onSubmit} onCancel={() => {}} />);

    fireEvent.change(screen.getByLabelText('Attributes'), { target: { value: '{"a":1}' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ attributes: { a: 1 } }))
    );
  });
});
