/**
 * Rate-limit keying and the /register limits (#59).
 *
 * `TRUST_CF_CONNECTING_IP` is separate from `TRUST_PROXY`: the Cloudflare
 * header is only as trustworthy as the guarantee that every request came
 * through Cloudflare, which a hop count says nothing about.
 *
 * Errors name the variable only, never its value.
 */

import { parseBoolean, parseBoundedInteger } from '../parse.js';
import type { HttpLoader } from './types.js';

export interface RateLimitSettings {
  /**
   * `TRUST_CF_CONNECTING_IP`: take the client address from `CF-Connecting-IP`.
   * Only when the origin is reachable solely through Cloudflare. Default false.
   */
  trustCfConnectingIp: boolean;
  /** `REGISTER_RATE_LIMIT_PER_IP`: /register requests per client IP (/64 for IPv6) per hour. Default 100. */
  registerRateLimitPerIp: number;
  /** `REGISTER_RATE_LIMIT_PER_HOST`: /register requests per redirect-URI host per hour. Default 20. */
  registerRateLimitPerHost: number;
}

export const loadRateLimitSettings: HttpLoader<RateLimitSettings> = ({ env, problems }) => ({
  trustCfConnectingIp: problems.capture(
    'TRUST_CF_CONNECTING_IP',
    () => parseBoolean(env['TRUST_CF_CONNECTING_IP'], false, 'TRUST_CF_CONNECTING_IP'),
    false
  ),
  registerRateLimitPerIp: problems.capture(
    'REGISTER_RATE_LIMIT_PER_IP',
    () => parseBoundedInteger(env['REGISTER_RATE_LIMIT_PER_IP'], 100, 'REGISTER_RATE_LIMIT_PER_IP', 1, 100_000),
    100
  ),
  registerRateLimitPerHost: problems.capture(
    'REGISTER_RATE_LIMIT_PER_HOST',
    () => parseBoundedInteger(env['REGISTER_RATE_LIMIT_PER_HOST'], 20, 'REGISTER_RATE_LIMIT_PER_HOST', 1, 100_000),
    20
  ),
});
