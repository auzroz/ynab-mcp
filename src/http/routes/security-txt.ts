/**
 * GET /.well-known/security.txt (RFC 9116), mounted through the extension
 * routes (src/http/extensions.ts), so it sees Host validation like every other
 * route. Served only when `SECURITY_CONTACT` is set; otherwise nothing is
 * mounted and the path is a plain 404. `Expires` is computed per request
 * (now + 180 days), so the file never goes stale on a long-running server.
 *
 * Unauthenticated by design, and it carries only what the operator configured.
 */

import type { Request, Response } from 'express';
import type { HttpConfig } from '../../config/environment.js';
import { renderSecurityTxt } from '../../utils/security-txt.js';
import type { RouteExtension } from '../extensions.js';

export const SECURITY_TXT_PATH = '/.well-known/security.txt';

type Settings = Pick<HttpConfig, 'securityContacts' | 'securityPolicyUrl' | 'publicUrl'>;

/**
 * Where the file is served: PUBLIC_URL's origin with the well-known path. The
 * URL's own path and query are dropped, so a `?x=y` on PUBLIC_URL cannot end
 * up in front of the path. (The route is served at the root, so a PUBLIC_URL
 * with a path prefix is not part of the retrieval URL either.)
 */
export function canonicalUrl(publicUrl: string): string {
  return new URL(SECURITY_TXT_PATH, new URL(publicUrl).origin).href;
}

/** The route extension; `clock` is only for tests. */
export function securityTxtRoute(clock: () => Date = () => new Date()): RouteExtension {
  return {
    name: 'security-txt',
    mount(router, { config }) {
      const { securityContacts, securityPolicyUrl, publicUrl } = config as Settings;
      if (securityContacts.length === 0) return;
      const canonical = publicUrl ? canonicalUrl(publicUrl) : undefined;
      router.get(SECURITY_TXT_PATH, (_req: Request, res: Response) => {
        res
          .status(200)
          .type('text/plain; charset=utf-8')
          .set('Cache-Control', 'public, max-age=3600')
          .send(renderSecurityTxt({ contacts: securityContacts, policy: securityPolicyUrl, canonical, now: clock() }));
      });
    },
  };
}

/** The registered instance, with the real clock. */
export const securityTxt: RouteExtension = securityTxtRoute();
