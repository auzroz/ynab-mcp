/**
 * How `McpOAuthProvider.verifyAccessToken` refuses a token (WS7.3): v2's
 * `OAuthError` with the `invalid_token` code and the one message every refusal
 * carries. That is the class `@modelcontextprotocol/express`'s bearer
 * middleware answers 401 for; server-legacy's `InvalidTokenError` (or any other
 * error) would be a 500 there (ADR-0001 D14), so a rejection with anything else
 * fails the check.
 */

import { expect } from 'vitest';
import { OAuthError, OAuthErrorCode } from '@modelcontextprotocol/server';

export const INVALID_ACCESS_TOKEN_MESSAGE = 'Invalid or expired access token';

/** Asserts that `verification` rejects with verifyAccessToken's refusal. */
export async function expectInvalidToken(verification: Promise<unknown>): Promise<void> {
  const err = await verification.then(
    () => {
      throw new Error('expected verifyAccessToken to refuse the token');
    },
    (e: unknown) => e
  );
  expect(err).toBeInstanceOf(OAuthError);
  expect(err).toMatchObject({ code: OAuthErrorCode.InvalidToken, message: INVALID_ACCESS_TOKEN_MESSAGE });
}
