/**
 * #55a: the client registration rules (client-metadata.ts), as pure functions.
 * The HTTP behaviour is in tests/unit/http-oauth-dcr-authorize.test.ts.
 */

import { describe, it, expect } from 'vitest';
import {
  CLIENT_METADATA_FIELDS,
  MAX_CLIENT_NAME_LENGTH,
  MAX_REDIRECT_URIS,
  MAX_REDIRECT_URI_LENGTH,
  checkClientName,
  checkRedirectUri,
  checkStoredClient,
  displayClientName,
  errorsMayRedirect,
  redirectHostLabel,
  redirectPolicyFrom,
  redirectTrust,
  redirectUriMatches,
  validateClientMetadata,
  type ClientMetadataPolicy,
} from '../../../src/auth/client-metadata.js';

const NO_SCHEMES: ClientMetadataPolicy = { privateUseSchemes: [] };
const APP_SCHEME: ClientMetadataPolicy = { privateUseSchemes: ['com.example.app'] };

describe('checkRedirectUri', () => {
  it.each([
    ['https://client.example/cb', 'https'],
    ['https://client.example:8443/cb?x=1', 'https'],
    ['https://localhost/cb', 'https'],
    ['http://localhost/cb', 'loopback-http'],
    ['http://localhost:33418/callback', 'loopback-http'],
    ['http://127.0.0.1:9/cb', 'loopback-http'],
    ['http://[::1]:9/cb', 'loopback-http'],
  ])('accepts %s as %s', (uri, kind) => {
    expect(checkRedirectUri(uri, NO_SCHEMES)).toEqual({ kind, problem: undefined });
  });

  it('refuses plain http to any other host, including near-loopback names', () => {
    for (const uri of ['http://client.example/cb', 'http://127.0.0.2/cb', 'http://localhost.evil.example/cb', 'http://10.0.0.1/cb']) {
      expect(checkRedirectUri(uri, NO_SCHEMES).kind, uri).toBe('plain-http');
      expect(checkRedirectUri(uri, NO_SCHEMES).problem, uri).toMatch(/http is allowed only for localhost/);
    }
  });

  it('refuses userinfo and fragments, on every scheme', () => {
    for (const uri of [
      'https://user@client.example/cb',
      'https://user:pw@client.example/cb',
      'http://u@localhost/cb',
      'com.example.app://u@host/cb',
    ]) {
      expect(checkRedirectUri(uri, APP_SCHEME).problem, uri).toBe('must not contain userinfo');
    }
    for (const uri of ['https://client.example/cb#x', 'https://client.example/cb#', 'com.example.app:/cb#frag']) {
      expect(checkRedirectUri(uri, APP_SCHEME).problem, uri).toBe('must not contain a fragment');
    }
  });

  it(`refuses a URI over ${MAX_REDIRECT_URI_LENGTH} characters and accepts one at it`, () => {
    const base = 'https://client.example/';
    const at = base + 'a'.repeat(MAX_REDIRECT_URI_LENGTH - base.length);
    expect(checkRedirectUri(at, NO_SCHEMES).problem).toBeUndefined();
    expect(checkRedirectUri(at + 'a', NO_SCHEMES).problem).toMatch(/at most 512/);
  });

  it('accepts a private-use scheme only from the allow-list', () => {
    expect(checkRedirectUri('com.example.app:/oauth/cb', APP_SCHEME)).toEqual({ kind: 'private-use', problem: undefined });
    expect(checkRedirectUri('COM.EXAMPLE.APP:/oauth/cb', APP_SCHEME).kind).toBe('private-use');
    expect(checkRedirectUri('com.example.app:/oauth/cb', NO_SCHEMES).problem).toMatch(/allow-list/);
    expect(checkRedirectUri('com.other.app:/cb', APP_SCHEME).problem).toMatch(/allow-list/);
  });

  it('refuses browser and script schemes even if listed', () => {
    const policy = { privateUseSchemes: ['javascript', 'data', 'file'] };
    for (const uri of ['javascript:alert(1)', 'data:text/html,x', 'file:///etc/passwd', 'vbscript:x', 'blob:https://a/b']) {
      expect(checkRedirectUri(uri, policy).problem, uri).toBe('this scheme is not allowed');
    }
  });

  it('refuses non-strings, empty strings and relative URIs', () => {
    for (const uri of [undefined, 42, '', '/cb', 'client.example/cb']) {
      expect(checkRedirectUri(uri, NO_SCHEMES).problem).toBeDefined();
    }
  });

  it('never puts the URI in the problem', () => {
    const uri = 'http://secret-host.example/cb';
    expect(checkRedirectUri(uri, NO_SCHEMES).problem).not.toContain('secret-host');
  });
});

