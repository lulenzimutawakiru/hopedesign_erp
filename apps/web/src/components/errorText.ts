/**
 * Failure text shown to users.
 *
 * The API deliberately returns human business refusals on 4xx (Zod messages,
 * Postgres RAISE EXCEPTION text such as a stock shortage, permission and
 * workflow errors) and a generic message on 5xx. What still reaches the browser
 * unfiltered is driver output: constraint violations, relation/column names,
 * and locally thrown errors that wrap a raw API message (export and QR
 * verification paths). Everything a user sees therefore passes through here.
 */

/**
 * A query echoed back in an error. Uppercase statements are matched outright;
 * a lowercase one must also carry statement punctuation so ordinary prose
 * ("Select a branch from the list") is not mistaken for SQL.
 */
const SQL_STATEMENT =
  /\bSELECT\b[^;]{0,120}\bFROM\b|\bINSERT\s+INTO\b|\bDELETE\s+FROM\b|\bUPDATE\s+\w+\s+SET\b|\b(?:select|insert|update|delete)\b[^;]{0,120}\b(?:from|into|set|values)\b[^;]{0,40}(?:[=*;]|\bwhere\b)/;

/**
 * Driver output, stack frames, file paths, machine codes and credentials that
 * must never reach a user's screen.
 */
const TECHNICAL_ARTEFACT =
  /(?:pg_|syntax error|stack trace|\bat\s+\w+\s*\(|\/[\w.-]+\.(?:ts|tsx|js|jsx|mjs|cjs):\d+|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|TypeError|ReferenceError|SyntaxError|RangeError|Cannot read propert|undefined is not|null is not|relation "|column "|duplicate key value|violates (?:foreign key|check|unique|not-null) constraint|null value in column|invalid input syntax|permission denied for (?:table|relation|schema)|<!doctype|<html|Bearer\s+ey)/i;

const UNREACHABLE =
  /(failed to fetch|networkerror|network request failed|load failed|fetch failed|err_network|err_internet|err_connection)/i;

const NETWORK_TEXT = 'Cannot reach the server. Check your connection and try again.';
const GENERIC_TEXT = 'Something went wrong. The action was not completed.';

/**
 * Statuses whose server text is never useful to a user: session, routing and
 * capacity outcomes, plus every server fault, which the API already collapses
 * to "Internal server error" but which must never be echoed on the chance it
 * carries something internal.
 */
const CANONICAL_ONLY = new Set([401, 404, 405, 408, 413, 429, 500, 501, 502, 503, 504]);

const STATUS_TEXT: Record<number, string> = {
  400: 'The request could not be processed. Review the information and try again.',
  401: 'Your session has expired. Sign in again to continue.',
  403: 'You do not have permission to perform this action.',
  404: 'This record could not be found. It may have been removed.',
  405: 'That action is not available here.',
  408: 'The server took too long to respond. Try again.',
  409: 'This record changed while you were working on it. Reload and try again.',
  413: 'That file is too large to upload.',
  422: 'Some information needs correcting. Check the highlighted fields and try again.',
  429: 'Too many requests in a short time. Wait a moment and try again.',
  500: 'Something went wrong on the server. The action was not completed.',
  501: 'That action is not available here.',
  502: 'The service is temporarily unavailable. Try again shortly.',
  503: 'The service is temporarily unavailable. Try again shortly.',
  504: 'The server took too long to respond. Try again.',
};

function rawMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (error === null || error === undefined) return '';
  return String(error);
}

function statusOf(error: unknown): number {
  const status = (error as { status?: unknown } | null | undefined)?.status;
  return typeof status === 'number' && Number.isFinite(status) ? status : 0;
}

function isHumanReadable(message: string): boolean {
  if (message.length < 3 || message.length > 240) return false;
  if (!/[A-Za-z]{3}/.test(message)) return false;
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(message)) return false;
  if (SQL_STATEMENT.test(message)) return false;
  if (TECHNICAL_ARTEFACT.test(message)) return false;
  if (message.startsWith('{') || message.startsWith('[')) return false;
  return true;
}

/**
 * English, user-facing text for any failure. Business refusals written for
 * people pass through unchanged; driver output, stack traces and machine codes
 * are replaced with a plain description of what the user can do next.
 */
export function describeError(error: unknown, fallback = GENERIC_TEXT): string {
  if (error === null || error === undefined || error === false) return '';
  const raw = rawMessage(error).trim();
  const status = statusOf(error);
  const canonical = status ? STATUS_TEXT[status] : undefined;
  if (canonical && CANONICAL_ONLY.has(status)) return canonical;
  if (raw && UNREACHABLE.test(raw)) return NETWORK_TEXT;
  if (raw && isHumanReadable(raw)) return raw;
  if (canonical) return canonical;
  return fallback;
}

/**
 * Strict variant for callers that supply their own default when a message is
 * not trustworthy enough to render at all.
 */
export function safeMessage(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  const message = error.message.trim();
  if (!message || message.length > 180) return undefined;
  if (!isHumanReadable(message)) return undefined;
  if (!/^[A-Z]/.test(message)) return undefined;
  return message;
}
