/**
 * /.well-known/security.txt (RFC 9116): parsing the operator's settings and
 * rendering the file. Pure: no I/O, and the clock is a parameter.
 *
 * Every field value is a single line with no control characters (an operator
 * value with a line break could add fields to the file). Errors name the
 * variable only, never its value.
 */

/** RFC 9116 section 2.5.5: Expires is at most a year out; this server always says 180 days. */
export const SECURITY_TXT_VALIDITY_DAYS = 180;

/** At most this many Contact lines. */
export const MAX_SECURITY_CONTACTS = 5;

/** ASCII control characters (C0 and DEL) and Unicode line separators. */
// eslint-disable-next-line no-control-regex
const CONTROL_OR_BREAK = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029]');
const ANY_WHITESPACE = /\s/;
const EMAIL = /^[^\s@<>()[\]\\,;:"]+@[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,}$/;
const MAX_VALUE_LENGTH = 512;

/** A single-line URI safe to put in a field: no control characters, no whitespace, bounded. */
function assertSingleLine(raw: string, varName: string): void {
  if (CONTROL_OR_BREAK.test(raw)) {
    throw new Error(`Invalid ${varName}: must not contain control characters or line breaks.`);
  }
  if (ANY_WHITESPACE.test(raw)) {
    throw new Error(`Invalid ${varName}: must not contain whitespace.`);
  }
  if (raw.length > MAX_VALUE_LENGTH) {
    throw new Error(`Invalid ${varName}: too long.`);
  }
}

/**
 * `SECURITY_CONTACT`: one or more comma-separated contacts, each an email
 * address (written as `mailto:` in the file), a `mailto:`, `tel:` or `https:`
 * URI. Returns the normalized URIs; empty when unset or blank. Throws
 * (value-free) on anything else, including a control character anywhere.
 */
export function parseSecurityContacts(raw: string | undefined, varName = 'SECURITY_CONTACT'): string[] {
  if (raw === undefined) return [];
  // Checked on the whole value first, so a control character cannot hide in a separator.
  if (CONTROL_OR_BREAK.test(raw)) {
    throw new Error(`Invalid ${varName}: must not contain control characters or line breaks.`);
  }
  const items = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (items.length > MAX_SECURITY_CONTACTS) {
    throw new Error(`Invalid ${varName}: at most ${MAX_SECURITY_CONTACTS} contacts.`);
  }
  return items.map((item) => {
    assertSingleLine(item, varName);
    if (EMAIL.test(item)) {
      // RFC 6068: a reserved character in the address must be percent-encoded, or `?` and `#`
      // would start the URI's header fields and fragment instead of staying part of the recipient.
      const at = item.lastIndexOf('@');
      const local = encodeURIComponent(item.slice(0, at));
      return `mailto:${local}${item.slice(at)}`;
    }
    let url: URL;
    try {
      url = new URL(item);
    } catch {
      throw new Error(`Invalid ${varName}: each contact must be an email address or a mailto:, tel: or https: URI.`);
    }
    if (url.protocol === 'https:' || url.protocol === 'mailto:' || url.protocol === 'tel:') {
      if ((url.protocol === 'mailto:' || url.protocol === 'tel:') && url.pathname === '') {
        throw new Error(`Invalid ${varName}: a mailto: or tel: contact needs a destination.`);
      }
      return item;
    }
    throw new Error(`Invalid ${varName}: each contact must be an email address or a mailto:, tel: or https: URI.`);
  });
}

/** `SECURITY_POLICY_URL`: an https URL, or undefined when unset or blank. Throws (value-free) otherwise. */
export function parseSecurityPolicyUrl(raw: string | undefined, varName = 'SECURITY_POLICY_URL'): string | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const value = raw.trim();
  assertSingleLine(value, varName);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Invalid ${varName}: must be an absolute https URL.`);
  }
  if (url.protocol !== 'https:') {
    throw new Error(`Invalid ${varName}: must be an absolute https URL.`);
  }
  return value;
}

export interface SecurityTxtFields {
  /** Normalized contact URIs (see parseSecurityContacts); at least one. */
  contacts: readonly string[];
  /** The policy URL, if any. */
  policy?: string | undefined;
  /** The URL this file is served at (PUBLIC_URL + the well-known path), if known. */
  canonical?: string | undefined;
  /** The current time; Expires is this plus SECURITY_TXT_VALIDITY_DAYS. */
  now: Date;
}

/** The file's text: Contact, Expires, then Policy and Canonical when set. Ends with a newline. */
export function renderSecurityTxt(fields: SecurityTxtFields): string {
  const expires = new Date(fields.now.getTime() + SECURITY_TXT_VALIDITY_DAYS * 24 * 60 * 60 * 1000);
  const lines = fields.contacts.map((c) => `Contact: ${c}`);
  // RFC 3339 date-time in UTC, without fractional seconds.
  lines.push(`Expires: ${expires.toISOString().replace(/\.\d{3}Z$/, 'Z')}`);
  if (fields.policy) lines.push(`Policy: ${fields.policy}`);
  if (fields.canonical) lines.push(`Canonical: ${fields.canonical}`);
  lines.push('Preferred-Languages: en');
  return `${lines.join('\n')}\n`;
}
