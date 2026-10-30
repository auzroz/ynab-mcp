/**
 * RFC 8707 resource normalization: which spellings name the configured MCP
 * resource and which do not.
 */

import { describe, it, expect } from 'vitest';
import { canonicalResource, isSameResource } from '../../../src/auth/resource.js';

const configured = 'https://mcp.example.com/mcp';

describe('canonicalResource', () => {
  it.each([
    ['https://mcp.example.com/mcp', 'https://mcp.example.com/mcp'],
    ['HTTPS://MCP.Example.COM/mcp', 'https://mcp.example.com/mcp'],
    ['https://mcp.example.com:443/mcp', 'https://mcp.example.com/mcp'],
    ['http://localhost:80/mcp', 'http://localhost/mcp'],
    ['https://mcp.example.com/mcp#frag', 'https://mcp.example.com/mcp'],
    ['https://mcp.example.com/mcp#', 'https://mcp.example.com/mcp'],
    ['https://mcp.example.com/mcp/', 'https://mcp.example.com/mcp'],
    ['https://mcp.example.com', 'https://mcp.example.com'],
    ['https://mcp.example.com/', 'https://mcp.example.com'],
    ['https://mcp.example.com:8443/mcp', 'https://mcp.example.com:8443/mcp'],
  ])('%s -> %s', (input, expected) => {
    expect(canonicalResource(input)).toBe(expected);
  });

  it('accepts URL objects', () => {
    expect(canonicalResource(new URL('https://MCP.example.com:443/mcp#x'))).toBe(configured);
  });

  it.each(['', 'not a url', '/mcp', 'mcp.example.com/mcp'])('returns undefined for %j', (input) => {
    expect(canonicalResource(input)).toBeUndefined();
  });
});

describe('isSameResource', () => {
  it.each([
    'https://mcp.example.com/mcp',
    'HTTPS://MCP.EXAMPLE.COM/mcp',
    'https://mcp.example.com:443/mcp',
    'https://mcp.example.com/mcp/',
    'https://mcp.example.com/mcp#section',
  ])('matches %s', (requested) => {
    expect(isSameResource(requested, configured)).toBe(true);
  });

  it.each([
    'https://evil.example.com/mcp',
    'https://mcp.example.com.evil.example/mcp',
    'http://mcp.example.com/mcp',
    'https://mcp.example.com:8443/mcp',
    'https://mcp.example.com/MCP',
    'https://mcp.example.com/mcp/extra',
    'https://mcp.example.com/mcp//',
    'https://mcp.example.com/mcpx',
    'https://mcp.example.com/',
    'https://mcp.example.com/mcp?tenant=other',
    'https://user@mcp.example.com/mcp',
    'https://mcp.example.com/%6Dcp',
    'urn:example:mcp',
    'not a url',
  ])('rejects %s', (requested) => {
    expect(isSameResource(requested, configured)).toBe(false);
  });
});
