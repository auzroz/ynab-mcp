# ADR-0002: Our own authorization server handlers, off server-legacy

| | |
|---|---|
| Status | **Proposed** (2026-11-13). The maintainer signs it off before the port starts, after WS7.3 (P5, Wed Nov 18, decision batch 3). |
| Issues | #47 (this port), #46 (Client ID Metadata Documents, which builds on it), and #42, #52, #55, #59, #64a, which share its files |
| Bound by | ADR-0001: the package table, D14 (the `~2.4.0` pin, the guard test, the advisory trigger, the `OAuthError` `instanceof` problem), Q3 (the fallback at the freeze), and the rejected alternative "Porting the AS off server-legacy inside WS7.3". The 2026-11-09 scope decision: #47 ships in 0.5.0. The plan's "#47a after the tag / 0.5.1" rows (WS8.92, lane L2, the §1 deferred table) are superseded. |
| Changes | Later changes are dated addenda at the end of this file. |

## Context

"Today" means `release/0.5.0` at b57bc2e, before WS7.2. Line numbers are from that commit. WS7.2 changes only the import specifiers in these files.

**How the authorization server is built.** `mountAuthorizationServer` (`src/auth/as-router.ts:178-351`) mounts one pipeline of named stages per route (`routePipeline`, `:82-89`; `mountStages`, `src/http/pipeline.ts:63-88`). On `/authorize`, `/token`, `/register` and `/revoke` the last stage, `sdk-router`, is the SDK's own handler:

| Route | Stages today (`http-as-pipeline.test.ts:30-38`) | The handler in the last stage |
|---|---|---|
| `/authorize` | host-validation → bounded-parser → iss-redirect → sdk-router | `authorizationHandler({ provider })` (`:314`) |
| `/token` | host-validation → bounded-parser → cors-origin → route-limiter → client-auth → sdk-router | `tokenHandler({ provider, rateLimit: false })` (`:320`) |
| `/register` | host-validation → bounded-parser → sdk-router | `clientRegistrationHandler({ clientsStore })` (`:327`) |
| `/revoke` | as `/token` | `revocationHandler({ provider, rateLimit: false })` (`:335`) |
| the three metadata routes | host-validation → bounded-parser → metadata | `metadataHandler(doc)` (`:243`) |

#55 adds stages ahead of the handler (as-limiter, authorize-validation, authorize-guard, dcr-validator; gate G21), and #59 changes how the limiters key their counts. Neither changes the last stage.

**What we use from the SDK's authorization server.** In 0.4.x it comes from `@modelcontextprotocol/sdk` 1.32.2. After WS7.2 it comes from `@modelcontextprotocol/server-legacy` 2.4.0 (`/auth`). Both were checked in the published packages; 2.4.0's TypeScript source was read from its source maps.

