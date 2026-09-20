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
 * Verification compares /build.json against the newest commit that touched
 * anything the images are built from, so a commit that only changes docs/
 * does not read as a failed rollout - and it samples that endpoint several
 * times, because the web pool spans nodes and one response cannot tell a
 * healthy pool from one where half the replicas still serve the old bundle.
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
// The web pool spans more than one node: deploy/caddy-live/webpeer*.caddy adds
// each peer VPS to the same Caddy reverse_proxy block, so a rolled-out node and
// a node that was never rebuilt both answer public requests. Such a pool does
// not look stale, it alternates between builds, which is why one sample cannot
// gate a deploy and why these are compared for unanimity instead.
const BUILD_SAMPLES = 8;

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
const BUILD_INPUTS = [
  'apps/api',
  'apps/web',
  'packages/db',
  'Dockerfile',
  'package.json',
  'package-lock.json',
];

// The newest commit that touched anything the images are built from. A commit
// that only touches docs/ does not move this, so a docs-only push legitimately
// leaves the running image - and /build.json - unchanged.
function newestInputChange() {
  const result = spawnSync('git', ['log', '-1', '--format=%cI', '--', ...BUILD_INPUTS], {
    encoding: 'utf8',
  });
  if (result.error || result.status !== 0) return null;
  const iso = (result.stdout ?? '').trim();
  return iso.length > 0 ? iso : null;
}

// Group the replies to /build.json by build id. A pool that rolled out together
// answers with exactly one id; a pool with a node that was not rebuilt answers
// with two or more, in proportion to how many replicas that node runs.
async function sampleBuildIds(base) {
  const seen = new Map();
  for (let i = 0; i < BUILD_SAMPLES; i += 1) {
    let id;
    let body = null;
    try {
      body = await fetchJson(base + '/build.json');
      id = typeof body.buildId === 'string' ? body.buildId : JSON.stringify(body);
    } catch (error) {
      const cause = error.cause && error.cause.code ? error.cause.code : null;
      id = 'unreachable (' + (cause ? cause + ': ' : '') + error.message + ')';
    }
    const entry = seen.get(id) ?? { count: 0, body };
    entry.count += 1;
    if (entry.body === null) entry.body = body;
    seen.set(id, entry);
  }
  return seen;
}

async function verify(domain) {
  const base = 'https://' + domain;
  let healthy = true;
  let build = null;

  try {
    const body = await fetchJson(base + '/api/health');
    console.log('  ok   /api/health  ' + JSON.stringify(body));
  } catch (error) {
    healthy = false;
    const cause = error.cause && error.cause.code ? error.cause.code : null;
    console.log('  FAIL /api/health  ' + (cause ? cause + ' - ' : '') + error.message);
  }

  const samples = await sampleBuildIds(base);
  const ids = [...samples.keys()];
  if (ids.length === 1 && samples.get(ids[0]).body !== null) {
    build = samples.get(ids[0]).body;
    console.log('  ok   /build.json  all ' + BUILD_SAMPLES + ' samples agree: ' + JSON.stringify(build));
  } else {
    const split = ids.length > 1;
    healthy = false;
    console.log('  FAIL /build.json  ' + (split
      ? ids.length + ' different bundles across ' + BUILD_SAMPLES + ' requests:'
      : 'unusable after ' + BUILD_SAMPLES + ' requests:'));
    for (const id of ids) {
      console.log('       ' + samples.get(id).count + ' x ' + id);
    }
    if (split) {
      console.log('       the web pool must serve one build id end to end; sync the peer');
      console.log('       nodes with deploy/sync-web-to-peer.sh');
    }
  }

  if (build && typeof build.builtAt === 'string') {
    const age = minutesSince(build.builtAt);
    const builtMs = Date.parse(build.builtAt);
    const inputsIso = newestInputChange();
    const inputsMs = inputsIso === null ? NaN : Date.parse(inputsIso);

    if (Number.isNaN(builtMs)) {
      console.log('  warn build.json has an unreadable builtAt: ' + build.builtAt);
    } else if (!Number.isNaN(inputsMs) && builtMs >= inputsMs) {
      console.log('  ok   live build ' + build.buildId + ' postdates the newest change to its');
      console.log('       own sources (' + inputsIso + '); built ' + age + ' minutes ago');
    } else if (Number.isNaN(inputsMs)) {
      if (age === null || age > FRESH_MINUTES) {
        console.log('  warn live build is ' + age + ' minutes old and this is not a git');
        console.log('       checkout, so freshness cannot be confirmed');
        healthy = false;
      } else {
        console.log('  ok   live build ' + build.buildId + ' is ' + age + ' minutes old');
      }
    } else {
      healthy = false;
      console.log('  FAIL live build predates the newest change to its own sources');
      console.log('       built ' + build.builtAt + ' but that source changed ' + inputsIso);
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
