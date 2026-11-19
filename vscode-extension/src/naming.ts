import type { FlowConfig } from './config';

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Formats a Date into local YYYYMMDD (never UTC) so branch prefixes match the user's calendar date.
 */
export function formatLocalDate(date: Date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}${month}${day}`;
}

/**
 * Normalizes whitespace to the configured separator and trims redundant boundary separators.
 */
export function sanitizeTaskName(raw: string, separator = '_'): string {
  const sep = separator || '_';
  let result = raw.trim().replace(/\s+/g, sep);
  const escapedSep = escapeRegExp(sep);
  result = result.replace(new RegExp(`(?:${escapedSep}){2,}`, 'g'), sep);
  result = result.replace(new RegExp(`^(?:${escapedSep})+|(?:${escapedSep})+$`, 'g'), '');
  return result;
}

/**
 * Validates a task name for Git branch safety. Returns a Korean error message, or null when valid.
 */
export function validateTaskName(raw: string, separator = '_'): string | null {
  const sanitized = sanitizeTaskName(raw, separator);
  if (!sanitized) {
    return '작업명을 입력해 주세요.';
  }

  for (let i = 0; i < sanitized.length; i++) {
    const code = sanitized.charCodeAt(i);
    if (code < 32 || code === 127) {
      return '제어 문자는 브랜치 이름에 사용할 수 없습니다.';
    }
  }

  if (
    sanitized.includes('/') ||
    sanitized.includes('..') ||
    sanitized.includes('@{') ||
    /[~^:?*[\\]/.test(sanitized)
  ) {
    return '브랜치 이름에 사용할 수 없는 문자(/, .., @{, ~, ^, :, ?, *, [, \\)가 포함되어 있습니다.';
  }

  if (sanitized.startsWith('.') || sanitized.endsWith('.')) {
    return '브랜치 이름은 마침표(.)로 시작하거나 끝날 수 없습니다.';
  }

  if (sanitized.toLowerCase().endsWith('.lock')) {
    return '브랜치 이름은 .lock으로 끝날 수 없습니다.';
  }

  return null;
}

/**
 * Builds a task branch name formatted as `YYYYMMDD<separator><sanitizedTaskName>`.
 */
export function buildTaskBranchName(
  raw: string,
  config: Pick<FlowConfig, 'separator'>,
  date: Date = new Date()
): string {
  const sep = config.separator || '_';
  const validationError = validateTaskName(raw, sep);
  if (validationError) {
    throw new Error(validationError);
  }
  const sanitized = sanitizeTaskName(raw, sep);
  return `${formatLocalDate(date)}${sep}${sanitized}`;
}

/**
 * Checks whether a branch is a protected base branch (`develop` or `master`).
 */
export function isProtectedBranch(
  branch: string,
  config: Pick<FlowConfig, 'developBranch' | 'masterBranch'>
): boolean {
  return branch === config.developBranch || branch === config.masterBranch;
}
