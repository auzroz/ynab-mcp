/**
 * #55: MCP_VERIFIED_REDIRECT_URIS, MCP_DCR_PRIVATE_USE_SCHEMES and
 * MCP_TRUST_LOOPBACK_REDIRECTS (src/config/http/dcr.ts).
 */

import { describe, it, expect } from 'vitest';
import { loadHttpConfig } from '../../../src/config/environment.js';
import {
  DEFAULT_VERIFIED_REDIRECT_URIS,
  parsePrivateUseSchemes,
  parseVerifiedRedirectUris,
} from '../../../src/config/http/dcr.js';

const BASE = {
  MCP_TRANSPORT: 'http',
  AUTH_MODE: 'oauth',
  PUBLIC_URL: 'https://mcp.example.com',
  YNAB_OAUTH_CLIENT_ID: 'cid',
  YNAB_OAUTH_CLIENT_SECRET: 'sec',
  ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
};

describe('defaults (batch 3)', () => {
  it("verifies Claude's two connector callbacks, no private-use scheme, and trusts loopback", () => {
    const c = loadHttpConfig(BASE);
    expect(c.verifiedRedirectUris).toEqual([
      'https://claude.ai/api/mcp/auth_callback',
      'https://claude.com/api/mcp/auth_callback',
    ]);
    expect(c.verifiedRedirectUris).toBe(DEFAULT_VERIFIED_REDIRECT_URIS);
    expect(c.privateUseSchemes).toEqual([]);
    expect(c.trustLoopbackRedirects).toBe(true);
  });
});

describe('MCP_VERIFIED_REDIRECT_URIS', () => {
  it('replaces the default list; `none` empties it; blank keeps the default', () => {
    expect(parseVerifiedRedirectUris('https://a.example/cb, http://localhost:9/cb')).toEqual([
      'https://a.example/cb',
      'http://localhost:9/cb',
    ]);
    expect(parseVerifiedRedirectUris('none')).toEqual([]);
    expect(parseVerifiedRedirectUris(' NONE ')).toEqual([]);
    expect(parseVerifiedRedirectUris('')).toBe(DEFAULT_VERIFIED_REDIRECT_URIS);
    expect(parseVerifiedRedirectUris(undefined)).toBe(DEFAULT_VERIFIED_REDIRECT_URIS);
  });

  it('normalizes entries and drops duplicates', () => {
    expect(parseVerifiedRedirectUris('https://A.example, https://a.example/')).toEqual(['https://a.example/']);
  });

  it.each([
    ['http://remote.example/cb', /https is required/],
    ['not a url', /absolute URL/],
    ['https://a.example/cb#x', /fragment/],
    ['https://u@a.example/cb', /userinfo/],
    ['ftp://a.example/cb', /scheme must be https/],
    [`https://a.example/${'x'.repeat(520)}`, /at most 512/],
  ])('refuses %s', (value, message) => {
    expect(() => parseVerifiedRedirectUris(value)).toThrow(message);
  });

  it('refuses more than 20 entries', () => {
    const many = Array.from({ length: 21 }, (_, i) => `https://a.example/${i}`).join(',');
    expect(() => parseVerifiedRedirectUris(many)).toThrow(/at most 20/);
  });

  it('a bad value fails startup, naming the variable but not the value', () => {
    let message = '';
    try {
      loadHttpConfig({ ...BASE, MCP_VERIFIED_REDIRECT_URIS: 'http://secret-host.example/cb' });
    } catch (err) {
      message = String(err);
    }
    expect(message).toMatch(/MCP_VERIFIED_REDIRECT_URIS/);
    expect(message).not.toContain('secret-host');
  });
});

describe('MCP_DCR_PRIVATE_USE_SCHEMES', () => {
  it('accepts scheme names, lowercased, with or without the colon', () => {
    expect(parsePrivateUseSchemes('com.Example.App, cursor:')).toEqual(['com.example.app', 'cursor']);
    expect(parsePrivateUseSchemes('none')).toEqual([]);
    expect(parsePrivateUseSchemes(undefined)).toEqual([]);
  });

  it.each(['https', 'http', 'javascript', 'data', 'file', 'about', 'blob', 'vbscript'])('refuses the reserved scheme %s', (scheme) => {
    expect(() => parsePrivateUseSchemes(scheme)).toThrow(/not private-use schemes/);
  });

  it.each(['1app', 'com.example.app://cb', 'a b', 'ex_ample', 'x'.repeat(65)])('refuses %s as a scheme name', (value) => {
    expect(() => parsePrivateUseSchemes(value)).toThrow(/URI scheme name/);
  });

  it('a bad value fails startup, naming the variable only', () => {
    expect(() => loadHttpConfig({ ...BASE, MCP_DCR_PRIVATE_USE_SCHEMES: 'https' })).toThrow(/MCP_DCR_PRIVATE_USE_SCHEMES/);
  });
});

describe('MCP_TRUST_LOOPBACK_REDIRECTS', () => {
  it('is a strict boolean', () => {
    expect(loadHttpConfig({ ...BASE, MCP_TRUST_LOOPBACK_REDIRECTS: 'false' }).trustLoopbackRedirects).toBe(false);
    expect(() => loadHttpConfig({ ...BASE, MCP_TRUST_LOOPBACK_REDIRECTS: 'ture' })).toThrow(/MCP_TRUST_LOOPBACK_REDIRECTS/);
  });
});
