/**
 * The method-check stage (ADR-0002 D8): a request with a method the route
 * doesn't serve gets 405, an `Allow` header and a `method_not_allowed` body,
 * as the SDK's authorization-server handlers answered. oidc-provider answers
 * 404 for a method it has no route for, so this runs ahead of `as-library`.
 *
 * Ported from `allowedMethods` in `@modelcontextprotocol/sdk` 1.32.2
 * (src/server/auth/middleware/allowedMethods.ts), maintainer decision 2 on
 * ADR-0002's first draft. That code is under the MIT License:
 *
 *   MIT License
 *
 *   Copyright (c) 2024 Anthropic, PBC
 *
 *   Permission is hereby granted, free of charge, to any person obtaining a copy
 *   of this software and associated documentation files (the "Software"), to deal
 *   in the Software without restriction, including without limitation the rights
 *   to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 *   copies of the Software, and to permit persons to whom the Software is
 *   furnished to do so, subject to the following conditions:
 *
 *   The above copyright notice and this permission notice shall be included in all
 *   copies or substantial portions of the Software.
 *
 *   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 *   IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 *   FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 *   AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 *   LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 *   OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 *   SOFTWARE.
 */

import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { MethodNotAllowedError, sendOAuthError } from './errors.js';

/** Answer 405 for any method not in `allowed`. */
export function methodCheck(allowed: readonly string[]): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (allowed.includes(req.method)) {
      next();
      return;
    }
    res.setHeader('Allow', allowed.join(', '));
    sendOAuthError(res, new MethodNotAllowedError(`The method ${req.method} is not allowed for this endpoint`), 405);
  };
}
