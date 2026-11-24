/**
 * OAuth protocol settings (#64a): `MCP_REQUIRE_RESOURCE`.
 *
 * - **Resource required** (RFC 8707, the MCP authorization spec): a client
 *   registered on 0.5.0 or later must send `resource` at `/authorize` (see
 *   src/auth/resource-required.ts for which clients count as registered before
 *   0.5.0; `/token` never requires it). Default true. `false` turns the
 *   requirement off for every client, for a client that can't send it yet.
 *   **Deprecated: removed in 0.6**, when `resource` becomes required for every
 *   new client with no switch.
 *
 * Errors name the variable only, never its value.
 */

import { parseBoolean } from '../parse.js';
import type { HttpLoader } from './types.js';

export interface OAuthSettings {
  /** `MCP_REQUIRE_RESOURCE`: clients registered on 0.5.0 or later must send `resource` at `/authorize`. Removed in 0.6. */
  requireResource: boolean;
}

/** The default (#64a): required. */
export const DEFAULT_REQUIRE_RESOURCE = true;

export const loadOAuthSettings: HttpLoader<OAuthSettings> = ({ env, problems }) => ({
  requireResource: problems.capture(
    'MCP_REQUIRE_RESOURCE',
    () => parseBoolean(env['MCP_REQUIRE_RESOURCE'], DEFAULT_REQUIRE_RESOURCE, 'MCP_REQUIRE_RESOURCE'),
    // On a bad value the requirement stays on (fail closed); the start is refused anyway.
    true
  ),
});
