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

const envStr = (k: string) => { const v = process.env[k]; return v && v.trim() !== '' ? v : undefined; };

const isLoopbackHost = (host: string) =>
  host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '0.0.0.0';

interface DbTarget {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

/** Parse a postgres:// or postgresql:// connection string (Supabase, Neon, RDS…). */
function parseDbUrl(raw: string | undefined): DbTarget | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== 'postgres:' && u.protocol !== 'postgresql:') return null;
    return {
      host: u.hostname || 'localhost',
      port: u.port ? Number(u.port) : 5432,
      user: u.username ? decodeURIComponent(u.username) : '',
      password: u.password ? decodeURIComponent(u.password) : '',
      database: u.pathname.replace(/^\//, '') || 'postgres',
    };
  } catch {
    return null;
  }
}

// DATABASE_URL (used by the migrate/seed tooling and by many PaaS setups) may
// provide the connection target. Individual POSTGRES_* variables, when set,
// take precedence so existing deployments keep working unchanged.
const urlDb = parseDbUrl(process.env.DATABASE_URL);
const postgresHost = envStr('POSTGRES_HOST') ?? urlDb?.host ?? 'localhost';
const postgresPort = envStr('POSTGRES_PORT') ?? String(urlDb?.port ?? 5432);
const postgresUser = envStr('POSTGRES_USER') ?? urlDb?.user ?? 'hopedesign';
const postgresPassword = envStr('POSTGRES_PASSWORD') ?? urlDb?.password ?? 'hopedesign_dev';
const postgresDatabase = envStr('POSTGRES_DB') ?? urlDb?.database ?? 'hopedesign_erp';

// TLS: managed providers such as Supabase/Neon require SSL on TCP connections.
// Default to SSL for any remote host, disable on loopback, and allow an
// explicit POSTGRES_SSL=true/false override (e.g. a private VPS Postgres that
// has TLS disabled).
const postgresSslRaw = envStr('POSTGRES_SSL');
const postgresSsl = postgresSslRaw
  ? !['0', 'false', 'disable'].includes(postgresSslRaw.toLowerCase())
  : !isLoopbackHost(postgresHost);

export const config = {
  env: process.env.NODE_ENV ?? 'development',
  port: num(process.env.PORT, 4000),
  postgres: {
    host: postgresHost,
    port: num(postgresPort, 5432),
    // POSTGRES_USER/POSTGRES_PASSWORD are the migration/bootstrap (owner) role.
    user: postgresUser,
    password: postgresPassword,
    database: postgresDatabase,
    // DB-001: the runtime pool MUST connect as the least-privilege
    // `hopedesign_app` role (non-superuser, non-BYPASSRLS) so RLS is enforced.
    // When the app-role variables are unset the pool keeps historical
    // behaviour so dev/tests run unchanged unless explicitly switched.
    appUser: envStr('POSTGRES_APP_USER') ?? postgresUser,
    appPassword: envStr('POSTGRES_APP_PASSWORD') ?? postgresPassword,
    ssl: postgresSsl,
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

// ---------------------------------------------------------------------------
// Production fail-fast gate (DB-001 / SEC-004).
//
// Never boot with missing, predictable, or owner-privileged credentials. A
// misconfigured deployment must crash loudly at cold start instead of silently
// using signing keys that allow token forgery or connecting with a role that
// bypasses row-level security. The runtime connection is the *application*
// role (config.postgres.appUser/appPassword), not the migration owner.
// ---------------------------------------------------------------------------
if (isProd) {
  const problems: string[] = [];

  const knownWeak = new Set([
    'change-me-in-production',
    'change-me-too',
    'change-me-doc-signing-v1',
    'hopedesign_dev',
    'hopedesign_app_dev',
    'postgres',
    'password',
    'secret',
  ]);

  const checkStrong = (name: string, value: string | undefined, minLen: number) => {
    if (!value || value.length < minLen || knownWeak.has(value.toLowerCase())) {
      problems.push(`${name} must be set to a strong, unique value (>= ${minLen} chars) in production`);
    }
  };

  // Signing keys – token forgery protection.
  checkStrong('JWT_SECRET', config.jwtSecret, 32);
  checkStrong('REFRESH_SECRET', config.refreshSecret, 32);
  checkStrong('DOC_SIGNING_SECRET', config.docSigningSecret, 32);

  // Database – the runtime pool must reach a remote host as a non-owner role.
  const dbHost = config.postgres.host;
  const dbUser = config.postgres.appUser;
  const dbPass = config.postgres.appPassword;

  if (isLoopbackHost(dbHost)) {
    problems.push('POSTGRES_HOST (or DATABASE_URL) must point to a remote managed database in production (found ' + dbHost + ')');
  }
  if (!dbUser || dbUser.length < 1) {
    problems.push('POSTGRES_APP_USER must be set in production');
  } else if (['postgres', 'hopedesign', 'supabase_admin', 'supabase_auth_admin', 'service_role'].includes(dbUser.toLowerCase())) {
    problems.push('POSTGRES_APP_USER must be the least-privilege application role (e.g. hopedesign_app), not the owner/superuser role "' + dbUser + '"');
  }
  if (!dbPass || dbPass.length < 16 || knownWeak.has(dbPass.toLowerCase())) {
    problems.push('POSTGRES_APP_PASSWORD must be a strong, unique password (>= 16 chars) in production');
  }

  if (problems.length > 0) {
    throw new Error('[config] Production boot blocked:\n  - ' + problems.join('\n  - '));
  }
}

