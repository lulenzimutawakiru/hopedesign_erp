/**
 * Second-factor stage.
 *
 * Three backend shapes share this skeleton, so the rules worth pinning are the
 * ones that decide which controls a given shape may show: the enrollment detour
 * must not also ask for a code it has not sent, and a TOTP enrolment must never
 * offer to change an email address it does not use.
 */

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MfaForm, mfaSubtitle, type MfaFormProps } from './MfaForm';

const noop = () => {};

function renderMfa(overrides: Partial<MfaFormProps> = {}) {
  const props: MfaFormProps = {
    mode: 'code',
    emailEntry: false,
    code: '',
    newEmail: '',
    qrDataUrl: '',
    secret: '',
    copied: false,
    busy: false,
    error: '',
    notice: '',
    maskedEmail: 'a***@example.com',
    resendIn: 0,
    primaryLabel: 'Verify',
    submitDisabled: false,
    onCodeChange: noop,
    onNewEmailChange: noop,
    onCopySecret: noop,
    onResend: noop,
    onUseDifferentEmail: noop,
    onBack: noop,
    ...overrides,
  };
  return render(<MfaForm {...props} />);
}

describe('mfaSubtitle', () => {
  it('explains the authenticator enrolment', () => {
    expect(mfaSubtitle('totp-enroll', false, '')).toBe(
      'Scan this with Google Authenticator, Authy, or 1Password, then enter the 6-digit code.'
    );
  });

  it('explains the personal-email enrolment', () => {
    expect(mfaSubtitle('email-enroll', true, '')).toBe(
      'Add the personal email address your sign-in codes should go to. We will mail a 6-digit code there to confirm it.'
    );
  });

  it('names the masked address a code was sent to', () => {
    expect(mfaSubtitle('code', false, 'a***@example.com')).toBe(
      'We emailed a 6-digit code to a***@example.com. It expires in 10 minutes.'
    );
  });

  it('falls back to a generic phrase when no address is known', () => {
    expect(mfaSubtitle('code', false, '')).toBe(
      'We emailed a 6-digit code to your personal email address. It expires in 10 minutes.'
    );
  });
});

describe('MfaForm', () => {
  it('asks for the code with numeric-friendly input settings', () => {
    renderMfa();
    const code = screen.getByLabelText('6-digit code');
    expect(code).toHaveAttribute('maxlength', '6');
    expect(code).toHaveAttribute('inputmode', 'numeric');
    expect(code).toHaveAttribute('placeholder', '000000');
    expect(code).toHaveClass('login-otp');
  });

  it('offers a resend that stays locked until the cooldown expires', () => {
    const { unmount } = renderMfa({ resendIn: 12 });
    expect(screen.getByRole('button', { name: 'Resend in 12s' })).toBeDisabled();
    unmount();

    renderMfa({ resendIn: 0 });
    expect(screen.getByRole('button', { name: 'Resend code' })).not.toBeDisabled();
  });

  it('hides the resend control when no address is known to resend to', () => {
    renderMfa({ maskedEmail: '' });
    expect(screen.queryByRole('button', { name: /resend/i })).toBeNull();
  });

  it('shows the authenticator enrolment without offering an email change', () => {
    renderMfa({ mode: 'totp-enroll', qrDataUrl: 'data:image/png;base64,AAA', secret: 'ABCD1234' });

    expect(screen.getByAltText('Authenticator QR code')).toBeInTheDocument();
    expect(screen.getByText('ABCD1234')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy key' })).toBeInTheDocument();
    // A TOTP enrolment does not use the email address, so it must not offer it.
    expect(screen.queryByRole('button', { name: 'Use a different email address' })).toBeNull();
    // The code is still collected here, because this is how the factor is proven.
    expect(screen.getByLabelText('6-digit code')).toBeInTheDocument();
  });

  it('swaps the copy control label once the key is copied', () => {
    renderMfa({ mode: 'totp-enroll', secret: 'ABCD1234', copied: true });
    expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Copy key' })).toBeNull();
  });

  it('collects an address during email enrolment instead of a code', () => {
    renderMfa({ mode: 'email-enroll', emailEntry: true, submitDisabled: true });

    const email = screen.getByLabelText('Personal email');
    expect(email).toHaveAttribute('type', 'email');
    expect(email).toHaveAttribute('autocomplete', 'email');
    // Nothing has been sent yet, so there is no code to enter or resend.
    expect(screen.queryByLabelText('6-digit code')).toBeNull();
    expect(screen.queryByRole('button', { name: /resend/i })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Use a different email address' })).toBeNull();
  });

  it('asks for the code once the enrolment address has been submitted', () => {
    renderMfa({ mode: 'email-enroll', emailEntry: false, maskedEmail: 'a***@example.com' });

    expect(screen.queryByLabelText('Personal email')).toBeNull();
    expect(screen.getByLabelText('6-digit code')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Use a different email address' })).toBeInTheDocument();
  });

  it('always offers a way back to the start of sign-in', () => {
    for (const mode of ['code', 'email-enroll', 'totp-enroll'] as const) {
      const { unmount } = renderMfa({ mode });
      expect(screen.getByRole('button', { name: 'Back to sign in' })).toBeInTheDocument();
      unmount();
    }
  });

  it('announces a failure and blocks re-entry while verifying', () => {
    renderMfa({ busy: true, error: 'The code is invalid or has expired.' });

    expect(screen.getByRole('alert')).toHaveTextContent('The code is invalid or has expired.');
    // The submit control reports progress and refuses a second press.
    expect(screen.getByRole('button', { name: 'Verifying...' })).toBeDisabled();
  });

  it('renders no alert region while the step is healthy', () => {
    renderMfa({ notice: 'We sent you a code.' });

    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent('We sent you a code.');
  });
});
