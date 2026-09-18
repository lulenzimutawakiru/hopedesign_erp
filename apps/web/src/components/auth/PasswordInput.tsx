/**
 * Password field with a reveal toggle.
 *
 * The toggle is a real button (not a decoration): it carries an accessible name
 * that reflects the action it will perform, reports state through
 * `aria-pressed`, and stays in the tab order so a keyboard user can reveal what
 * they typed before submitting.
 */

import { useState } from 'react';
import { AuthInput, type AuthInputProps } from './AuthInput';
import { EyeIcon, EyeOffIcon, LockIcon } from './icons';

export type PasswordInputProps = Omit<AuthInputProps, 'type' | 'trailing' | 'icon'>;

export function PasswordInput({ id, label, hint, error, ...rest }: PasswordInputProps) {
  const [visible, setVisible] = useState(false);
  const action = visible ? 'Hide password' : 'Show password';

  return (
    <AuthInput
      {...rest}
      id={id}
      label={label}
      hint={hint}
      error={error}
      icon={<LockIcon size={16} />}
      type={visible ? 'text' : 'password'}
      trailing={
        <button
          type="button"
          className="auth-reveal"
          onClick={() => setVisible((v) => !v)}
          aria-pressed={visible}
          aria-controls={id}
          aria-label={action}
          title={action}
        >
          {visible ? <EyeOffIcon size={17} /> : <EyeIcon size={17} />}
        </button>
      }
    />
  );
}
