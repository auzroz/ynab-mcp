# ADR-0001: MCP SDK v2 and stateless Streamable HTTP

| | |
|---|---|
| Status | **Accepted** (2026-11-13). Proposed 2026-11-10; the maintainer answered Q1-Q9 on 2026-11-13 with the recommendations (see "Maintainer decisions"). |
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
  - **No workaround (Q6):** we accept it until #3160 ships, then bump `server`. If WS7.9a finds a client that sends this shape, WS7.4 adds the workaround instead: before the handler, strip a 2025-revision envelope claim from `params._meta` on non-`initialize` requests (about 15 lines, deleted after the fix).
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
  - At f35a0d7, `YnabTokenResolver.refresh` wrote back the whole `UserRecord` it read before refreshing (`upsertUser({ ...user, … })`). A read-only re-consent that landed during the refresh was overwritten with the old read-write `grantedScope`.
  - STOR-1 (WS8.25, #93, merged into `release/0.5.0` on 2026-11-13) replaced that write-back with the compare-and-set `updateUserRefreshToken(userId, oldCiphertext, newCiphertext)`. It writes only the refresh token and misses when the row has changed, which closes the race.
  - WS7.4 relies on that change, which is already on `release/0.5.0`.
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
  - The maintainer confirmed this change from the plan (Q4, 2026-11-13), including its cost: a hung YNAB fetch keeps its slot until #58's fetch timeout.

### D6. In-flight caps and a request ceiling replace the session caps

- **What:**
  - **Caps:** a new `src/services/inflight-limiter.ts` keeps in-flight counters per user and per (client, user). Past either cap, the request gets 429 with `Retry-After: 1` and a JSON-RPC error, before any server is built.
  - **Numbers (Q1):** 8 per user (`MCP_MAX_INFLIGHT_PER_USER`) and 4 per (client, user) (`MCP_MAX_INFLIGHT_PER_CLIENT`). The plan had them the other way round, where the per-client cap could never bind and one client could take all of a user's slots.
  - **Header mode** has no client id, so only the per-user cap applies.
  - **A process-wide cap (Q1):** header mode accepts any non-empty token as a new "user" (`http.ts:282-289`), so per-user caps alone don't bound total concurrency. `MCP_MAX_INFLIGHT` (default 64) caps in-flight requests across all users, with the same 429 response. Today's global session cap is the thing it replaces.
    - Slots are **not** guaranteed to free at the ceiling. Under D5, a slot is held until the request's started work settles, and that includes `resolver.resolve`.
    - `resolve` awaits storage reads and an `upsertUser` write. #58's fetch timeout bounds the YNAB token refresh inside it, but nothing bounds the storage calls today: `postgres.ts` sets no statement, query or pool-acquire timeout.
    - So requests that stall in storage hold their slots until the storage call returns, and enough of them can exhaust the cap with their responses already closed.
    - **Storage work is bounded (Q7).** On Postgres every held slot then frees. On SQLite the bound covers lock waits only (see the last item):
      - Postgres, server side: `statement_timeout`, and the pool's `connectionTimeoutMillis` (for example 10 s).
      - Postgres, client side: `pg`'s `query_timeout`, set above `statement_timeout`, so the server cancels a slow statement first and the client-side timeout fires only when the server can't be reached (for example a reply lost in a network partition). A connection whose query timed out is discarded, not returned to the pool.
      - A timed-out write is an unknown outcome. The request fails; nothing retries the write or acts on a re-read as if it had failed, because the write may still commit. The refresh-token write is already a compare-and-set (STOR-1's `updateUserRefreshToken`), so a late commit can't overwrite a newer token.
      - SQLite: a bounded `busy_timeout`, which bounds the wait for a lock held by another connection or process.
      - A query that hits a timeout fails as a 401 or a mapped error, never a hang.
      - SQLite (`better-sqlite3`) runs synchronously on the event loop. A slow query or a stalled disk therefore stalls the whole process, ceiling timers included, instead of holding slots while other requests run. That is a single-node outage, not slot exhaustion, and moving SQLite to a worker thread is out of scope for 0.5.0.
  - **Ceiling:** `MCP_REQUEST_TIMEOUT_MS`, default 60 000. At the ceiling, a request whose response hasn't started gets a JSON-RPC error that echoes its id ("Request timed out", with no upstream text).
  - **Open SSE streams get the error in the stream:**
    - In 2.4.0 the stateless legacy leg answers every request-bearing POST over SSE. `WebStandardStreamableHTTPServerTransport` defaults to `enableJsonResponse: false`, the fallback can't change that, and it writes the headers and a keepalive every 15 s straight away. So for 2025-era clients the response has always "started".
    - Ending that stream without a result would leave a timed-out write with no outcome at all.
    - **Requirement:** a `tools/call` that times out on an open SSE stream first receives a JSON-RPC result for its id as an SSE `message` event: the unknown-outcome text below for write tools, "Request timed out" otherwise. Only then is the stream ended. Other methods are covered below.
    - **Mechanism (Q8):** a deadline inside the `tools/call` handler (`server.ts`), taken from the request's absolute deadline (when `request-ceiling` started, plus `MCP_REQUEST_TIMEOUT_MS`) less a small margin, never a fresh timer. A slow `resolve` therefore shortens the handler's time instead of pushing its deadline past the ceiling; a test covers a delayed resolver followed by a slow write. It returns the timeout as an `isError` tool result, and the SDK delivers that over whichever transport the request uses (JSON, modern SSE or legacy SSE). The HTTP-level ceiling stays as the backstop for stalled stages before the handler, and for non-tool methods:
      - A stage before `mcp-handler` (for example a stalled `resolver.resolve`) runs before the SDK has started any response, legacy SSE included, so the ceiling answers with the JSON-RPC error above ("Request timed out", echoing the id).
      - A non-tool method that stalls after the legacy leg has started its SSE response gets no error event: the ceiling ends the stream. Those methods change nothing, so there is no unknown outcome to report. Writing our own SSE frame into the SDK's stream was option (b) of Q8, which was not chosen.
  - **Settings (Q5):** `MCP_MAX_INFLIGHT_PER_USER` (default 8) and `MCP_MAX_INFLIGHT_PER_CLIENT` (default 4), each 1-64; `MCP_MAX_INFLIGHT` (default 64); `MCP_REQUEST_TIMEOUT_MS` from 5 000 to 300 000 (default 60 000). All are parsed strictly and bounds-checked like #56's settings, in WS7.4's `src/config/http/limits.ts`, which fixes the final names and `MCP_MAX_INFLIGHT`'s range.
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
  - Storage owner D: the Q7 timeouts in `postgres.ts` and `sqlite.ts`, with tests that a stalled query fails instead of hanging.
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
  - Under the 2026-11-09 scope decision, #47 itself (moving the AS off server-legacy) ships in 0.5.0. It needs its own ADR-0002 for the replacement choice, which issue #47 asks for. #46 (Client ID Metadata Documents) builds on it.
  - **Q3:** ADR-0002 is P's next document after WS7.3. If the port hasn't merged by the Dec 9 freeze, 0.5.0 ships on this pin with the documented reason (issue #47's own fallback), and #47 and #46 move to 0.5.1.
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
   - The other 59 tools follow in 45b, in P10 with the pilot (Q2). A tool without a schema at the tag ships without `outputSchema`, which doesn't block the release.

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
  - **No pre-authentication cap in 0.5.0 (Q9).** It would let an unauthenticated flood lock out authenticated users. 0.5.0 relies on the ceiling, Node's `server.headersTimeout` and `requestTimeout`, and a reverse proxy's connection limits, and WS7.7 documents that. A per-IP limiter on `/mcp`, keyed the way #59 keys the AS limiters, is the better tool for unauthenticated load; it isn't planned yet.
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

## Maintainer decisions (2026-11-13)

The ADR's nine open questions, answered with the recommendations. The numbers match the PR #91 review threads.

1. **Caps:** 8 in flight per user and 4 per (client, user); a process-wide cap, `MCP_MAX_INFLIGHT`, default 64 (D6). Breaking-change row 3 and its CHANGELOG line use these numbers.
2. **#45 in full:** (a) 45b, the other 59 tools, lands in P10 with the pilot; (b) a tool without a schema at the tag ships without `outputSchema`, which doesn't block the release; (c) #45's `registerTool` checkbox is reworded to "outputSchema on the low-level Server" (D2, D15).
3. **#47 in full:** (a) ADR-0002 is P's next document after WS7.3; (b) if the port hasn't merged by the Dec 9 freeze, 0.5.0 ships on the D14 pin and #47 and #46 move to 0.5.1 (D14).
4. **Leases:** held until the response has closed and the started work has settled (D5).
5. **Bounds:** `MCP_REQUEST_TIMEOUT_MS` 5 000-300 000 (default 60 000); the per-user and per-client caps 1-64; `Retry-After: 1` on 429 (D6).
6. **SDK legacy-routing defect:** no workaround unless WS7.9a finds a client that sends the shape (D1).
7. **Storage work:** bounded at the database and driver level, owned by storage owner D in P5-P6 (D6).
8. **Timed-out tool calls:** a handler-level deadline returns an `isError` result through the SDK; the HTTP ceiling is the backstop (D6).
9. **Unauthenticated load:** no pre-authentication cap in 0.5.0; rely on timeouts and a reverse proxy, documented in WS7.7 (pipeline section).

## Addenda

### 2026-11-13: WS7.4 implementation notes

WS7.4 (`feat/stateless-http`) builds the decisions above as written. No SDK gap was found: every behaviour the ADR assumes from `@modelcontextprotocol/server` 2.4.0 and `@modelcontextprotocol/node` 2.1.2 holds, including the routing defect's exact answers (D1: `-32602` for the envelope key alone, `-32022` for the full envelope; pinned in `tests/unit/http-v2-client.test.ts`). Where the ADR left a detail open, or stated an SDK fact imprecisely, this is what was built:

- **`toNodeHandler` and the parsed body (D1, D12).** It does not read `req.body` itself: mounted as Express middleware its third argument is `next`, which it ignores. The `mcp-handler` stage passes `req.body` explicitly. A body `express.json` skipped (not `application/json`) is still read by the adapter under its own 512 KB bound, and answered `415` by the handler.
- **Mounting (D1).** The pipeline is one route, `app.route('/mcp').all(…)`: exactly `/mcp`, every method. (`app.all` would register the handlers once per HTTP method.) A path under `/mcp` is a plain `404`. The app-wide JSON parser is mounted after `/mcp`, so a `/mcp` body is read only by `json-512kb`, inside the ceiling.
- **Ceiling answers (D6).** Not set by the ADR: `504` with the JSON-RPC error echoing the id when the request had fully arrived, `408` with `Connection: close` and `id: null` when its body had not. JSON-RPC code `-32000` for the timeout and for the `429`. A started stream is ended with `res.end()`.
- **Handler deadline (D6, Q8).** The request's absolute deadline less `min(1000 ms, MCP_REQUEST_TIMEOUT_MS / 10)`. A call whose deadline has passed before it starts (a slow `resolve`), or whose request has already closed, is not started, and its result says only "Request timed out": nothing ran, so the outcome is known.
- **`MCP_MAX_INFLIGHT` (D6, Q5).** Range 1-1024, default 64. Two cross-rules, like `MCP_MAX_SESSIONS_PER_USER`'s: the per-client cap may not exceed the per-user cap, nor the per-user cap the process-wide one; a default follows a smaller explicit cap.
- **The 401 from `request-context` (D3, G6).** The same body and challenge as an invalid token (`invalid_token`, "Invalid or expired access token"), so a client can't tell a revoked YNAB grant from a bad token. Header mode keeps its JSON-RPC `401` (`-32001`) with no challenge.
- **Account generation (D3).** `request-context` pins the request's `YnabClient` token source to the account generation its `resolve` returned (`accessTokenFor(userId, generation)`), instead of the first YNAB call's.
- **Shutdown (D1, D5).** `close()` waits until every request is released (its response closed and its started work settled, so a timed-out write's YNAB call is not cut off; the process entry's 10 s deadline bounds the wait), then closes idle connections and calls `mcp.close()`.
