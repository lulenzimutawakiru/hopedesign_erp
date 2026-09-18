/**
 * Submit primitive for the authentication surfaces.
 *
 * Authentication is the one place a double submit is expensive, so the
 * contract worth pinning is that a busy button disables itself, reports
 * `aria-busy`, and that it defaults to `type="button"` so a stray Enter cannot
 * fire a request the caller did not wire up.
 */

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AuthButton } from './AuthButton';

describe('AuthButton', () => {
  it('defaults to type="button"', () => {
    render(<AuthButton>Cancel</AuthButton>);
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveAttribute('type', 'button');
  });

  it('honours an explicit submit type', () => {
    render(<AuthButton type="submit">Sign in</AuthButton>);
    expect(screen.getByRole('button', { name: 'Sign in' })).toHaveAttribute('type', 'submit');
  });

  it('blocks re-entry and swaps its label while busy', () => {
    render(
      <AuthButton type="submit" busy busyLabel="Signing in...">
        Sign in
      </AuthButton>
    );

    const button = screen.getByRole('button');
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('aria-busy', 'true');
    expect(button).toHaveTextContent('Signing in...');
    expect(button.querySelector('.auth-btn-spinner')).not.toBeNull();
  });

  it('keeps the children as the label when busy without a progress label', () => {
    render(<AuthButton busy>Verify</AuthButton>);
    const button = screen.getByRole('button');
    expect(button).toBeDisabled();
    expect(button).toHaveTextContent('Verify');
  });

  it('shows neither spinner nor busy state when idle', () => {
    render(<AuthButton icon={<span />}>Sign in</AuthButton>);
    const button = screen.getByRole('button');
    expect(button).not.toHaveAttribute('aria-busy');
    expect(button).not.toBeDisabled();
    expect(button.querySelector('.auth-btn-spinner')).toBeNull();
    expect(button.querySelector('.auth-btn-icon')).not.toBeNull();
  });

  it('stays disabled when the caller disables it outright', () => {
    render(<AuthButton disabled>Verify</AuthButton>);
    expect(screen.getByRole('button')).toBeDisabled();
  });

  it('applies tone and block modifiers', () => {
    render(
      <AuthButton tone="secondary" block>
        Copy key
      </AuthButton>
    );
    expect(screen.getByRole('button')).toHaveClass(
      'auth-btn',
      'auth-btn-secondary',
      'auth-btn-block'
    );
  });
});
