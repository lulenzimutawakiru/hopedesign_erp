/** Shared shapes for the sign-in surface. */

/** Which half of sign-in the panel is showing. */
export type Stage = 'credentials' | 'mfa';

/** How the second factor is being satisfied. Email is the default; TOTP stays for legacy enrollments. */
export type MfaMode = 'code' | 'email-enroll' | 'totp-enroll';

/**
 * Which step failed. A bare 400 carries no domain information, so the copy
 * falls back on where the user was standing when it arrived.
 */
export type AuthErrorContext = 'signin' | 'mfa' | 'send-code' | 'reset';
