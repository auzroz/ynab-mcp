/** Listener, Host/Origin validation, proxy trust and logging. */

import { isIP } from 'node:net';
import { LOOPBACK_HOSTNAMES, parseAbsoluteUrl, parseBoolean, parseBoundedInteger, parseList } from '../parse.js';
import type { HttpLoader } from './types.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];

export interface ServerSettings {
  port: number;
  /**
   * Address to bind (`MCP_BIND_HOST`). Undefined = every interface (Node's
   * default), which counts as a non-loopback bind.
   */
  bindHost: string | undefined;
  publicUrl: string | undefined;
  allowedHosts: string[] | undefined;
  allowedOrigins: string[] | undefined;
  enableDnsRebindingProtection: boolean;
  /**
   * Absolute URL of the protected MCP resource (RFC 9728 / RFC 8707 audience).
   * `MCP_RESOURCE_URL`, else `PUBLIC_URL` + `/mcp`; undefined when neither is set.
   */
  resourceUrl: string | undefined;
  /** Number of reverse-proxy hops to trust for X-Forwarded-* headers (Express `trust proxy`). 0 = none (default). */
  trustProxy: number;
  /** `LOG_LEVEL`, validated in HTTP mode as it is for stdio. */
  logLevel: LogLevel;
}

/**
 * Validate `MCP_BIND_HOST` as something `listen()` accepts: an IP literal
 * (IPv6 without brackets) or a plain hostname. A bracketed `[::1]` is URL
 * syntax and would be resolved as a hostname, so it is refused with a hint.
 * Throws a value-free message.
 */
export function parseBindHost(value: string | undefined): string | undefined {
  if (value === undefined || value === '') return undefined;
  if (isIP(value) !== 0) return value;
  if (value.startsWith('[') || value.endsWith(']')) {
    throw new Error('Invalid MCP_BIND_HOST. Write an IPv6 address without brackets (for example ::1).');
  }
  if (!/^[A-Za-z0-9]([A-Za-z0-9._-]{0,251}[A-Za-z0-9])?$/.test(value)) {
    throw new Error('Invalid MCP_BIND_HOST. Expected an IP address or a hostname.');
  }
  return value;
}

/** Whether a bind address only accepts connections from this machine. */
export function isLoopbackBind(host: string | undefined): boolean {
  if (host === undefined) return false;
  const h = host.toLowerCase();
  return h === 'localhost' || h === '::1' || (isIP(h) === 4 && h.startsWith('127.'));
}

export const loadServerSettings: HttpLoader<ServerSettings> = ({ env, problems }) => {
  const port = problems.capture('PORT', () => parseBoundedInteger(env['PORT'], 3000, 'PORT', 1, 65535), 3000);

  const publicUrlRaw = env['PUBLIC_URL'] || undefined;
  const publicParsed = publicUrlRaw
    ? problems.capture<URL | undefined>('PUBLIC_URL', () => parseAbsoluteUrl(publicUrlRaw, 'PUBLIC_URL'), undefined)
    : undefined;
  const publicUrl = publicParsed && publicUrlRaw ? publicUrlRaw.replace(/\/+$/, '') : undefined;

  const explicitResource = env['MCP_RESOURCE_URL'] || undefined;
  const resourceOk = explicitResource
    ? problems.capture<URL | undefined>(
        'MCP_RESOURCE_URL', () => parseAbsoluteUrl(explicitResource, 'MCP_RESOURCE_URL'), undefined)
    : undefined;
  const resourceUrl = (resourceOk ? explicitResource : undefined) ?? (publicUrl ? `${publicUrl}/mcp` : undefined);

  // Precedence: an explicit ALLOWED_HOSTS / ALLOWED_ORIGINS fully replaces the
  // derived defaults. Defaults: PUBLIC_URL's host (and origin), plus localhost
  // variants (with and without the listen port) when PUBLIC_URL is unset or loopback.
  const loopbackBound = publicParsed === undefined || LOOPBACK_HOSTNAMES.has(publicParsed.hostname);
  const derivedHosts: string[] = [];
  if (publicParsed) derivedHosts.push(publicParsed.host);
  if (loopbackBound) {
    for (const h of LOOPBACK_HOSTNAMES) derivedHosts.push(h, `${h}:${port}`);
  }
  const allowedHosts = parseList(env['ALLOWED_HOSTS']) ?? [...new Set(derivedHosts)];
  const allowedOrigins = parseList(env['ALLOWED_ORIGINS']) ?? (publicParsed ? [publicParsed.origin] : undefined);

  const logRaw = env['LOG_LEVEL'];
  const logLevel = problems.capture<LogLevel>(
    'LOG_LEVEL',
    () => {
      if (logRaw === undefined || logRaw === '') return 'info';
      const v = logRaw.toLowerCase();
      if ((LOG_LEVELS as readonly string[]).includes(v)) return v as LogLevel;
      throw new Error(`Invalid value for LOG_LEVEL. Expected one of: ${LOG_LEVELS.join(', ')}.`);
    },
    'info'
  );

  return {
    port,
    bindHost: problems.capture('MCP_BIND_HOST', () => parseBindHost(env['MCP_BIND_HOST']), undefined),
    publicUrl,
    allowedHosts,
    allowedOrigins,
    // ON by default; set ENABLE_DNS_REBINDING_PROTECTION=false to opt out.
    enableDnsRebindingProtection: problems.capture(
      'ENABLE_DNS_REBINDING_PROTECTION',
      () => parseBoolean(env['ENABLE_DNS_REBINDING_PROTECTION'], true, 'ENABLE_DNS_REBINDING_PROTECTION'),
      true
    ),
    resourceUrl,
    trustProxy: problems.capture('TRUST_PROXY', () => parseBoundedInteger(env['TRUST_PROXY'], 0, 'TRUST_PROXY', 0, 10), 0),
    logLevel,
  };
};
