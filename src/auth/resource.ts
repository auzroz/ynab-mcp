/**
 * RFC 8707 resource indicator helpers.
 *
 * This authorization server issues tokens for exactly one protected resource: the
 * MCP endpoint (`MCP_RESOURCE_URL`, default `PUBLIC_URL` + `/mcp`). Every resource
 * value a client sends is reduced to a canonical string and compared exactly with
 * the canonical form of that configured URL.
 *
 * Canonical form (via the WHATWG URL parser, then two explicit steps):
 *  - scheme and host lowercased, default port elided, empty path becomes `/`
 *    (done by the parser);
 *  - fragment removed (RFC 8707 section 2: a resource MUST NOT carry one);
 *  - one trailing `/` removed, matching the SDK's bearer middleware comparison.
 *
 * Path, query and userinfo are kept as-is, so `/MCP`, `/mcp?x=1` or
 * `https://user@host/mcp` do not match `https://host/mcp`.
 */

/**
 * Canonical string for a resource URL, or `undefined` when the value does not
 * parse as an absolute URL.
 */
export function canonicalResource(value: string | URL): string | undefined {
  let url: URL;
  try {
    url = new URL(typeof value === 'string' ? value : value.href);
  } catch {
    return undefined;
  }
  url.hash = '';
  return url.href.replace(/\/$/, '');
}

/** True when `requested` names the same resource as the canonical `configured` value. */
export function isSameResource(requested: string | URL, configured: string): boolean {
  const canonical = canonicalResource(requested);
  return canonical !== undefined && canonical === configured;
}
