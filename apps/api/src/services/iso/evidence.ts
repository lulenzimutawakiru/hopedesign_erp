import type { IsoControl, IsoEvidence, IsoFramework, IsoStatus } from './types.js';

export const ev = (path: string, note: string): IsoEvidence => ({ path, note });

export function control(
  framework: IsoFramework,
  code: string,
  title: string,
  theme: string,
  status: IsoStatus,
  owner: string,
  implementation: string,
  evidence: IsoEvidence[],
  gap: string | null,
): IsoControl {
  return { framework, code, title, theme, status, owner, implementation, evidence, gap };
}
