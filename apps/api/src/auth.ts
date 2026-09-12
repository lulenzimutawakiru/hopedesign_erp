import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { authenticator } from 'otplib';
import { randomBytes, randomInt, timingSafeEqual, createHash } from 'node:crypto';
import { config } from './config.js';

export const hashPassword = (plain: string) => bcrypt.hash(plain, 10);
export const verifyPassword = (plain: string, hash: string) => bcrypt.compare(plain, hash);

export interface AccessPayload {
  sub: number;
  tid: number;
  type: 'access';
  sid?: number;
}

export const signAccessToken = (payload: AccessPayload) =>
  jwt.sign(payload, config.jwtSecret, { expiresIn: config.jwtExpiresIn as jwt.SignOptions['expiresIn'] });

export const verifyAccessToken = (token: string): AccessPayload => {
  const decoded = jwt.verify(token, config.jwtSecret) as unknown as AccessPayload;
  if (decoded.type !== 'access') throw new Error('Invalid token type');
  return decoded;
};

export const signLoginToken = (userId: number, tenantId: number) =>
  jwt.sign({ sub: userId, tid: tenantId, type: 'login' }, config.jwtSecret, { expiresIn: '10m' as jwt.SignOptions['expiresIn'] });

export const verifyLoginToken = (token: string): { sub: number; tid: number } => {
  const decoded = jwt.verify(token, config.jwtSecret) as unknown as { sub: number; tid: number; type: string };
  if (decoded.type !== 'login') throw new Error('Invalid token type');
  return decoded;
};

export const generateRefreshToken = () => randomBytes(48).toString('base64url');
export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

/** TOTP secret for MFA. */
export const generateTotpSecret = () => authenticator.generateSecret();
export const generateTotpQrData = (email: string, secret: string) =>
  authenticator.keyuri(email, config.otpIssuer, secret);

/** otpauth URL plus a scannable PNG data URL for enrollment screens. */
export async function totpEnrollmentPayload(email: string, secret: string) {
  const otpauthUrl = generateTotpQrData(email, secret);
  const { default: QRCode } = await import('qrcode');
  const qrDataUrl = await QRCode.toDataURL(otpauthUrl, {
    width: 200,
    margin: 1,
    errorCorrectionLevel: 'M',
    color: { dark: '#0B1F33', light: '#FFFFFF' },
  });
  return { secret, otpauthUrl, qrDataUrl };
}
export const verifyTotp = (secret: string, code: string) => {
  try {
    return authenticator.verify({ token: code, secret });
  } catch {
    return false;
  }
};

/**
 * MFA-002: a six-digit one-time code for email delivery.
 * randomInt is the CSPRNG-backed, rejection-sampled generator - never
 * Math.random, which is not cryptographically secure and is biased by modulo.
 */
export const generateEmailOtp = () => String(randomInt(0, 1_000_000)).padStart(6, '0');

/**
 * Only the hash of a sign-in code is ever stored or compared. The value is
 * domain-separated so a code hash can never collide with a session/refresh
 * token hash produced by the same primitive.
 */
export const hashOtp = (code: string) => hashToken(`mfa-email-otp:${String(code).trim()}`);

/** Constant-time comparison of two hex digests. */
export const safeEqualHex = (a: string, b: string) => {
  const left = Buffer.from(String(a), 'hex');
  const right = Buffer.from(String(b), 'hex');
  if (left.length === 0 || left.length !== right.length) return false;
  return timingSafeEqual(left, right);
};

/**
 * Display form of an address for a challenge screen: first character plus a
 * fixed-width mask. Never reveals how long the local part is.
 */
export const maskEmail = (value: string | null | undefined): string | null => {
  const email = String(value ?? '').trim();
  const at = email.lastIndexOf('@');
  if (at <= 0 || at === email.length - 1) return null;
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  return `${local.slice(0, 1)}${'\u2022'.repeat(4)}@${domain}`;
};

export const redactUser = (row: Record<string, unknown>) => {
  const { password_hash: _ph, mfa_secret: _ms, personal_email: _pe, ...rest } = row;
  return rest;
};
