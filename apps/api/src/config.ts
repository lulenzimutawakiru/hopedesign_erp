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
    // DB-001: the runtime pool should connect as the least-privilege
    // `hopedesign_app` role (non-superuser, non-BYPASSRLS) in production.
    // POSTGRES_USER/POSTGRES_PASSWORD remain the migration/bootstrap role.
    // When the app-role variables are unset the pool keeps historical
    // behaviour so dev/tests run unchanged unless explicitly switched.
    appUser: process.env.POSTGRES_APP_USER ?? process.env.POSTGRES_USER ?? 'hopedesign',
    appPassword: process.env.POSTGRES_APP_PASSWORD ?? process.env.POSTGRES_PASSWORD ?? 'hopedesign_dev',
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
  africastalking: {
    username: process.env.AT_USERNAME ?? '',
    apiKey: process.env.AT_API_KEY ?? '',
    senderId: process.env.AT_SENDER_ID ?? '',
    whatsappNumber: process.env.AT_WHATSAPP_NUMBER ?? '',
  },
  resend: {
    apiKey: process.env.RESEND_API_KEY ?? '',
    fromEmail: process.env.RESEND_FROM_EMAIL ?? '',
    fromName: process.env.RESEND_FROM_NAME ?? 'HOPE DESIGN ERP',
  },
};

export const isProd = config.env === 'production';

// Fail fast in production: never boot with known fallback or missing secrets.
// A misconfigured deployment must crash loudly instead of silently using
// predictable signing keys that would allow token forgery.
if (isProd) {
  const weakSecrets: Array<[string, string]> = [
    ['JWT_SECRET', config.jwtSecret],
    ['REFRESH_SECRET', config.refreshSecret],
    ['DOC_SIGNING_SECRET', config.docSigningSecret],
    ['POSTGRES_PASSWORD', config.postgres.password],
    ['POSTGRES_APP_USER', config.postgres.appUser],
    ['POSTGRES_APP_PASSWORD', config.postgres.appPassword],
  ];
  const knownFallbacks = new Set([
    'change-me-in-production',
    'change-me-too',
    'change-me-doc-signing-v1',
    'hopedesign_dev',
    'hopedesign_app_dev',
    '',
  ]);
  for (const [name, value] of weakSecrets) {
    if (!value || knownFallbacks.has(value)) {
      throw new Error(`[config] ${name} must be set to a strong, unique value in production`);
    }
  }
}
