/**
 * Sign-in error copy.
 *
 * The authentication API is precise, but its messages are written for operators
 * and logs rather than for someone standing at a sign-in screen. This module is
 * the single place that turns an API failure into the sentence a person should
 * read: it never echoes a raw backend string and it never confirms whether an
 * account exists.
 *
 * Ordering matters here. `describeError` is the app-wide sanitiser, but it treats
 * a handful of statuses as canonical-only -- 401 and 503 among them -- which
 * would discard the domain meaning of "Invalid credentials" and of a code that
 * could not be sent. Every rule below therefore runs on the error code and
 * status *before* delegating, and `describeError` stays the last resort.
 */

import { ApiError } from '../api';
import { describeError } from '../components/errorText';
import type { AuthErrorContext } from './signin.types';

/** Transport-level failures: no HTTP response ever arrived. */
const UNREACHABLE =
  /failed to fetch|networkerror|network request failed|load failed|fetch failed|econnrefused|econnreset|enotfound|etimedout|err_network|err_internet|err_connection|err_name_not_resolved/i;

const OFFLINE_TEXT =
  "We couldn't connect to HOPE DESIGN ERP. Check your network connection and try again.";

const INVALID_CREDENTIALS_TEXT =
  'The username or password is incorrect. Please verify your details and try again.';

const SESSION_ENDED_TEXT = 'Your verification session has ended. Sign in again to continue.';

const NOT_ACTIVE_TEXT =
  'This account is not active. Contact your system administrator or the Service Desk to restore access.';

const LOCKED_TEXT =
  'Your account has been temporarily locked after repeated unsuccessful attempts. Contact your administrator or support team.';

const UNAVAILABLE_TEXT = 'HOPE DESIGN ERP is temporarily unavailable. Please try again shortly.';

const RESET_LINK_TEXT = 'This reset link is invalid or has expired. Request a new one.';

/**
 * Bare 400s carry no domain detail. Rather than echo whatever the server said,
 * fall back on where the user was standing when the error arrived.
 */
const CONTEXT_FALLBACK: Record<AuthErrorContext, string> = {
  signin: 'Sign-in was not completed. Check your details and try again.',
  mfa: 'That verification step was not completed. Try again, or request a new code.',
  'send-code': 'We could not send your code. Try again shortly.',
  reset: 'We could not start the reset. Try again shortly.',
};

/** `[status or null for any, message fragment, copy]`, matched in order. */
const MESSAGES: Array<[number | null, RegExp, string]> = [
  [null, /invalid credentials/i, INVALID_CREDENTIALS_TEXT],
  [null, /account is not active/i, NOT_ACTIVE_TEXT],
  [null, /locked/i, LOCKED_TEXT],
  [null, /invalid mfa code|invalid or expired code/i, 'Verification unsuccessful. The code is invalid or has expired. Request a new code or try again.'],
  [null, /identifier and password are required/i, 'Enter both your username and password to sign in.'],
  [null, /login ?token and code are required/i, 'Enter the 6-digit code from your verification message.'],
  [null, /enter a valid email address/i, 'Enter a valid email address, for example name@company.com.'],
  [null, /enter your personal email address/i, 'Enter the personal email address that should receive your sign-in codes.'],
  [null, /email address is already in use/i, 'That email address is already in use. Enter a different one.'],
  [null, /mfa is not enabled for this account/i, 'Two-step verification is not enabled for this account. Contact your administrator.'],
  [null, /no authenticator app is paired/i, 'No authenticator app is paired with this account. Contact your administrator.'],
  [null, /two-step verification is already set up/i, 'Two-step verification is already set up for this account.'],
  [null, /password must be at least 8 characters/i, 'Your password must be at least 8 characters long.'],
  [null, /reset link is invalid or has expired/i, RESET_LINK_TEXT],
  // An expired or unknown verification handle must not reveal whether the
  // account behind it exists, so both collapse to the same restart copy.
  [null, /invalid login token|user not found/i, SESSION_ENDED_TEXT],
  [503, /could not send/i, 'We could not send your code. Please try again shortly.'],
];

/**
 * Turns an authentication failure into copy a member of staff can act on.
 *
 * @param error   Whatever was thrown by the auth layer.
 * @param context Which step the user was on, used for bare validation errors.
 * @param fallback Last-resort sentence when nothing more specific applies.
 */
export function describeAuthError(
  error: unknown,
  context: AuthErrorContext,
  fallback: string
): string {
  if (!(error instanceof ApiError)) {
    if (error instanceof Error && UNREACHABLE.test(`${error.name} ${error.message}`)) {
      return OFFLINE_TEXT;
    }
    return describeError(error, fallback);
  }

  if (error.code === 'ACCOUNT_LOCKED') return LOCKED_TEXT;

  for (const [status, pattern, copy] of MESSAGES) {
    if ((status === null || status === error.status) && pattern.test(error.message)) return copy;
  }

  switch (error.status) {
    case 400:
      return CONTEXT_FALLBACK[context];
    case 401:
      return context === 'signin' ? INVALID_CREDENTIALS_TEXT : SESSION_ENDED_TEXT;
    case 403:
      return 'You do not have clearance for this action. Contact your system administrator if you believe this is a mistake.';
    case 423:
      return LOCKED_TEXT;
    case 429:
      return 'Too many attempts. Wait a moment, then try again.';
    default:
      break;
  }

  if (error.status >= 500) return UNAVAILABLE_TEXT;
  return describeError(error, fallback);
}
