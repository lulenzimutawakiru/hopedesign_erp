import { config as loadEnv } from 'dotenv';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Load the repo-root .env so dev servers and tests share one configuration
// regardless of the process working directory.
const here = path.dirname(fileURLToPath(import.meta.url));
loadEnv({ path: path.resolve(here, '../../../.env') });
loadEnv(); // fall back to CWD .env if the repo root file is absent

const num = (v: string | undefined, d: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

export const config = {
  env: process.env.NODE_ENV ?? 'development',
  port: num(process.env.PORT, 4000),
  postgres: {
    host: process.env.POSTGRES_HOST ?? 'localhost',
    port: num(process.env.POSTGRES_PORT, 5432),
    user: process.env.POSTGRES_USER ?? 'hopedesign',
    password: process.env.POSTGRES_PASSWORD ?? 'hopedesign_dev',
    database: process.env.POSTGRES_DB ?? 'hopedesign_erp',
  },
  jwtSecret: process.env.JWT_SECRET ?? 'change-me-in-production',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? '8h',
  refreshSecret: process.env.REFRESH_SECRET ?? 'change-me-too',
  refreshExpiresDays: 14,
  docSigningSecret: process.env.DOC_SIGNING_SECRET ?? 'change-me-doc-signing-v1',
  apiPublicUrl: process.env.API_PUBLIC_URL ?? 'http://localhost:4000',
  webPublicUrl: process.env.WEB_PUBLIC_URL ?? 'http://localhost:5173',
  otpIssuer: process.env.OTP_ISSUER ?? 'HopeDesignERP',
  rateLimitWindowMs: num(process.env.RATE_LIMIT_WINDOW_MS, 60_000),
  rateLimitMax: num(process.env.RATE_LIMIT_MAX, 300),
  storageRoot: process.env.STORAGE_ROOT ?? './data/uploads',
  bird: {
    apiKey: process.env.BIRD_API_KEY ?? '',
    fromEmail: process.env.BIRD_FROM_EMAIL ?? 'notifications@hopedesign.ug',
    fromName: process.env.BIRD_FROM_NAME ?? 'HOPE DESIGN ERP',
    smsFrom: process.env.BIRD_SMS_FROM ?? '',
    whatsappFrom: process.env.BIRD_WHATSAPP_FROM ?? '',
  },
};

export const isProd = config.env === 'production';
