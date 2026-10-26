import { ANNEX_A_CONTROLS } from './annex-a.js';
import { ISO_9001_CONTROLS } from './iso-9001.js';
import {
  ISO_ASSESSED_ON,
  ISO_DISCLAIMER,
  type IsoControl,
  type IsoFramework,
  type IsoQuery,
  type IsoStatus,
  type IsoSummary,
} from './types.js';

export { ISO_ASSESSED_ON, ISO_DISCLAIMER };
export type { IsoControl, IsoFramework, IsoQuery, IsoStatus, IsoSummary };

const STATUSES: IsoStatus[] = ['implemented', 'partial', 'planned'];

function annexCodes(prefix: string, from: number, to: number): string[] {
  const codes: string[] = [];
  for (let n = from; n <= to; n += 1) codes.push(`${prefix}${n}`);
  return codes;
}

/** The 93 identifiers in ISO/IEC 27001:2022 Annex A. */
export const ANNEX_A_CODES: string[] = [
  ...annexCodes('A.5.', 1, 37),
  ...annexCodes('A.6.', 1, 8),
  ...annexCodes('A.7.', 1, 14),
  ...annexCodes('A.8.', 1, 34),
];

/** ISO 9001:2015 clauses this product has machinery for. */
export const ISO_9001_CODES: string[] = [
  '7.5', '8.1', '8.2', '8.4', '8.5.1', '8.5.2', '8.5.3', '8.5.4',
  '8.5.5', '8.5.6', '8.6', '8.7', '9.1', '9.2', '10.2', '10.3',
];

export const ISO_CONTROLS: IsoControl[] = [...ANNEX_A_CONTROLS, ...ISO_9001_CONTROLS];

function frameworkKey(framework: IsoFramework): string {
  return framework.includes('27001') ? '27001' : '9001';
}

function matchesFramework(control: IsoControl, framework: string | undefined): boolean {
  if (!framework) return true;
  const want = framework.trim().toLowerCase();
  if (want === '27001' || want === '27002' || want.includes('27001')) {
    return control.framework === 'ISO/IEC 27001:2022';
  }
  if (want === '9001' || want.includes('9001')) return control.framework === 'ISO 9001:2015';
  return control.framework.toLowerCase() === want;
}

export function queryRegister(query: IsoQuery = {}): IsoControl[] {
  const status = query.status?.trim().toLowerCase();
  const q = query.q?.trim().toLowerCase();
  return ISO_CONTROLS.filter((control) => {
    if (!matchesFramework(control, query.framework)) return false;
    if (status && control.status !== status) return false;
    if (!q) return true;
    const hay = [
      control.code, control.title, control.theme, control.owner,
      control.implementation, control.gap ?? '',
      ...control.evidence.map((item) => `${item.path} ${item.note}`),
    ].join(' ').toLowerCase();
    return hay.includes(q);
  });
}

export function findControl(code: string): IsoControl | null {
  const want = code.trim().toLowerCase();
  return ISO_CONTROLS.find((control) => control.code.toLowerCase() === want) ?? null;
}

export function summariseRegister(controls: IsoControl[] = ISO_CONTROLS): IsoSummary[] {
  const frameworks: IsoFramework[] = ['ISO/IEC 27001:2022', 'ISO 9001:2015'];
  return frameworks.map((framework) => {
    const rows = controls.filter((control) => control.framework === framework);
    return {
      framework,
      implemented: rows.filter((control) => control.status === 'implemented').length,
      partial: rows.filter((control) => control.status === 'partial').length,
      planned: rows.filter((control) => control.status === 'planned').length,
      total: rows.length,
    };
  });
}

/**
 * Structural problems in the register. An empty list is the bar for shipping
 * a status: every Annex A code once, evidence on anything we claim is in
 * place, and a gap wherever the control is not implemented.
 */
