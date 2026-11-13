/** /.well-known/security.txt (RFC 9116, #65b): settings, rendering and the route. */

import { describe, it, expect } from 'vitest';
import request from 'supertest';
import {
  parseSecurityContacts,
  parseSecurityPolicyUrl,
  renderSecurityTxt,
  SECURITY_TXT_VALIDITY_DAYS,
  MAX_SECURITY_CONTACTS,
} from '../../src/utils/security-txt.js';
import { securityTxtRoute } from '../../src/http/routes/security-txt.js';
import { buildHttpApp } from '../../src/http.js';
import { loadHttpConfig } from '../../src/config/environment.js';
import { makeHttpConfig } from './helpers/http-config.js';

const NOW = new Date('2026-11-13T12:34:56.789Z');

describe('parseSecurityContacts', () => {
  it('is empty when unset or blank', () => {
    expect(parseSecurityContacts(undefined)).toEqual([]);
    expect(parseSecurityContacts('')).toEqual([]);
    expect(parseSecurityContacts('  ,  ')).toEqual([]);
  });
  it('turns an email address into a mailto: URI and keeps mailto:, tel: and https: URIs', () => {
    expect(parseSecurityContacts('security@example.com')).toEqual(['mailto:security@example.com']);
    expect(
      parseSecurityContacts('mailto:sec@example.com, https://example.com/report, tel:+1-201-555-0123')
    ).toEqual(['mailto:sec@example.com', 'https://example.com/report', 'tel:+1-201-555-0123']);
  });
  it('refuses a control character or line break anywhere, without echoing the value', () => {
    for (const bad of [
      'a@example.com\nExpires: 2099-01-01T00:00:00Z',
      'a@example.com\r\nPolicy: https://evil.example',
      'a@example.com,\nb@example.com',
      'a@example.com\u0000',
      'https://example.com/\u007f',
      'a@example.com\u2028x',
      'a@exa\tmple.com',
    ]) {
      expect(() => parseSecurityContacts(bad), JSON.stringify(bad)).toThrow(/SECURITY_CONTACT/);
      try {
        parseSecurityContacts(bad);
      } catch (e) {
        expect((e as Error).message).not.toContain('example');
      }
    }
  });
  it('refuses other schemes, bare words and whitespace inside a contact', () => {
    for (const bad of ['http://example.com', 'javascript:alert(1)', 'ftp://example.com', 'not a contact', 'plain', 'mailto:', 'tel:']) {
      expect(() => parseSecurityContacts(bad), bad).toThrow(/SECURITY_CONTACT/);
    }
  });
  it('limits the number of contacts', () => {
    const many = Array.from({ length: MAX_SECURITY_CONTACTS + 1 }, (_, i) => `a${i}@example.com`).join(',');
    expect(() => parseSecurityContacts(many)).toThrow(/at most/);
  });
});

describe('parseSecurityPolicyUrl', () => {
  it('accepts https and unset', () => {
    expect(parseSecurityPolicyUrl(undefined)).toBeUndefined();
    expect(parseSecurityPolicyUrl(' ')).toBeUndefined();
    expect(parseSecurityPolicyUrl('https://example.com/security')).toBe('https://example.com/security');
  });
  it('refuses http, other schemes, whitespace and control characters', () => {
    for (const bad of ['http://example.com/p', 'mailto:a@example.com', 'https://example.com/a b', 'https://example.com/\nX: y', 'nope']) {
      expect(() => parseSecurityPolicyUrl(bad), JSON.stringify(bad)).toThrow(/SECURITY_POLICY_URL/);
    }
  });
});

