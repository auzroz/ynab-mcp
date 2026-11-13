# ADR-0002: The OAuth authorization server moves to oidc-provider

| | |
|---|---|
| Status | **Proposed** (2026-11-13, revised the same day after the maintainer's answers). The first draft proposed porting server-legacy's handlers. The maintainer chose a library instead (decision 1 below), so this revision designs the move to one. |
| Issues | #47 (this move), #46 (Client ID Metadata Documents, built on it), and #42, #52, #53, #54, #55, #59, #64, #94, which share its code |
| Bound by | ADR-0001: the package table, D14 (the `~2.4.0` pin, the guard test, the advisory trigger, the `OAuthError` `instanceof` problem) and the Q3 fallback. The maintainer's answers of 2026-11-13 (below) replace Q3's "ship on the pin at the freeze": 0.5.0 waits for this move. |
| Evidence | Two throwaway spikes, run on 2026-11-13 outside the repository (see "The spikes") |
| Changes | Later changes are dated addenda at the end of this file. |

## Maintainer decisions (2026-11-13)

The answers to the first draft's eight questions. They bind this revision.

1. **Adopt a maintained OAuth library, not a port.** The first draft rejected `oidc-provider` because it couldn't land by Dec 9; decision 7 removes that constraint.
2. **Code we still port or adapt comes from the MIT `@modelcontextprotocol/sdk` 1.32.2.** With a library, that is only the 405 method check (D8).
3. **Our own OAuth error classes are thin subclasses of v2's `OAuthError`**: the glue stages, the YNAB legs and the resource side (D9).
4. **The last AS stage gets a new name in 0.5.0**, in G21 and the pipeline test. It becomes `as-library` (D8).
5. **The dependency changes are re-derived for the library** and go in as B's hunk (D11).
6. **The PR plan and packets are re-planned** (D15).
7. **The timeline is flexible**: "Completion is more important than the specific date." 0.5.0 waits for the move instead of shipping on ADR-0001's D14 pin. The Dec 9 freeze, the Dec 10 rc and the Dec 18 tag move if needed. v1.x and server-legacy support ends around 2027-01-27.
8. **S writes the PRs.** O acks `as-router.ts` and owns the AS code afterwards; B acks `package.json`. Opus writes the design-sensitive PRs and Sonnet the mechanical ones (D15 says which is which).

## Context

"Today" means `release/0.5.0` at 05353a6, after WS7.2 (#97), #94 (#98), WS8.32 (#99), #61b (#101) and WS7.5+7.6 (#102), before WS7.3.

**What the AS runs on today.** `mountAuthorizationServer` (`src/auth/as-router.ts`) mounts one pipeline of named stages per route. The last stage of `/authorize`, `/token`, `/register` and `/revoke` is `sdk-router`, which is server-legacy 2.4.0's handler (`authorizationHandler`, `tokenHandler`, `clientRegistrationHandler`, `revocationHandler`). The handlers call our `McpOAuthProvider` (`src/auth/mcp-provider.ts`), which:
- implements the YNAB broker (consent page, `/oauth/ynab/*` legs, the browser-binding cookie);
- keeps codes and tokens in our storage under `h1.` keys (#52), with tombstones for #42's replay revocation and RFC 9700 reuse detection;
- relies on storage for STOR-1's user checks and on #94's `completeAuthorization` for an atomic sign-in.

Our stages sit ahead of the handlers: host validation, limiters, bounded parsers, `cors-origin`, and #52's fail-closed `client-auth`. #55 and #59 add more.

**Why it moves.** server-legacy is frozen, npm-deprecated and "planned for removal in v3". Its README sends AS users to "a dedicated OAuth provider". v2 ships no authorization server: no authorize, token, registration or revocation handler, no provider interface, no client authentication, no PKCE check, no RFC 8414 builder. It does ship v2's branded `OAuthError`, the core Zod schemas and the resource-side helpers. server-legacy's own `OAuthError` family isn't recognized by v2's bearer middleware (ADR-0001 D14). server-legacy 2.4.0 is Apache-2.0; the same handlers are MIT in `@modelcontextprotocol/sdk` 1.32.2.

## Options

Facts checked on 2026-11-13 against npm, the published tarballs and the two spikes.

| | (a1) `oidc-provider` | (a2) `mcp-oauth-server` | (a3) `@node-oauth/oauth2-server` | (c) v2 alone |
|---|---|---|---|---|
| Version, date | 9.15.0, 2026-11-13 (9.14.0 on Nov 11; 9.x since 2025-04-15, 43 releases) | 1.1.0, 2026-11-11 (1.0.0 on 2026-08-11) | 5.3.1, 2026-10-13 | server 2.4.0, 2026-10-23 |
| Adoption, maintenance | 1.63 M downloads a week; first release 2016; one maintainer (panva); OpenID certified | 2.7 k a week; one maintainer; 9 GitHub stars; a fork of the SDK's AS | 324 k a week; a community fork of oauthjs | Upstream, but the AS is out of scope |
| License | MIT | MIT | MIT | Apache-2.0 |
| Size, dependencies | 561 KB; `koa` 3, `jose` 6, `debug`, 24 packages more than Express needs | 683 KB; `zod`, `debug`; peers `express`, `express-rate-limit` | 151 KB; `type-is`, `basic-auth`, `@node-oauth/formats` | Installed |
| Fits Express | Koa inside Express, one wrapper stage | Express-native | Express wrapper | Not applicable |
| PKCE S256 only, RFC 8707, RFC 9207, DCR, revocation, RFC 8414 | All built in | All built in (RFC 8707 matches a path prefix) | PKCE allows `plain`; no DCR, revocation, metadata, RFC 8707 or RFC 9207 | None |
| Refresh rotation, reuse revocation, code-replay revocation | Built in (a replay revokes the grant) | Rotation built in; reuse revocation is opt-in; code replay is the model's job | Rotation hook only | None |
| Storage | Its adapter models replace our tables | Its model interface fits our storage almost as it is | Model hooks | Not applicable |
| CIMD (#46) | Experimental (draft-03, needs an `ack`) | Built in, opt-in | No | Schema field only |
| **Disqualifier** | None. It is a rewrite of our AS glue and storage (D15). | None on function. Maturity: a four-month-old 1.x with one maintainer and a few thousand installs, for our most security-sensitive code (new question 1). | Too little of the AS | No AS |

Also ruled out:
- `@better-auth/oauth-provider`: needs the better-auth framework.
- `@cloudflare/workers-oauth-provider`: Cloudflare Workers only.
- `mcp-auth`: a resource-side verifier, not an AS.
- An external identity provider (Auth0, Keycloak): every self-hosted operator would run a second service, and the YNAB broker would become a plug-in of it.
- The port of server-legacy's handlers: decision 1.

**Recommendation: (a1) `oidc-provider`, as the lead assumed.** Every must-keep behaviour has a place in it (the table after D15), and the spike exercised each one. It is the mature choice, and maturity is the main reason to adopt a library rather than port. (a2) `mcp-oauth-server` is the newly found alternative. It fits our code better: it is the SDK's AS continued as a library, so our storage, error shapes and tests would change far less. But it is four months old, with one maintainer and about 2.7 k installs a week. New question 1 asks the maintainer to confirm the choice.

## The spikes

Neither is in the repository. Both mount the library inside Express 5 behind stand-in stages, register a client, authorize with PKCE S256 and a `resource`, complete a stand-in YNAB login, then exchange, refresh and revoke.

- **oidc-provider 9.15.0: 46 of 46 checks pass.** Each check is backed by the result of a request it ran:
  - **Discovery and DCR.** RFC 8414 metadata at `/.well-known/oauth-authorization-server`, with `S256` only and `authorization_response_iss_parameter_supported`. DCR answers 201, and storage holds only the secret's `s256.` hash.
  - **The authorize request.** Plain PKCE, a missing PKCE challenge and a foreign `resource` are each redirected back to the client with an error, `state` and `iss`. An unregistered `redirect_uri` is never redirected to.
  - **Consent and the code.** The consent page is our interaction route. A read-only choice gives a `read-only` token although `read-write` was requested. The code and every token are 43-character values, and no token value is stored.
  - **Replay, reuse and races.** A code replay revokes the grant. Rotation works, and so does narrowing a refresh to `read-only`. A reused refresh token revokes the grant. A **forced race**, with both requests reading the token before either consumes it, leaves no live token; the adapter's compare-and-set `consume()` catches it. Two concurrent redemptions of one code leave no live token either.
  - **Client authentication.** A wrong secret, or the stored hash presented as the secret, gets `invalid_client` before the library. **Fail closed:** the library alone refuses the real secret.
  - **Revocation.** `/revoke` from a client that doesn't own the token does nothing; revoking a refresh token removes the whole grant.
  - **STOR-1.** A token issued before its user row was re-created reads as unknown.
  - **The browser binding.** Completing an interaction from a browser without its cookie is refused before the YNAB exchange. Cancel returns `access_denied` with `state` and `iss`.
  - **#64a and the upgrade.** The #64a idempotency stage gives a retry within 60 s the same token pair. A 0.4.x refresh token known only by its hash is honoured once through the public model constructors, then rotated; replaying it later counts as reuse.
- **mcp-oauth-server 1.1.0: 18 of 19 checks pass.** The one failure is narrowing a refresh to `read-only` after a `read-write` grant. D7's normalization fixes it for both libraries. The spike also showed that the library defaults an omitted `grant_types` to `authorization_code` only. A client registered that way can't refresh, so `dcr-validator` would have to default it.

## Spike checks

The oidc-provider 9.15.0 spike's 46 checks, in the order they ran. All passed on 2026-11-13 (Node 26, Express 5.3.0, memory adapter as in D4, stand-in stages as in D8, a stand-in YNAB leg).

1. RFC 8414 metadata served at `/.well-known/oauth-authorization-server`
2. Discovery: `code_challenge_methods_supported` is `["S256"]`
3. Discovery: `authorization_response_iss_parameter_supported`
4. Discovery: registration and revocation endpoints
5. DCR answers 201 with a `client_secret`
6. DCR: storage holds only the `s256.` hash, never the secret
7. DCR: a public client with an `http://localhost` redirect is accepted
8. DCR: an invalid redirect URI gets `invalid_redirect_uri`
9. Plain PKCE: redirected with `error` and `iss`
10. No PKCE challenge: refused
11. A foreign `resource` at `/authorize`: `invalid_target`, redirected with `iss`
12. An unregistered `redirect_uri`: no redirect
13. The consent page offers both levels when read-write is requested and allowed
14. The authorization response carries `code`, `state` and `iss`
15. Codes are 43 base64url characters
16. A wrong `code_verifier`: `invalid_grant`
17. The code exchange returns access and refresh tokens
18. A read-only choice gives a `read-only` scope although `read-write` was requested
19. The token response is `no-store`
20. `provider.AccessToken.find` gives the account, the client and `aud` = the MCP resource
21. No token value appears in storage
22. A code replay: `invalid_grant`, and the grant is revoked
23. A read-write choice gives a read-write scope (`read-only` implied)
24. No requested scope: the consent page still offers both levels
25. A refresh rotates the refresh token
26. A refresh narrows read-write to read-only
27. A refresh with a foreign `resource`: `invalid_target`
28. Reuse of a rotated refresh token: `invalid_grant`, and the grant is revoked
29. Concurrent refreshes by one client never yield two different live pairs
30. The #64a stage: a retry within 60 s gets the same pair, and nothing is revoked
31. The #64a stage: once the successor is used, the old token is reuse
32. A forced race: the compare-and-set `consume()` refuses the loser and revokes the grant
33. The upgrade bridge honours a 0.4.x refresh token once, and the library rotates it
34. The upgrade bridge: replaying the 0.4.x value after rotation is reuse
35. Concurrent redemption of one code leaves no live token
36. Completing an interaction without its browser cookie is refused before the YNAB exchange
37. Cancel returns `access_denied` with `state` and `iss`
38. A wrong secret: `invalid_client` before the library
39. The stored hash presented as a secret: `invalid_client`
40. Fail closed: the library alone refuses the real secret
41. Errors are `{ error, error_description }` JSON
42. A wrong method on `/token` (records the library's 404; D8 keeps 405)
43. `/revoke` by a client that doesn't own the token has no effect
44. Revoking a refresh token removes the whole grant
45. A token issued before its user row was re-created reads as unknown
46. Its refresh token is refused too

## Decision

### D1. oidc-provider `~9.15.0` is the authorization server

- **What:**
  - One `Provider` instance, built by `src/auth/oidc/provider.ts`, serves `/authorize`, `/token`, `/register`, `/revoke`, the RFC 8414 and OIDC discovery documents, and `/jwks`.
  - In each AS route's pipeline it is the last stage, `as-library`: a wrapper that restores `req.url` and `req.baseUrl` (Express strips the mount path) and hands the request to `provider.callback()`.
  - Our protected-resource document (RFC 9728) stays ours.
- **Why:** it is the only mature library that covers every protocol feature we use, plus CIMD for #46.
- **Binds:** #47-2 (the configuration) and #47-4 (the mount).

### D2. Configuration

- **Routes:** `/authorize`, `/token`, `/register`, `/revoke` and `/jwks`. Discovery is served at both `/.well-known/oauth-authorization-server` and `/.well-known/openid-configuration` (verified).
- **Features on:**
  - `registration`, with no initial access token;
  - `revocation`;
  - `resourceIndicators`:
    - `defaultResource` is the MCP resource, so an omitted `resource` keeps working as today;
    - `getResourceServerInfo` accepts only the canonical resource from `resource.ts` and throws `InvalidTarget` for anything else;
    - `useGrantedResource` is on;
    - access tokens are opaque, bound to the resource as their audience, with a TTL of `MCP_ACCESS_TOKEN_TTL_SEC`.
- **Features off:** dev interactions, userinfo, introspection, pushed authorization requests, RP-initiated logout, the claims parameter, the device flow and client credentials. D7 drops the `openid` scope, so no ID token is ever signed. The signing key the library requires is generated at startup and never used.
- **PKCE:** always required. S256 is the library's only method.
- **Client authentication:** `clientAuthMethods: ['client_secret_post', 'none']`, as today. `clientDefaults` gives `grant_types: ['authorization_code', 'refresh_token']`, `response_types: ['code']` and `token_endpoint_auth_method: 'client_secret_post'`, so a registration that omits them behaves as today.
- **Tokens:**
  - `rotateRefreshToken: true` (every use, as today);
  - `issueRefreshToken` whenever the client may refresh;
  - `expiresWithSession: false`;
  - the `ttl` functions apply STOR-1's and #54's retention: refresh tokens get the idle window, capped by the absolute lifetime from the family's start (`iiat`); codes and interactions get `authCodeTtlSec`, today's pending-authorization lifetime. `YNAB_CALLBACK_DEADLINE_MS` stays as our check in `complete`.
- **CORS:** `clientBasedCORS: () => true`, the `*` the SDK sends today. Without it, browser clients such as the MCP Inspector lose `/register` and `/token`.
- **Errors:** `renderError` answers pre-redirect `/authorize` errors as today's JSON (`400 { error, error_description }`) instead of the library's HTML page. #55 replaces this with its own error page for unverified clients.
- **Cookies:** the library's interaction and session cookies are signed with a key derived from `ENCRYPTION_KEY` (HKDF; no new setting). They are `Secure` whenever `PUBLIC_URL` is HTTPS. `provider.proxy` follows `TRUST_PROXY`.
- **No silent sign-in:** `loadExistingGrant` returns only the grant our interaction just created. Every authorization therefore shows the consent page and goes through YNAB, as today.
- **Binds:** #47-2.

### D3. The YNAB broker runs as the library's interaction

- **What:**
  - `interactions.url` is `/oauth/interaction/:uid`. Every leg therefore stays under `/oauth` and `oauth-leg-limiter`.
  - `GET /oauth/interaction/:uid` renders today's consent page from `provider.interactionDetails`. It offers read-write only when `YNAB_OAUTH_ALLOW_WRITE`, not `YNAB_READ_ONLY`, and the requested scope allow it (`scopeCeiling`, unchanged).
  - `…/start?scope=` records the choice in a hashed `state` row (`pending_auth`, as today) and redirects to YNAB.
  - `/oauth/ynab/callback` (the URI registered at YNAB) maps `state` to the interaction and redirects to `/oauth/interaction/:uid/complete`. The library's interaction cookie is scoped to that path.
  - `complete` first calls `interactionDetails`. Without this browser's cookie that call throws, before anything else happens, so the library's cookie replaces our consent cookie as the browser binding (the spike checked this).
  - `complete` then exchanges the YNAB code, resolves the YNAB user, stages the sign-in (D4) and saves a `Grant`:
    - a `read-only` choice adds the resource scope `read-only` and rejects `read-write`;
    - a `read-write` choice adds both.
  - Finally `complete` calls `interactionFinished`. The library then issues the code to the client with `state` and `iss`.
  - Cancel, a YNAB denial and a failed exchange each call `interactionFinished` with `access_denied` or `server_error` and today's fixed descriptions. The library redirects with `iss`, and nothing from YNAB is forwarded.
- **Why:** the documented extension point for a login and consent flow. It needs no change to the library.
- **Binds:** #47-2. The consent-page code moves from `mcp-provider.ts` into `src/auth/oidc/interaction.ts`, carrying #55's hardening if #55 has merged.

### D4. Storage: the adapter keeps #52, #42, STOR-1 and #94

- **What:** `src/auth/oidc/adapter.ts` implements the library's adapter (`upsert`, `find`, `findByUid`, `consume`, `destroy`, `revokeByGrantId`) over new `Storage` methods. Its rules:
  - **#52, hashed at rest.** A row's key is `TokenHasher` `h1.` HMAC of its kind and id:
    - access token, refresh token and code map to today's kinds `access`, `refresh` and `code`;
    - session, interaction and registration access token get new kinds;
    - grants and clients are keyed by their (non-secret) ids.

    A token id that isn't 43 base64url characters is refused before any storage read. The library keeps each token's value in its payload as `jti`; the adapter never stores it and puts it back on `find`.
  - **#52, client secrets.** A DCR client's secret is stored as `s256.` and returned as `client_secret`, so the library's own comparison can only pass after `client-auth` (D5).
  - **#42 and RFC 9700, a compare-and-set `consume()`.** Consuming an already-consumed code or refresh token revokes its grant and throws the library's `InvalidGrant`. This catches the race the library's own read-then-consume leaves open.
  - **#42, tokens only for a live grant.** A token or code is saved only while its grant row exists, checked in the same transaction (on Postgres, `FOR KEY SHARE` on the grant). A replay that revoked the grant in between leaves nothing behind.
  - **STOR-1.** Every token read is joined to its user row. A token whose user is gone, or which predates the user's row, reads as unknown.
  - **#94, atomic sign-in.** `complete` stages the sign-in (the encrypted YNAB refresh token and the YNAB grant level) under the grant id. The code's `upsert` runs #94's `completeAuthorization` in one transaction: the client must still be registered (locked against the sweep), the staged user is applied, and the code row is inserted. If the client is gone, nothing is written and the library answers `server_error`.
  - **Retention and the sweep.** Every row carries `expires_at`, `grant_id`, `account_id`, `client_id` and `consumed_at`. `sweepExpired` deletes expired rows in batches. Abandoned and unused clients use the grant rows.
  - **Account deletion and #53b.** `deleteUserData` deletes every row with the user's `account_id`, then the user, in one transaction. `AccountStore` keeps its interface: `listConnections` reads grant rows, and `revokeUserFamily` takes a grant id.
- **Drivers:** memory, SQLite and Postgres, all in the same PR, with one conformance suite run against each (D13).
- **Migration M4** (it takes #64a's slot, since #64a's own M4 is dropped: see D14):
  - one `oauth_rows` table (`key` PK, `model`, `payload` JSON, `grant_id`, `account_id`, `client_id`, `uid`, `expires_at`, `consumed_at`, `created_at`), with indexes on `(model, grant_id)`, `account_id`, `uid` and `expires_at`;
  - existing clients converted (D12);
  - the old token tables left in place, read only by the upgrade bridge.
- **Binds:** #47-1. D owns the drivers; S writes the adapter.

### D5. Client authentication stays #52's fail-closed stage

- **What:** `client-auth` stays where it is, behind `route-limiter`, with every check it makes today. On success it still writes the stored hash into `req.body.client_secret`, now so that the library's comparison passes.
- **Why:** it is fail-closed by construction. The library alone compares the presented secret with the stored hash and refuses (the spike checked this). The rewrite is a stage ahead of the library, not a patch of it.
- **Changes:**
  - The library's DCR returns `client_secret_expires_at: 0`: new secrets no longer expire after the SDK's 30 days. The sweep still removes clients unused for 90 days.
  - A refusal that comes from the library itself (for example an unknown auth method) is 401, not 400. Our stage keeps answering 400.
- **Binds:** #47-4.

### D6. Refresh tokens, codes and the #64a stage

| Behaviour | Where |
|---|---|
| Rotation on every use; reuse revokes the family (the library's grant) | Library (`rotateRefreshToken`) |
| A race between two refreshes of one token | Adapter compare-and-set (D4) |
| Code replay revokes the grant | Library, plus the adapter for the race |
| A **live** refresh token or a **consumed** code presented by another client revokes the grant (today's RFC 9700 hardening; the library only refuses it) | Our `grant-guard` stage on `/token`. It looks the value up with `provider.RefreshToken.find` and `provider.AuthorizationCode.find` (public API) and revokes through storage. It keeps today's behaviour, so it lands in #47-4. |
| #64a's 60 s idempotency window | Our `refresh-guard` stage on `/token`, added by the re-scoped #64a. The cache key is the refresh token's hash, the client, the requested `scope` and the requested `resource`. A retry that repeats all four within 60 s, while the successor is unused, gets the cached response; the library never sees it. Any other replay goes to the library as reuse and revokes the family, as #64a specifies ("anything else revokes the family"). The cache is per process, like the limiters (#67a). |
| A consumed refresh token stays detectable | The adapter keeps a consumed row until the later of: 30 days after consumption (today's `REFRESH_TOKEN_REUSE_WINDOW_MS`), and the expiry of its grant's last live token. A replay inside that window revokes the family, as today; the sweep checks the grant before deleting the row. |

### D7. Scope normalization

- **What:** a Koa pre-middleware (`provider.use`, a documented extension point) normalizes `scope` on `/authorize`:
  - no scope means `read-only read-write`;
  - `read-write` implies `read-only`;
  - `openid` and other unknown scopes are dropped (#55 decides drop or refuse).
- **Why:**
  - The library answers `access_denied` when no requested scope is granted. Without this, a client asking only for `read-write` that the user downgrades, or a client sending no scope, would fail.
  - Narrowing a refresh to `read-only` needs `read-only` in the grant (both spikes).
- **Change:** a read-write token's `scope` is `read-only read-write` instead of `read-write`. The access level is unchanged: read-write only when the scope includes `read-write`.

### D8. G21: stage lists, with the library stage renamed

- **What:**
  - The last stage is `as-library` (decision 4).
  - A new `method-check` stage keeps today's 405 with `Allow` and a `method_not_allowed` body; the library answers 404. It is ported from 1.32.2's `allowedMethods` (MIT, about 10 lines, decision 2).
  - `route-limiter` stages on `/authorize` (100 per 15 min) and `/register` (20 per hour) replace the SDK handlers' internal limiters. #59's keys apply to them.
  - `iss-redirect` goes: the library sets `iss` on every authorization response, errors included (the spike checked this).
- **The final stage lists**, once #47-5 and the re-scoped #64a have merged (with #55's and #59's stages as the plan has them). #47-4 mounts every stage except `legacy-refresh` and `legacy-revoke` (added by #47-5) and `refresh-guard` (added by #64a). Each of those PRs adds its stages to `EXPECTED` itself.

| Route | Stages |
|---|---|
| `/authorize` | host-validation → as-limiter → bounded-parser → method-check → route-limiter → authorize-validation → authorize-guard → as-library |
| `/token` | host-validation → as-limiter → bounded-parser → method-check → cors-origin → route-limiter → client-auth → legacy-refresh → grant-guard → refresh-guard → as-library |
| `/revoke` | host-validation → as-limiter → bounded-parser → method-check → cors-origin → route-limiter → client-auth → legacy-revoke → as-library |
| `/register` | host-validation → as-limiter → bounded-parser → method-check → route-limiter → dcr-validator → as-library |
| `/.well-known/oauth-authorization-server`, `/.well-known/openid-configuration`, `/jwks` | host-validation → bounded-parser → as-library |
| the PRM routes | unchanged (`metadata`, ours) |
| `/oauth` | host-validation → oauth-leg-limiter → bounded-parser → ynab-federation (now including the interaction routes) |

- **`dcr-validator`** (#55) also sets `application_type: native` on a registration whose redirect URIs are all loopback or private-use. That keeps today's RFC 8252 loopback port relaxation, which the library applies only to native clients.
- **Binds:** #47-4, with `http-as-pipeline.test.ts`'s `EXPECTED` changed in that PR; #47-5 and #64a for their own stages.

### D9. Errors

- **Our own errors** (decision 3) come from `src/auth/errors.ts`: thin subclasses of v2's `OAuthError`. `sendOAuthError` answers 400, or 500 for `server_error`. They are used by the stages, the interaction and YNAB routes, and the `/mcp` verifier, which throws `OAuthError(InvalidToken)` as WS7.3 does.
- **Errors thrown into the library** (by the adapter) must be the library's own (`errors.InvalidGrant` from `oidc-provider`), because it recognizes only its own classes. Only the adapter throws them.
- **Response shapes** stay `{ error, error_description }` JSON. What clients can see change is listed in Consequences.

### D10. The resource side (`/mcp`)

- **What:** `src/auth/oidc/verifier.ts` implements `verifyAccessToken`:
  - it looks the token up with `provider.AccessToken.find` (public API: one adapter read, joined to the user per D4);
  - it requires `aud` to equal the canonical resource exactly;
  - it returns WS7.3's `AuthInfo`: `clientId`, `scopes`, `expiresAt`, `resource`, and `extra.userId` = `accountId`;
  - `extra.grantedScope` is read-write only when the scope includes `read-write`;
  - anything else throws v2's `OAuthError(InvalidToken)`.
- `mountAuthorizationServer` keeps returning the verifier as `provider`, so `http.ts` doesn't change. ADR-0001's D7 (no verification cache) holds.
- **Binds:** #47-2 builds the verifier; #47-4 wires it in. `http.ts` isn't touched, so WS7.4's quiet window is unaffected.

### D11. Dependencies, ADR-0001 D14's pin and the guard test

- **B's hunk in #47-2:**
  - adds `oidc-provider` `~9.15.0` (tilde, as the library advises for experimental features: CIMD); this adds koa 3.3.0, jose 6 and about 20 small packages;
  - adds `@types/oidc-provider` (DefinitelyTyped; 9.13.1 today) to the dev dependencies.
- **B's hunk in #47-4** removes `@modelcontextprotocol/server-legacy`.
- **ADR-0001 D14's guard test:**
  - asserts that server-legacy is absent from `package.json` and the lockfile, and that nothing imports it;
  - asserts the `oidc-provider` range;
  - keeps the single-`core` check.
- **The advisory trigger moves to oidc-provider:** an advisory with no patched 9.x release blocks the release. `release.yml`'s `npm audit --omit=dev --audit-level=moderate` already enforces this.
- **Nothing is vendored**, so there is no `THIRD_PARTY_NOTICES.md` beyond the 10-line `method-check` port, which carries its MIT notice in its header.

### D12. The 0.4.x upgrade path

What an upgrading instance holds, and what happens to it:

| Data | Lifetime | Recommended handling |
|---|---|---|
| `users` (encrypted YNAB refresh tokens) | Long | Kept as is (ours) |
| `oauth_clients` (DCR) | Until swept | **Converted** in M4 into library client records, validated with the library's client schema. `application_type` is set as in D8. A client that fails validation is dropped and logged, and has to register again. |
| Refresh-token families | 30-day idle, 90-day absolute (STOR-1) | **Honoured lazily** by the `legacy-refresh` stage (below) |
| Access tokens | At most `MCP_ACCESS_TOKEN_TTL_SEC` (1 h by default) | Honoured by the verifier's fallback read of the old table until they expire, or until their family is bridged or revoked |
| Codes, pending authorizations | 10 min | Dropped: a sign-in in flight at upgrade time starts over |
| Refresh tombstones (rotated before the upgrade) | 30 days | Kept read-only for the bridge's reuse detection |

**The bridge, step by step.** `legacy-refresh` runs only for a refresh token the library doesn't know:
1. **A live 0.4.x refresh token, presented by its own client.** In one storage transaction (D's drivers):
   - create a library `Grant` and a `RefreshToken` with `jti` set to the presented value, through the public model constructors (the spike checked this);
   - record the mapping from the legacy family to the new grant id;
   - delete the family's legacy access tokens (the client is refreshing, so it is about to get a new one);
   - mark the legacy refresh row converted.

   Then the library rotates the token as usual.
   - **If that rotation fails** (a storage error, say), the converted `RefreshToken` still holds the presented value, unconsumed. A retry finds it in the library, skips the bridge, and rotates normally. So a failed rotation never looks like reuse.
   - **If the rotation succeeded**, a later replay of the value is reuse, handled by the library.
2. **A 0.4.x tombstone** (a token rotated before the upgrade) is reuse. The bridge revokes the legacy family and its mapped grant, as `rejectRefreshToken` does today.
3. **A live 0.4.x token presented by another client** revokes the legacy family, as today.

Revoking a family covers both generations: `revokeByGrantId`, `revokeUserFamily` and `deleteUserData` follow the family-to-grant mapping into the legacy rows. #53b's `listConnections` also lists families not yet bridged.

**`/revoke` for an unbridged token.** A `legacy-revoke` stage on `/revoke` (#47-5) handles a token the library doesn't know but the legacy tables do. Today's ownership rule applies: the token must belong to the authenticated client. Then:
- an access token is deleted;
- a refresh token revokes its whole legacy family, including its access tokens, as `revokeToken` does today.

Either way the stage answers 200 itself. A token that belongs to another client, or that nothing knows, is left alone and also gets 200 (RFC 7009 §2.2), so the endpoint can't be used to probe for tokens.

- **The cost of preserving:** one PR, #47-5 (M). The bridge and the fallback are removed in 0.6, after every 0.4.x family has passed its 90-day absolute lifetime.
- **Leaving the bridge.** A family is converted only when its client refreshes. A family that isn't refreshed for the idle window (30 days by default) expires anyway (STOR-1). So:
  - an instance that runs 0.5.x for at least the idle window before 0.6 has bridged or expired every 0.4.x family;
  - the 0.6 upgrade notes say this;
  - 0.6 removes the bridge no earlier than 90 days after 0.5.0 ships.

  An instance upgrading from 0.4.x straight to 0.6 or later, or leaving 0.5.x sooner, reconnects its remaining connections once, as on the forced path.
- **The cost of forcing a reconnect instead:** every connected client of every user signs in again once (the consent page, then YNAB's approval) for U×C connections. A family instance with 3 users and 2 clients each means 6 reconnects. The claude.ai connector shows as disconnected until each one is redone.
- **Recommendation: preserve** (new question 3).
- **Rollback to 0.4.x** keeps the old tables. A family already bridged is unknown to 0.4.x and reconnects, which matches the existing "rollback means reconnect" note.

### D13. Tests

- **Rewritten:**
  - `tests/unit/auth/mcp-provider.test.ts` (94 cases). It splits into interaction tests and adapter tests; `McpOAuthProvider` goes away.
  - `code-replay.test.ts`, `account-deletion.test.ts`, `token-hashing-migration.test.ts` and `token-hash-provider.test.ts`, against the adapter;
  - `http-as-pipeline.test.ts` (`EXPECTED` per D8);
  - `consent-cookie.test.ts` (deleted with the cookie).
- **A new adapter conformance suite** runs against the memory, SQLite and Postgres drivers. It covers hashed keys, the absent `jti`, the shape refusal, the compare-and-set consume, the grant check, the user join, `revokeByGrantId`, expiry and sweeps. Postgres runs with `REQUIRE_DB_TESTS=1` and 0 skipped.
- **The HTTP tests keep their assertions on behaviour** (`http-oauth-flow`, `-security`, `-iss`, `-resource`, `-code-replay`, `-client-auth`, `-write-policy`, `-rate-limit`, `http-oauth.test.ts`, `http-user-state`). Two kinds of edit are expected:
  - **Helpers.** #47-3 moves token planting (direct `saveAuthCode`/`saveAccessToken` calls) behind helpers; #47-4 swaps the helpers' implementation.
  - **Assertions that encode SDK details.** Error descriptions, `bearer` against `Bearer`, the exact scope string, and the DCR response fields. The reviewer checks that every changed assertion is one of these.
- **WS7.4's protected list** must pass unchanged in meaning: #57a's `granted_scope='admin'`, `X-YNAB-Token` 401, the downgrade, `ALLOW_WRITE=false`, #42's replay end to end, RFC 8707 binding, `iss` and the non-owner `/revoke`.
- **New tests:** each D6 stage, the forced races, the browser binding, the upgrade bridge on fixtures for all three drivers (including a revoke followed by a read of the legacy access token, and a retry after a failed rotation), and a test that every OAuth error keeps its own code (400, or 500 only for `server_error`).

### D14. Effects on other work

| Item | Effect |
|---|---|
| WS7.3 (P5) | Unchanged. #47-2's verifier keeps its contract. |
| WS7.4 (P8) | It rewrites the HTTP test helpers, so #47-3 waits for it. `http.ts` isn't touched. |
| #55 (P9) | Lands as planned. Its stages stay. #47-4 moves its consent-page hunk into the interaction route, and its phase-2 guard pre-validates the same parameters for the library. O acks. |
| #59 (P7) | Its keys move from the SDK's internal limiters to D8's `route-limiter` stages in #47-4 |
| #64a (P10) | **Re-scoped after the cut-over**, so it isn't built twice: D6's `refresh-guard`; `resource` required for new clients in `authorize-validation`; PKCE negative tests against the library; the library's `/revoke` owner check (the spike passed it); the grant level across clients (users, unchanged). Its own M4 is dropped. |
| #46 | CIMD through the library's `clientIdMetadataDocument` feature: off by default, an `ack` of draft-03, `allowFetch` as the policy, and our own `fetch`. That `fetch` resolves the host once, refuses private and loopback addresses, and connects to the address it checked (a pinned lookup, so DNS rebinding can't swap it). The library already refuses redirects for these fetches (`redirect: 'manual'`) and applies its body limits. It lands after the cut-over (O). |
| #53b (P9) | `AccountStore` keeps its interface; #47-1 re-implements it over `oauth_rows` |
| #54b (P10) | Lands first; #47-1 extends the sweep to `oauth_rows` |
| #62a (merged) | No `release.yml` or `Dockerfile` change (no native dependencies). The audit gate covers the new packages. |
| #94 (merged) | Its `completeAuthorization` is reused by the adapter (D4) |

### D15. PRs, dependency order and dates

| PR | What | Files (owner) | Author, model | Size | Built | Packet |
|---|---|---|---|---|---|---|
| ADR-0002 | This document | `docs/adr/` (P) | P, Opus | S | Nov 13 | Sign-off Wed Nov 18 (P5) |
| **#47-1** Library storage | D4: the adapter, the `Storage` methods, M4, sweeps, `AccountStore`, the conformance suite | `src/auth/oidc/adapter.ts` (new; O after merge), `src/storage/**` (D), `token-hash.ts` (S) | S, Opus (design-sensitive), with D, Sonnet, committing the SQLite and Postgres drivers on S's branch | L (4) | Nov 18-Dec 4 | **P11 Sat Dec 12** |
| **#47-2** Provider and broker | D2, D3, D7, D10, and B's `oidc-provider` hunk. Not mounted yet; tested on its own Express app, as in the spike. | `src/auth/oidc/{provider,interaction,verifier}.ts`, `src/auth/errors.ts` (new; O after merge), `package.json` (B acks) | S, Opus | L (4) | Nov 23-Dec 9 | **P11 Sat Dec 12** |
| **#47-3** Test helpers | Move token planting in the HTTP tests behind helpers. No behaviour change. | `tests/unit/http-*.test.ts`, `tests/unit/helpers/**` | B, Sonnet (mechanical) | M (2) | Dec 3-8, after WS7.4 | **P10 Wed Dec 9** |
| **#47-4** Cut-over | D5, D8, D9, D6's `grant-guard` and D11's removal: mount the library, retire `McpOAuthProvider`, `iss-redirect`, the consent cookie and server-legacy, and update the tests (D13) | `as-router.ts` (O acks), `mcp-provider.ts` (deleted; S), `client-auth.ts` (S), `package.json` (B acks), tests | S, Opus | L (3) | Dec 12-15 | **P12 Wed Dec 16** |
| **#47-5** Upgrade bridge | D12: the client conversion check, `legacy-refresh` with the family-to-grant mapping, `legacy-revoke`, the verifier fallback, fixtures | `src/auth/oidc/legacy.ts` (new), `src/storage/**` (D) | S, Opus | M (2) | Dec 14-18 | **P13 Sat Dec 19** |
| **#64a, re-scoped** | D6's `refresh-guard` and the rest of #64a's row in D14 | `src/auth/oidc/**`, `src/config/http/oauth.ts` (C acks) | S, Opus | M (2) | Dec 14-18 | **P13 Sat Dec 19** |
| **#46** CIMD | #46's row in D14 | `src/auth/oidc/**`, `src/auth/client-id-metadata.ts` (O) | O, Opus | M (3) | Dec 10-18 | **P13 Sat Dec 19**, or 0.5.1 if it isn't ready |
| Docs | REMOTE_HOSTING: the new routes and cookies, the client-visible changes, the upgrade path; the CHANGELOG lines in each PR | docs | A, Sonnet (Opus signs off) | S (1) | Dec 16-22 | P14 Tue Dec 22 |

- **Dependency order:**
  - #47-1 ∥ #47-2, both after the sign-off; #47-3 after WS7.4;
  - #47-4 after #47-1, #47-2, #47-3, #55 and #59;
  - #47-5, #64a and #46 after #47-4.
- **New dates** (decision 7). The three new packets (P11 Sat Dec 12, P12 Wed Dec 16, P13 Sat Dec 19) and P14 (Tue Dec 22, fixes) follow the plan's Wednesday and Saturday rhythm.
  - **WS7.9b, Sat Dec 19-Sun Dec 20 (1.5 h of maintainer time):** the claude.ai connector, Desktop and the Inspector against the cut-over head on staging, so that client-visible changes show up before the holidays.
  - **Freeze: Wed Dec 23**, moved from Dec 9.
  - **Dec 24-Jan 3:** no maintainer packets. The closing audit (WS8.60) runs on the frozen head.
  - **rc.1 (#86): Mon Jan 4**, moved from Dec 10. Staging deploys it, with a 0.4.x-to-0.5.0 upgrade on a DB copy for D12.
  - **WS7.9 interop: Jan 4-8**, with fix packets Wed Jan 6 and Fri Jan 8.
  - **Go/no-go: Mon Jan 11.**
  - **REL and the tag: Tue Jan 12**, moved from Dec 18; it was the plan's backstop. Buffer to Fri Jan 22, five days before v1.x support ends.
- **Maintainer time:** about 9 h of reviews (#47-1 1.5, #47-2 1.5, #47-3 0.5, #47-4 1.5, #47-5 1, #64a 1, #46 1.5, docs 0.5), plus 1.5 h for WS7.9b. The interop week moves from mid-December to early January.

### Where each must-keep behaviour lives

| Behaviour | After the move | Kind | Tested by |
|---|---|---|---|
| PKCE S256 only | `pkce.required`; S256 is the library's only method | Config | `http-oauth-*`; spike 2, 9, 10, 16 |
| RFC 8707 resource binding | `resourceIndicators` with an exact `getResourceServerInfo`; the verifier's exact `aud` check | Config + ours | `http-oauth-resource`; spike 11, 20, 27 |
| RFC 9207 `iss` | Every authorization response, errors included | Library | `http-oauth-iss`; spike 3, 9-11, 14, 37 |
| Refresh rotation, reuse detection (RFC 9700) | `rotateRefreshToken`; the reuse revocation; the adapter's compare-and-set | Config + library + adapter | conformance suite; spike 25, 26, 28, 29, 32 |
| Another client presenting a live refresh token revokes the family | `grant-guard` stage | Ours | new stage tests |
| #42 code replay revocation | The library's consumed check; the adapter's compare-and-set and grant check; `grant-guard` for another client | Library + adapter + ours | `http-oauth-code-replay`, conformance; spike 22, 35 |
| The YNAB legs and their limit | Interaction routes under `/oauth`; `oauth-leg-limiter` | Ours (interaction hook) | `http-oauth-security`, `http-oauth-rate-limit`; spike 13, 36, 37 |
| Consent, read-only or read-write, `YNAB_OAUTH_ALLOW_WRITE` | The interaction page and the `Grant` scopes; `scopeCeiling` | Ours | `http-oauth-write-policy`; spike 13, 18, 23, 24 |
| #52 hashed tokens and codes | Adapter `h1.` keys; no `jti` stored; shape refusal | Adapter | conformance, `token-hashing-migration`; spike 15, 21 |
| #52 hashed client secrets, fail-closed | Adapter `s256.`; `client-auth` stage | Adapter + ours | `http-oauth-client-auth`; spike 6, 38-40 |
| G21 stage order | `as-router.ts`, `as-library` last | Ours | `http-as-pipeline` |
| DCR validator, authorize guard (#55) | Stages ahead of `as-library` | Ours | #55's tests |
| STOR-1 issued-under-user | The adapter's user join | Adapter | conformance; spike 45, 46 |
| STOR-1 retention, sweeps, deletion | `ttl` functions; `oauth_rows.expires_at`; `deleteUserData` | Config + storage | `retention`, `account-deletion` |
| #94 atomic sign-in | The code `upsert` → `completeAuthorization` | Adapter + storage | #94's tests, ported |
| Error response shapes | Library JSON; `renderError`; `method-check`; `sendOAuthError` | Config + ours | the HTTP tests |
| The `/mcp` resource side | `verifier.ts` via `AccessToken.find` | Ours (public API) | `http-oauth-flow`, `-resource`, WS7.3's never-500 test |
| #64a's 60 s idempotency | `refresh-guard` stage | Ours | spike 30, 31 |
| The path to #46 | `clientIdMetadataDocument` feature | Config (experimental) | #46's tests |

"Spike N" refers to the numbered list in "Spike checks", before the decisions.

## Consequences

**Positive:**
- server-legacy is gone. Protocol handling (PKCE, grants, rotation, redirect validation, DCR, revocation, metadata) is a certified library's job.
- A known path to CIMD, DPoP and PAR when we want them.
- Our code is glue at documented extension points: stages, the interaction, the adapter, `provider.use`, events. Nothing patches the library.

**Negative:**
- **A rewrite of the AS glue and its storage:** an estimated 1,500 lines changed, and the provider unit tests rewritten. Most of the risk is in the adapter (D4) and the bridge (D12).
- **Koa runs inside Express for the AS routes,** and oidc-provider adds 24 packages. Its type definitions come from DefinitelyTyped and lag behind.
- **What clients can see change:**
  - token values have no `ymcp1_` prefix (new question 2);
  - `token_type` is `Bearer` (RFC 6749 says case-insensitive);
  - a read-write token's `scope` is `read-only read-write`;
  - the DCR response has more fields, and `client_secret_expires_at` is `0`;
  - discovery lists OIDC fields and `jwks_uri`;
  - error descriptions read differently;
  - an `invalid_client` that comes from the library itself is 401.

  The 405 response and the JSON pre-redirect errors are kept (D2, D8).
- **0.5.0 moves from Dec 18 to Jan 12.**

**Neutral:**
- `http.ts`, the `/mcp` pipeline and the YNAB token resolver don't change.
- Single-replica operation stays as documented: #64a's replay cache is per process, like the limiters.

## Risks

- **The adapter's security rules** (hashing, compare-and-set, the grant check, the user join) are new code on all three drivers. Mitigation: one conformance suite runs on every driver, the forced-race tests, and an Opus review. Postgres is gated with 0 skipped.
- **An upstream change in the payload or adapter contract.** Mitigation: the tilde pin, and a review of every bump's changelog. The adapter treats payloads as opaque, except for the fields it indexes or strips (`jti`, `grantId`, `accountId`, `clientId`, `uid`, `iat`, `consumed`).
- **The bridge mis-converts a 0.4.x family.** Mitigation: the fixtures, and the DB-copy upgrade at rc time. A failed conversion falls back to a reconnect, never to a wrong grant.
- **A client-visible change breaks a real client** (Desktop, the connector, the Inspector). Mitigation: WS7.9b on Dec 19-20, before the freeze, and WS7.9 in January.
- **The schedule.** Three large and two medium PRs from one author (S) inside a month, with the holidays in it. Mitigation: #47-1 and #47-2 are independent and built in parallel, with D on the drivers. #46 can move to 0.5.1 without blocking. Jan 12 still leaves 15 days to v1.x's end of support.
- **A bus factor of one upstream** (panva). Mitigation: 10 years of releases and a broad user base. If it ever stalls, mcp-oauth-server and the port remain fallbacks.

## Alternatives considered

- **(a2) mcp-oauth-server**: new question 1. Choose it to keep our storage and tests largely as they are, in exchange for depending on a young project.
- **(a3) @node-oauth/oauth2-server**: too little of the AS.
- **(c) v2 alone**: no AS.
- **The port of server-legacy's handlers** (the first draft): rejected by decision 1.
- **Shipping 0.5.0 on ADR-0001's D14 pin**: rejected by decision 7.
- **Forcing every user to reconnect instead of the bridge**: D12, new question 3.

## Open questions for the maintainer

Each has a recommendation. As in plan §10, a missed answer means the recommendation ships.

1. **The library: oidc-provider or mcp-oauth-server?**
   - **oidc-provider:** mature (1.6 M installs a week, certified, released since 2016), at the cost of a rewrite of our glue and storage and the client-visible changes listed above.
   - **mcp-oauth-server:** fits our code (storage, error shapes and tests mostly unchanged), but it is a 1.x from August 2026 with one maintainer and about 2.7 k installs a week.

   *Recommendation: oidc-provider.*
2. **#52's token format.** The library generates its own token values (43 base64url characters). The `ymcp1_` prefix and the tag checked before any storage read can't be kept without patching the library. The `h1.` keys, the pepper, the shape check before storage and the per-kind separation all stay. *Recommendation: accept.*
3. **The upgrade path.** Preserve existing clients and grants (D12, one more PR), or force every connection to reconnect once. *Recommendation: preserve.*
4. **The client-visible changes in Consequences.** *Recommendation: accept them and document each in the CHANGELOG. Keep 405 and the JSON pre-redirect errors.*
5. **New secrets no longer expire.** The library issues DCR secrets with `client_secret_expires_at: 0`, where the SDK gave 30 days. The 90-day sweep removes only unused clients, so an active client's secret stays valid for as long as the client is used. What limits the exposure is that the secret works only at `/token` and `/revoke`, behind `client-auth` and the route limiter, and that a stored hash is never a credential (#52). *Recommendation: accept. Revisit if a secret-rotation story is needed.*
6. **#64a re-scoped onto the library**, its M4 dropped, and its replay cache per process (single replica, as documented). *Recommendation: yes. A shared cache comes with #48 and #67b in 0.5.1.*
7. **The new dates.** Freeze Wed Dec 23, rc.1 Mon Jan 4, tag Tue Jan 12, buffer to Jan 22. *Recommendation: approve.*
8. **#46 in 0.5.0** through the library's experimental CIMD (draft-03), off by default, if it is ready in P13; otherwise 0.5.1. *Recommendation: yes.*
9. **The OIDC surface:** disable every feature we don't use, drop the `openid` scope, use an ephemeral signing key, and offer no silent sign-in (D2). *Recommendation: yes.*

## Addenda

None yet.
