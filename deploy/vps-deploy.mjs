#!/usr/bin/env node
/**
 * HOPE DESIGN ERP - roll out to the production VPS from a workstation.
 *
 * CI (.github/workflows/production.yml) is the primary path. This is the
 * fallback for when Actions is unavailable, and it runs the same command the
 * workflow does, so both paths roll out identically.
 *
 *   node deploy/vps-deploy.mjs              roll out, then verify the result
 *   node deploy/vps-deploy.mjs --check      verify only, no rollout
 *   node deploy/vps-deploy.mjs --dry-run    print the command, run nothing
 *
 * Endpoint comes from --host/--port/--user/--domain or VPS_HOST/VPS_PORT/
 * VPS_USER/VPS_DOMAIN, defaulting to the documented production host.
 *
 * Authentication is left entirely to ssh: a loaded key if you have one,
 * otherwise ssh's own interactive prompt. This script never reads, stores or
 * echoes a credential.
 */

import { spawnSync } from 'node:child_process';

const APP_DIR = '/opt/hopedesign_erp';
const ROLLOUT = 'bash deploy/zero-downtime-deploy.sh';
const FRESH_MINUTES = 20;

const DEFAULTS = {
  host: process.env.VPS_HOST ?? '23.239.220.214',
  port: process.env.VPS_PORT ?? '2978',
  user: process.env.VPS_USER ?? 'root',
  domain: process.env.VPS_DOMAIN ?? 'hopedesign.jorlentech.com',
};

const USAGE = [
  'usage: node deploy/vps-deploy.mjs [options]',
  '',
  '  --host <host>      default ' + DEFAULTS.host,
  '  --port <port>      default ' + DEFAULTS.port,
  '  --user <user>      default ' + DEFAULTS.user,
  '  --domain <domain>  default ' + DEFAULTS.domain,
  '  --check            verify the live deployment only',
  '  --dry-run          print the ssh command without running it',
  '  -h, --help         show this text',
].join('\n');

function fail(message, code = 2) {
  console.error('error: ' + message);
  process.exit(code);
}

function parse(argv) {
  const options = { ...DEFAULTS, check: false, dryRun: false, help: false };
  let i = 0;
  while (i < argv.length) {
    const token = argv[i];
    const take = () => {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) fail(token + ' requires a value');
      i += 1;
      return next;
    };
    if (token === '--host') options.host = take();
    else if (token === '--port') options.port = take();
    else if (token === '--user') options.user = take();
    else if (token === '--domain') options.domain = take();
    else if (token === '--check') options.check = true;
    else if (token === '--dry-run') options.dryRun = true;
    else if (token === '--help' || token === '-h') options.help = true;
    else fail('unknown argument: ' + token + '\n\n' + USAGE);
    i += 1;
  }
  return options;
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error('HTTP ' + response.status);
  return response.json();
}

function minutesSince(iso) {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return null;
  return Math.round((Date.now() - then) / 60000);
}

async function verify(domain) {
  const base = 'https://' + domain;
  const probes = [
    ['/api/health', base + '/api/health'],
    ['/build.json', base + '/build.json'],
  ];
  let healthy = true;
  let build = null;

  for (const [label, url] of probes) {
    try {
      const body = await fetchJson(url);
      console.log('  ok   ' + label + '  ' + JSON.stringify(body));
      if (label === '/build.json') build = body;
    } catch (error) {
      healthy = false;
      const cause = error.cause && error.cause.code ? error.cause.code : null;
      console.log('  FAIL ' + label + '  ' + (cause ? cause + ' - ' : '') + error.message);
    }
  }

  if (build && typeof build.builtAt === 'string') {
    const age = minutesSince(build.builtAt);
    if (age === null) {
      console.log('  warn build.json has an unreadable builtAt: ' + build.builtAt);
    } else if (age > FRESH_MINUTES) {
      console.log('  warn live build is ' + age + ' minutes old - the rollout may not have shipped');
      healthy = false;
    } else {
      console.log('  ok   live build ' + build.buildId + ' is ' + age + ' minutes old');
    }
  }
  return healthy;
}

const options = parse(process.argv.slice(2));
if (options.help) {
  console.log(USAGE);
  process.exit(0);
}

const target = options.user + '@' + options.host;
const remote = 'cd ' + APP_DIR + ' && ' + ROLLOUT;
const sshLine = 'ssh -t -p ' + options.port + ' ' + target + " '" + remote + "'";

console.log('target  : ' + target + ':' + options.port);
console.log('rollout : ' + remote);

if (options.dryRun) {
  console.log('\n' + sshLine);
  process.exit(0);
}

if (!options.check) {
  console.log('\n' + sshLine + '\n');
  const result = spawnSync('ssh', ['-t', '-p', options.port, target, remote], { stdio: 'inherit' });
  if (result.error) fail('could not run ssh: ' + result.error.message, 1);
  if (result.status !== 0) fail('rollout failed (ssh exit ' + result.status + ')', 1);
  console.log('\nrollout finished; verifying ' + options.domain);
}

const ok = await verify(options.domain);
console.log(ok ? '\nverified: ' + options.domain + ' is healthy' : '\nNOT verified: see failures above');
process.exit(ok ? 0 : 1);