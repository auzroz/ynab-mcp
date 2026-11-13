/** #55: MCP_DCR_PRIVATE_USE_SCHEMES (src/config/http/dcr.ts). */

import { describe, it, expect } from 'vitest';
import { loadHttpConfig } from '../../../src/config/environment.js';
import { parsePrivateUseSchemes } from '../../../src/config/http/dcr.js';

const BASE = {
  MCP_TRANSPORT: 'http',
  AUTH_MODE: 'oauth',
  PUBLIC_URL: 'https://mcp.example.com',
  YNAB_OAUTH_CLIENT_ID: 'cid',
  YNAB_OAUTH_CLIENT_SECRET: 'sec',
  ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
};

describe('defaults (batch 3)', () => {
  it('accepts no private-use scheme', () => {
    expect(loadHttpConfig(BASE).privateUseSchemes).toEqual([]);
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
