/**
 * MCP_REQUIRE_RESOURCE (#64a): default true, strict boolean parsing, never
 * echoed.
 */

import { describe, it, expect } from 'vitest';
import { loadHttpConfig } from '../../../src/config/environment.js';

const OAUTH_ENV = {
  AUTH_MODE: 'oauth',
  PUBLIC_URL: 'https://mcp.example.com',
  YNAB_OAUTH_CLIENT_ID: 'cid',
  YNAB_OAUTH_CLIENT_SECRET: 'csecret-value',
  ENCRYPTION_KEY: 'k'.repeat(44),
};

describe('MCP_REQUIRE_RESOURCE', () => {
  it('defaults to true', () => {
    expect(loadHttpConfig(OAUTH_ENV).requireResource).toBe(true);
    expect(loadHttpConfig({ ...OAUTH_ENV, MCP_REQUIRE_RESOURCE: '' }).requireResource).toBe(true);
  });

  it.each([
    ['false', false],
    ['0', false],
    ['no', false],
    ['FALSE', false],
    ['true', true],
    ['1', true],
    ['yes', true],
  ])('parses %s', (value, expected) => {
    expect(loadHttpConfig({ ...OAUTH_ENV, MCP_REQUIRE_RESOURCE: value }).requireResource).toBe(expected);
  });

  it.each(['ture', 'off', 'disabled', 'false '])('refuses %j, naming the variable but not the value', (value) => {
    let message = '';
    try {
      loadHttpConfig({ ...OAUTH_ENV, MCP_REQUIRE_RESOURCE: value });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/MCP_REQUIRE_RESOURCE/);
    expect(message).not.toContain(value);
  });
});
