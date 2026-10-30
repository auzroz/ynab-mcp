/**
 * The consent cookie that binds a pending authorization to one browser.
 */

import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import {
  ConsentCookie,
  consentNonceMatches,
  newConsentNonce,
} from '../../../src/auth/consent-cookie.js';

describe('newConsentNonce / consentNonceMatches', () => {
  it('stores only the SHA-256 of a 256-bit nonce, and the pair matches', () => {
    const { nonce, hash } = newConsentNonce();
    expect(Buffer.from(nonce, 'base64url')).toHaveLength(32);
    expect(hash).toBe(createHash('sha256').update(nonce).digest('base64url'));
    expect(hash).not.toContain(nonce);
    expect(consentNonceMatches(nonce, hash)).toBe(true);
  });

  it('is fresh every time', () => {
    const a = newConsentNonce();
    const b = newConsentNonce();
    expect(a.nonce).not.toBe(b.nonce);
    expect(consentNonceMatches(a.nonce, b.hash)).toBe(false);
  });

  it('rejects a missing nonce, a missing binding, and a malformed binding', () => {
    const { nonce, hash } = newConsentNonce();
    expect(consentNonceMatches(undefined, hash)).toBe(false);
    expect(consentNonceMatches('', hash)).toBe(false);
    expect(consentNonceMatches(nonce, undefined)).toBe(false);
    expect(consentNonceMatches(nonce, '')).toBe(false);
    expect(consentNonceMatches(nonce, 'c2hvcnQ')).toBe(false);
    // The hash itself is not accepted in place of the nonce.
    expect(consentNonceMatches(hash, hash)).toBe(false);
  });
});

describe('ConsentCookie', () => {
  it('over https: __Host- prefix, Secure, HttpOnly, SameSite=Lax, Path=/, no Domain', () => {
    const cookie = new ConsentCookie('https://mcp.example.com/base', 600);
    const set = cookie.serialize('state-1', 'nonce-1');
    const [pair, ...attrs] = set.split('; ');
    expect(pair).toMatch(/^__Host-ynab_mcp_consent_[0-9a-f]{32}=nonce-1$/);
    expect(attrs).toEqual(['Path=/', 'Max-Age=600', 'HttpOnly', 'SameSite=Lax', 'Secure']);
    expect(set).not.toMatch(/Domain=/i);
  });

  it('over http (loopback): no prefix and no Secure', () => {
    const cookie = new ConsentCookie('http://localhost:3000', 600);
    const set = cookie.serialize('state-1', 'nonce-1');
    expect(set.startsWith('ynab_mcp_consent_')).toBe(true);
    expect(set).not.toContain('Secure');
    expect(set).toContain('HttpOnly');
    expect(set).toContain('SameSite=Lax');
  });

  it('names one cookie per state without revealing it', () => {
    const cookie = new ConsentCookie('https://mcp.example.com', 600);
    expect(cookie.name('state-1')).not.toBe(cookie.name('state-2'));
    expect(cookie.name('state-1')).toBe(cookie.name('state-1'));
    expect(cookie.name('state-1')).not.toContain('state-1');
  });

  it('clear() expires the same cookie', () => {
    const cookie = new ConsentCookie('https://mcp.example.com', 600);
    const cleared = cookie.clear('state-1');
    expect(cleared.startsWith(`${cookie.name('state-1')}=;`)).toBe(true);
    expect(cleared).toContain('Max-Age=0');
    expect(cleared).toContain('Secure');
  });

  it('read() finds the cookie for the state among others', () => {
    const cookie = new ConsentCookie('https://mcp.example.com', 600);
    const name = cookie.name('state-1');
    const header = `other=1; ${cookie.name('state-2')}=wrong; ${name}=nonce-1; trailing`;
    expect(cookie.read(header, 'state-1')).toBe('nonce-1');
    expect(cookie.read(header, 'state-2')).toBe('wrong');
  });

  it('read() returns undefined when absent, empty, or only a prefix of the name', () => {
    const cookie = new ConsentCookie('https://mcp.example.com', 600);
    const name = cookie.name('state-1');
    expect(cookie.read(undefined, 'state-1')).toBeUndefined();
    expect(cookie.read('', 'state-1')).toBeUndefined();
    expect(cookie.read('a=b', 'state-1')).toBeUndefined();
    expect(cookie.read(`${name}=`, 'state-1')).toBeUndefined();
    expect(cookie.read(`${name}x=nonce`, 'state-1')).toBeUndefined();
    expect(cookie.read(name, 'state-1')).toBeUndefined();
    // The unprefixed name doesn't satisfy the __Host- cookie.
    expect(cookie.read(`${name.replace('__Host-', '')}=nonce`, 'state-1')).toBeUndefined();
  });
});
