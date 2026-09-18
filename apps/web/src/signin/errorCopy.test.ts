/**
 * Sign-in error copy.
 *
 * These assertions are the contract that keeps raw backend output off the
 * sign-in screen, so they pin the exact sentences rather than merely checking
 * for "an error". Two of them are security-relevant and must not be relaxed:
 * an unknown account and an expired handle collapse to the same restart copy,
 * and a rejected credential pair never says which half was wrong.
 */

import { describe, expect, it } from 'vitest';
import { ApiError } from '../api';
import { describeAuthError } from './errorCopy';

const INVALID_CREDENTIALS =
  'The username or password is incorrect. Please verify your details and try again.';
const SESSION_ENDED = 'Your verification session has ended. Sign in again to continue.';
const LOCKED =
  'Your account has been temporarily locked after repeated unsuccessful attempts. Contact your administrator or support team.';
const UNAVAILABLE = 'HOPE DESIGN ERP is temporarily unavailable. Please try again shortly.';
const OFFLINE =
  "We couldn't connect to HOPE DESIGN ERP. Check your network connection and try again.";
const FORBIDDEN =
  'You do not have clearance for this action. Contact your system administrator if you believe this is a mistake.';

describe('describeAuthError', () => {
  it('maps a rejected credential pair to one message that names neither field', () => {
    const copy = describeAuthError(new ApiError('Invalid credentials', 401, 'AUTH'), 'signin', 'x');
    expect(copy).toBe(INVALID_CREDENTIALS);
    // Both halves must be blamed together; blaming exactly one would reveal
    // which half was wrong and turn the form into an account oracle.
    expect(copy).toMatch(/username or password/i);
    expect(copy).not.toMatch(
      /the username is|the password is|user not found|no such user|unknown (user|account)|account does not exist/i,
    );
  });

  it('honours the explicit ACCOUNT_LOCKED code ahead of every status rule', () => {
    // 400 would otherwise fall through to the context fallback.
    expect(describeAuthError(new ApiError('nope', 400, 'ACCOUNT_LOCKED'), 'signin', 'x')).toBe(LOCKED);
    expect(describeAuthError(new ApiError('nope', 423, 'ACCOUNT_LOCKED'), 'signin', 'x')).toBe(LOCKED);
  });

  it('treats a bare 423 as locked even without the code', () => {
    expect(describeAuthError(new ApiError('Locked', 423, 'X'), 'signin', 'x')).toBe(LOCKED);
  });

  it('turns bare 400s into copy scoped to the step the user was on', () => {
    const at = (context: 'signin' | 'mfa' | 'send-code' | 'reset') =>
      describeAuthError(new ApiError('Bad Request', 400, 'VALIDATION'), context, 'x');

    expect(at('signin')).toBe('Sign-in was not completed. Check your details and try again.');
    expect(at('mfa')).toBe('That verification step was not completed. Try again, or request a new code.');
    expect(at('send-code')).toBe('We could not send your code. Try again shortly.');
    expect(at('reset')).toBe('We could not start the reset. Try again shortly.');
  });

  it('keeps a 401 as "incorrect credentials" only while signing in', () => {
    const bare = () => new ApiError('Unauthorized', 401, 'AUTH');
    expect(describeAuthError(bare(), 'signin', 'x')).toBe(INVALID_CREDENTIALS);
    // Mid-flow there is nothing to re-enter, so the user has to start over.
    expect(describeAuthError(bare(), 'mfa', 'x')).toBe(SESSION_ENDED);
    expect(describeAuthError(bare(), 'send-code', 'x')).toBe(SESSION_ENDED);
  });

  it('collapses an expired handle and an unknown account to the same copy', () => {
    // Distinguishing these two would confirm whether an account exists.
    for (const message of ['Invalid login token', 'User not found']) {
      const copy = describeAuthError(new ApiError(message, 400, 'AUTH'), 'mfa', 'x');
      expect(copy).toBe(SESSION_ENDED);
      expect(copy).not.toMatch(/not found|no such|unknown account/i);
    }
  });

  it('reports too many attempts and missing clearance without echoing the server', () => {
    expect(describeAuthError(new ApiError('rate limited', 429, 'X'), 'signin', 'x')).toBe(
      'Too many attempts. Wait a moment, then try again.'
    );
    expect(describeAuthError(new ApiError('forbidden', 403, 'X'), 'signin', 'x')).toBe(FORBIDDEN);
  });

  it('collapses every server fault to one unavailable sentence', () => {
    expect(describeAuthError(new ApiError('Internal server error', 500, 'X'), 'signin', 'x')).toBe(UNAVAILABLE);
    expect(describeAuthError(new ApiError('Bad gateway', 502, 'X'), 'mfa', 'x')).toBe(UNAVAILABLE);
    expect(describeAuthError(new ApiError('boom', 503, 'X'), 'signin', 'x')).toBe(UNAVAILABLE);
  });

  it('only applies the "could not send" copy at 503', () => {
    // The message fragment alone is not enough; the status is part of the rule.
    expect(
      describeAuthError(new ApiError('Could not send code', 503, 'X'), 'send-code', 'x')
    ).toBe('We could not send your code. Please try again shortly.');
    expect(
      describeAuthError(new ApiError('Could not send code', 500, 'X'), 'send-code', 'x')
    ).toBe(UNAVAILABLE);
  });

  it('recognises a transport failure that never reached the server', () => {
    expect(describeAuthError(new TypeError('Failed to fetch'), 'signin', 'x')).toBe(OFFLINE);
    expect(describeAuthError(new Error('NetworkError when attempting to fetch'), 'mfa', 'x')).toBe(OFFLINE);
    expect(describeAuthError(new Error('ECONNREFUSED'), 'signin', 'x')).toBe(OFFLINE);
  });

  it('delegates to the shared sanitiser for everything else', () => {
    // A business refusal written for people passes through untouched.
    expect(describeAuthError(new Error('Select a branch from the list'), 'signin', 'x')).toBe(
      'Select a branch from the list'
    );
    // Driver output does not.
    expect(describeAuthError(new Error('relation "users" does not exist'), 'signin', 'fb')).toBe('fb');
    // Nothing at all renders as nothing at all.
    expect(describeAuthError(null, 'signin', 'fb')).toBe('');
  });
});
