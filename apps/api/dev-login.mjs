// dev-login.mjs - one-command developer login for HOPE DESIGN ERP (dev only).
// Uses the REAL auth flow: password -> TOTP (generated from the account's stored
// secret) -> access token. No bypass, no wildcard. Fail-closed: refuses to run
// unless NODE_ENV is development/test.
//   node dev-login.mjs            -> print credentials + fresh TOTP code
//   node dev-login.mjs --open     -> also open the web login page
//   node dev-login.mjs --browser  -> auto-login in a visible browser window
//
// DEV_LOGIN_USER may be a username (default: admin) or the alias "superadmin",
// which resolves to the user holding the super_administrator role.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(__dirname, 'package.json'));

const API = process.env.API_URL ?? 'http://localhost:4000';
const WEB = process.env.WEB_URL ?? 'http://localhost:5173';
function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : null;
}
const USER_REQUESTED = argValue('--user') ?? argValue('-u') ?? process.env.DEV_LOGIN_USER ?? 'admin';
const PASS = process.env.DEV_LOGIN_PASSWORD ?? 'ChangeMe!2026';
const SUPER_ALIASES = new Set(['superadmin', 'super_admin', 'super-administrator', 'super_administrator']);

if (process.env.NODE_ENV && !['development', 'test'].includes(process.env.NODE_ENV)) {
  console.error('dev-login refuses to run with NODE_ENV=' + process.env.NODE_ENV);
  process.exit(1);
}

const envPath = path.join(__dirname, '..', '..', '.env');
const env = {};
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
}

async function realLogin() {
  const pg = require('pg');
  const { authenticator } = require('otplib');
  const conn = env.DATABASE_URL || `postgres://${env.POSTGRES_USER}:${env.POSTGRES_PASSWORD}@${env.POSTGRES_HOST}:${env.POSTGRES_PORT}/${env.POSTGRES_DB}`;
  const pool = new pg.Pool({ connectionString: conn });

  // Resolve the account: alias "superadmin" -> holder of the super_administrator role.
  let username = USER_REQUESTED;
  let resolvedVia = null;
  if (SUPER_ALIASES.has(username.toLowerCase())) {
    const rr = await pool.query(`
      SELECT u.username, u.tenant_id, u.company_id
      FROM user_roles ur
      JOIN roles r ON r.id = ur.role_id
      JOIN users u ON u.id = ur.user_id
      WHERE r.code = 'super_administrator'
      ORDER BY u.id LIMIT 1`);
    if (!rr.rows[0]) throw new Error('no user holds the super_administrator role');
    username = rr.rows[0].username;
    resolvedVia = `superadmin alias -> ${username} (tenant ${rr.rows[0].tenant_id})`;
  }

  const res = await pool.query(
    'SELECT id, username, email, mfa_enabled, mfa_secret, tenant_id, company_id FROM users WHERE username = $1',
    [username],
  );
  const u = res.rows[0];
  await pool.end();
  if (!u) throw new Error(`user "${username}" not found`);

  const loginRes = await fetch(`${API}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ identifier: username, password: PASS }),
  });
  const login = await loginRes.json();
  if (login.accessToken) {
    return { user: u, token: login.accessToken, code: null, resolvedVia };
  }
  if (!login.loginToken || !login.mfaRequired) {
    throw new Error(`unexpected login response (${loginRes.status}): ${JSON.stringify(login)}`);
  }
  const code = u.mfa_secret ? authenticator.generate(u.mfa_secret) : null;
  if (!code) throw new Error(`no TOTP secret for ${username}`);
  const mfaRes = await fetch(`${API}/api/auth/mfa/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ loginToken: login.loginToken, code }),
  });
  const mfa = await mfaRes.json();
  if (!mfa.accessToken) throw new Error(`mfa verify failed (${mfaRes.status}): ${JSON.stringify(mfa)}`);
  return { user: u, token: mfa.accessToken, code, resolvedVia };
}

const { user: u, token, code, resolvedVia } = await realLogin();

console.log(`✔ ${u.username} logged in through REAL auth flow`);
if (resolvedVia) console.log(`  resolved  : ${resolvedVia}`);
console.log(`  user      : ${u.username} (id ${u.id}, tenant ${u.tenant_id}, company ${u.company_id})`);
console.log(`  email     : ${u.email}`);
if (code) {
  console.log(`  TOTP code : ${code}  (valid for the current 30s window)`);
  console.log(`  otpauth   : otpauth://totp/HOPE%20DESIGN:${encodeURIComponent(u.email)}?secret=${u.mfa_secret}&issuer=HOPE%20DESIGN`);
}
console.log(`  accessToken: ${token}`);

if (process.argv.includes('--browser')) {
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ headless: false, channel: 'msedge' });
  const page = await browser.newPage();
  await page.goto(WEB, { waitUntil: 'networkidle' });
  await page.waitForTimeout(600);
  await page.fill('input[placeholder="admin"]', u.username);
  await page.fill('input[type="password"]', PASS);
  await page.click('button[type="submit"]');
  if (code) {
    await page.waitForSelector('input[placeholder="000000"]', { timeout: 15000 });
    await page.fill('input[placeholder="000000"]', code);
    await page.click('button[type="submit"]');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1500);
  }
  console.log(`\nBrowser left open on ${page.url()} (${u.username}, real MFA completed).`);
  console.log('Keep this process running; closing it closes the demo window.');
  await new Promise(() => {});
} else if (process.argv.includes('--open')) {
  const opener = process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', WEB] : [WEB];
  spawnSync(opener, args, { stdio: 'ignore' });
  console.log(`\nOpened ${WEB} (sign in with ${u.username}${code ? ` / code ${code}` : ''})`);
}
