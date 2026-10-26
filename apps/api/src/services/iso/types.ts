/**
 * Internal ISO alignment register for Hope Design ERP.
 *
 * Control titles identify ISO/IEC 27001:2022 Annex A and the ISO 9001:2015
 * clauses this product already operates. The implementation notes are an
 * assessment of this codebase. They are not the text of either standard, and
 * the register is not a certificate.
 */

export const ISO_ASSESSED_ON = '2026-10-26';

export const ISO_DISCLAIMER =
  'Internal alignment register for Hope Design ERP. It records what this system implements against ISO/IEC 27001:2022 Annex A and the ISO 9001:2015 clauses already operated here. It is not a certificate, not a signed Statement of Applicability, and not a copy of the standards.';

export type IsoFramework = 'ISO/IEC 27001:2022' | 'ISO 9001:2015';

export type IsoStatus = 'implemented' | 'partial' | 'planned';

export type IsoEvidence = {
  /** Path relative to the Hope Design ERP repository root. */
  path: string;
  note: string;
};

export type IsoControl = {
  framework: IsoFramework;
  code: string;
  title: string;
  theme: string;
  status: IsoStatus;
  /** Role that should own the control in this company. Not a named person. */
  owner: string;
  /** What this system does. Original assessment text. */
  implementation: string;
  evidence: IsoEvidence[];
  /** Remaining gap. Required for partial and planned. */
  gap: string | null;
};

export type IsoQuery = {
  framework?: string;
  status?: string;
  q?: string;
};

export type IsoSummary = {
  framework: IsoFramework;
  implemented: number;
  partial: number;
  planned: number;
  total: number;
};
