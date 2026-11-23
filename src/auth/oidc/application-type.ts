/**
 * ADR-0002 D8's `application_type` rule, without the library (storage's M4
 * uses it, and so will #55's `dcr-validator`): a client whose redirect URIs
 * are all loopback `http:` URIs or private-use schemes is `native`, so the
 * library applies RFC 8252's loopback port relaxation to it, as the SDK did.
 * Anything else keeps the library's default, `web`.
 */

/** The hostnames oidc-provider treats as loopback (its `LOOPBACKS`). */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * `native` when every redirect URI is a loopback `http:` URI or uses a
 * private-use scheme (neither `http:` nor `https:`); otherwise undefined. An
 * unparseable URI gives undefined, and the schema then refuses the client.
 */
export function applicationTypeFor(redirectUris: unknown): 'native' | undefined {
  if (!Array.isArray(redirectUris) || redirectUris.length === 0) return undefined;
  for (const uri of redirectUris) {
    const parsed = typeof uri === 'string' ? URL.parse(uri) : null;
    if (!parsed) return undefined;
    const loopback = parsed.protocol === 'http:' && LOOPBACK_HOSTS.has(parsed.hostname);
    const privateUse = parsed.protocol !== 'http:' && parsed.protocol !== 'https:';
    if (!loopback && !privateUse) return undefined;
  }
  return 'native';
}
