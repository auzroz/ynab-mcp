/**
 * String Sanitization Utilities
 *
 * Sanitizes user-controlled strings before including in responses
 * to prevent log forging, injection, and other security issues.
 */

/**
 * Sanitize a user-provided string for safe output.
 *
 * - Removes control characters (except common whitespace)
 * - Trims whitespace
 * - Enforces maximum length
 * - Returns null for null/undefined input
 */
export function sanitizeString(
  input: string | null | undefined,
  maxLength: number = 500
): string | null {
  if (input === null || input === undefined) {
    return null;
  }

  // Ensure maxLength is a valid positive integer
  const effectiveMaxLength = Math.max(1, Math.floor(Number(maxLength) || 500));

  // Convert to string if not already
  const str = String(input);

  // Remove control characters except tab, newline, carriage return
  // Includes: ASCII controls (0x00-0x1F, 0x7F), C1 controls (0x80-0x9F),
  // zero-width characters (U+200B-U+200F, U+FEFF),
  // and Unicode line/paragraph separators (U+2028, U+2029) which can break JS string literals
  // eslint-disable-next-line no-control-regex
  const cleaned = str.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F\x80-\x9F\u200B-\u200F\u2028\u2029\uFEFF]/g, '');

  // Trim whitespace
  const trimmed = cleaned.trim();

  // Enforce max length (reserve space for ellipsis to stay within limit)
  if (trimmed.length > effectiveMaxLength) {
    if (effectiveMaxLength <= 3) {
      return trimmed.substring(0, effectiveMaxLength);
    }
    return trimmed.substring(0, effectiveMaxLength - 3) + '...';
  }

  return trimmed;
}

/**
 * Sanitize a string, returning empty string instead of null for missing input.
 * Useful when a non-null string is required.
 */
export function sanitizeStringOrEmpty(
  input: string | null | undefined,
  maxLength: number = 500
): string {
  return sanitizeString(input, maxLength) ?? '';
}

/**
 * Sanitize a memo or note field (allows slightly longer content).
 */
export function sanitizeMemo(input: string | null | undefined): string | null {
  return sanitizeString(input, 1000);
}

/**
 * Sanitize a name field (account name, category name, payee name).
 * Returns 'Unknown' for null, undefined, or empty/whitespace-only input.
 */
export function sanitizeName(input: string | null | undefined): string {
  const sanitized = sanitizeString(input, 200);
  return sanitized && sanitized.length > 0 ? sanitized : 'Unknown';
}
