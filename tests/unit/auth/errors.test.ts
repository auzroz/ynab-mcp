/**
 * Our OAuth errors (ADR-0002 D9, D13): thin subclasses of v2's `OAuthError`,
 * each keeping its own code, answered 400, or 500 only for `server_error`.
 */

import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { OAuthError } from '@modelcontextprotocol/server';
import {
  AccessDeniedError,
  InvalidClientError,
  InvalidGrantError,
  InvalidRequestError,
  InvalidScopeError,
  InvalidTargetError,
  InvalidTokenError,
  MethodNotAllowedError,
  ServerError,
  oauthErrorStatus,
  sendOAuthError,
} from '../../../src/auth/errors.js';

const CASES = [
  [InvalidRequestError, 'invalid_request', 400],
  [InvalidClientError, 'invalid_client', 400],
  [InvalidGrantError, 'invalid_grant', 400],
  [InvalidScopeError, 'invalid_scope', 400],
  [InvalidTargetError, 'invalid_target', 400],
  [AccessDeniedError, 'access_denied', 400],
  [InvalidTokenError, 'invalid_token', 400],
  [MethodNotAllowedError, 'method_not_allowed', 400],
  [ServerError, 'server_error', 500],
] as const;

describe('src/auth/errors.ts', () => {
  it.each(CASES)('%o keeps its own code (%s) and status (%i), and is a v2 OAuthError', (Cls, code, status) => {
    const err = new Cls('fixed text');
    expect(err).toBeInstanceOf(OAuthError);
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe(code);
    expect(err.message).toBe('fixed text');
    expect(oauthErrorStatus(err)).toBe(status);
    expect(err.toResponseObject()).toEqual({ error: code, error_description: 'fixed text' });
  });

  it('sendOAuthError answers { error, error_description } JSON, no-store, with its status or the one given', async () => {
    const app = express();
    app.get('/a', (_req, res) => sendOAuthError(res, new InvalidGrantError('Invalid grant')));
    app.get('/b', (_req, res) => sendOAuthError(res, new ServerError('Something failed')));
    app.get('/c', (_req, res) => sendOAuthError(res, new MethodNotAllowedError('Method not allowed'), 405));
    const a = await request(app).get('/a');
    expect(a.status).toBe(400);
    expect(a.headers['cache-control']).toBe('no-store');
    expect(a.body).toEqual({ error: 'invalid_grant', error_description: 'Invalid grant' });
    const b = await request(app).get('/b');
    expect(b.status).toBe(500);
    expect(b.body).toEqual({ error: 'server_error', error_description: 'Something failed' });
    const c = await request(app).get('/c');
    expect(c.status).toBe(405);
    expect(c.body.error).toBe('method_not_allowed');
  });
});
