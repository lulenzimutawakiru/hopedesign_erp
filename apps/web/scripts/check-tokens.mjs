// Design-token guard.
//
// tokens.css is the single source of truth for the core colour palette.
// This script fails when one of those core colours is hard-coded anywhere
// else in the app (CSS or inline styles), because it should be referenced
// via var(--token) instead.
//
//   node scripts/check-tokens.mjs          # check only (exit 1 on violations)
//   node scripts/check-tokens.mjs --fix    # rewrite hard-coded hex -> var(--token)
//
// Run from apps/web (the package root).

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Core token colour -> its canonical hex (from tokens.css). Module accents and
// status tones alias these same values, so migrating to the core token is always
// colour-identical and just centralises the value.
const CORE_TOKENS = {
  '#0B1F33': '--navy',
  '#1261A0': '--hope',
  '#0E4F83': '--hope-hover',
  '#2E7DB2': '--steel',
  '#00A6A6': '--teal',
  '#168A5B': '--success',
  '#D99A00': '--warning',
  '#C93636': '--danger',
  '#2878D0': '--info',
  '#B42318': '--critical',
  '#F5F7FA': '--paper',
  '#EEF2F6': '--paper-2',
  '#172B3A': '--ink',
  '#5F6B76': '--muted',
  '#8995A1': '--muted-2',
  '#D9E1E8': '--line',
  '#C5D0D9': '--line-strong',
};

const SRC_ROOT = join(process.cwd(), 'src');
const FIX = process.argv.includes('--fix');

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|css)$/.test(entry.name) && !p.endsWith('tokens.css')) out.push(p);
  }
  return out;
}

let violations = 0;
let rewritten = 0;
const files = walk(SRC_ROOT);

for (const file of files) {
  const src = readFileSync(file, 'utf8');
  let changed = false;
  let next = src;
  for (const [hex, token] of Object.entries(CORE_TOKENS)) {
    // Match the exact 6-digit hex, not a prefix of a longer (8-digit RGBA) one.
    const re = new RegExp(hex.replace('#', '#') + '(?![0-9a-f])', 'gi');
    const hits = next.match(re);
    if (hits) {
      violations += hits.length;
      if (FIX) {
        next = next.replace(re, `var(${token})`);
        changed = true;
      }
    }
  }
  if (FIX && changed) {
    writeFileSync(file, next);
    rewritten += 1;
  }
}

if (FIX) {
  console.log(`check-tokens: rewrote ${violations} hard-coded colour(s) across ${rewritten} file(s) to var(--token).`);
} else if (violations > 0) {
  console.error(`check-tokens: ${violations} core colour(s) are hard-coded outside tokens.css. Run \`node scripts/check-tokens.mjs --fix\` to migrate them to var(--token).`);
  process.exit(1);
} else {
  console.log('check-tokens: ok');
}
