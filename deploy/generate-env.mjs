#!/usr/bin/env node
/**
 * Write a production `.env.production` with strong random secrets.
 *   node deploy/generate-env.mjs --domain hopedesign.jorlentech.com --email admin@hopedesign.jorlentech.com
 *   node deploy/generate-env.mjs --domain :80 --http   # HTTP only (no Let's Encrypt)
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dest = path.join(root, '.env.production');

function arg(flag, fallback = '') {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('-')
    ? process.argv[i + 1]
    : fallback;
}

const force = process.argv.includes('--force');
const httpOnly = process.argv.includes('--http');
const domain = arg('--domain', httpOnly ? ':80' : 'hopedesign.jorlentech.com');
const email = arg('--email', 'admin@hopedesign.jorlentech.com');
const seed = process.argv.includes('--seed');

if (fs.existsSync(dest) && !force) {
  console.error('.env.production already exists. Pass --force to overwrite.');
  process.exit(1);
}

const secret = (bytes = 48) => crypto.randomBytes(bytes).toString('base64url');
const ownerPass = secret(24);
const appPass = secret(24);
const scheme = httpOnly || domain === ':80' ? 'http' : 'https';
const publicHost = domain === ':80' ? 'localhost' : domain;
const publicUrl = `${scheme}://${publicHost}`;

const body = `# Generated ${new Date().toISOString()} by deploy/generate-env.mjs
DOMAIN=${domain}
ACME_EMAIL=${email}

WEB_PUBLIC_URL=${publicUrl}
API_PUBLIC_URL=${publicUrl}

NODE_ENV=production
PORT=4000
HOST=0.0.0.0
OTP_ISSUER=HopeDesignERP

POSTGRES_HOST=postgres
POSTGRES_PORT=5432
POSTGRES_USER=hopedesign
POSTGRES_PASSWORD=${ownerPass}
POSTGRES_DB=hopedesign_erp
POSTGRES_SSL=false
DATABASE_URL=postgres://hopedesign:${ownerPass}@postgres:5432/hopedesign_erp

POSTGRES_APP_USER=hopedesign_app
POSTGRES_APP_PASSWORD=${appPass}

JWT_SECRET=${secret()}
JWT_EXPIRES_IN=8h
REFRESH_SECRET=${secret()}
DOC_SIGNING_SECRET=${secret()}

STORAGE_ROOT=/data/uploads
RATE_LIMIT_WINDOW_MS=60000
RATE_LIMIT_MAX=300

SEED_ON_BOOT=${seed ? 'true' : 'false'}

BIRD_API_KEY=
BIRD_FROM_EMAIL=notifications@hopedesign.jorlentech.com
BIRD_FROM_NAME=HOPE DESIGN ERP
RESEND_API_KEY=
RESEND_FROM_EMAIL=notifications@hopedesign.jorlentech.com
RESEND_FROM_NAME=HOPE DESIGN ERP
AT_USERNAME=
AT_API_KEY=
AT_SENDER_ID=
NIIMBOT_ENABLED=false
`;

fs.writeFileSync(dest, body, { encoding: 'utf8', mode: 0o600 });
console.log('Wrote', dest);
console.log('Public URL:', publicUrl);
console.log('SEED_ON_BOOT:', seed ? 'true (change admin password after first login)' : 'false');
if (!httpOnly && domain === ':80') {
  console.log('HTTP-only bind. Re-run with --domain your.hostname for Lets Encrypt.');
}
