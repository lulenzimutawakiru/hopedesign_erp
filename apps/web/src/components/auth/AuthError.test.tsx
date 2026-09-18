/**
 * Outcome messages for the authentication surfaces.
 *
 * A failed sign-in is announced, not just coloured: the error region is
 * assertive and the notice region is polite. These assertions pin the roles,
 * the live-region politeness, and the fact that an empty message renders
 * nothing at all rather than an empty alert box.
 */

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AuthError, AuthNotice } from './AuthError';

describe('AuthError', () => {
  it('announces a failure assertively', () => {
    render(<AuthError message="The username or password is incorrect." id="signin-error" />);

    const alert = screen.getByRole('alert');
    expect(alert).toHaveAttribute('id', 'signin-error');
    expect(alert).toHaveAttribute('aria-live', 'assertive');
    expect(alert).toHaveClass('auth-alert', 'auth-alert-error');
    expect(alert).toHaveTextContent('The username or password is incorrect.');
  });

  it('announces a notice politely', () => {
    render(<AuthNotice message="We sent you a code." id="signin-notice" />);

    const status = screen.getByRole('status');
    expect(status).toHaveAttribute('id', 'signin-notice');
    expect(status).toHaveAttribute('aria-live', 'polite');
    expect(status).toHaveClass('auth-alert', 'auth-alert-success');
    expect(status).toHaveTextContent('We sent you a code.');
  });

  it('renders nothing when there is no message', () => {
    const { container } = render(<AuthError message="" />);
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('leaves no live region behind once the message clears', () => {
    const { rerender } = render(<AuthError message="Incorrect" />);
    expect(screen.getByRole('alert')).toBeInTheDocument();

    rerender(<AuthError message="" />);
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
