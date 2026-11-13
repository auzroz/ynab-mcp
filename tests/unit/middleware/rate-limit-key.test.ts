import { describe, it, expect } from 'vitest';
import type { Request } from 'express';
import {
  clientIp,
  clientKey,
  redirectHostKeys,
  requestClientId,
  MAX_REDIRECT_HOSTS,
} from '../../../src/middleware/rate-limit-key.js';

/** A request as far as the key functions read it. */
function fakeReq(init: {
  ip?: string;
  headers?: Record<string, string>;
  body?: unknown;
  query?: Record<string, unknown>;
}): Request {
  const headers = Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    ip: init.ip,
    socket: { remoteAddress: init.ip },
    header: (name: string) => headers[name.toLowerCase()],
    body: init.body,
    query: init.query ?? {},
  } as unknown as Request;
}

const OFF = { trustCfConnectingIp: false };
const ON = { trustCfConnectingIp: true };

describe('clientKey', () => {
  it('keys an authenticated request by user alone', () => {
    const req = fakeReq({ ip: '203.0.113.7' });
    expect(clientKey(req, OFF, { userId: 'u1', clientId: 'c1' })).toBe('user:u1');
    expect(clientKey(fakeReq({ ip: '198.51.100.1' }), OFF, { userId: 'u1' })).toBe('user:u1');
  });

  it('keys an unauthenticated request by (client_id, IP), never client_id alone', () => {
    const a = clientKey(fakeReq({ ip: '203.0.113.7' }), OFF, { clientId: 'c1' });
    const b = clientKey(fakeReq({ ip: '198.51.100.1' }), OFF, { clientId: 'c1' });
    expect(a).toBe('client:c1|ip:203.0.113.7');
    expect(b).not.toBe(a);
    expect(clientKey(fakeReq({ ip: '203.0.113.7' }), OFF, { clientId: 'c2' })).not.toBe(a);
  });

  it('keys by IP when there is no client_id', () => {
    expect(clientKey(fakeReq({ ip: '203.0.113.7' }), OFF)).toBe('ip:203.0.113.7');
  });

  it('bounds the client_id kept in a key', () => {
    const key = clientKey(fakeReq({ ip: '203.0.113.7' }), OFF, { clientId: 'x'.repeat(5000) });
    expect(key.length).toBeLessThan(300);
  });
});

describe('clientIp: IPv6 collapses to /64', () => {
  it('maps two addresses in one /64 to one key and another /64 to another', () => {
    const a = clientIp(fakeReq({ ip: '2001:db8:1:2:aaaa:bbbb:cccc:dddd' }), OFF);
    const b = clientIp(fakeReq({ ip: '2001:db8:1:2:1111:2222:3333:4444' }), OFF);
    const c = clientIp(fakeReq({ ip: '2001:db8:1:3::1' }), OFF);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('keys an IPv4-mapped IPv6 address as its IPv4', () => {
    expect(clientIp(fakeReq({ ip: '::ffff:203.0.113.7' }), OFF)).toBe('203.0.113.7');
  });

  it('leaves an IPv4 address alone', () => {
    expect(clientIp(fakeReq({ ip: '203.0.113.7' }), OFF)).toBe('203.0.113.7');
  });

  it('collapses a CF-Connecting-IP IPv6 address too', () => {
    const a = clientIp(fakeReq({ ip: '10.0.0.1', headers: { 'CF-Connecting-IP': '2001:db8::1' } }), ON);
    const b = clientIp(fakeReq({ ip: '10.0.0.1', headers: { 'CF-Connecting-IP': '2001:db8::ffff' } }), ON);
    expect(a).toBe(b);
  });

  it('uses one key when the request has no address', () => {
    expect(clientIp(fakeReq({}), OFF)).toBe('unknown');
  });
});

describe('CF-Connecting-IP', () => {
  const headers = { 'CF-Connecting-IP': '198.51.100.9' };
  it('is ignored unless TRUST_CF_CONNECTING_IP is on', () => {
    expect(clientIp(fakeReq({ ip: '10.0.0.1', headers }), OFF)).toBe('10.0.0.1');
  });
  it('is used when it is on', () => {
    expect(clientIp(fakeReq({ ip: '10.0.0.1', headers }), ON)).toBe('198.51.100.9');
  });
  it('falls back to the socket address when the header is not an IP', () => {
    expect(clientIp(fakeReq({ ip: '10.0.0.1', headers: { 'CF-Connecting-IP': 'not-an-ip' } }), ON)).toBe('10.0.0.1');
    expect(clientIp(fakeReq({ ip: '10.0.0.1', headers: { 'CF-Connecting-IP': '1.2.3.4, 5.6.7.8' } }), ON)).toBe('10.0.0.1');
  });
  it('falls back to the socket address when the header is absent', () => {
    expect(clientIp(fakeReq({ ip: '10.0.0.1' }), ON)).toBe('10.0.0.1');
  });
});

describe('requestClientId', () => {
  it('reads the Basic user, then the body, then the query', () => {
    const basic = `Basic ${Buffer.from('basic-id:secret').toString('base64')}`;
    expect(requestClientId(fakeReq({ headers: { Authorization: basic }, body: { client_id: 'body-id' } }))).toBe('basic-id');
    expect(requestClientId(fakeReq({ body: { client_id: 'body-id' }, query: { client_id: 'q' } }))).toBe('body-id');
    expect(requestClientId(fakeReq({ query: { client_id: 'q-id' } }))).toBe('q-id');
  });
  it('ignores non-string values', () => {
    expect(requestClientId(fakeReq({ body: { client_id: ['a'] }, query: { client_id: ['b'] } }))).toBeUndefined();
    expect(requestClientId(fakeReq({ body: 'x' }))).toBeUndefined();
  });
});

describe('redirectHostKeys (/register)', () => {
  const ip = '203.0.113.7';
  it('keys a public host by the host alone, so another IP shares its budget', () => {
    expect(redirectHostKeys({ redirect_uris: ['https://Claude.AI/cb'] }, ip)).toEqual(['host:claude.ai']);
    expect(redirectHostKeys({ redirect_uris: ['https://claude.ai/other'] }, '198.51.100.1')).toEqual(['host:claude.ai']);
  });
  it('keys loopback and private-use schemes by IP too, so native clients do not share one budget', () => {
    for (const uri of ['http://localhost:3000/cb', 'http://127.0.0.1/cb', 'http://[::1]/cb']) {
      expect(redirectHostKeys({ redirect_uris: [uri] }, ip)).toEqual([`loopback|ip:${ip}`]);
    }
    expect(redirectHostKeys({ redirect_uris: ['com.example.app:/cb'] }, ip)).toEqual([`scheme:com.example.app:|ip:${ip}`]);
  });
  it('returns one key per distinct host, so a second host does not dodge the first', () => {
    expect(redirectHostKeys({ redirect_uris: ['https://a.example/x', 'https://b.example/y', 'https://a.example/z'] }, ip).sort()).toEqual([
      'host:a.example',
      'host:b.example',
    ]);
  });
  it('caps the number of hosts counted', () => {
    const uris = Array.from({ length: 50 }, (_, i) => `https://h${i}.example/cb`);
    expect(redirectHostKeys({ redirect_uris: uris }, ip)).toHaveLength(MAX_REDIRECT_HOSTS);
  });
  it('falls back to the IP when the body has no usable redirect URI', () => {
    for (const body of [undefined, {}, { redirect_uris: 'x' }, { redirect_uris: [1, 'not a url'] }]) {
      expect(redirectHostKeys(body, ip)).toEqual([`no-redirect|ip:${ip}`]);
    }
  });
});
