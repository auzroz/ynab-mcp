/**
 * `SECURITY_CONTACT` and `SECURITY_POLICY_URL` (#65): the content of
 * `/.well-known/security.txt` (RFC 9116). With no contact the route is not
 * served. Validation lives in src/utils/security-txt.ts.
 */

import { parseSecurityContacts, parseSecurityPolicyUrl } from '../../utils/security-txt.js';
import type { HttpLoader } from './types.js';

export interface SecurityTxtSettings {
  /** `SECURITY_CONTACT`, normalized to URIs; empty = no security.txt. */
  securityContacts: string[];
  /** `SECURITY_POLICY_URL` (https); undefined when unset. */
  securityPolicyUrl: string | undefined;
}

export const loadSecurityTxtSettings: HttpLoader<SecurityTxtSettings> = ({ env, problems }) => ({
  securityContacts: problems.capture('SECURITY_CONTACT', () => parseSecurityContacts(env['SECURITY_CONTACT']), []),
  securityPolicyUrl: problems.capture(
    'SECURITY_POLICY_URL',
    () => parseSecurityPolicyUrl(env['SECURITY_POLICY_URL']),
    undefined
  ),
});
