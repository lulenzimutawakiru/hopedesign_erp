import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { authenticator } from 'otplib';
import { randomBytes, createHash } from 'node:crypto';
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

export const redactUser = (row: Record<string, unknown>) => {
  const { password_hash: _ph, mfa_secret: _ms, ...rest } = row;
  return rest;
};
