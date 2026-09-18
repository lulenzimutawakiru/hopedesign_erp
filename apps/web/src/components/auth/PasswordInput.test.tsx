/**
 * Password field with a reveal toggle.
 *
 * The toggle is the only control standing between a mistyped password and a
 * failed sign-in, so what matters is that it is a real, keyboard-reachable
 * button with an accessible name that describes the action it performs.
 */

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { PasswordInput } from './PasswordInput';

describe('PasswordInput', () => {
  it('starts masked and reveals the value on toggle', async () => {
    const user = userEvent.setup();
    render(<PasswordInput id="password" label="Password" />);

    expect(screen.getByLabelText('Password')).toHaveAttribute('type', 'password');

    await user.click(screen.getByLabelText('Show password'));

    expect(screen.getByLabelText('Password')).toHaveAttribute('type', 'text');
  });

  it('hides the value again on a second toggle', async () => {
    const user = userEvent.setup();
    render(<PasswordInput id="password" label="Password" />);

    await user.click(screen.getByLabelText('Show password'));
    await user.click(screen.getByLabelText('Hide password'));

    expect(screen.getByLabelText('Password')).toHaveAttribute('type', 'password');
  });

  it('names the toggle after the action it will take, not the current state', async () => {
    const user = userEvent.setup();
    render(<PasswordInput id="password" label="Password" />);

    const toggle = screen.getByLabelText('Show password');
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    expect(toggle).toHaveAttribute('aria-controls', 'password');
    expect(toggle).toHaveAttribute('type', 'button');

    await user.click(toggle);

    const flipped = screen.getByLabelText('Hide password');
    expect(flipped).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByLabelText('Show password')).toBeNull();
  });

  it('passes the caller\u2019s error through to the field', () => {
    render(<PasswordInput id="password" label="Password" error="Required" />);
    const input = screen.getByLabelText('Password');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAttribute('aria-describedby', 'password-error');
  });
});
