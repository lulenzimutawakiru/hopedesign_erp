// Design-token guard.
//
// tokens.css is the single source of truth for the core colour palette.
// This script fails when one of those core colours is hard-coded in a CSS
// context where it should be referenced via var(--token) instead.
//
// A `var(--token)` reference is only valid where real CSS is parsed:
//   - .css files, and
//   - React inline `style={{ ... }}` objects.
// It is NOT valid in SVG presentation attributes (fill/stroke), <meta>
// content, <input> colour values, data strings, validation hint copy, or
// standalone export HTML/CSS strings (those documents load no tokens.css).
// This script therefore scans only CSS files and `style={{ ... }}` regions,
// so it never rewrites a colour into a context where var() would break it.
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
  '#6A7683': '--muted-2',
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

// Balanced `style={{ ... }}` regions in a .ts/.tsx file. Inline style objects
// are flat (no nested braces), but the walker still skips quoted strings so a
// stray brace inside a string value cannot unbalance it.
function styleRegions(src) {
  const regions = [];
  let i = 0;
  const kw = 'style={';
  while ((i = src.indexOf(kw, i)) !== -1) {
    const b = src.indexOf('{', i + kw.length);
    if (b === -1) break;
    let depth = 0;
    let j = b;
    for (; j < src.length; j++) {
      const c = src.charCodeAt(j);
      if (c === 123) depth++; // {
      else if (c === 125) { depth--; if (depth === 0) break; } // }
      else if (c === 34 || c === 39 || c === 96) { // " ' `
        const q = c;
        j++;
        while (j < src.length && src.charCodeAt(j) !== q) { if (src.charCodeAt(j) === 92) j++; j++; }
      }
    }
    if (depth === 0) { regions.push([b, j + 1]); i = j + 1; }
    else i = b + 1;
  }
  return regions;
}

// Count/replace core hex inside one region of `src`, returning the updated text.
function sweep(text) {
  let changed = false;
  let hits = 0;
  let next = text;
  for (const [hex, token] of Object.entries(CORE_TOKENS)) {
    const re = new RegExp(hex.replace('#', '#') + '(?![0-9a-f])', 'gi');
    const found = next.match(re);
    if (found) {
      hits += found.length;
      if (FIX) {
        next = next.replace(re, `var(${token})`);
        changed = true;
      }
    }
  }
  return { text: next, hits, changed };
}

let violations = 0;
let rewritten = 0;
const files = walk(SRC_ROOT);

for (const file of files) {
  const src = readFileSync(file, 'utf8');

  // CSS files: the whole file is a valid CSS context.
  // TS/TSX files: only inline `style={{ ... }}` objects are.
  const regions = file.endsWith('.css') ? [[0, src.length]] : styleRegions(src);
  if (regions.length === 0) continue;

  let changed = false;
  let next = src;
  // Apply regions right-to-left so earlier spans keep their offsets.
  for (let k = regions.length - 1; k >= 0; k--) {
    const [s, e] = regions[k];
    const inner = src.slice(s, e);
    const res = sweep(inner);
    if (res.hits) {
      violations += res.hits;
      if (res.changed) {
        next = next.slice(0, s) + res.text + next.slice(e);
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
  console.error(`check-tokens: ${violations} core colour(s) are hard-coded in a CSS context. Run \`node scripts/check-tokens.mjs --fix\` to migrate them to var(--token).`);
  process.exit(1);
} else {
  console.log('check-tokens: ok');
}
