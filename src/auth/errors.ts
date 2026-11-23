/**
 * Our own OAuth errors (ADR-0002 D9, maintainer decision 3 on the first
 * draft): thin subclasses of v2's `OAuthError`, so v2's bearer middleware and
 * every `instanceof OAuthError` check recognize them. They are used by the AS
 * stages, the interaction and YNAB routes (src/auth/oidc/interaction.ts) and
 * the `/mcp` verifier (src/auth/oidc/verifier.ts).
 *
 * Errors thrown *into* oidc-provider (by the adapter) are the library's own
 * (`errors.InvalidGrant` from `oidc-provider`), because it recognizes only its
 * own classes. Nothing here is thrown into the library.
 *
 * Every response is `{ error, error_description }` JSON with `no-store`:
 * status 400, or 500 for `server_error` only (D13's "every OAuth error keeps
 * its own code"). A description is always a fixed string chosen by our code:
 * nothing from YNAB, storage or the library reaches it.
 */

import type { Response } from 'express';
import { OAuthError, OAuthErrorCode } from '@modelcontextprotocol/server';

export { OAuthError, OAuthErrorCode };

export class InvalidRequestError extends OAuthError {
  constructor(description: string) {
    super(OAuthErrorCode.InvalidRequest, description);
    this.name = 'InvalidRequestError';
  }
}

export class InvalidClientError extends OAuthError {
  constructor(description: string) {
    super(OAuthErrorCode.InvalidClient, description);
    this.name = 'InvalidClientError';
  }
}

export class InvalidGrantError extends OAuthError {
  constructor(description: string) {
    super(OAuthErrorCode.InvalidGrant, description);
    this.name = 'InvalidGrantError';
  }
}

export class InvalidScopeError extends OAuthError {
  constructor(description: string) {
    super(OAuthErrorCode.InvalidScope, description);
    this.name = 'InvalidScopeError';
  }
}

export class InvalidTargetError extends OAuthError {
  constructor(description: string) {
    super(OAuthErrorCode.InvalidTarget, description);
    this.name = 'InvalidTargetError';
  }
}

export class AccessDeniedError extends OAuthError {
  constructor(description: string) {
    super(OAuthErrorCode.AccessDenied, description);
    this.name = 'AccessDeniedError';
  }
}

export class InvalidTokenError extends OAuthError {
  constructor(description: string) {
    super(OAuthErrorCode.InvalidToken, description);
    this.name = 'InvalidTokenError';
  }
}

export class ServerError extends OAuthError {
  constructor(description: string) {
    super(OAuthErrorCode.ServerError, description);
    this.name = 'ServerError';
  }
}

/** `method_not_allowed` (D8's `method-check`, answered with 405 by its caller). */
export class MethodNotAllowedError extends OAuthError {
  constructor(description: string) {
    super(OAuthErrorCode.MethodNotAllowed, description);
    this.name = 'MethodNotAllowedError';
  }
}

/** The status an OAuth error is answered with: 500 for `server_error`, 400 for every other code. */
export function oauthErrorStatus(error: OAuthError): number {
  return error.code === OAuthErrorCode.ServerError ? 500 : 400;
}

/**
 * Answer `error` as `{ error, error_description }` JSON, `no-store`, with
 * {@link oauthErrorStatus} unless the caller names a status (D8's 405 does).
 */
export function sendOAuthError(res: Response, error: OAuthError, status: number = oauthErrorStatus(error)): void {
  res.setHeader('Cache-Control', 'no-store');
  res.status(status).json({ error: error.code, error_description: error.message });
}
