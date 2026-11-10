# ADR-0001: MCP SDK v2 and stateless Streamable HTTP

| | |
|---|---|
| Status | **Proposed** (2026-11-10). Maintainer sign-off due Wed 2026-11-11. |
| Issues | #41 (SDK v2 and stateless HTTP), #47 (server-legacy), #45 (structured tool output) |
| Plan row | WS7.0. It binds WS7.2, WS7.3, WS7.4, WS7.5+7.6, WS7.7, WS7.8 and #47. |
| Already decided | D15.5: size and truncation budgets count text content only (maintainer, 2026-11-09, on #41) |
| Changes | Later changes are dated addenda at the end of this file, for example the result of the Dec 4 WS7.4 cut. |

## Context

**Where 0.4.x stands.** The server runs on `@modelcontextprotocol/sdk` 1.32.2. That line gets fixes until at least 2027-01-27 and will never implement protocol revision 2026-07-28. HTTP mode is sessionful:

- `src/http.ts:359-375` builds a `StreamableHTTPServerTransport` and a `Server` per session.
- `src/services/session-manager.ts` caps sessions globally (`MCP_MAX_SESSIONS`, default 100) and per user (`MCP_MAX_SESSIONS_PER_USER`, which evicts that user's least recently used session). It also runs an idle sweep (`MCP_SESSION_IDLE_TIMEOUT_MS`).
- A session is bound to its creator: (client, user, token level) in OAuth mode (`http.ts:87-92`), or the YNAB token digest in header mode (`http.ts:286-289`).
- Each session holds a `UserRegistry` lease on its user's rate limiter, cache, delta cache and audit log (`user-registry.ts:103-130`).
- The read-only flag is computed once, at `initialize` (`http.ts:270`), and is fixed for the session's life.

The 2026-11-03 security review (#41 comment) found these problems:

- The global cap can be starved.
- An open GET SSE stream counts as active, so the idle sweep never closes it (ABUSE-7).
- The per-user cap is keyed by YNAB user, so one client can evict another client's sessions (ABUSE-22).
- Read-only is decided only at session start (OAUTH-24).

**What SDK v2 offers.** These facts were checked against the published packages on 2026-11-10: the `.d.mts` declarations and the shipped JavaScript, not the docs.

| Package | Version | What we use |
|---|---|---|
| `@modelcontextprotocol/server` | 2.4.0 | `createMcpHandler(factory, { legacy, maxRequestBodySize, maxSubscriptions, … })` returns `{ fetch, close, notify, bus }`. The factory gets `McpRequestContext { era: 'legacy' \| 'modern', authInfo?, requestInfo? }` and may return a `Server` or an `McpServer`. Also `Server`, `isLegacyRequest` and `serveStdio` (from `/stdio`). |
| `@modelcontextprotocol/node` | 2.1.2 (peer: server `^2.4.0`) | `toNodeHandler(handler, { maxRequestBodySize, onerror })`. It forwards `req.auth` as `authInfo` and Express's `req.body` as `parsedBody`, and it aborts the web `Request`'s signal on `res.on('close')`. |
| `@modelcontextprotocol/express` | 2.0.2 (peer: server `^2.3.0`) | `requireBearerAuth({ verifier, resourceMetadataUrl, expectedResource })` |
| `@modelcontextprotocol/server-legacy` | 2.4.0, npm-deprecated | `/auth`: `mcpAuthRouter` and its handlers. These are "a frozen copy of v1 … Will not receive new features" and are "planned for removal in v3". It has been republished at every v2 version so far (2.0.0 through 2.4.0), and it depends on exactly `@modelcontextprotocol/core@2.4.0`. |
| `@modelcontextprotocol/client` | 2.4.0 (dev only) | A v2 client for the 2026-07-28 tests |

**Decisions that bind this ADR.**

- 2026-11-09 (#41): budgets count text only.
- 2026-11-09 (#68): every open issue ships whole in 0.5.0, so **#45 and #47 are in full**. The plan's WS7.0 row treated #45 as a stretch pilot and split #47 (the port to 0.5.1). D14, D15, Q2 and Q3 follow the decision, not the plan.

## Decision

Each decision states what it is, why, and the code it binds. "Today" means `release/0.5.0` at f35a0d7.

### D1. Stateless `/mcp` through `createMcpHandler` and `toNodeHandler`

- **What:**
  - `const mcp = createMcpHandler(factory, { legacy: 'stateless', maxRequestBodySize: 512 * 1024, onerror })`, mounted for every method as `app.all('/mcp', …, toNodeHandler(mcp, { maxRequestBodySize: 512 * 1024, onerror }))`.
  - Every request gets a fresh `Server` from the factory, with no `Mcp-Session-Id` and no session store.
  - 2026-07-28 requests take the modern leg. 2025-era requests take the SDK's stateless legacy leg, a per-request `WebStandardStreamableHTTPServerTransport` with `sessionIdGenerator: undefined`.
  - GET and DELETE `/mcp` classify as legacy. That leg answers anything but POST with `405` and `Method not allowed.`, so G2's 405 comes from the SDK.
  - Today's session-based GET and DELETE routes (`http.ts:386-400`, which answer 400 without a session id) are deleted. `app.all` is what lets those methods reach the SDK: an `app.post` mount would leave them to Express's 404.
  - `legacy: 'stateless'` is already the SDK default. We pass it anyway, so a future default change can't silently switch us to `'reject'`.
- **Known SDK defect (2.4.0):** typescript-sdk#3159, fixed by #3160, which is still open.
  - A non-`initialize` request whose `params._meta` carries `io.modelcontextprotocol/protocolVersion` naming a *2025* revision is routed to the modern leg and rejected with 400: `-32022` with the full envelope, `-32602` with the key alone.
  - The cause is `classifyRequestBody`: any envelope claim routes modern. Plain 2025-era clients don't send that key, so they aren't affected. A client that falls back to 2025 but keeps the 2026 envelope key is.
  - WS7.4 adds a test pinning today's behaviour for that request shape, so the SDK fix shows up as a test change.
  - WS7.9a checks whether any client in the interop set sends it.
  - Whether to work around it before the fix ships is Q6.
- **Why:**
  - It removes the process-local session state behind ABUSE-7 and ABUSE-22.
  - It removes the need for sticky sessions.
  - It is the only v2 serving path that handles both protocol eras from one factory.
  - 2026-07-28 has no sessions.
- **Binds:**
  - WS7.4 `src/http.ts`: replace `http.ts:309-400` and remove `sessions` from `HttpApp`.
  - Delete `src/services/session-manager.ts` and `tests/unit/http-sessions.test.ts`.
  - Gate G2: no `Mcp-Session-Id`; GET and DELETE return 405; two users who send the same JSON-RPC id each get their own result.
  - Shutdown: `startHttpServer` calls `mcp.close()` where it calls `sessions.close()` today (`http.ts:462`).

### D2. Keep the low-level `Server`; don't move to `McpServer.registerTool`

- **What:** The factory returns `createServerForRequest(ctx)`, the low-level `Server` that `createServerFromClient` builds today (`server.ts:73-152`). Its handlers are registered in v2's method-string form (`setRequestHandler('tools/call', …)`, which the WS7.2 codemod converts).
- **Why:**
  - The 69 tools declare hand-written JSON Schema `inputSchema` objects and dispatch through one switch (`tools/index.ts`).
  - `registerTool` would mean rewriting all of them, regenerating the advertised input schemas from Zod (so the published schemas would change), and replacing our input checks (`assertSafeToolInput`, then each handler's own Zod parse) with the SDK's.
  - The read-only tool filter (`server.ts:89-97`) and the hidden-write-tool guard (`server.ts:109-111`) would also have to be rebuilt.
  - The low-level `Server` gives us everything we need: the factory accepts it, and `projectCallToolResult()` and `cacheHints` are on `Server`.
- **Caveat:** v2 marks `Server` `@deprecated` ("Only use `Server` for advanced use cases"). Our ESLint config has `@typescript-eslint/no-deprecated` off, so nothing flags it. Removal could come in v3, the same release that removes server-legacy.
- **Binds:** `src/server.ts` (owner B), WS7.2, WS7.4 and WS7.8. Issue #45's first checkbox ("Move tool registration … to `McpServer.registerTool`") is replaced; see D15 and Q2.

### D3. Identity reaches the factory as `authInfo`, through `req.auth`

- **What:** A request-context stage runs ahead of the handler:
  - It reads the identity the verifier put in `AuthInfo.extra`: `userId` and `grantedScope`, set today at `mcp-provider.ts:686-701`.
  - It resolves the YNAB grant (`YnabTokenResolver.resolve`) and acquires the user's registry lease.
  - It assigns a `requestId` (for #60).
  - It stores the result as a frozen `RequestContext` under one private key of `req.auth.extra`.
  - `toNodeHandler` passes `req.auth` through unchanged as `authInfo`, and the factory reads `ctx.authInfo.extra` and only builds the server (it is synchronous and can't fail on input).
  - In header mode the stage sets `req.auth` itself: `clientId: 'header'`. The `token` field holds the token digest, never the YNAB token. The resolved context goes in `extra`.
- **Why:**
  - Anything that can fail (an unknown user, a revoked YNAB grant) has to answer 401 with `resource_metadata` (gate G6).
  - A factory that throws becomes a generic 500 inside `createMcpHandler`.
  - The SDK passes `authInfo` by reference and never builds it from headers, so `extra` is the supported channel. It is never serialized to the wire.
  - One code path serves both auth modes.
- **Binds:**
  - WS7.4: `http.ts` and the new `createServerForRequest(ctx)` in `server.ts`, whose `ctx` is our `RequestContext`, not the SDK's `McpRequestContext`.
  - `resolveInitContext` (`http.ts:249-307`) becomes this stage.
  - The YNAB token is never logged, and the existing log-redaction tests are extended to cover it.

### D4. Read-only is computed on every request, including `!allowWrite`

- **What:** The context stage computes `readOnly` for every request:
  - OAuth mode: `config.readOnly || !config.allowWrite || tokenScope !== 'read-write' || grantedScope !== 'read-write'`, which is #56's line, carried unchanged.
  - Header mode: `config.readOnly`.
- **Why:**
  - Because the read-only flag is computed per request, a downgraded token or grant takes effect on the very next request.
  - Today the flag is frozen at `initialize` (`http.ts:270`), which is OAUTH-24.
- **The write switch needs a restart:**
  - `YNAB_OAUTH_ALLOW_WRITE` is read once, at startup (`loadHttpConfig()`, `environment.ts:245`, called from `index.ts:58`). Recomputing `readOnly` does not reload it.
  - So changing the setting takes effect on the first request after a restart. With no sessions to outlive the restart, that first request is the very next one.
  - WS7.7's upgrade notes and Breaking-change row 8 must say "restart", not "instant switch".
- **A downgrade depends on STOR-1:**
  - "The very next request" holds only if a YNAB token refresh can't put back an older grant.
  - Today `YnabTokenResolver.refresh` writes back the whole `UserRecord` it read before refreshing (`user-session.ts`, `upsertUser({ ...user, … })`). A read-only re-consent that lands during the refresh is overwritten with the old read-write `grantedScope`.
  - STOR-1 (WS8.25) replaces that write-back with the compare-and-set `updateUserRefreshToken(userId, oldCiphertext, newCiphertext)`. It writes only the refresh token and misses when the row has changed, which closes the race.
  - WS7.4 relies on that change and must not merge ahead of it.
- **Binds:**
  - WS7.4 carries #56's line verbatim, and the reviewer diffs it.
  - Protected tests: the downgrade test and the `ALLOW_WRITE=false` test.
  - A test in STOR-1: a read-only re-consent during an in-flight refresh stays read-only on the next request.
  - WS7.7: the restart wording.

### D5. Leases are released when the response has closed and all started work has settled

- **What:**
  - The request takes an in-flight slot (D6, at `inflight-limit`) and a `UserRegistry` lease (at `request-context`).
  - Both are released once two things are true: `res.once('close')` has fired, and every asynchronous step the request started has settled.
  - Those steps are the context resolution (`resolver.resolve(userId)`, which may refresh a YNAB token) and the tool call.
  - Each step marks when it starts and settles. A request whose steps have all settled releases on `'close'` alone.
  - `release()` is already idempotent (`user-registry.ts:119-125`), so both paths can call it.
- **Change from the plan:** the plan says release on `res.on('close')` alone. That is wrong after the ceiling fires or the client disconnects, because the response closes while the YNAB work behind it keeps running:
  - The registry can evict the released entry under `maxEntries` pressure (`user-registry.ts:150-160`). A later request then gets fresh components, while the orphaned call still writes to the discarded audit log and limiter.
  - The freed slot lets a client stack up abandoned work: up to the cap, every ceiling period.
- **Why:**
  - `'close'` fires on every way a response can end: it finishes, the client disconnects, or the ceiling fires. `toNodeHandler` uses the same event to abort the exchange.
  - Waiting for the work to settle as well means the registry never evicts components that are still in use, and the caps count real work, not open responses.
  - The registry never evicts an entry while it has a live lease, so a user's limiter and caches survive between requests exactly as they do between sessions today.
- **Per-instance state moves to `UserComponents`:**
  - `YnabClient` is now built per request. `feedSinceDateRejected` (`ynab-client.ts:304`) must move into `UserComponents`, or every request would repeat a rejected YNAB call.
  - `serverKnowledge` (`ynab-client.ts:309`) is written but never read by a tool, so resetting it per request changes nothing. The delta cursor lives in the per-user `DeltaCache`.
- **Binds:**
  - WS7.4: `http.ts`, `server.ts` (the settle hook in the `tools/call` handler), `user-registry.ts` (leases only; owner A acks) and `ynab-client.ts` (only `feedSinceDateRejected`).
  - Tests: after the ceiling fires, the lease and the slot stay held until the tool call settles; with a stalled resolver, the slot stays held until `resolve` settles.
  - Q4 asks you to confirm this change from the plan.

### D6. In-flight caps and a request ceiling replace the session caps

- **What:**
  - **Caps:** a new `src/services/inflight-limiter.ts` keeps in-flight counters per user and per (client, user). Past either cap, the request gets 429 with `Retry-After` and a JSON-RPC error, before any server is built.
  - **The plan's numbers:** 4 per user and 8 per (client, user). As written, the second cap can never bind; see Q1.
  - **Header mode** has no client id, so only the per-user cap applies.
  - **A process-wide cap (proposed; Q1):** header mode accepts any non-empty token as a new "user" (`http.ts:282-289`), so per-user caps alone don't bound total concurrency. `MCP_MAX_INFLIGHT` (proposed default 64) caps in-flight requests across all users, with the same 429 response. Today's global session cap is the thing it replaces.
    - Slots are **not** guaranteed to free at the ceiling. Under D5, a slot is held until the request's started work settles, and that includes `resolver.resolve`.
    - `resolve` awaits storage reads and an `upsertUser` write. #58's fetch timeout bounds the YNAB token refresh inside it, but nothing bounds the storage calls today: `postgres.ts` sets no statement, query or pool-acquire timeout.
    - So requests that stall in storage hold their slots until the storage call returns, and enough of them can exhaust the cap with their responses already closed.
    - Bounding storage work is Q7.
    - Until it's bounded, the cap stops new work from piling onto a stalled database (429). It does not promise recovery within the ceiling.
  - **Ceiling:** `MCP_REQUEST_TIMEOUT_MS`, default 60 000. At the ceiling, a request whose response hasn't started gets a JSON-RPC error that echoes its id ("Request timed out", with no upstream text).
  - **Open SSE streams get the error in the stream:**
    - In 2.4.0 the stateless legacy leg answers every request-bearing POST over SSE. `WebStandardStreamableHTTPServerTransport` defaults to `enableJsonResponse: false`, the fallback can't change that, and it writes the headers and a keepalive every 15 s straight away. So for 2025-era clients the response has always "started".
    - Ending that stream without a result would leave a timed-out write with no outcome at all.
    - **Requirement:** at the ceiling, a request on an open SSE stream first receives a JSON-RPC error for its id as an SSE `message` event: the unknown-outcome text below for write tools, "Request timed out" otherwise. Only then is the stream ended.
    - **Proposed mechanism (Q8):** a deadline inside the `tools/call` handler (`server.ts`), a little earlier than `MCP_REQUEST_TIMEOUT_MS`. It returns the timeout as an `isError` tool result, and the SDK delivers that over whichever transport the request uses (JSON, modern SSE or legacy SSE). The HTTP-level ceiling stays as the backstop for stalled stages before the handler, and for non-tool methods.
  - **Settings:** `MCP_MAX_INFLIGHT_PER_USER`, `MCP_MAX_INFLIGHT_PER_CLIENT` and `MCP_REQUEST_TIMEOUT_MS`. All three are parsed strictly and bounds-checked like #56's settings.
- **Why:**
  - These caps bound concurrency per principal instead of counting sessions.
  - The (client, user) key stops one client from starving another client of the same user (ABUSE-22).
  - The ceiling bounds a hung exchange.
  - A cap per `client_id` alone (the #41 comment) would throttle every user of a shared public client, such as the claude.ai connector, together.
- **What the ceiling can't do:**
  - Nothing in our tool path takes an `AbortSignal`, so the YNAB fetch behind a timed-out tool keeps running until it finishes. It keeps its slot while it runs (D5).
  - #58's per-fetch `AbortSignal.timeout` bounds that work. #58 is in 0.5.0 in full.
- **A timed-out write has an unknown outcome:**
  - A write tool that hits the ceiling may still complete. `ynab_create_transaction` makes `import_id` optional, so a blind retry can create a duplicate.
  - The ceiling's error for a `tools/call` of a write tool (any tool without `readOnlyHint: true`) therefore says the outcome is unknown: "Request timed out; the change may still have been applied. Check (for example with ynab_list_transactions) before retrying". It never says the call failed.
  - The audit log records the real outcome when the work settles.
  - `ynab_create_transaction`'s description already says to pass `import_id` for an idempotent create (`create-transaction.ts:87`). Generating one on the server would change YNAB's import matching, so it is not part of this ADR.
- **Binds:**
  - WS7.4: `src/services/inflight-limiter.ts` (new) and `src/config/http/limits.ts` (owner C acks).
  - Gate G2: 429 per user and per (client, user), and the ceiling holds (including a stalled `resolve`).
  - A test that a timed-out write tool gets the unknown-outcome message, including a 2025-era (legacy SSE) write that times out after keepalives have started: the error event must arrive before the stream ends.
  - Breaking-change row 3.

### D7. No bearer-verification cache in 0.5.0

- **What:**
  - Every `/mcp` request calls `verifyAccessToken`, which is one storage read, and `resolver.resolve(userId)`.
  - The resolver's existing in-memory YNAB access-token cache is not a verification cache, and it stays.
- **Why:**
  - Revocation (#53b `ynab_revoke_connection`, `/revoke`, reuse detection) and downgrades take effect on the next request, with no window.
  - #52's hashed lookup is an HMAC plus an indexed read.
  - The ~30 s cache that #41's comment allows is an upper bound, not a requirement. It can come back later if profiling shows a need.
- **Binds:** WS7.3 and WS7.4. Nothing in `http.ts` or the provider may memoize `AuthInfo`.

### D8. The session settings warn and are ignored

- **What:**
  - `MCP_MAX_SESSIONS`, `MCP_MAX_SESSIONS_PER_USER` and `MCP_SESSION_IDLE_TIMEOUT_MS` are still parsed strictly: a malformed value still refuses to start.
  - A value that parses is ignored and logs a one-time warning that names the replacement settings.
  - 0.6 removes them.
- **Why:** An operator's existing config keeps starting, and the warning tells them what changed. This is Breaking-change row 2: "already soft".
- **Binds:** WS7.4 (`src/config/http/limits.ts` and the composer line), WS7.7 (the env table and the upgrade checklist), and `.env.example`.

### D9. No `isLegacyRequest` fallback in 0.5.0

- **What:**
  - `isLegacyRequest` exists. It is the SDK's documented way to run a sessionful legacy wiring next to a strict (`legacy: 'reject'`) modern handler. We don't use it.
  - If WS7.9a shows that a 2025-era client needs sessions, the fallback is the Dec 4 cut decision: WS7.4 doesn't merge, and 0.5.0 ships sessionful on v2 (`NodeStreamableHTTPServerTransport` with a session id generator) with today's `SessionManager`.
  - A hybrid of the two is not an option.
- **Why:**
  - A hybrid keeps both code paths, both test sets and the session caps' problems.
  - It also doubles what the security reviewer has to sign off, inside the freeze window.
- **Binds:** WS7.4 and the Dec 4 cut (plan §1). The cut result is recorded as an addendum here.

### D10. `/health` reports no session count

- **What:** `/health` returns `{"status":"ok"}`. #56 made this change, and WS7.4 doesn't add a `sessions` or in-flight figure back.
- **Why:** There are no sessions to count. An in-flight count would give an unauthenticated probe a load signal.
- **Binds:** WS7.4 (`http.ts:210-212`) and Breaking-change row 4.

### D11. `tools/list` is cached privately, with a TTL of 0

- **What:** The server option is `cacheHints: { 'tools/list': { ttlMs: 0, cacheScope: 'private' } }`.
- **Why:**
  - The list depends on the caller's per-request read-only state (`server.ts:93-95`), so a shared cache would leak one user's list to another.
  - A TTL above 0 would let a client keep showing write tools after a downgrade.
  - These are already the SDK's defaults (`{ ttlMs: 0, cacheScope: 'private' }`). Setting them explicitly records the requirement and lets a test assert it.
  - Cache hints apply to 2026-07-28 responses only; 2025-era responses are unchanged.
- **Binds:** WS7.6 (`server.ts`, owner B) and a test asserting `cacheScope: 'private'` on a 2026-07-28 `tools/list`.

### D12. Request bodies are capped at 512 KB, everywhere they are read

- **What:**
  - The app-wide `express.json({ limit: '512kb' })` (`http.ts:196`) is split into two mounts with the same limit.
  - The first goes ahead of the extension router, which keeps the contract in `src/http/extensions.ts:5-9` and `tests/unit/http-extensions.test.ts`.
  - The second goes in the `/mcp` pipeline, after `request-ceiling`, so a slow upload hits the deadline.
  - `maxRequestBodySize: 512 * 1024` is passed to both `createMcpHandler` and `toNodeHandler`. Their default is 4 MiB.
  - The `rejectBatch` stage stays.
- **Why:**
  - The SDK's own bound doesn't apply to a pre-parsed body.
  - `express.json` skips bodies that aren't JSON. `toNodeHandler` then buffers the raw stream, up to its bound, before the handler's 415 check runs. Without the explicit 512 KB, an unparsed body could be read up to 4 MiB.
  - The AS routes already carry their own parsers (`http.ts:177-179`).
- **Binds:** WS7.4.

### D13. No change-notification capabilities, so `subscriptions/listen` never stays open

- **What:**
  - `createMcpHandler` serves `subscriptions/listen` for any 2026-07-28 client. It narrows the requested notifications to what the server declares.
  - When nothing is left, the SDK sends the acknowledgement and completes the stream at once (2.4.0, `listenRouter` `serve()`).
  - We declare no `tools.listChanged`, `prompts.listChanged`, `resources.listChanged` or `resources.subscribe`, so for us a listen request is a short request. It counts against D6's caps like any other until D5 releases it.
  - `maxSubscriptions` stays at the SDK default (1024, per handler).
- **Why:**
  - An open stream is held state, the thing ABUSE-7 is about.
  - We publish no change events, so we have nothing to stream.
  - Declaring any of those capabilities later would make listen streams long-lived, and the caps and ceiling would have to be revisited for them.
- **Binds:**
  - WS7.4 and WS7.6 (`server.ts` capabilities; owner B).
  - A 2026-07-28 client test: an empty listen completes and releases its slot.
  - A test that the server capabilities declare none of the four.

### D14. server-legacy is pinned to `~2.4.0` until #47 removes it (#47-doc)

- **What:**
  - `@modelcontextprotocol/server-legacy` is pinned to `~2.4.0` (WS7.2, gate G1) for as long as our glue depends on its internals:
    - #52's `client-auth.ts` rewrites `req.body.client_secret` so that server-legacy's client authentication matches;
    - `as-router.ts` mounts its handlers stage by stage;
    - the provider throws its error classes inside the authorization server.
  - A guard test asserts the range and checks that `@modelcontextprotocol/core` resolves to one version.
  - **Trigger:** if a server-legacy advisory has no patched 2.4.x release, #47 is pulled forward (or, after the release, a 0.5.x).
  - Under the 2026-11-09 scope decision, #47 itself (moving the AS off server-legacy) ships in 0.5.0. It needs its own ADR-0002 for the replacement choice, which issue #47 asks for. #46 (Client ID Metadata Documents) builds on it. See Q3.
- **Why:**
  - server-legacy is frozen and npm-deprecated, and it pins `core` exactly. If `server` moved to 2.5 while server-legacy stayed at 2.4, the tree would hold two copies of `core`.
  - The v2 bearer middleware recognizes only v2's `OAuthError` (an `instanceof` check). server-legacy ships its own copy of the class.
  - So a provider that throws server-legacy's `InvalidTokenError` from `verifyAccessToken` gets a 500, not a 401. That is why WS7.3 makes `verifyAccessToken` throw v2's `OAuthError(InvalidToken)` while the AS paths keep throwing server-legacy's classes.
  - A minor-version bump of server-legacy could change the internals our glue relies on without notice.
- **Binds:** WS7.2 (`package.json`; owner B), WS7.3 (`mcp-provider.ts` throw sites), the guard test, G1, and #47's PR, which deletes the pin.

### D15. #45 conventions: structured output on the low-level `Server`

1. **Null omission.**
   - The output keeps 0.4.x's shape: a null-valued key is left out, as #44's `omitNull` does.
   - Output schemas declare those properties optional and never `nullable`.
   - A field a tool reports as `null` on purpose (`?? null`) is declared nullable explicitly.
   - So adding schemas is not a Breaking change.
2. **Registration.**
   - Each tool module exports a Zod output schema. Its `Tool` definition carries `outputSchema: z.toJSONSchema(schema)`, with an object root.
   - The `tools/call` handler sets `structuredContent` to the same object the text block serializes, and returns it through `server.projectCallToolResult(result, outputSchema)`.
   - `registerTool` is not used (D2).
3. **Error results.** Error results (`isError: true`) carry no `structuredContent`.
4. **Validation.**
   - The low-level `Server` checks only the wire shape of a `tools/call` result, not our schema.
   - An ajv test validates every tool's real output, including #44's null-payload fixtures, against its advertised schema.
5. **Budgets.** Size and truncation budgets count text content only. `structuredContent` isn't counted (decided 2026-11-09).
6. **Pilot (45a).**
   - The first ten tools: `ynab_get_user`, `ynab_list_budgets`, `ynab_get_budget_settings`, `ynab_list_accounts`, `ynab_get_account`, `ynab_get_category`, `ynab_get_month`, `ynab_get_transaction`, `ynab_list_scheduled_transactions` and `ynab_rate_limit_status`.
   - Four of them (`get_category`, `get_month`, `get_transaction`, `list_scheduled_transactions`) go through `omitNull` today, so they exercise item 1.
   - The rest follow in 45b (see Q2).

- **Binds:** WS7.8 and 45b (`src/server.ts`, `src/tools/index.ts`, the tool modules; owner B) and the CHANGELOG "Added" section.

### The `/mcp` pipeline, in order (binds WS7.4)

The stages are mounted with `mountStages` and named, so a stage-list test covers `/mcp` the way `http-as-pipeline.test.ts` covers the AS:

`host-validation → origin-validation → request-ceiling → json-512kb → reject-batch → bearer (oauth) | header-identity (header) → inflight-limit → request-context → mcp-handler`

- The ceiling starts before the first stage that waits on anything. A slow or incomplete upload, a stalled `verifyAccessToken`, a stalled `resolver.resolve(userId)` (a storage read, possibly a YNAB token refresh) and a stalled handler all hit the same deadline.
- If the ceiling fires before the body has been parsed, there is no JSON-RPC id yet. The ceiling then answers with a JSON-RPC error with `id: null` and closes the connection.
- Cleanup for work that outlives the response: every stage after `request-ceiling` checks whether the response has already closed before it acts. Any lease or slot it took is released through D5's rule, so nothing taken after a timeout is kept.
- The in-flight limiter runs before the request context, so a refused request costs no storage read. It answers 429 in both modes (D6).
- Nothing bounds the *number* of requests that are still unauthenticated:
  - Partial uploads and `verifyAccessToken` reads take no slot, because the caps key on identity. The ceiling bounds how long each one lasts, but not how many there are.
  - A pre-authentication admission cap would close this, but it lets an unauthenticated flood lock out authenticated users. That trade-off is Q9.
- Every authentication failure (`bearer`) and every `request-context` failure answers 401 with `resource_metadata` in OAuth mode, never 500 (gate G6). The 429 from `inflight-limit` is outside G6.

## Consequences

**Positive:**

- No session state: no session caps to starve, no SSE streams that outlive their use, no stickiness at a proxy.
- Revocation, downgrades and the write switch all take effect on the next request.
- One factory serves both protocol eras, and stdio uses the same factory shape through `serveStdio` (WS7.5).
- About 300 lines (`session-manager.ts`) and their tests are deleted.

**Negative:**

- Every request builds a `Server` and a `YnabClient`, and makes two storage reads (D7).
- The ceiling answers the client, but the abandoned YNAB work continues until #58's fetch timeout.
- `Server` is deprecated in v2, and server-legacy is deprecated outright. Both are expected to go in v3.
- `npm install` prints server-legacy's deprecation notice until #47 lands.
- Clients that relied on `Mcp-Session-Id`, or on GET `/mcp` for a server-to-client stream, see 405 (Breaking-change row 1). WS7.9a checks the claude.ai connector, Desktop and Inspector before merge.

**Neutral:**

- The user's rate limiter, caches, delta snapshots and audit ring stay in process, per user (`UserRegistry`), and survive between requests exactly as they survive between sessions today.
- With several replicas, the caps and limiter are per process until #67's shared store. WS7.7's per-process state table says so.

**If WS7.4 is cut on Dec 4:**

- 0.5.0 ships sessionful on v2.
- D2, D3 (`authInfo.extra`), D7, D11, D14 and D15 still apply.
- D1, D5, D6, D8, D12 and D13 move to 0.5.1 with WS7.4.
- The session settings stay live.

## Alternatives considered

- **Sessionful on v2 as the target.** This is the Dec 4 fallback, not the goal. It keeps per-process session state and every problem listed in the Context section, and 2026-07-28 has no sessions.
- **`legacy: 'reject'` (modern only).** This breaks every 2025-era client, including Claude Desktop and the claude.ai connector as they stand today.
- **A hybrid routed with `isLegacyRequest`.** Rejected in D9.
- **`McpServer` with `registerTool`.** Rejected in D2. It is the SDK's preferred path, and the reason to revisit it is if v3 removes `Server`.
- **A bearer cache of 30 s or less.** Rejected in D7 for 0.5.0.
- **A global cap per `client_id`** (the #41 comment). Rejected in D6: it throttles all users of a shared public client together.
- **Porting the AS off server-legacy inside WS7.3.** Rejected: WS7.3 stays a small auth split. The port has its own issue (#47) and ADR (ADR-0002).

## Open questions for the maintainer (Wed Nov 11)

1. **The cap numbers can't both bind.**
   - The plan says 4 in-flight requests per user and 8 per (client, user). Every (client, user) count is at most the user's count, so the 8 never binds, and one client can still take all 4 of a user's slots (ABUSE-22).
   - **Recommendation:** 8 per user and 4 per (client, user): `MCP_MAX_INFLIGHT_PER_USER=8`, `MCP_MAX_INFLIGHT_PER_CLIENT=4`.
   - Alternative: keep 4 per user and drop the per-client cap.
   - Either way, Breaking-change row 3 and its CHANGELOG line change to match.
   - Also confirm the process-wide cap D6 proposes (`MCP_MAX_INFLIGHT`, default 64). The plan has none, and without one, header mode with made-up tokens is unbounded.
2. **#45 in full.**
   - The 2026-11-09 scope decision puts all of #45 in 0.5.0. The plan has only the ten-tool pilot, as a stretch item in P9 or P10, and no slot for the other 59 tools.
   - Please confirm:
     - (a) Where 45b (59 tools, mechanical once the pilot sets the pattern) lands: P10 with the pilot, or the Sun Dec 13 interop-fix packet.
     - (b) A tool without a schema at the tag ships without `outputSchema`, which is not a release blocker.
     - (c) #45's `registerTool` checkbox is reworded to "outputSchema on the low-level Server" (D2, D15).
3. **#47 in full.**
   - The scope decision moves the AS port into 0.5.0. The plan had P draft it after the tag, and the port needs ADR-0002 first.
   - Please confirm:
     - (a) ADR-0002 is P's next document after WS7.3.
     - (b) If the port hasn't merged by the Dec 9 freeze, 0.5.0 ships on the D14 pin with the documented reason (issue #47's own fallback), and #47 and #46 move to 0.5.1.
4. **When leases are released (a change from the plan).**
   - The plan releases on `res.on('close')` alone. D5 instead holds the registry lease and the in-flight slot until the response has closed *and* the tool call has settled.
   - The reasons: no eviction of components still in use, and no stacking of abandoned work after the ceiling fires.
   - The cost: a hung YNAB fetch keeps its slot until #58's fetch timeout, so that user may get 429s sooner.
   - Please confirm.
5. **Ceiling bounds and `Retry-After`.**
   - **Proposed:** `MCP_REQUEST_TIMEOUT_MS` from 5 000 to 300 000 (default 60 000); the in-flight caps from 1 to 64; `Retry-After: 1` on 429.
   - The final names and bounds go in WS7.4's `limits.ts`, as #58a did with its setting.
6. **Work around the SDK's legacy-routing defect (D1)?**
   - Options:
     - (a) Accept it until typescript-sdk#3160 ships, and bump `server` then. A pinning test flags the change, and WS7.9a checks the real clients.
     - (b) Before the handler, strip a 2025-revision `io.modelcontextprotocol/protocolVersion` claim from `params._meta` on non-`initialize` requests, so they classify legacy. This is about 15 lines; delete it after the fix.
   - **Recommendation:** (a), unless WS7.9a finds a client that sends the shape. Then (b).
7. **Bound storage work, so held slots always free (D6).**
   - Options:
     - (a) Bound storage calls on both sides:
       - Postgres server side: `statement_timeout` and the pool's `connectionTimeoutMillis` (e.g. 10 s).
       - Postgres client side: `pg`'s `query_timeout`. This also covers a reply lost in a network partition, which the server-side timeouts don't. A connection whose query timed out is discarded, not returned to the pool, and a timed-out write is treated as an unknown outcome: re-read before acting on it.
       - SQLite: a bound `busy_timeout`.
     - (b) An application-level timeout around `resolve`'s storage calls. A timed-out call is abandoned and its slot freed, but the write may still land.
     - (c) No bound in 0.5.0; document that the process-wide cap may fill while storage is stalled.
   - **Recommendation:** (a). It belongs to storage owner D (`postgres.ts`, `sqlite.ts`), fits P5-P6, and makes every storage call settle. A query that hits the timeout fails as a 401 or a mapped error, never a hang.
8. **How a timed-out tool call reports (D6).**
   - Options:
     - (a) A handler-level deadline in `tools/call` returns the error as an `isError` result through the SDK, plus the HTTP ceiling as a backstop.
     - (b) The HTTP ceiling writes its own SSE `message` frame into the stream `toNodeHandler` is piping, then ends it.
   - **Recommendation:** (a). The SDK keeps the framing, it works on all three response shapes, and the model sees an ordinary tool error. (b) depends on the transport's frame boundaries.
9. **A pre-authentication admission cap?**
   - The in-flight caps key on identity, so requests still uploading or being verified count against nothing (pipeline section).
   - Options:
     - (a) A process-wide pre-auth cap (e.g. 128) acquired before `json-512kb` and held until verification settles.
     - (b) Rely on the ceiling, Node's `server.headersTimeout` and `requestTimeout`, and a reverse proxy's connection limits, and document that.
   - **Recommendation:** (b) for 0.5.0. A pre-auth cap is a lever an unauthenticated client can use to lock out every authenticated user.
   - A per-IP limiter on `/mcp`, keyed the way #59 keys the AS limiters, is the better tool for unauthenticated load. It isn't planned today: #59 covers only the AS routes.

## Addenda

None yet.