describe('redirectUriMatches (the handler rule, for resolution)', () => {
  it('matches exactly, or loopback on any port', () => {
    expect(redirectUriMatches('https://c.example/cb', 'https://c.example/cb')).toBe(true);
    expect(redirectUriMatches('https://c.example:444/cb', 'https://c.example/cb')).toBe(false);
    expect(redirectUriMatches('http://localhost:5555/cb', 'http://localhost/cb')).toBe(true);
    expect(redirectUriMatches('http://localhost:5555/other', 'http://localhost/cb')).toBe(false);
    expect(redirectUriMatches('http://127.0.0.1:5555/cb', 'http://localhost/cb')).toBe(false);
  });
});

describe('validateClientMetadata', () => {
  const ok = (body: unknown, policy = NO_SCHEMES) => {
    const r = validateClientMetadata(body, policy);
    if (!r.ok) throw new Error(`refused: ${r.error.error_description}`);
    return r.metadata;
  };
  const refused = (body: unknown, policy = NO_SCHEMES) => {
    const r = validateClientMetadata(body, policy);
    if (r.ok) throw new Error('accepted');
    return r.error;
  };

  it('keeps only the allowed fields and drops the rest (jwks, contacts, software_statement, logo_uri, ...)', () => {
    const metadata = ok({
      redirect_uris: ['https://client.example/cb'],
      client_name: 'App',
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      scope: 'read-only',
      software_id: 'id',
      software_version: '1.0',
      jwks: { keys: [] },
      jwks_uri: 'https://client.example/jwks',
      contacts: ['a@example.com'],
      software_statement: 'eyJ...',
      logo_uri: 'https://client.example/logo.png',
      client_uri: 'https://client.example',
      tos_uri: 'https://client.example/tos',
      policy_uri: 'https://client.example/policy',
      client_secret: 'chosen-by-client',
      anything: 1,
    });
    expect(Object.keys(metadata).sort()).toEqual(
      ['redirect_uris', 'client_name', 'token_endpoint_auth_method', 'grant_types', 'response_types', 'scope', 'software_id', 'software_version'].sort()
    );
    for (const k of Object.keys(metadata)) expect(CLIENT_METADATA_FIELDS).toContain(k);
  });

  it(`requires 1 to ${MAX_REDIRECT_URIS} redirect URIs (invalid_redirect_uri)`, () => {
    const uris = (n: number) => Array.from({ length: n }, (_, i) => `https://client.example/cb${i}`);
    expect(ok({ redirect_uris: uris(1) }).redirect_uris).toHaveLength(1);
    expect(ok({ redirect_uris: uris(MAX_REDIRECT_URIS) }).redirect_uris).toHaveLength(MAX_REDIRECT_URIS);
    expect(refused({ redirect_uris: uris(MAX_REDIRECT_URIS + 1) })).toEqual({
      error: 'invalid_redirect_uri',
      error_description: 'redirect_uris: at most 5 are allowed',
    });
    expect(refused({ redirect_uris: [] }).error).toBe('invalid_redirect_uri');
    expect(refused({}).error_description).toBe('redirect_uris: is required');
    expect(refused({ redirect_uris: 'https://client.example/cb' }).error).toBe('invalid_redirect_uri');
    expect(refused({ redirect_uris: ['https://client.example/cb', 'https://client.example/cb'] }).error_description).toMatch(
      /must not repeat/
    );
  });

  it('reports which redirect URI failed, without its value', () => {
    const err = refused({ redirect_uris: ['https://client.example/cb', 'http://evil.example/cb'] });
    expect(err.error).toBe('invalid_redirect_uri');
    expect(err.error_description).toMatch(/^redirect_uris\[1\]: http is allowed only/);
    expect(err.error_description).not.toContain('evil');
  });

  it('marks an all-loopback or private-use registration native (ADR-0002 D8), and leaves others as sent', () => {
    expect(ok({ redirect_uris: ['http://localhost:9/cb', 'http://127.0.0.1/cb'] }).application_type).toBe('native');
    expect(ok({ redirect_uris: ['com.example.app:/cb'], application_type: 'web' }, APP_SCHEME).application_type).toBe('native');
    expect(ok({ redirect_uris: ['https://client.example/cb', 'http://localhost/cb'] }).application_type).toBeUndefined();
    expect(ok({ redirect_uris: ['https://client.example/cb'], application_type: 'web' }).application_type).toBe('web');
  });

  it('normalizes client_name (NFKC, trimmed) and bounds it', () => {
    expect(ok({ redirect_uris: ['https://c.example/cb'], client_name: '  ＣＬＡＵＤＥ ' }).client_name).toBe('CLAUDE');
    expect(ok({ redirect_uris: ['https://c.example/cb'], client_name: 'é'.repeat(MAX_CLIENT_NAME_LENGTH) }).client_name).toHaveLength(
      MAX_CLIENT_NAME_LENGTH
    );
    expect(ok({ redirect_uris: ['https://c.example/cb'] }).client_name).toBeUndefined();
    expect(refused({ redirect_uris: ['https://c.example/cb'], client_name: 'x'.repeat(MAX_CLIENT_NAME_LENGTH + 1) })).toEqual({
      error: 'invalid_client_metadata',
      error_description: 'client_name: must be at most 100 characters',
    });
  });

  it('refuses names with control, bidi, zero-width, tag or private-use characters, empty names and non-strings', () => {
    for (const name of [
      'Cla\u0007ude',
      'Cla‮ude',
      'Cla⁦ude',
      'Cla​ude',
      'Cla‍ude',
      'Cla﻿ude',
      'Cla\u{E0041}ude',
      'Claude',
      'Cla ude',
      'Cla\uD800ude',
      '   ',
      '',
      42,
      ['Claude'],
    ]) {
      const err = refused({ redirect_uris: ['https://c.example/cb'], client_name: name });
      expect(err.error, JSON.stringify(name)).toBe('invalid_client_metadata');
      expect(err.error_description).toMatch(/^client_name: /);
    }
  });

  it('bounds the other kept fields', () => {
    const base = { redirect_uris: ['https://c.example/cb'] };
    expect(refused({ ...base, token_endpoint_auth_method: 'x'.repeat(65) }).error_description).toMatch(/^token_endpoint_auth_method/);
    expect(refused({ ...base, grant_types: ['a', 'b', 'c', 'd', 'e', 'f'] }).error_description).toMatch(/^grant_types/);
    expect(refused({ ...base, response_types: ['co de'] }).error_description).toMatch(/^response_types\[0\]/);
    expect(refused({ ...base, scope: 'x'.repeat(257) }).error_description).toMatch(/^scope/);
    expect(refused({ ...base, software_id: 'x'.repeat(129) }).error_description).toMatch(/^software_id/);
  });

  it('refuses a body that is not an object', () => {
    for (const body of [null, 'x', [], 1]) expect(refused(body).error).toBe('invalid_client_metadata');
  });
});