| Export | Used at | What it does that we rely on |
|---|---|---|
| `authorizationHandler` | as-router `:314` | Allows GET and POST (405 otherwise). Its own limiter: 100 per 15 min per IP. Sets `Cache-Control: no-store`. **Phase 1** checks `client_id` and `redirect_uri`: the URI must be registered (loopback ports relaxed per RFC 8252), or be the client's only one. Errors are answered directly (400, or 500 for `server_error`), never by redirect. **Phase 2** checks `response_type=code`, `code_challenge`, `code_challenge_method=S256`, `scope`, `state` and `resource` (a URL). Every error is redirected to the validated `redirect_uri` with `error`, `error_description` and `state`. Then it calls `provider.authorize(client, params, res)`. |
| `tokenHandler` | `:320` | CORS for any origin; POST only. Client authentication by `client_secret_post` (`authenticateClient`: a plain `!==` on `client_secret`, then `client_secret_expires_at`). Sets `no-store`. For `authorization_code`: `challengeForAuthorizationCode`, then the PKCE S256 check (`pkce-challenge`'s `verifyChallenge`), then `exchangeAuthorizationCode(client, code, undefined, redirect_uri, resource)`. For `refresh_token`: `exchangeRefreshToken(client, token, scope.split(' '), resource)`. Anything else is `unsupported_grant_type`. |
| `clientRegistrationHandler` | `:327` | CORS; POST only. Its own limiter: 20 per hour per IP. Parses the body with core's `OAuthClientMetadataSchema` (`invalid_client_metadata` on failure). Issues a 32-byte hex secret unless `token_endpoint_auth_method` is `none`, expiring after 30 days. Calls `clientsStore.registerClient`, answers 201 with the result. |
| `revocationHandler` | `:335` | CORS; POST only; `authenticateClient`. Parses `OAuthTokenRevocationRequestSchema`, calls `provider.revokeToken`, answers 200 `{}`. |
| `metadataHandler` | `:243` | CORS; GET and OPTIONS only (405 with `Allow` otherwise); 200 JSON. |
| `createOAuthMetadata` | `:223` | The RFC 8414 document: the issuer and the four endpoints, `response_types_supported: ['code']`, `code_challenge_methods_supported: ['S256']`, `token_endpoint_auth_methods_supported: ['client_secret_post', 'none']`, `grant_types_supported`, `revocation_endpoint_auth_methods_supported: ['client_secret_post']`, `scopes_supported`. Also the issuer check: HTTPS unless the host is `localhost` or `127.0.0.1`. Its message, "Issuer URL must be HTTPS", is pinned by `http-oauth-security.test.ts:515`. We add `authorization_response_iss_parameter_supported: true` (`:222-225`). |
| `getOAuthProtectedResourceMetadataUrl` | `:210` | The RFC 9728 well-known URL for `/mcp` |
| Error classes | `TooManyRequestsError` (as-router `:279`); `InvalidClientError`, `ServerError` (client-auth `:27`); `InvalidGrantError`, `InvalidScopeError`, `InvalidTargetError`, `InvalidTokenError`, `ServerError` (provider `:79-85`) | Each handler catches `instanceof OAuthError` and answers `{ error, error_description[, error_uri] }` with 400, or 500 for `server_error`. Anything else becomes a generic `server_error` 500. |
| Types | `OAuthServerProvider`, `AuthorizationParams`, `OAuthRegisteredClientsStore` (provider `:68-72`, client-auth `:26`) | The provider interface the handlers call |

We use none of `mcpAuthRouter`, `mcpAuthMetadataRouter`, `ProxyOAuthServerProvider`, `skipLocalPkceValidation` or the server-legacy `requireBearerAuth` (WS7.3 moves `/mcp` to v2's). We don't use 2.4.0's new `issuerUrl` option on `authorizationHandler` either: our `iss-redirect` stage adds `iss` instead (`src/middleware/iss-redirect.ts`).

**Glue that depends on those internals (D14):**
- **#52's client authentication.**
  - `getClient` returns a confidential client's stored `s256.` hash as its `client_secret` (`mcp-provider.ts:154-162`), so the SDK's `!==` fails closed.
  - The `client-auth` stage verifies the presented secret, then writes the stored hash into `req.body.client_secret` so that the SDK's comparison passes (`client-auth.ts:82-83`).
  - This works only because of exactly how `authenticateClient` compares.
- **The code exchange.** The SDK splits it into two provider calls around its PKCE check, so the provider keeps an in-process bridge between them (`consumedCodes`, `mcp-provider.ts:249-262`, bounded by `CODE_EXCHANGE_WINDOW_MS`). #42's replay detection lives in those two calls (`:534-614`).
- **The consent page's `Cache-Control: no-store`** (`http-oauth-security.test.ts:196`) comes from the SDK's authorize handler, not from the provider.

**What v2 ships for OAuth.** Checked in the 2.4.0 packages:

| Package | OAuth exports | An authorization server? |
|---|---|---|
| `@modelcontextprotocol/server` 2.4.0 | `OAuthError` (`code`, `toResponseObject()`, `fromResponse()`; branded, so `instanceof` works across bundled copies) and `OAuthErrorCode` (20 codes, including `invalid_target`, `too_many_requests`, `method_not_allowed`, `invalid_client_metadata`). Resource-server helpers: `requireBearerAuth`, `verifyBearerToken`, `bearerAuthChallengeResponse`, `requireScopes`, `buildOAuthProtectedResourceMetadata`, `getOAuthProtectedResourceMetadataUrl`, `oauthMetadataResponse`, `checkResourceAllowed`, `resourceUrlFromServerUrl`. Types: `OAuthClientInformationFull`, `OAuthTokens`, `OAuthMetadata`, `OAuthTokenRevocationRequest`, `AuthInfo`, `OAuthTokenVerifier`. | No |
| `@modelcontextprotocol/core` 2.4.0 | Zod schemas: `OAuthClientMetadataSchema`, `OAuthClientInformationFullSchema`, `OAuthMetadataSchema` (which already has `client_id_metadata_document_supported` and `authorization_response_iss_parameter_supported`), `OAuthTokensSchema`, `OAuthTokenRevocationRequestSchema`, `OAuthErrorResponseSchema`, `OAuthProtectedResourceMetadataSchema` | No |
| `@modelcontextprotocol/express` 2.0.2 | `requireBearerAuth`, `mcpAuthMetadataRouter`, `getOAuthProtectedResourceMetadataUrl` | No |

- v2 has no authorize, token, registration or revocation handler. It also has no provider interface, no client authentication, no PKCE check and no RFC 8414 document builder.
- server-legacy's README gives the reason: they were "removed in v2 because MCP servers should use dedicated OAuth providers".
- server-legacy imports its schemas from `@modelcontextprotocol/core/internal` at run time. So the DCR and revocation schemas are the same objects whichever package we take them from.

**The `OAuthError` problem (D14).**
- server-legacy ships its own `OAuthError` hierarchy (`InvalidGrantError` and the rest, with an `errorCode` getter), unbranded. v2's `OAuthError` is branded (`mcp.OAuthError`). Neither family's `instanceof` recognizes the other's errors.
- After WS7.3 there are two error families in one provider. `verifyAccessToken` throws v2's `OAuthError(InvalidToken)` for the bearer middleware; the AS paths throw server-legacy's classes for server-legacy's handlers.
- When a provider error reaches a handler of the other family, the client gets a 500 instead of the OAuth error.

**License.**
- server-legacy 2.4.0 is Apache-2.0. Its LICENSE says the project is moving from MIT, and that contributions whose authors haven't agreed to relicense stay MIT.
- The same handlers ship in `@modelcontextprotocol/sdk` 1.32.2 under MIT ("Copyright (c) 2024 Anthropic, PBC"). That is the code 0.4.x runs today.
- Our package is MIT.

**Constraints:**
- **The freeze** is Wed Dec 9 (P10). ADR-0001 Q3: if the port hasn't merged by then, 0.5.0 ships on the D14 pin, and #47 and #46 move to 0.5.1.
- **Per-file chains** (plan §5): `as-router.ts` has #59 in P7 (Tue Nov 24) and #55 in P9 (Sat Dec 5). `mcp-provider.ts` has WS7.3 in P5, #55 in P9 and #64a in P10. A file takes at most one PR per packet.
- **The `http.ts` quiet window** runs from Mon Nov 23 until WS7.4 merges (P8, Wed Dec 2; cut Fri Dec 4).
- **Owners.** O owns `as-router.ts` and the AS surface modules (`client-metadata.ts` and `authorize-guard.ts`, both created by #55). S owns `mcp-provider.ts` and `client-auth.ts`. B owns `package.json` and the lockfile. P owns `http.ts` and `docs/adr/`.
- **#47's acceptance:**
  - PKCE S256 only, RFC 8707, RFC 9207 `iss`, refresh-token families with reuse detection, #42's code-replay revocation, and the YNAB legs and their limit;
  - server-legacy removed;
  - "the existing OAuth flow and security tests pass unchanged";
  - the Postgres storage tests run with 0 skipped.

## Options

Facts checked on 2026-11-13 against the npm registry and the published tarballs.

| | (a1) `oidc-provider` | (a2) `@node-oauth/oauth2-server` | (b) Our handlers, ported | (c) What v2 ships |
|---|---|---|---|---|
| Version, date | 9.15.0, 2026-11-13 (9.14.0 on Nov 11) | 5.3.1, 2026-10-13; the Express wrapper `@node-oauth/express-oauth-server` is 4.2.0 | Not a package: ported from the 1.32.2 or 2.4.0 handlers, both released 2026-10-23 | server 2.4.0, core 2.4.0, express 2.0.2, all 2026-10-23 |
| Maintenance | Active; one maintainer; OpenID certified | Active fork of the abandoned oauthjs project | Ours | Active, but the AS is out of scope upstream |
| License | MIT | MIT | MIT if ported from 1.32.2; Apache-2.0 if from 2.4.0 (Q2) | Apache-2.0 |
| Size, dependencies | 561 KB unpacked; `koa` ^3, `jose`, `debug` | 151 KB; `type-is`, `basic-auth`, `@node-oauth/formats` | About 500 lines of code. Nothing new in the dependency tree: `express`, `express-rate-limit`, `zod`, `cors`, core. | Already installed |
| PKCE S256 only | Yes; S256 is its only method | S256 and `plain`; `plain` must be refused by hand | Unchanged | No PKCE |
| RFC 8707 | Yes (`resourceIndicators`), but with its own audience model, not our single-resource binding | No | Unchanged (in the provider) | Only `checkResourceAllowed`, a path-prefix match that is looser than `resource.ts` |
| RFC 9207 `iss` | Yes | No | Unchanged | The metadata field only |
| Refresh families, reuse detection | Its own: reuse revokes the grant. By default it always rotates for public clients, and for other clients only after 70% of the token's lifetime (configurable). | A rotation hook; no families | Unchanged (provider, storage) | No |
| #42 code replay | Its own: a replay revokes the grant | No | Unchanged | No |
| YNAB legs and limit | Rewritten as its login and consent "interactions", with its own sessions and cookies | Ours | Unchanged | Ours |
| #52 client auth | It compares a stored plaintext secret (`compareClientSecret`); hashed secrets need an override of its internals | A `getClient(id, secret)` model hook | Simpler: the stage is the only check (D4) | No |
| Hashed tokens (#52), STOR-1, migrations M1-M4 | Its adapter models (Session, Grant, AccessToken, …) replace our storage API; its token ids replace `ymcp1_` and the tag check | Its model hooks; no families or tombstones | Unchanged | Not applicable |
| G21 stage order | One Koa app with its routes inside it | Middleware per route | Unchanged | Not applicable |
| DCR validator, authorize guard (#55) | Its own registration validation, plus RFC 7592 management | No DCR | Unchanged: they are stages ahead of the handler | Schemas only |
| Metadata, error responses | OIDC discovery; error details differ | No metadata | Unchanged | A PRM builder, the schemas, `OAuthError` |
| Path to #46 | Experimental CIMD (draft 03) | None | Ours (see "The path to #46") | The field in the metadata schema |
| **Disqualifier** | A rewrite of the AS and its storage around Koa and OIDC. It can't land by Dec 9, and every flow, security and storage test would change. | No DCR, revocation, metadata, RFC 8707 or RFC 9207, so most of the AS stays ours anyway, now behind a model adapter | None | It has no authorization server |

Also considered and ruled out:
- **`@better-auth/oauth-provider` 1.7.23** (MIT). It needs the better-auth framework (`better-auth`, `better-call` and `@better-auth/core` are peer dependencies) and its database adapters.
- **`@cloudflare/workers-oauth-provider` 1.2.4** (MIT). It runs only on Cloudflare Workers: it needs a KV namespace and Service Bindings.
- **`mcp-auth` 1.0.0-beta.1** (MIT). It verifies tokens for a resource server that sits in front of an external provider. It isn't an authorization server.
- **A dedicated identity provider** (Auth0, Keycloak), as server-legacy's README suggests. Every self-hosted operator would have to run and configure a second service. The YNAB federation (consent, YNAB sign-in, the YNAB identity as the user) would become a custom extension of that service. Both contradict the deployment model: self-hosted, one process, SQLite by default.

## Decision

### D1. We port the four handlers into `src/auth/oauth-server/` (option b)

- **What:** a new directory that holds only what we use, trimmed:
  - `authorize.ts`, `token.ts`, `register.ts` and `revoke.ts`, the handlers. The middleware inside each keeps its order (CORS, method check, form parser, limiter, then the route), and the status codes, headers and response bodies stay the same.
  - `metadata.ts`: `createOAuthMetadata` (our RFC 8414 document, including `authorization_response_iss_parameter_supported: true`) and `metadataHandler`.
  - `provider.ts`: the `OAuthServerProvider`, `OAuthRegisteredClientsStore` and `AuthorizationParams` types we implement.
  - `errors.ts` (D3), `authenticated-client.ts` (D4) and `allowed-methods.ts`.
  - `pkce.ts`: S256 with `node:crypto` and `timingSafeEqual`, in place of `pkce-challenge`.
- **Dropped:**
  - `mcpAuthRouter`, `mcpAuthMetadataRouter` and the proxy provider;
  - the `skipLocalPkceValidation` and `clientIdGeneration` options, and 2.4.0's `issuerUrl` option;
  - `authenticateClient` (D4);
  - the `MCP_DANGEROUSLY_ALLOW_INSECURE_ISSUER_URL` switch. `src/config/http/checks.ts:38` already refuses any non-HTTPS `PUBLIC_URL` except `localhost` and `127.0.0.1`, so the switch can't take effect today.
- **Kept options:**
  - `rateLimit` (`Partial<Options> | false`) on every handler, because #59 and #55 configure the limiters through it;
  - `clientSecretExpirySeconds` on `/register`, default 30 days.
- **Reused from v2 (D6):** `OAuthError`, `OAuthErrorCode`, the core schemas, the types, and `getOAuthProtectedResourceMetadataUrl`.
- **Why:**
  - It's the only option that keeps every must-keep behaviour where it already lives (see the table after D11). The provider, storage, stages and tests stay where they are.
  - The code is small (about 500 lines), it already runs in production, and the existing HTTP tests describe its behaviour precisely.
  - It removes both of the couplings D14 describes: the secret rewrite and the error-family split.
- **Binds:** #47-1 and #47-2 (D10).

### D2. The port preserves behaviour

- **What:** the port changes no status code, header, error code, redirect, limit or metadata field. It may differ only in:
  - the `error_description` for malformed input to `/token` and `/revoke` (a missing `client_id` or a non-string secret). The `client-auth` stage now answers these (D4) with fixed text instead of Zod's message;
  - the PKCE comparison, which becomes constant-time;
  - `Error.name` in log lines (D3).
- **Not part of the port**, even where it would be an improvement (each is its own issue later):
  - checking the `code_verifier` length and characters (RFC 7636 §4.1); the SDK accepts any string;
  - `client_secret_basic`;
  - folding the two-call code exchange into one, which would delete `consumedCodes`;
  - dropping `iss-redirect` now that our handler could add `iss` itself;
  - renaming `sdk-router` (Q4).
- **Why:** "the existing OAuth flow and security tests pass unchanged" can only be checked if nothing else changes in the same PR. #55 and #64a land on the ported AS three and seven days later, and they change behaviour on purpose.
- **Binds:** both PRs. The reviewer compares behaviour against server-legacy (D9).

### D3. One `OAuthError`: v2's

- **What:**
  - `src/auth/oauth-server/errors.ts` exports thin named subclasses of v2's `OAuthError`, one per code we throw:
    - `InvalidRequestError`, `InvalidClientError`, `InvalidGrantError`, `InvalidScopeError`, `InvalidTargetError`;
    - `InvalidClientMetadataError`, `UnsupportedGrantTypeError`;
    - `ServerError`, `TooManyRequestsError`, `MethodNotAllowedError`.
  - Each subclass passes its `OAuthErrorCode` to the base constructor and keeps an `errorCode` getter equal to `code`, so existing `.errorCode` reads keep working.
  - The same module exports `sendOAuthError(res, err)`. When `OAuthError.isInstance(err)` holds, it answers `toResponseObject()` with 400, or 500 for `server_error`. Anything else gets `server_error` with "Internal Server Error" and 500. Every direct error response in the handlers and in `client-auth.ts` goes through it, with two exceptions that keep their own status: `allowed-methods.ts` answers an unsupported method with 405 and the `Allow` header, and each limiter answers 429 with the `too_many_requests` body (both as today). `/authorize` phase-2 errors stay redirects to the validated `redirect_uri` (D2), built from the same `toResponseObject()` fields.
  - The provider, `client-auth.ts` and `as-router.ts` take their error classes only from this module. `verifyAccessToken` keeps WS7.3's `new OAuthError(OAuthErrorCode.InvalidToken, …)`.
  - After #47-2, nothing imports server-legacy's error classes. A test checks that (D7).
- **Why:**
  - Every error is an instance of the one branded class. The bearer middleware, our handlers and the tests all agree on `instanceof`.
  - The subclasses leave the provider's 21 OAuth throw sites and the tests' `toBeInstanceOf(InvalidGrantError)` assertions as they are; only import lines move.
  - v2 brands only its own classes, so our subclasses keep plain prototype `instanceof`. Their instances still carry v2's brand, so `instanceof OAuthError` holds as well.
- **Constraint:** the provider's error family and the handlers must switch in the same merge. Otherwise, from the first merge to the second, every provider error would answer 500. #47-2 is that single merge.
- **Binds:** #47-1 (`errors.ts`), #47-2 (every import), and #55 and #64a (they rebase onto it).

### D4. `client-auth` becomes the only client authentication, and #52 stays fail-closed

- **What:**
  - The `client-auth` stage keeps its position, behind `route-limiter` (G21), and every check it makes today (`client-auth.ts:60-81`): an unknown client, a missing secret, hash-format input, the presented secret against the stored hash, and an expired `client_secret_expires_at`, each answered with the same `invalid_client` text as now.
  - It now also answers what `authenticateClient` used to answer before any client lookup: `invalid_request` for a missing `client_id` or a non-string `client_secret`.
  - The record lives in `src/auth/oauth-server/authenticated-client.ts`, which #47-1 adds: a module-private `WeakMap<Request, Client>` with two functions, `setAuthenticatedClient(req, client)` and `authenticatedClient(req)`.
  - When authentication succeeds, for a confidential or a public client, `client-auth` calls `setAuthenticatedClient`. It no longer writes to `req.body`.
  - The ported `/token` and `/revoke` handlers take the client only from `authenticatedClient(req)`. When there is none, they answer `invalid_client` and touch no storage.
  - In #47-1, before `client-auth` uses the module, the tests mount a small stage in front of our handlers that looks the client up and compares its secret the way server-legacy's `authenticateClient` does, then calls `setAuthenticatedClient`. Both sides of the differential test therefore see the same client.
  - `getClient` still returns the stored hash as `client_secret` (`mcp-provider.ts:154-162`). Whether a client is confidential or public, and the 0.4.x plaintext case, are decided exactly as today.
- **Why:**
  - It is fail-closed by construction. Without the stage, nothing can authenticate a client, so every request gets `invalid_client`, from confidential and public clients alike. Today that holds only for confidential clients, and only because of the SDK's `!==`.
  - Request input can't forge the record: only code that calls `setAuthenticatedClient` writes it, and in production only `client-auth` does (a test greps for other callers).
  - It deletes the secret rewrite, the one place where #52 depends on how a library compares.
- **Binds:** #47-1 (`authenticated-client.ts`, the handlers' read side, the test stage) and #47-2 (`client-auth.ts`, S). The fail-closed test (`http-oauth-client-auth.test.ts:274-313`) keeps its assertions and mounts our `tokenHandler` instead of the SDK's.

### D5. G21 doesn't change

- **What:**
  - Every route keeps its stage list and its stage names, including whatever #59 and #55 have added by then.
  - The `sdk-router` stage now mounts our handler, so `EXPECTED` in `http-as-pipeline.test.ts` doesn't change.
  - `iss-redirect` stays on `/authorize`.
- **Why:** G21 is the contract the reviewer checks on every PR. A rename is a separate, deliberate change (Q4).
- **Binds:** #47-2 (`as-router.ts`: the imports and the four handler constructors, nothing else).

### D6. What we reuse from v2, and what we don't

- **Reuse:**
  - `OAuthError`, `OAuthErrorCode` and the types, from `@modelcontextprotocol/server`;
  - `getOAuthProtectedResourceMetadataUrl`, from the same package;
  - `OAuthClientMetadataSchema` and `OAuthTokenRevocationRequestSchema` from `@modelcontextprotocol/core`. They are the objects server-legacy uses, so `/register` accepts, strips and rejects exactly what it does today.
- **Don't reuse:**
  - `checkResourceAllowed`. It accepts any path under the configured resource, while `resource.ts` compares canonical URLs exactly.
  - `buildOAuthProtectedResourceMetadata` and `mcpAuthMetadataRouter`. Our document adds `bearer_methods_supported` and has a root alias, and one router for both documents would break G21's one pipeline per route.
  - `oauthMetadataResponse`. It is for a fetch handler, not Express.
- **Why:** v2 is the canonical source for wire shapes. Using its helpers where their rules differ from ours would change behaviour.

### D7. Dependencies, D14's pin and the guard test

- **What:**
  - #47-2 removes `@modelcontextprotocol/server-legacy` (B's hunk). After that, `pkce-challenge` stays in the tree only under the dev-only v2 client.
  - The port imports `@modelcontextprotocol/core` and `cors` directly, so both become direct dependencies: `core` with the same range as `server` (`^2.4.0`), and `cors` with `@types/cors`. Both are already in the tree (`server` depends on `core`, the express adapter on `cors`), so the lockfile gains no package. When the change lands is Q5.
  - #47-2 rewrites D14's guard test (added by WS7.2). It then asserts that server-legacy is absent from `package.json` and the lockfile, that nothing in `src` or `tests` imports it, and that `core` still resolves to one version.
  - G1's "server-legacy pinned `~2.4.0`" becomes "server-legacy absent" (the lead updates the plan). The advisory trigger ends with the pin.
  - When #47-2 merges, ADR-0001 gets a dated addendum saying that D14 is complete.
- **Why:** D14 pinned the package only "for as long as our glue depends on its internals". After the port there is no glue left.

### D8. Attribution

- **What:**
  - Each ported file starts with a header that names its source package, version and path, and says the file was modified. `tsconfig.json` doesn't set `removeComments`, so the headers survive into `dist`.
  - A new `THIRD_PARTY_NOTICES.md` holds the license text.
  - `package.json` adds it to `files` (B's hunk), so the npm package ships it.
  - The Docker image copies only `dist`, `node_modules` and `package.json` today, so it carries neither `LICENSE` nor the notices. The `Dockerfile` (O) copies both.
  - Which source and which license: Q2.
- **Why:** both candidate licenses require the notice to travel with the code.

### D9. Tests, and what "unchanged" means

- **Unchanged, not edited at all:**
  - `http-oauth-flow`, `http-oauth-security`, `http-oauth-iss`, `http-oauth-resource`, `http-oauth-code-replay`, `http-oauth-rate-limit`, `http-oauth-write-policy`, `http-oauth.test.ts`, `http-user-state` and `http-as-pipeline`;
  - `storage.test.ts` and `retention.test.ts`;
  - WS7.4's protected list: #42's replay end-to-end test, RFC 8707 binding and `iss`.

  This is what #47's "pass unchanged" means here.
- **Import lines only.** The reviewer checks that `git diff` on these files touches nothing but `import` statements:
  - `tests/unit/auth/mcp-provider.test.ts` (`AuthorizationParams`; `InvalidGrantError`, `InvalidScopeError`, `InvalidTargetError`, `ServerError`);
  - `tests/unit/auth/code-replay.test.ts`, `tests/unit/auth/account-deletion.test.ts` and `tests/unit/storage/token-hashing-migration.test.ts` (`InvalidGrantError`).

  WS7.3 has already moved their `InvalidTokenError` assertions to v2's `OAuthError`. If WS7.2 maps the type-only imports (`OAuthClientInformationFull`, `OAuthTokens`) to server-legacy rather than `@modelcontextprotocol/server`, `token-hash-provider.test.ts` and the storage tests join this list.
- **Changed on purpose:**
  - `http-oauth-client-auth.test.ts`: the fail-closed test imports our `tokenHandler` (its import and its mount line). It gains one case: without the stage, a public client also gets `invalid_client` (D4).
  - The D14 guard test (D7).
- **New:**
  - Unit tests for each ported handler and for `errors.ts`.
  - In #47-1, a differential test. The same requests go to server-legacy's handler and to ours, both backed by one fake provider that throws the matching family's errors. The status must match, and so must the `Location`, `Cache-Control`, `Allow`, `Access-Control-*` and `RateLimit-*` headers and the body. The test covers both authorize phases, each grant type, malformed bodies, wrong methods, preflights and the limits. #47-2 deletes it, along with the dependency it needs.
  - In #47-2, a test that each `OAuthError` the provider throws reaches the client with its own code: 400 for every code except `server_error`, which answers 500 as D3 requires (or, on `/authorize` phase 2, a redirect). A family mismatch would instead turn a 400 code into a generic 500.
- **Gates:** the full suite, plus the Postgres storage tests with `DATABASE_URL` and `REQUIRE_DB_TESTS=1` on the verifier's throwaway Postgres, with 0 skipped.

### D10. Two PRs, with the cut-over in P8 (Wed Dec 2)

| PR | What | Files (owner) | Author | Size | Built | Packet |
|---|---|---|---|---|---|---|
| ADR-0002 | This document | `docs/adr/` (P) | P | S | Nov 13 | Signed off Wed Nov 18 (P5, batch 3) |
| **#47-1** Port the handlers | D1, the `errors.ts` part of D3, D4's `authenticated-client.ts`, D8, and the differential and unit tests. New files, plus the two `Dockerfile` lines and, if Q5 puts it here, B's hunk. Nothing mounts the new code yet. | `src/auth/oauth-server/**` (new; O owns it after the merge), `THIRD_PARTY_NOTICES.md`, `tests/unit/auth/oauth-server/**`; two `COPY` lines in `Dockerfile` (O acks) | S | M (2 sessions) | Thu Nov 19-Mon Nov 23 | **P7, Tue Nov 24**; P8 if P7 is full |
| **#47-2** Cut over and remove server-legacy | D3-D5, D7 and D9. Stacked on #47-1, rebased on #59 after P7. | `mcp-provider.ts` and `client-auth.ts` (S); `as-router.ts` (O acks); `package.json` and the lockfile (B's hunk); the test files in D9 | S | S (1 session) | Tue Nov 24-Tue Dec 1 | **P8, Wed Dec 2: the cut date** |

- **The per-file chains (plan §5) become:**
  - `as-router.ts`: … → #59 (P7) → #47-2 (P8) → #55 (P9).
  - `mcp-provider.ts` and its test file: … → WS7.3 (P5) → #47-2 (P8) → #55 (P9) → #64a (P10).
  - `client-auth.ts`: #52 → #47-2.
  - The lockfile: … → WS7.2 (P4) → #47-2 (P8) → REL.
  - P8 also carries WS7.4, which touches none of these files.
- **No `http.ts` change.** After WS7.3, `http.ts` imports only v2 packages, and the port doesn't change `mountAuthorizationServer`'s signature. If something does turn out to need `http.ts`, it waits until WS7.4 merges and goes through P. The port is independent of the Dec 4 WS7.4 cut.
- **Rebases after the cut-over.** #55 (O, P9) and #64a (S, P10) are built against server-legacy's imports, so both rebase onto #47-2. The rebase is mechanical: error imports move to `./oauth-server/errors.js`, and #55's stages sit next to the handler constructors that #47-2 changed.
- **Why S writes both PRs:**
  - S owns the two files the cut-over has to change in one merge (D3), and S wrote the token and client-authentication code (#42, #52).
  - S's lane is free until #64a.
  - O is on #55 until Dec 1, and P is on WS7.3 and WS7.4.
- **Maintainer time:** about 0.75 h for #47-1, 0.5 h for #47-2 and 0.5 h for this sign-off.

### D11. If #47-2 misses P8

- **0.5.0 ships on the D14 pin**, as ADR-0001 Q3 says, and #47 and #46 move to 0.5.1.
- **No P10 attempt.** P10 already has #64a on `mcp-provider.ts`, it is the freeze, and no packet would be left for a fix.
- **#47-1 stays merged if it has merged.** It isn't mounted and its tests still run. The 0.5.1 cut-over is then one PR in January, before v1.x support ends (about 2027-01-27; the plan's backstop is Jan 12).
- **The documented reason** (issue #47's fallback), for the CHANGELOG and SECURITY.md:
  - server-legacy 2.4.0 is the authorization server code the SDK maintainers publish with every v2 release (2.0.0 through 2.4.0).
  - It is pinned `~2.4.0`, and a guard test holds the pin and a single `core` version.
  - An advisory with no patched 2.4.x pulls the port forward into a 0.5.x (D14's trigger).
  - The port is ready and lands in 0.5.1.

### Where each must-keep behaviour lives after the port

| Behaviour | Today | After the port |
|---|---|---|
| PKCE S256 only | The SDK's authorize schema (`code_challenge_method` is the literal `S256`); the SDK's token handler (`verifyChallenge`); the metadata | `oauth-server/authorize.ts` (the same literal); `oauth-server/token.ts` with `pkce.ts` (constant-time); `metadata.ts` |
| RFC 8707 resource binding | The provider (`authorize` `:371`, `bindResource` `:319`, `exchangeRefreshToken` `:625`, `verifyAccessToken` `:768`), `resource.ts` and the stored `resource`. The SDK parses `resource` as a URL. `expectedResource` on the bearer middleware (`http.ts`; v2's after WS7.3). | Unchanged. The ported handlers parse `resource` the same way. |
| RFC 9207 `iss` | The provider's redirects (`authorizationResponse`, `:302`); the `iss-redirect` stage on the SDK's error redirects; the metadata flag | Unchanged. The flag moves into our `createOAuthMetadata`. |
| Refresh-token families with reuse detection (RFC 9700) | The provider's `exchangeRefreshToken` and `rejectRefreshToken` (`:616-701`); storage's `rotateRefreshToken`, `getConsumedRefreshToken` and `deleteTokenFamily` | Unchanged. `token.ts` calls the provider with the same arguments. |
| #42 code-replay revocation | The provider's `challengeForAuthorizationCode` and `exchangeAuthorizationCode` (`:534-614`); storage's `consumeAuthCode`, `revokeConsumedAuthCode` and `saveCodeTokens` | Unchanged. `token.ts` keeps the call order: the challenge (which spends the code), then PKCE, then the exchange. |
| The YNAB OAuth legs and their rate limit | `as-router.ts`: `ynabFederationLegs` and `oauth-leg-limiter` (100 per 15 min) | Unchanged; they never used the SDK |
| #52's fail-closed client authentication | `client-auth.ts`, plus `getClient` returning the hash, plus the SDK's `!==` | `client-auth.ts` is the only check; the handlers take the client from `authenticatedClient(req)` (D4) |
| G21's stage order per route | `as-router.ts` (`routePipeline`); `http-as-pipeline.test.ts` | Unchanged (D5) |
| The DCR validator and the authorize guard (#55) | Stages ahead of `sdk-router`, backed by `client-metadata.ts` and `authorize-guard.ts` (created by #55) | Unchanged. `register.ts` still parses with core's schema after `dcr-validator`. `authorize.ts` keeps both phases, so the guard still covers every phase-2 path. There is one copy of `redirectUriMatches`; O decides where during #55's rebase. |
| STOR-1's issued-under-user checks | Storage: every token read is joined to its user; `saveCodeTokens` needs the user row; rotation holds that row `FOR KEY SHARE` | Unchanged. The handlers reach storage only through the provider. |
| The metadata documents | The SDK's `createOAuthMetadata` plus our flag; our protected-resource document; the SDK's `metadataHandler` | `oauth-server/metadata.ts`, with the same fields and the same issuer check and message. The protected-resource document is unchanged. |
| Error responses | The SDK's handlers and error classes | `sendOAuthError` and D3's classes, with the same codes, statuses, bodies and redirects |
| Rate limits inside the handlers | The SDK's: 100 per 15 min on `/authorize`, 20 per hour on `/register`. `/token` and `/revoke` have 50 per 15 min, in `route-limiter`. | The same numbers, behind the same `rateLimit` option that #59 and #55 use |

### The path to #46 (Client ID Metadata Documents)

- **What #46 needs:**
  - a URL-form `client_id` resolved to a client at `/authorize` and `/token`;
  - the metadata flag `client_id_metadata_document_supported` (already in core's `OAuthMetadataSchema`);
  - the `redirect_uri` checked against the fetched document;
  - DCR kept working.
- **How it fits after the port:**
  - A pure module, `src/auth/client-id-metadata.ts` (O), fetches and validates the document: HTTPS only, size and time limits, the SSRF block list, a TTL cache, and the document's `client_id` equal to its URL.
  - `clientsStore.getClient` (S) resolves an `https:` client id through that module, so `client-auth` and `authorize.ts` see an ordinary public client.
  - `createOAuthMetadata` sets the flag behind a setting, off by default.
  - `authorize.ts` checks `redirect_uri` against the document's `redirect_uris`. Whether the loopback port relaxation applies to such a client is #46's decision; with the handler ours, it is a one-line choice.
  - `as-limiter` (#55a) bounds the fetches per IP.
- **No new stage**, so G21's lists don't change.
- **Schedule:** that is for #46's own design and PR, not this ADR. #46 rebases on #47-2. With #55 in P9 and #64a in P10, its provider hunk has no packet of its own before the freeze (see Risks).

## Consequences

**Positive:**
- server-legacy and its deprecation notice are gone. The AS no longer depends on a package that is "planned for removal in v3".
- There is one `OAuthError` family, so a mismatch between families can't turn an OAuth error into a 500.
- #52's fail-closed client authentication no longer depends on a library's `!==`.
- The handlers are ours to change, which #55b (a guard over every phase-2 path), #64a and #46 need.

**Negative:**
- We maintain about 500 lines of security-relevant code ourselves, with no upstream fixes. Until v1.x support ends (about 2027-01-27), fixes to the v1.x and server-legacy handlers must be watched for and ported by hand.
- Two more PRs land on `mcp-provider.ts` and `as-router.ts` ahead of #55 and #64a, which rebase onto them.
- There is one more lockfile write after WS7.2.

**Neutral:**
- Nothing changes on the wire or in storage: no migration and no new setting.
- `http.ts` is untouched.

## Risks

- **The port drifts from server-legacy in a way no test sees.** Mitigation: #47-1's differential test runs against the real server-legacy handlers while they are still installed; the HTTP tests stay unchanged; the reviewer checks that the edited test files changed only their imports.
- **The two error families meet.** If the provider and the handlers don't switch in the same merge, provider errors answer 500. Mitigation: #47-2 is one PR, and its test checks that each provider error keeps its own code (D9).
- **#55 and #64a rebase late.** Both are built against server-legacy's imports and rebase between Dec 2 and their packets. Mitigation: the rebase only changes imports, the error classes keep their names, and O and S are the authors.
- **Packet hours in P7 and P8.** P7 falls in Thanksgiving week, and P8 is WS7.4's packet. Mitigation: Q6's fallback order. #47-1 touches no file in an open per-file chain (the `Dockerfile`'s only planned PR, 62a, merged as #76), so it can take any packet with room.
- **#46 has no slot.** Even with the port on time, #46's provider hunk would share P10 with #64a. The lead decides #46's packet separately: stacked on #64a, or 0.5.1.
- **Upstream fixes stop reaching us.** A security fix to the v1.x or server-legacy handlers no longer arrives through `npm update`. Mitigation: watch the typescript-sdk advisories for the `server/auth` code until v1.x support ends. SECURITY.md lists the AS as ours.
- **WS7.2 maps imports differently.** This ADR assumes WS7.2 maps the AS imports to server-legacy and the type imports to `@modelcontextprotocol/server`. If it doesn't, only D9's list of import-only files changes.

## Alternatives considered

- **(a1) `oidc-provider`.** The most complete option, and the one to revisit if the AS grows (CIMD, DPoP, PAR). Rejected for 0.5.0: it would replace our storage model, consent flow and token formats, so #42, #52, STOR-1 and #64a would be redone on its terms.
- **(a2) `@node-oauth/oauth2-server`.** It covers only authorize and token. Everything else stays ours, now behind a model adapter.
- **(c) v2 alone.** It isn't an authorization server. Its pieces are used inside (b) (D6).
- **Vendoring server-legacy's `auth` directory unchanged.** It would keep the second `OAuthError` hierarchy and the `!==` client check, and add dead code (`mcpAuthRouter`, the proxy provider, `bearerAuth`).
- **An external identity provider.** Ruled out under Options.
- **Shipping 0.5.0 on the pin by choice.** That is the fallback (D11), not the goal: the 2026-11-09 decision put #47 in 0.5.0.
- **One PR instead of two.** About 500 new lines and the cut-over would go into one review, in P8 next to WS7.4. With two PRs, #47-1 is reviewed on its own, against the differential test, a week earlier.

## Open questions for the maintainer

Each question has a recommendation. As in plan §10, a missed answer means the recommendation ships.

1. **The option.** Port the handlers (option b), as D1 says. *Recommendation: yes.*
2. **The source and license of the ported code.**
   - (a) Port from `@modelcontextprotocol/sdk` 1.32.2, which is MIT ("Copyright (c) 2024 Anthropic, PBC"). It is the code 0.4.x runs today, and it behaves the same as 2.4.0 for everything we use. `THIRD_PARTY_NOTICES.md` carries the MIT notice.
   - (b) Port from server-legacy 2.4.0, which is Apache-2.0 with an MIT residue. The files then keep the Apache-2.0 notice and a statement of changes (Apache-2.0 §4).

   *Recommendation: (a), one license and the same as ours.*
3. **Error classes.** Either thin named subclasses of v2's `OAuthError` with an `errorCode` alias (D3), or a bare `new OAuthError(code, …)` everywhere, which means rewriting about 60 test assertions to check `code`. *Recommendation: the subclasses.*
4. **The `sdk-router` stage name.** Keep it through 0.5.0 (D5), or rename it to `as-handler` in #47-2. A rename changes `EXPECTED` in `http-as-pipeline.test.ts` and one assertion in `http-oauth-client-auth.test.ts`. *Recommendation: keep it, and rename in 0.5.1.*
5. **Where the dependency changes go.** If WS7.2 hasn't merged when this is answered (it is due Sat Nov 14), add `@modelcontextprotocol/core` (`^2.4.0`), `cors` and `@types/cors` in WS7.2's lockfile write; this adds no package to the tree. Otherwise they go in #47-1 as B's hunk. #47-2 removes server-legacy. *Recommendation: as written.*
6. **Packets.** #47-1 in P7 (Tue Nov 24), about 0.75 h on top of #59 and #65b. #47-2 in P8 (Wed Dec 2), about 0.5 h next to WS7.4. P8 is the cut. *Recommendation: yes. If P7 is full, both go in P8, which then has three PRs.*
7. **The fallback.** If #47-2 misses P8: ship on the pin with D11's reason, keep #47-1 merged and unmounted, and cut over in 0.5.1. *Recommendation: yes, and no attempt in P10.*
8. **Authors and owners.** S writes both PRs. O acks the `as-router.ts` hunk and owns `src/auth/oauth-server/**` once #47-1 merges. B acks the `package.json` hunk. *Recommendation: yes.*

## Addenda

None yet.