describe('renderSecurityTxt', () => {
  it('writes Contact, Expires (now + 180 days, RFC 3339 UTC), Policy and Canonical', () => {
    const text = renderSecurityTxt({
      contacts: ['mailto:sec@example.com', 'https://example.com/report'],
      policy: 'https://example.com/policy',
      canonical: 'https://mcp.example.com/.well-known/security.txt',
      now: NOW,
    });
    const expected = new Date(NOW.getTime() + SECURITY_TXT_VALIDITY_DAYS * 86_400_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
    expect(expected).toBe('2027-05-12T12:34:56Z');
    expect(text.split('\n')).toEqual([
      'Contact: mailto:sec@example.com',
      'Contact: https://example.com/report',
      `Expires: ${expected}`,
      'Policy: https://example.com/policy',
      'Canonical: https://mcp.example.com/.well-known/security.txt',
      'Preferred-Languages: en',
      '',
    ]);
  });
  it('omits Policy and Canonical when not set, and always has exactly one Expires', () => {
    const text = renderSecurityTxt({ contacts: ['mailto:sec@example.com'], now: NOW });
    expect(text).not.toMatch(/Policy:|Canonical:/);
    expect(text.match(/^Expires:/gm)).toHaveLength(1);
  });
});

describe('GET /.well-known/security.txt', () => {
  const config = (overrides: Parameters<typeof makeHttpConfig>[0] = {}) => makeHttpConfig({ ...overrides });

  it('is a 404 when SECURITY_CONTACT is unset', async () => {
    const { app } = await buildHttpApp(config());
    expect((await request(app).get('/.well-known/security.txt')).status).toBe(404);
  });

  it('serves plain text from the extension route hook when it is set', async () => {
    const { app } = await buildHttpApp(
      config({
        securityContacts: ['mailto:sec@example.com'],
        securityPolicyUrl: 'https://example.com/policy',
        publicUrl: 'https://mcp.example.com',
      }),
      { routes: [securityTxtRoute(() => NOW)] }
    );
    const res = await request(app).get('/.well-known/security.txt');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/plain; charset=utf-8/);
    expect(res.text).toContain('Contact: mailto:sec@example.com\n');
    expect(res.text).toContain('Expires: 2027-05-12T12:34:56Z\n');
    expect(res.text).toContain('Policy: https://example.com/policy\n');
    expect(res.text).toContain('Canonical: https://mcp.example.com/.well-known/security.txt\n');
  });

  it('is registered by default and computes Expires from the current time', async () => {
    const { app } = await buildHttpApp(config({ securityContacts: ['mailto:sec@example.com'] }));
    const res = await request(app).get('/.well-known/security.txt');
    expect(res.status).toBe(200);
    const expires = /^Expires: (.+)$/m.exec(res.text)?.[1];
    const days = (Date.parse(expires ?? '') - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(179.9);
    expect(days).toBeLessThan(180.1);
  });

  it('answers HEAD, and refuses a bad Host like every other route', async () => {
    const { app } = await buildHttpApp(
      config({
        securityContacts: ['mailto:sec@example.com'],
        publicUrl: 'https://mcp.example.com',
        enableDnsRebindingProtection: true,
        allowedHosts: ['mcp.example.com'],
      })
    );
    expect((await request(app).head('/.well-known/security.txt').set('Host', 'mcp.example.com')).status).toBe(200);
    expect((await request(app).get('/.well-known/security.txt').set('Host', 'evil.example')).status).toBe(403);
  });

  it('is loaded from SECURITY_CONTACT and SECURITY_POLICY_URL, and a bad value is part of the startup error', () => {
    const env = { AUTH_MODE: 'header', SECURITY_CONTACT: 'sec@example.com', SECURITY_POLICY_URL: 'https://example.com/p' };
    const c = loadHttpConfig(env);
    expect(c.securityContacts).toEqual(['mailto:sec@example.com']);
    expect(c.securityPolicyUrl).toBe('https://example.com/p');
    expect(() => loadHttpConfig({ ...env, SECURITY_CONTACT: 'a@example.com\nPolicy: x', SECURITY_POLICY_URL: 'http://x' })).toThrow(
      /SECURITY_CONTACT[\s\S]*SECURITY_POLICY_URL|SECURITY_POLICY_URL[\s\S]*SECURITY_CONTACT/
    );
  });
});
