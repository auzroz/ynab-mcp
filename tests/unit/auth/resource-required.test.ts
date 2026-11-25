/**
 * #64a: which clients must send `resource`. The HTTP behaviour is in
 * tests/unit/http-oauth-resource-required.test.ts.
 */

import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { clientMustSendResource, hasResource, registeredBefore050 } from '../../../src/auth/resource-required.js';

describe('registeredBefore050', () => {
  it('is true for a 0.4.x client id (crypto.randomUUID)', () => {
    for (let i = 0; i < 20; i++) expect(registeredBefore050(randomUUID())).toBe(true);
  });

  it.each([
    ['a library (nanoid) id', 'Xk2v9Qp1sT8bN4mR7cW0yL5aE3hJ6gU2dF1zK8oP9iS'],
    ['a Client ID Metadata Document URL (#46)', 'https://client.example/oauth/metadata.json'],
    ['an uppercase UUID (never issued)', randomUUID().toUpperCase()],
    ['a UUID with extra characters', `${randomUUID()}x`],
    ['an empty id', ''],
  ])('is false for %s', (_name, id) => {
    expect(registeredBefore050(id)).toBe(false);
  });
});

describe('clientMustSendResource', () => {
  it('requires it of every 0.5.0+ client while MCP_REQUIRE_RESOURCE is on, CIMD clients included', () => {
    expect(clientMustSendResource('Xk2v9Qp1sT8bN4mR7cW0yL5aE3hJ6gU2dF1zK8oP9iS', true)).toBe(true);
    expect(clientMustSendResource('https://client.example/oauth/metadata.json', true)).toBe(true);
    expect(clientMustSendResource(randomUUID(), true)).toBe(false);
  });

  it('requires it of no client with MCP_REQUIRE_RESOURCE=false', () => {
    expect(clientMustSendResource('Xk2v9Qp1sT8bN4mR7cW0yL5aE3hJ6gU2dF1zK8oP9iS', false)).toBe(false);
    expect(clientMustSendResource('https://client.example/oauth/metadata.json', false)).toBe(false);
  });
});

describe('hasResource', () => {
  it.each([
    ['a value', 'https://mcp.example.com/mcp', true],
    ['repeated values', ['https://mcp.example.com/mcp', 'x'], true],
    ['nothing', undefined, false],
    ['an empty value', '', false],
    ['only empty values', ['', ''], false],
    ['a non-string', 42, false],
  ])('%s: %s', (_name, value, expected) => {
    expect(hasResource(value)).toBe(expected);
  });
});
