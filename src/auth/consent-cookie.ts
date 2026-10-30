/**
 * Browser binding for the federated authorization flow.
 *
 * The consent page (`/authorize`) sets a cookie holding a random nonce and the
 * pending authorization stores only the nonce's SHA-256. `/oauth/ynab/start`,
 * `/oauth/ynab/callback` and `/oauth/cancel` require the cookie and check it
 * against that hash, so a pending `state` is only usable from the browser that
 * was shown this server's consent page. Without it, anyone could create a
 * pending authorization for their own client and send the `/oauth/ynab/start`
 * link to a victim, skipping consent (the MCP "confused deputy" problem).
 *
 * One cookie per pending authorization (its name is derived from the state), so
 * two authorizations in progress in one browser don't overwrite each other.
 * Over https the cookie is `__Host-` prefixed and `Secure`; over http (allowed
 * for loopback only) it is unprefixed, since not every browser accepts Secure
 * cookies from http://localhost.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const COOKIE_BASE = 'ynab_mcp_consent_';

function sha256(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

/** A fresh nonce for the cookie and the hash to store on the pending authorization. */
export function newConsentNonce(): { nonce: string; hash: string } {
  const nonce = randomBytes(32).toString('base64url');
  return { nonce, hash: sha256(nonce).toString('base64url') };
}

/**
 * Whether `nonce` (from the cookie) matches `storedHash` (from the pending
 * authorization). False when either is missing, so a pending authorization
 * without a binding (written before 0.4.0) is never usable.
 */
export function consentNonceMatches(nonce: string | undefined, storedHash: string | undefined): boolean {
  if (!nonce || !storedHash) return false;
  const expected = Buffer.from(storedHash, 'base64url');
  const actual = sha256(nonce);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/** Cookie settings derived from the public URL. */
export class ConsentCookie {
  private readonly secure: boolean;

  constructor(
    publicUrl: string,
    private readonly maxAgeSec: number
  ) {
    this.secure = new URL(publicUrl).protocol === 'https:';
  }

  /** Cookie name for one pending authorization (no part of the state is revealed). */
  name(state: string): string {
    const id = sha256(state).toString('hex').slice(0, 32);
    return `${this.secure ? '__Host-' : ''}${COOKIE_BASE}${id}`;
  }

  private attributes(maxAgeSec: number): string {
    return `Path=/; Max-Age=${maxAgeSec}; HttpOnly; SameSite=Lax${this.secure ? '; Secure' : ''}`;
  }

  /** `Set-Cookie` value binding `state` to this browser. */
  serialize(state: string, nonce: string): string {
    return `${this.name(state)}=${nonce}; ${this.attributes(this.maxAgeSec)}`;
  }

  /** `Set-Cookie` value removing the cookie for `state`. */
  clear(state: string): string {
    return `${this.name(state)}=; ${this.attributes(0)}`;
  }

  /** The nonce for `state` from a request's `Cookie` header, if present. */
  read(cookieHeader: string | undefined, state: string): string | undefined {
    if (!cookieHeader) return undefined;
    const name = this.name(state);
    for (const part of cookieHeader.split(';')) {
      const eq = part.indexOf('=');
      if (eq === -1) continue;
      if (part.slice(0, eq).trim() === name) {
        const value = part.slice(eq + 1).trim();
        return value.length > 0 ? value : undefined;
      }
    }
    return undefined;
  }
}
