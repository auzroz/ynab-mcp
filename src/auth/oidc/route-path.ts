/**
 * A request path as oidc-provider routes it: its router matches
 * case-insensitively and ignores one trailing slash, so `/AUTHORIZE` and
 * `/authorize/` are its authorization route. Every path check on the
 * library's side (the provider's normalizer, the authorize guard's redirect
 * net) compares this form with the provider's routes, so no spelling of a
 * route skips them (#47-4).
 */
export function routePath(path: string): string {
  const lower = path.toLowerCase();
  return lower.length > 1 && lower.endsWith('/') ? lower.slice(0, -1) : lower;
}
