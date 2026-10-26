import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ANNEX_A_CODES,
  findControl,
  ISO_CONTROLS,
  queryRegister,
  registerProblems,
  renderRegisterMarkdown,
  summariseRegister,
} from '../src/services/iso/register.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

describe('ISO control register', () => {
  it('covers every Annex A control once and refuses an unsupported status', () => {
    expect(ANNEX_A_CODES).toHaveLength(93);
    expect(registerProblems()).toEqual([]);
  });

  it('points every evidence path at a file in this repository', () => {
    const missing = new Set<string>();
    for (const control of ISO_CONTROLS) {
      for (const item of control.evidence) {
        if (!existsSync(path.join(repoRoot, item.path))) missing.add(`${control.code} ${item.path}`);
      }
    }
    expect([...missing]).toEqual([]);
  });

  it('filters by framework, status and text without changing the assessment', () => {
    expect(queryRegister({ framework: '27001' })).toHaveLength(93);
    expect(queryRegister({ framework: '9001' }).every((row) => row.framework === 'ISO 9001:2015')).toBe(true);
    expect(queryRegister({ status: 'planned' }).every((row) => row.status === 'planned')).toBe(true);
    expect(findControl('A.5.15')?.status).toBe('implemented');
    expect(findControl('8.5.2')?.status).toBe('implemented');
    expect(findControl('nope')).toBeNull();
    const summary = summariseRegister();
    expect(summary.reduce((n, row) => n + row.total, 0)).toBe(ISO_CONTROLS.length);
  });

  it('matches the document a reader opens', () => {
    const doc = readFileSync(path.join(repoRoot, 'docs/ISO_CONTROL_REGISTER.md'), 'utf8');
    expect(doc).toBe(renderRegisterMarkdown());
  });
});