describe('checkStoredClient (grandfathered clients)', () => {
  it('flags a non-loopback http redirect URI as the one enforced rule', () => {
    expect(checkStoredClient({ client_id: 'a', redirect_uris: ['http://old.example/cb'] }, NO_SCHEMES).plainHttp).toBe(true);
    expect(
      checkStoredClient({ client_id: 'a', redirect_uris: ['https://ok.example/cb', 'http://old.example/cb'] }, NO_SCHEMES).plainHttp
    ).toBe(true);
    expect(checkStoredClient({ client_id: 'a', redirect_uris: ['http://localhost/cb'] }, NO_SCHEMES)).toEqual({
      plainHttp: false,
      failures: [],
    });
  });

  it('lists the other failures by rule and field name only', () => {
    const stored = {
      client_id: 'a',
      client_id_issued_at: 1,
      client_secret_hash: 's256.x',
      redirect_uris: ['com.legacy.app:/cb', ...Array.from({ length: 5 }, (_, i) => `https://ok.example/${i}`)],
      client_name: 'Bad‮name',
      logo_uri: 'https://ok.example/logo',
      contacts: ['x@example.com'],
      'weird key!': 1,
    };
    const { plainHttp, failures } = checkStoredClient(stored, NO_SCHEMES);
    expect(plainHttp).toBe(false);
    expect(failures).toEqual([
      'redirect_uris count',
      'redirect_uris[0] invalid',
      'client_name',
      'unsupported fields: (other), contacts, logo_uri',
    ]);
    expect(failures.join(' ')).not.toContain('legacy');
  });
});

