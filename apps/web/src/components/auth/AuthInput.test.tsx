/**
 * Field primitive for the authentication surfaces.
 *
 * The interesting behaviour is the description wiring: a field must carry its
 * guidance to a screen reader, and a field that has been refused must say so
 * even when the caller deliberately withholds a message.
 */

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AuthInput } from './AuthInput';

describe('AuthInput', () => {
  it('renders a persistent label bound to the input', () => {
    render(<AuthInput id="username" label="Username or work email" />);
    const input = screen.getByLabelText('Username or work email');
    expect(input).toHaveAttribute('id', 'username');
    expect(input).toHaveClass('auth-input');
  });

  it('describes the field with its hint while it is valid', () => {
    render(<AuthInput id="username" label="Username" hint="Use your work email" />);
    const input = screen.getByLabelText('Username');
    expect(input).toHaveAttribute('aria-describedby', 'username-hint');
    expect(screen.getByText('Use your work email')).toHaveAttribute('id', 'username-hint');
    expect(input).not.toHaveAttribute('aria-invalid');
  });

  it('replaces the hint with the error and marks the field invalid', () => {
    render(<AuthInput id="username" label="Username" hint="Use your work email" error="Required" />);
    const input = screen.getByLabelText('Username');
    expect(input).toHaveAttribute('aria-describedby', 'username-error');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByText('Required')).toHaveAttribute('id', 'username-error');
    expect(screen.queryByText('Use your work email')).toBeNull();
  });

  it('flags a refused field without printing a message when asked to', () => {
    // Sign-in depends on this: both credential fields are shown as refused,
    // while naming the offending one would reveal which half was wrong.
    render(<AuthInput id="password" label="Password" invalid />);
    const input = screen.getByLabelText('Password');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).not.toHaveAttribute('aria-describedby');
    expect(document.querySelector('.auth-field-error')).toBeNull();
    expect(input.closest('.auth-field')).toHaveClass('is-invalid');
  });

  it('reserves room for the glyphs it is given', () => {
    const { rerender } = render(<AuthInput id="a" label="Plain" />);
    expect(screen.getByLabelText('Plain').className).toBe('auth-input');

    rerender(
      <AuthInput
        id="a"
        label="Decorated"
        icon={<svg />}
        trailing={<button type="button">x</button>}
      />
    );
    expect(screen.getByLabelText('Decorated')).toHaveClass('auth-input', 'has-icon', 'has-trailing');
  });

  it('marks the wrapper invalid when a message is present', () => {
    render(<AuthInput id="a" label="Field" error="Broken" />);
    expect(screen.getByLabelText('Field').closest('.auth-field')).toHaveClass('is-invalid');
  });
});
