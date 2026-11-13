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

/** The route extension; `clock` is only for tests. */
export function securityTxtRoute(clock: () => Date = () => new Date()): RouteExtension {
  return {
    name: 'security-txt',
    mount(router, { config }) {
      const { securityContacts, securityPolicyUrl, publicUrl } = config as Settings;
      if (securityContacts.length === 0) return;
      const canonical = publicUrl ? `${publicUrl}${SECURITY_TXT_PATH}` : undefined;
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