describe('redirect trust (the verified-client predicate, 55b)', () => {
  const policy = redirectPolicyFrom({
    verifiedRedirectUris: ['https://claude.ai/api/mcp/auth_callback'],
    privateUseSchemes: [],
    trustLoopbackRedirects: true,
  });

  it('verifies only listed URIs, exactly', () => {
    expect(redirectTrust('https://claude.ai/api/mcp/auth_callback', policy)).toBe('verified');
    expect(redirectTrust('https://claude.ai/api/mcp/auth_callback?x=1', policy)).toBe('unverified');
    expect(redirectTrust('https://claude.ai.evil.example/api/mcp/auth_callback', policy)).toBe('unverified');
    expect(redirectTrust('https://CLAUDE.AI/api/mcp/auth_callback', policy)).toBe('verified');
    expect(redirectTrust('http://localhost:1/cb', policy)).toBe('loopback');
    expect(redirectTrust('https://client.example/cb', policy)).toBe('unverified');
    expect(redirectTrust('not a url', policy)).toBe('unverified');
  });

  it('lets errors redirect to verified URIs, and to loopback only while that is trusted', () => {
    expect(errorsMayRedirect('https://claude.ai/api/mcp/auth_callback', policy)).toBe(true);
    expect(errorsMayRedirect('http://127.0.0.1:5/cb', policy)).toBe(true);
    expect(errorsMayRedirect('https://client.example/cb', policy)).toBe(false);
    const noLoopback = { ...policy, trustLoopbackRedirects: false };
    expect(errorsMayRedirect('http://127.0.0.1:5/cb', noLoopback)).toBe(false);
    const empty = redirectPolicyFrom({ verifiedRedirectUris: [], privateUseSchemes: [], trustLoopbackRedirects: false });
    expect(errorsMayRedirect('https://claude.ai/api/mcp/auth_callback', empty)).toBe(false);
  });
});

describe('display helpers', () => {
  it('redirectHostLabel shows the host, or the scheme for a private-use URI', () => {
    expect(redirectHostLabel('https://client.example/cb')).toBe('client.example');
    expect(redirectHostLabel('http://localhost:3000/cb')).toBe('localhost:3000');
    expect(redirectHostLabel('https://xn--80ak6aa92e.com/cb')).toBe('xn--80ak6aa92e.com');
    expect(redirectHostLabel('https://аррӏе.com/cb')).toBe('xn--80ak6aa92e.com');
    expect(redirectHostLabel('com.example.app:/cb')).toBe('com.example.app:');
    expect(redirectHostLabel('nope')).toBeUndefined();
  });

  it('displayClientName strips bidi, invisible and control characters and bounds the length', () => {
    expect(displayClientName('Cla‮ude​⁦ App\u0007')).toBe('Claude App');
    expect(displayClientName('A\u{E0041}\u{E0042}B')).toBe('AB');
    expect(displayClientName('​‮')).toBeUndefined();
    expect(displayClientName(undefined)).toBeUndefined();
    expect(displayClientName('x'.repeat(150))).toBe(`${'x'.repeat(100)}…`);
    expect(checkClientName('ok').name).toBe('ok');
  });
});