export function registerProblems(): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const control of ISO_CONTROLS) {
    const key = `${control.framework}:${control.code}`;
    if (seen.has(key)) problems.push(`duplicate ${key}`);
    seen.add(key);
    if (!control.title.trim()) problems.push(`${control.code} has no title`);
    if (!control.owner.trim()) problems.push(`${control.code} has no owner`);
    if (!STATUSES.includes(control.status)) problems.push(`${control.code} has status ${control.status}`);
    if (control.status === 'implemented') {
      if (control.evidence.length === 0) problems.push(`${control.code} is implemented without evidence`);
      if (control.gap) problems.push(`${control.code} is implemented but still names a gap`);
    }
    if (control.status === 'partial') {
      if (control.evidence.length === 0) problems.push(`${control.code} is partial without evidence`);
      if (!control.gap) problems.push(`${control.code} is partial without a gap`);
    }
    if (control.status === 'planned' && !control.gap) problems.push(`${control.code} is planned without a gap`);
    for (const item of control.evidence) {
      if (!item.path.trim() || !item.note.trim()) problems.push(`${control.code} has an empty evidence ref`);
    }
  }
  const annex = new Set(ISO_CONTROLS.filter((c) => c.framework === 'ISO/IEC 27001:2022').map((c) => c.code));
  for (const code of ANNEX_A_CODES) {
    if (!annex.has(code)) problems.push(`missing Annex A ${code}`);
  }
  for (const code of annex) {
    if (!ANNEX_A_CODES.includes(code)) problems.push(`unexpected Annex A ${code}`);
  }
  const iso9 = ISO_CONTROLS.filter((c) => c.framework === 'ISO 9001:2015').map((c) => c.code);
  if (iso9.join(',') !== ISO_9001_CODES.join(',')) {
    problems.push(`ISO 9001 codes are ${iso9.join(', ')}`);
  }
  return problems;
}

function cell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function evidenceLine(control: IsoControl): string {
  if (control.evidence.length === 0) return '—';
  return control.evidence.map((item) => `\`${item.path}\` (${item.note})`).join('; ');
}

/** Auditor-facing document. The test requires this to match docs/ISO_CONTROL_REGISTER.md. */
export function renderRegisterMarkdown(): string {
  const summary = summariseRegister();
  const lines: string[] = [
    '# Hope Design ERP — ISO control register',
    '',
    '| Field | Value |',
    '|---|---|',
    `| Assessed | ${ISO_ASSESSED_ON} |`,
    '| Subject | Hope Design ERP (API, web, database, deploy kit) |',
    '| Frameworks | ISO/IEC 27001:2022 Annex A (93 controls); ISO 9001:2015 clauses this product operates |',
    '| Status | Internal alignment register |',
    '',
    ISO_DISCLAIMER,
    '',
    'A control is **implemented** when the repository enforces it and no gap is left in that enforcement. It is **partial** when a related control exists and a named gap remains. It is **planned** when the system does not operate the control. Titles identify the clause. The notes are an assessment of this codebase, not the text of the standard.',
    '',
    'The same register is served at `GET /api/ops/compliance/iso` and shown at `/compliance/iso` to anyone holding `compliance.iso.view`.',
    '',
    '## Summary',
    '',
    '| Framework | Implemented | Partial | Planned | Total |',
    '|---|---:|---:|---:|---:|',
  ];
  for (const row of summary) {
    lines.push(`| ${row.framework} | ${row.implemented} | ${row.partial} | ${row.planned} | ${row.total} |`);
  }
  lines.push('');
  lines.push('ISO 9001 clauses on organisational context, leadership and planning are omitted. This product does not operate them, so they are not given a status.');
  lines.push('');
  for (const framework of ['ISO/IEC 27001:2022', 'ISO 9001:2015'] as const) {
    lines.push(`## ${framework}`, '');
    lines.push('| Code | Title | Status | Owner | What the system does | Evidence | Gap |');
    lines.push('|---|---|---|---|---|---|---|');
    for (const control of ISO_CONTROLS.filter((item) => item.framework === framework)) {
      lines.push(`| ${[
        cell(control.code),
        cell(control.title),
        control.status,
        cell(control.owner),
        cell(control.implementation),
        cell(evidenceLine(control)),
        cell(control.gap ?? '—'),
      ].join(' | ')} |`);
    }
    lines.push('');
  }
  lines.push('## What this register does not do', '');
  lines.push('- It does not certify Hope Design ERP.');
  lines.push('- It does not replace a management-signed Statement of Applicability.');
  lines.push('- It does not close the partial and planned rows. Those rows are the remaining work.');
  lines.push('');
  return lines.join('\n');
}
