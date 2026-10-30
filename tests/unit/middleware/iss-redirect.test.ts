/**
 * RFC 9207 `iss` helper and authorization-endpoint redirect middleware.
 */

import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { issOnAuthorizationRedirects, withIssuer } from '../../../src/middleware/iss-redirect.js';

const ISSUER = 'https://mcp.example.com/';

describe('withIssuer', () => {
  it('adds iss and keeps code and state', () => {
    const out = new URL(withIssuer('https://client.example/cb?code=abc&state=xyz', ISSUER));
    expect(out.searchParams.get('code')).toBe('abc');
    expect(out.searchParams.get('state')).toBe('xyz');
    expect(out.searchParams.get('iss')).toBe(ISSUER);
  });

  it('URL-encodes the issuer and round-trips special characters in other params', () => {
    const src = new URL('https://client.example/cb');
    src.searchParams.set('state', 'a b&c=d/é');
    src.searchParams.set('error_description', 'Bad: "x" + y');
    const raw = withIssuer(src.href, 'https://mcp.example.com/base?');
    expect(raw).not.toContain('iss=https://');
    const out = new URL(raw);
    expect(out.searchParams.get('state')).toBe('a b&c=d/é');
    expect(out.searchParams.get('error_description')).toBe('Bad: "x" + y');
    expect(out.searchParams.get('iss')).toBe('https://mcp.example.com/base?');
  });

  it('keeps a query the client registered in its redirect URI', () => {
    const out = new URL(withIssuer('https://client.example/cb?tenant=t1&code=c', ISSUER));
    expect(out.searchParams.get('tenant')).toBe('t1');
    expect(out.pathname).toBe('/cb');
  });

  it('replaces an existing iss instead of duplicating it', () => {
    const out = new URL(withIssuer('https://client.example/cb?iss=https%3A%2F%2Fevil.example%2F', ISSUER));
    expect(out.searchParams.getAll('iss')).toEqual([ISSUER]);
  });

  it('works for native-app custom-scheme and loopback redirect URIs', () => {
    expect(new URL(withIssuer('com.example.app:/oauth/cb?code=c', ISSUER)).searchParams.get('iss')).toBe(ISSUER);
    expect(new URL(withIssuer('http://127.0.0.1:53111/cb?code=c', ISSUER)).searchParams.get('iss')).toBe(ISSUER);
  });

  it('leaves a relative URL untouched', () => {
    expect(withIssuer('/somewhere?x=1', ISSUER)).toBe('/somewhere?x=1');
  });
});

describe('issOnAuthorizationRedirects', () => {
  function makeApp(): express.Express {
    const app = express();
    app.use('/authorize', issOnAuthorizationRedirects(ISSUER));
    app.get('/authorize', (_req, res) => {
      res.redirect(302, 'https://client.example/cb?error=invalid_request&state=s1');
    });
    app.get('/authorize/location', (_req, res) => {
      res.location('https://client.example/cb?code=c1').status(303).end();
    });
    app.get('/elsewhere', (_req, res) => {
      res.redirect('https://app.ynab.com/oauth/authorize?state=s2');
    });
    return app;
  }

  it('adds iss to redirects from the authorization endpoint, keeping the other params', async () => {
    const res = await request(makeApp()).get('/authorize').set('Accept', 'text/plain');
    expect(res.status).toBe(302);
    const loc = new URL(res.headers['location'] as string);
    expect(loc.searchParams.get('error')).toBe('invalid_request');
    expect(loc.searchParams.get('state')).toBe('s1');
    expect(loc.searchParams.get('iss')).toBe(ISSUER);
    // The redirect body names the same URL as the Location header.
    expect(res.text).toContain(res.headers['location'] as string);
  });

  it('also covers res.location', async () => {
    const res = await request(makeApp()).get('/authorize/location');
    expect(res.status).toBe(303);
    expect(new URL(res.headers['location'] as string).searchParams.get('iss')).toBe(ISSUER);
  });

  it('does not touch redirects from other routes', async () => {
    const res = await request(makeApp()).get('/elsewhere');
    expect(res.status).toBe(302);
    expect(res.headers['location']).toBe('https://app.ynab.com/oauth/authorize?state=s2');
  });
});
