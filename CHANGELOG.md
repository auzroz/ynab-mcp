# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Breaking

- **HTTP mode's OAuth authorization server is now
  [oidc-provider](https://github.com/panva/node-oidc-provider)** (#47,
  ADR-0002). It replaces the MCP SDK's frozen `server-legacy` handlers. Every
  connection signs in again once after the upgrade; registered clients carry
  over. What clients can see:
  - `POST /authorize` answers `405 method_not_allowed` (`Allow: GET`). Only
    `GET` is served.
  - `prompt=none` returns `login_required`, since every authorization goes
    through the consent page and YNAB. `response_mode` is ignored, as before:
    the answer is always a query redirect.
  - The token response's `token_type` is `Bearer`, and a read-write token's
    `scope` is `read-only read-write` (read-write access is unchanged).
    Token values are 43 characters, with no `ymcp1_` prefix.
  - The registration (DCR) response has more fields: `application_type`,
    `subject_type`, `id_token_signed_response_alg` and `require_auth_time`,
    with the defaults filled in. `client_secret_expires_at` is `0`: new client
    secrets no longer expire after 30 days, though a client unused for 90 days
    is still removed. `sector_identifier_uri` is refused. A registered
    `scope`, `software_id` and `software_version` are accepted but no longer
    kept or echoed (none of them ever limited a client; scopes are asked for
    at `/authorize`).
  - The discovery document lists OIDC fields and a `jwks_uri`, and is also
    served at `/.well-known/openid-configuration`. Like `/jwks`, it echoes
    the request's `Origin` in `Access-Control-Allow-Origin` (`*` without
    one), so any origin can still read it. Error descriptions read
    differently, and an `invalid_client` that comes from the library itself
    is 401 (this server's own client check still answers 400). Client
    credentials are read only from the form body, as before: an
    `Authorization` header on `/token` or `/revoke` is ignored. The JSON error
    shapes and the 405 for a wrong method are unchanged.
- Replacing `ENCRYPTION_KEY` now needs a new `ENCRYPTION_KEY_ID` (#57). A
  different key under an id the database has already recorded refuses to
  start, so swapping the key in place and letting every user reconnect no
  longer works. To rotate without logging anyone out, follow "Rotating
  ENCRYPTION_KEY" in docs/REMOTE_HOSTING.md. If the old key is lost, give the
  new key a new id: every user then reconnects once.
- Writes are capped at 20 write requests per user per hour (#61c). Before,
  writes were unlimited, so an automation that makes more than 20 write calls
  an hour (stdio included) is now refused with `write_limit_exceeded` until the
  window frees up. Set `YNAB_WRITE_LIMIT_PER_HOUR` (0 to 1000) to change it;
  `0` turns the cap off.
- **OAuth clients registered on 0.5.0 or later must send `resource`** (RFC
  8707) at `/authorize` (#64). Without it `/authorize` answers
  `invalid_target`. At `/token` it stays optional: a code exchange or refresh
  without it gets the resource the user authorized. A `resource` sent to
  `/token` that isn't this server's is `400 invalid_target`, and the code or
  refresh token is no longer spent by that mistake. Clients registered before
  0.5.0, which the upgrade converts, keep working without it. MCP clients that
  follow the MCP authorization spec already send it. **Clients:** send
  `resource` (this server's MCP endpoint URL) on every authorization request.
  **Operators:** if a newly registered client can't send it yet, set
  `MCP_REQUIRE_RESOURCE=false` until it can. That setting is deprecated and is
  removed in 0.6.

- **HTTP mode is stateless** (#41, ADR-0001). `/mcp` no longer issues an
  `Mcp-Session-Id`, and `GET` and `DELETE /mcp` answer `405`, so nothing needs
  sticky sessions: remove any sticky-session routing at your proxy. Each
  request is authenticated on its own and gets a fresh server.
  - `MCP_MAX_SESSIONS`, `MCP_MAX_SESSIONS_PER_USER` and
    `MCP_SESSION_IDLE_TIMEOUT_MS` still parse but have no effect. A set one
    logs a startup warning naming its replacements, and 0.6 removes them.
  - New caps replace them: at most 8 requests in flight per user
    (`MCP_MAX_INFLIGHT_PER_USER`), 4 per client and user
    (`MCP_MAX_INFLIGHT_PER_CLIENT`) and 64 per process (`MCP_MAX_INFLIGHT`).
    A request past a cap gets `429` with `Retry-After: 1`. A request that runs
    longer than 60 seconds (`MCP_REQUEST_TIMEOUT_MS`) is ended.
  - In header mode every request needs a YNAB token (`X-YNAB-Token`, or
    `YNAB_ACCESS_TOKEN`), not only the first.
- HTTP mode requires `AUTH_MODE` (#56). Set `AUTH_MODE=oauth` or
  `AUTH_MODE=header`: without it the server refuses to start. 0.4.x guessed
  `oauth` when the four OAuth variables were set and `header` otherwise, so
  set the one you were running. Related rules, all checked at startup (every
  problem is listed in one message that never echoes a value):
  - `oauth` mode refuses `YNAB_ACCESS_TOKEN` and `YNAB_BUDGET_ID`.
  - `header` mode with `YNAB_ACCESS_TOKEN` refuses to start on a bind other
    than loopback, which includes the default of every interface, unless you
    set `MCP_ALLOW_ANONYMOUS_FALLBACK=true` or bind to loopback with
    `MCP_BIND_HOST=127.0.0.1`. Behind a reverse proxy on the same host a
    loopback bind does not protect the token. A Docker deployment in header
    mode with a token needs `MCP_ALLOW_ANONYMOUS_FALLBACK=true`.
  - Numeric settings are bounds-checked: for example `RATE_LIMIT_PER_HOUR` is
    1 to 195 in HTTP mode (stdio still allows 200).
  - `/health` returns only `{"status":"ok"}`.
  - An `MCP_TRANSPORT` other than `stdio` or `http` refuses to start (0.4.x
    ran stdio for any other value).
- `YNAB_OAUTH_ALLOW_WRITE` now defaults to `false` and is checked on every
  request (#56, #68). Unless it is `true`, no connection can write, including
  one granted read-write on 0.4.x (the default was `true`). To keep writes,
  set `YNAB_OAUTH_ALLOW_WRITE=true` (with `YNAB_READ_ONLY=false`).
- Stored MCP tokens, codes, `state` and client secrets are hashed (#52, #68).
  The token, code and `state` hashes are keyed by `TOKEN_PEPPER`, or by a
  pepper derived from `ENCRYPTION_KEY` when it is unset, and the database
  records the pepper's fingerprint at the first 0.5.0 start. After that, a
  different `TOKEN_PEPPER` (or a new `ENCRYPTION_KEY` with no `TOKEN_PEPPER`)
  refuses to start. Before any key change, pin `TOKEN_PEPPER` (see "Rotating
  ENCRYPTION_KEY" in docs/REMOTE_HOSTING.md). Rolling back means restoring the
  pre-upgrade backup (see Upgrading from 0.4.x).
- MCP refresh tokens expire after 30 days without use or 90 days after the
  sign-in that issued them, whichever comes first (#54, #68). A client then
  sends the user through sign-in again. Change the windows with
  `MCP_REFRESH_TOKEN_IDLE_DAYS` and `MCP_REFRESH_TOKEN_TTL_DAYS` (1 to 3650).
  Tokens issued before the upgrade stop working at it anyway (see the
  authorization-server note above).
- Client registration and `/authorize` follow the server's own rules (#55).
  Before upgrading, check that your clients fit them:
  - `/register` refuses a redirect URI that is plain `http://` to a host other
    than `localhost`, `127.0.0.1` or `[::1]`, has userinfo or a fragment, is
    over 512 characters, or uses a private-use scheme that isn't on
    `MCP_DCR_PRIVATE_USE_SCHEMES` (empty by default). It refuses more than 5
    redirect URIs with `invalid_client_metadata`, and a `client_name` over 100
    characters or with control, bidi or zero-width characters. Fields the
    server doesn't use (`jwks`, `contacts`, `logo_uri`, `software_statement`
    and the like) are dropped.
  - `/authorize` refuses a `state` over 512 characters, a `code_challenge`
    that isn't 43 base64url characters, and more than 5 scopes. Unknown scopes
    are dropped.
  - A client registered before 0.5.0 with a non-loopback `http://` redirect
    URI is refused at `/authorize` and must register again.
  - An authorization error for a client whose redirect URI isn't verified
    (`MCP_VERIFIED_REDIRECT_URIS`, or loopback) is shown on the server's own
    page instead of being redirected to the client. To have your own clients'
    errors redirected, add their callbacks to `MCP_VERIFIED_REDIRECT_URIS`,
    which replaces the default list (Claude's two callbacks): include those
    too. See "Using other MCP clients" in docs/REMOTE_HOSTING.md.
  - Request bodies over 8 KB on the authorization server routes get `413`.
- When the YNAB request budget is used up, calls fail at once with
  `retry_after_seconds` instead of queueing (#58). A call may still wait up to
  `RATE_LIMIT_MAX_WAIT_MS` (default 2000; `0` never waits) for a token, and
  only one call waits at a time. The error `type` is now `rate_limited` (was
  `rate_limit`): anything that matches on the old value must change. This
  applies to stdio too.
- The `ynab-mcp-server` command is removed (#43); use `ynab-mcp`. That name
  belongs to an unrelated npm package. `npx -y ynab-mcp` is unchanged.

### Changed

- A read-only sign-in no longer downgrades a user's other connections (#64).
  The server stores one YNAB token per user. When a user with a live
  read-write connection connects another client read-only, the read-write
  YNAB token is now kept and the new read-only one discarded; before, the
  latest sign-in's token replaced it and every connection of that user became
  read-only. Each connection's own grant still decides its access level, so
  the new client stays read-only. YNAB keeps both authorizations valid
  (checked against YNAB on 2026-11-23), so nothing breaks. A read-write token
  YNAB has refused (`invalid_grant`) is not kept: the refusal is recorded
  (best-effort), and the next sign-in, read-only included, replaces it. No
  setting and no migration.
- `ynab_audit_log` changes (#60a):
  - Entry fields are snake_case: `timestamp`, `tool`, `operation`,
    `resource_type` (was `resourceType`), `resource_id` (was `resourceId`),
    `budget_id` (was `budgetId`), `outcome`, `success`, `client_id`,
    `family_id` and `request_id`.
  - Entries no longer carry `details` (amounts, dates, presence flags) or
    `error` text.
  - New `outcome` filter. The `operation` and `resource_type` filters accept
    every value the log records (`move`, `import`, `audit_suppressed`;
    `category_group`, `payee`, `scheduled_transaction`).
  - `success: false` now matches every write outcome but `success`, refusals
    included. A revocation entry (#60b) matches neither value and shows
    `success: null`.
  - In OAuth mode it shows only the calling client's entries; another client
    of the same user no longer sees them. `all_clients: true` shows all of the
    user's clients' entries (#60b), never another user's.
  - The summary adds `by_outcome` and `revocation_count`.
  - A bulk call (`ynab_create_transactions`, `ynab_update_transactions`) is
    one entry per transaction YNAB saved, all with the call's `request_id`
    (#60b); before, it was one entry for the call.
- **What operators see after the authorization server move** (#47):
  - The consent page is now at `/oauth/interaction/<id>`, reached by a
    redirect from `/authorize`. Its choices go to `.../start`, and Cancel to
    `.../cancel`. After YNAB, `/oauth/ynab/callback` (the redirect URI
    registered at YNAB, unchanged) sends the browser to `.../complete`, then
    back through `/authorize/<id>` to the client. `/oauth/ynab/start` and
    `/oauth/cancel` are gone. Every leg stays under `/oauth` and its rate
    limit, which doubles to 200 requests per 15 minutes per address: a
    sign-in now takes four requests there, so the limit still allows 50
    sign-ins. The `/authorize` rate limit counts both the request and the
    return from the consent page.
  - The consent-page cookie is replaced by the library's signed cookies
    (`_interaction`, `_interaction_resume`, `_session`, each with a `.sig`).
    They are signed with a key derived from `ENCRYPTION_KEY` (no new setting)
    and are `Secure` when `PUBLIC_URL` is https. The browser still has to be
    the one that saw the consent page.
  - New routes: `/.well-known/openid-configuration` and `/jwks` (the library
    requires a signing key; it is generated at startup and signs nothing).
  - Registered clients, tokens and codes live in one `oauth_rows` table. The
    0.4.x token tables are no longer read; their rows are swept on the usual
    schedule, removed with an account, and dropped in 0.6.
- **Upgrading from 0.4.x:** registered clients are converted at the first
  start (a client that fails the new rules is dropped and logged, and must
  register again). 0.4.x access tokens, refresh tokens and codes, and sign-ins
  in progress, stop working: each user signs in again once per client (for
  example, 6 sign-ins for 3 users with 2 clients each). The claude.ai
  connector shows as disconnected until it's reconnected. Tell your users to
  expect this. Rolling back to 0.4.x means restoring the pre-upgrade backup.
- Temporary YNAB token failures (a timeout, YNAB unavailable, or another
  replica's refresh in progress) now return `503` with `Retry-After` instead
  of forcing the client to reconnect; only a rejected (`invalid_grant`)
  refresh token does (#48). A tool call gets `upstream_unavailable` with
  `retry_after_seconds`. The stored grant is kept, and the failure is not
  remembered. A replica below the key floor (still on a key that is being
  retired) answers `503` the same way until it is restarted with the current
  key.
- Amounts are formatted with the budget's `currency_format` instead of a
  hard-coded `$` (#49): symbol, symbol position, decimal places (0 for JPY, 3
  for BHD), decimal and group separators, and `display_symbol`. This changes
  only the human-readable strings (`balance`, `budgeted`, `summary` and
  `*_formatted` fields, messages). Raw milliunit fields, keys and the shape of
  every response are unchanged, and no field is added. For a USD budget,
  amounts of 1,000 or more now carry group separators (`$3,000.00`, was
  `$3000.00`). The format comes from the budget's cached settings, so it costs
  at most one extra request per budget every 5 minutes; if the settings cannot
  be read, amounts keep the previous `$1234.56` style. The format is reused for
  an hour per budget, so it costs well under one request an hour. Symbols and
  separators are cleaned of control and bidi characters but never trimmed, so
  space group separators (French, Swedish, Polish, Czech, Norwegian) survive.
  `ynab_transaction_search` now writes its `min`/`max` criteria as formatted
  amounts (`min: $80.00`, was `min: $80`). The split-sum and `ynab_move_money`
  minimum-amount validation messages, raised before the budget is known, no
  longer name a currency (`... (splits total 100, transaction is 90)`, `amount
  must be at least 0.001 (1 milliunit)`). `ynab_detect_recurring`'s
  `estimated_monthly_total` is now summed from milliunits, so it can differ by a
  milliunit or two.

- **MCP SDK v2** (#41, ADR-0001). The server moves from `@modelcontextprotocol/sdk`
  1.x to the v2 packages (`@modelcontextprotocol/server`, `node` and
  `express`), and serves MCP protocol revision 2026-07-28 next to 2025-11-25 on
  both transports. stdio runs through `serveStdio`. Tool names, arguments and
  output are unchanged.
- HTTP read-only access is computed on every request (#41), so a downgraded
  token or grant loses write tools on its next request. In OAuth mode a
  request whose YNAB grant can no longer be resolved gets the same `401`
  challenge as an invalid token, so the client signs in again. Any failure
  while checking an access token (a storage error or timeout) is now that
  `401` too, logged without the upstream text; it was a `500`.
- A tool call that reaches the request timeout returns a timeout error (#41).
  For a write that had started it says the change may still have been
  applied, so check before retrying.
- Every call to YNAB has a 10 second timeout, never longer than the request's
  own deadline (#58). A timed-out write reports that its outcome is unknown
  and is not retried.
- Analytics tools that make several YNAB requests reserve them all up front,
  or return `rate_limited` with `retry_after_seconds` before sending any
  (#58). Each user's caches are capped at 8 MiB together, and expired entries
  are pruned.
- Authorization server rate limits are keyed by client address as well as
  `client_id`, so behind a reverse proxy one client no longer uses up everyone's
  allowance (#59). Authenticated requests are keyed by user. `/authorize`,
  `/token` and `/revoke` also have an address-only ceiling (1000, 500 and 500
  per 15 minutes), because a `client_id` is free to invent. IPv6 addresses
  count by their /64. `/register` allows 100 per address per hour (was 20),
  plus 20 per redirect host per hour. Set `TRUST_PROXY` to your proxy hop
  count: the server now warns at startup when it is `0` and `PUBLIC_URL`
  isn't loopback. See "Client addresses and rate limits" in
  docs/REMOTE_HOSTING.md.
- The `ynab` SDK is now 5.0.0 (#44). Tool output is unchanged: fields the API
  returns as null are still left out.
- The Docker image no longer installs python3, make and g++, and the release
  and Docker builds install with `npm ci --ignore-scripts`. The SQLite driver
  comes as a prebuilt binary for amd64 and arm64 (#62).
- Storage waits are bounded, so a request can no longer hang on the database
  (#99). Postgres cancels a statement after 10 seconds, a query after 15
  seconds and a connection attempt after 10 seconds, and SQLite waits at most
  5 seconds for a lock (60 seconds during the startup migration). A write that
  times out fails the request and is not retried. There are no settings.
- The consent page tells the user how to end the access later: open the YNAB
  settings at app.ynab.com/settings, find Authorized Applications, and choose
  Revoke next to this server's app, which is listed under the name you gave
  your YNAB OAuth application (#85).
- The database records a schema version and a minimum compatible release
  (#73). A start that finds the database's floor above its own release, or an
  unreadable one, refuses to start. The 0.5.0 migrations add nullable columns
  and indexes (retention clocks for #54), which briefly lock each table at
  startup, so take the backup first.
- Tool descriptions and the server's MCP `instructions` tell the model that
  budget free text (payee, account and category names, memos) is untrusted
  data, not instructions (#61). Only descriptions change; schemas and output
  are unchanged. Every write tool and the 17 read tools that return memos or
  notes carry the note.
### Security

- A refresh whose response was lost can be retried (#64, OAUTH-15). An
  identical refresh from the same client within 60 seconds, before the new
  pair is used, gets the same new pair back; before, it counted as refresh
  token reuse and revoked the connection, so the user had to sign in again.
  A retry after 60 seconds, from another client, with another `scope` or
  `resource`, or after the new pair was used still revokes the connection.
  The record is kept in the database, so it works across replicas, encrypted
  under a key that needs the old refresh token (never stored), and is swept
  after the 60 seconds. No migration and no setting.
- Audit entries hold ids only (#60a): no amount or other financial value, no
  payee, account, category or memo text, and no error message, by
  construction (the table has no column for one). Before, an entry's details
  could carry a transaction's amount and date.
- Stored YNAB refresh tokens are bound to their user and column, and carry a
  key id (#57). The new format is `v2.<kid>.<iv>.<tag>.<ct>`, with AAD
  `ynab-mcp|<column>|v2|<user id>`, so a ciphertext copied into another user's
  row no longer decrypts. 0.4.x tokens (`v1`) are still read. A background
  rekey job rewrites them, and the rows under an older key, using
  compare-and-set writes, logging counts only. When none are left it announces
  the retirement. From then on a replica still on an older `ENCRYPTION_KEY_ID`
  refuses new refreshes and sign-ins before calling YNAB. One already in
  flight is still stored: its key is still configured everywhere, and it holds
  the retirement back until it is rekeyed. Every token write also re-checks the
  retired key id in the same database transaction, so a request that stalled
  past the retirement is refused instead of storing a token no replica can
  read. An hour later it retires `v1` and the older key ids for every
  replica, unless a token was written under an older key in the meantime.
- `ENCRYPTION_KEY` can be rotated without logging anyone out.
  `ENCRYPTION_KEY_ID` (default 1) names the current key, and
  `ENCRYPTION_KEY_PREVIOUS` (`<id>:<key>,…`) lists keys that are kept for
  reading only. The new `ynab-mcp derive-pepper` command prints the token
  pepper derived from `ENCRYPTION_KEY`, so it can be pinned as `TOKEN_PEPPER`
  before a rotation. See "Rotating ENCRYPTION_KEY" in docs/REMOTE_HOSTING.md.
- The server refuses to start if:
  - the key under an id differs from the one the database recorded for that id;
  - `ENCRYPTION_KEY_ID` is below a retired id;
  - `ENCRYPTION_KEY_PREVIOUS` is set without `TOKEN_PEPPER`.
- Upgrading needs no configuration change. Back up the database first:
  rolling back means restoring that backup. 0.4.x has no schema-version check,
  so it does start on a 0.5.0 database, but it can't read the tokens 0.5.0
  stores. Don't run 0.4.x and 0.5.0 replicas against the same database, not
  even during a rolling deploy.
- The binding protects tokens from the upgrade on. A `v1` token carries none,
  so one copied into another user's row before the upgrade is re-encrypted as
  that row's.
- Release tags are verified (#62). `Release: Verify` refuses a `v*` tag,
  release candidates included, unless it is an annotated tag signed with an
  SSH key listed in `.github/allowed_signers`.
- The Docker image is pushed to `ghcr.io/auzroz/ynab-mcp` with a token that
  only the approved `production` environment holds, instead of the workflow's
  `GITHUB_TOKEN`. No release job has `packages: write` any more, and the
  package gives the repository's workflows read access only, so a workflow
  run outside an approved release can't push an image (#62). The
  image's attestation remains its proof of origin.

- MCP access tokens, refresh tokens, authorization codes and sign-in `state`
  are stored only as keyed hashes, and client secrets as SHA-256 hashes (#52).
  A copy of the database holds no usable MCP credential. A token or code that
  isn't 43 base64url characters is refused without a database read, and so is
  a `state` that isn't a correctly tagged `ymcp1_` value. `TOKEN_PEPPER` is
  optional (32 bytes, base64 or hex): when unset the pepper is derived from
  `ENCRYPTION_KEY`. A change to the pepper refuses to start (see Breaking).
  `TOKEN_PEPPER` is redacted in logs. 0.4.x rows are converted on the first
  start.
- Replaying an authorization code revokes the tokens issued for it and every
  refresh since (#42, RFC 9700). A replayed, an unknown and an expired code get
  the same `invalid_grant` answer. The record of spent codes is in the
  database, so every replica and a restart see it.
- `/authorize` no longer redirects an authorization error to a redirect URI
  that isn't verified (#55). This closes an open redirect: the error is shown
  on the server's own page, with a link back the user can choose to follow.
  Dynamic client registration is checked against the server's own rules (see
  Breaking). The consent page shows the host the browser returns to in bold,
  labels an unverified client "calls itself" and loopback addresses, strips
  bidi and invisible characters from the client's name, and is served with a
  strict `Content-Security-Policy` and `no-store`. A shared per-address limit
  runs before any request body is read.
- Releases publish only from a `v*.*.*` tag on a commit already on `main` or a
  `release/*` branch, after the tests, the build, `npm audit` and both image
  builds pass (#62). Each publish job waits for approval on the `production`
  environment, and only the publish jobs and the opt-in MCP Registry job hold
  an OIDC identity. The release and Docker builds install with
  `--ignore-scripts`, and the npm publish job runs no checkout and no
  install. Releases include `SHA256SUMS`, build provenance attestations for every
  release file and the image, and SPDX SBOM attestations for the npm tarball
  and the image's npm dependencies. Verify them with `gh attestation verify`.
- Text from the budget in tool output (payee, account and category names,
  memos, notes) has Unicode bidirectional control characters removed, so it
  can't be visually reordered to mislead the user or the model (#61).
- A stored access level other than `read-only` or `read-write` is read as
  read-only, so a corrupted or hand-edited row can't widen a connection (#73).
- Erasing an account is supported by the storage layer (#53, #54): tokens
  issued before an account was erased stay dead if the same person connects
  again. A YNAB token refresh that finishes after the account was erased
  fails instead of recreating the user, and the user reconnects (#93).
### Added

- **A durable, attributable audit log** (#60a). Every write tool call is
  recorded with how it ended: `success`, `denied_read_only`, `denied_scope`
  (a read-only grant), `denied_write_limit` or `error`. Refused writes are
  recorded too, up to 20 read-only or scope refusals per user per hour, then
  one `audit_suppressed` entry marks that later ones are missing; a call that
  fails input validation is not. Recording never fails a write and holds it up
  for at most 1 second: a slower insert finishes in the background, and if the
  store can't be written the write stands and the entry is lost (logged). Each entry names
  the user, the MCP client, its grant and the request, the tool, the operation,
  and the resource and budget ids. In OAuth mode entries go to the storage
  driver, so with `sqlite` or `postgres` they survive restarts and are shared
  by replicas. In header mode and on stdio they stay in memory, newest 1,000
  per user. Erasing an account erases its entries. This needs schema 7: one
  `audit_log` table with two indexes, added on startup.
  See "The audit log" in docs/REMOTE_HOSTING.md.
- **The audit log, completed** (#60b):
  - Each revoked connection is one entry in OAuth mode (D-7a): `revoked` (at
    `/revoke`, or with the account tools), `revoked_reuse` (a spent refresh
    token or code presented again, or by another client) or `revoked_replay`
    (one spent twice at once). Issuing and refreshing tokens is not recorded,
    nor is an account erase. Each revocation is recorded once, by the request
    that deleted the connection, and no entry holds a token.
  - A bulk call records one entry per transaction, in one insert under the
    same 1-second bound and erasure check as a single write.
  - `AUDIT_RETENTION_DAYS` (1-3650, default 90): the retention sweep deletes
    older entries, in batches. OAuth mode's durable log only; stdio and
    header mode keep the newest 1,000 per user in memory, as before.
  - `ynab_audit_log` takes `all_clients` to show every connection of the
    user. No schema change.
- `ynab_rate_limit_status` reports
 the calling client's share of the user's
  requests and refusals in the last hour, under `client_usage` (#58).
  `client_id` is `null` on stdio and in header mode.
- `YNAB_WRITE_LIMIT_PER_HOUR`: a per-user write cap on every transport (#61c).
  One write tool call is one write request, so a bulk call such as
  `ynab_create_transactions` counts as 1. It is checked once, before the tool
  runs, so a refused write takes no YNAB request and changes nothing. The error
  names the limit and when the next write is allowed. A call that fails input
  validation gives its slot back; one YNAB rejects keeps it. The first refusal of
  each episode is recorded in the audit log as `denied_write_limit`. It is separate
  from `RATE_LIMIT_PER_HOUR`, which counts YNAB requests.
- Retention windows are settings, and a sweep enforces them (#54): a
  background job deletes expired credentials and clients every 15 minutes.
  `MCP_REFRESH_TOKEN_IDLE_DAYS` (default 30) and `MCP_REFRESH_TOKEN_TTL_DAYS`
  (default 90) bound a connection, `MCP_ABANDONED_CLIENT_HOURS` (default 24)
  and `MCP_UNUSED_CLIENT_DAYS` (default 90) bound client registrations. Whole
  numbers up to 3650 days; the idle window may not exceed the total. See
  "Retention and the sweep" in `docs/REMOTE_HOSTING.md`.
- Optional erase of inactive users (#54): `MCP_INACTIVE_USER_DAYS` (30 to
  3650, off by default). A background job erases each user who has had no
  sign-in and no YNAB token refresh for that many days and has no live
  connection. It re-checks both inside the erase's transaction and logs a
  count only. For existing users the clock starts at the upgrade.
- Client ID Metadata Documents (#46), the replacement the MCP specification of
  2026-07-28 gives for Dynamic Client Registration:
  `MCP_CLIENT_ID_METADATA_DOCUMENTS=true` (experimental, off by default) lets a
  client use an https URL as its `client_id`. The server fetches the client's
  metadata from that URL and holds it to the `/register` rules, and discovery
  advertises `client_id_metadata_document_supported`. The fetch is guarded
  against server-side request forgery:
  - public addresses only, resolved once and pinned against DNS rebinding;
  - no redirects;
  - 16 KB and 2.5 seconds at most;
  - a per-address fetch budget.

  A refusal never echoes the document. `/register` keeps working. See
  docs/REMOTE_HOSTING.md, "Client ID Metadata Documents".

- `MCP_MAX_INFLIGHT_PER_USER`, `MCP_MAX_INFLIGHT_PER_CLIENT`,
  `MCP_MAX_INFLIGHT` and `MCP_REQUEST_TIMEOUT_MS` (#41). The first three take
  1 to 64, 1 to 64 and 1 to 1024 (a per-client cap above the per-user cap, or a
  per-user cap above the process cap, refuses to start), and the timeout takes
  5000 to 300000 ms.
- The server reports a short description in `serverInfo`, and marks its
  `tools/list` result private with a TTL of 0 for 2026-07-28 clients, because
  the tool list depends on the caller's read-only state (#41).
- `AUTH_MODE` (required), `MCP_BIND_HOST` and `MCP_ALLOW_ANONYMOUS_FALLBACK`
  (#56); see Breaking.
- `RATE_LIMIT_MAX_WAIT_MS` (0 to 60000, default 2000): how long a call may wait
  for a YNAB rate-limit token (#58). `ynab_rate_limit_status` gains a `usage`
  block (`requests_last_hour`, `rejected_last_hour`, `max_wait_ms`), the
  circuit-breaker state under `upstream`, and the cache size.
- A per-user circuit breaker for YNAB (#58). After 20 consecutive 5xx
  responses or timeouts within 60 seconds, requests fail at once for 30
  seconds with `upstream_unavailable` and `retry_after_seconds`; then one probe
  goes through.
- `MCP_VERIFIED_REDIRECT_URIS`, `MCP_DCR_PRIVATE_USE_SCHEMES` and
  `MCP_TRUST_LOOPBACK_REDIRECTS` (#55). By default Claude's two callbacks are
  verified, no private-use scheme is accepted, and loopback redirects are
  trusted. See "Using other MCP clients" in docs/REMOTE_HOSTING.md.
- `TRUST_CF_CONNECTING_IP` (default `false`, separate from `TRUST_PROXY`),
  `REGISTER_RATE_LIMIT_PER_IP` and `REGISTER_RATE_LIMIT_PER_HOST` (#59).
- `SECURITY_CONTACT` and `SECURITY_POLICY_URL` enable
  `/.well-known/security.txt` (RFC 9116, #65). It is not served (404) while
  `SECURITY_CONTACT` is unset.

### Fixed

- Replicas sharing one database no longer race to refresh a user's YNAB token
  (#48). Before, both could spend the same refresh token, and the user had to
  reconnect. One replica now claims a lease on the user row and refreshes
  without holding a database connection during the YNAB call. It stores the
  new YNAB access token, encrypted and bound to its own column, so the others
  use it instead of calling YNAB. A replica that loses the claim waits up to 15
  seconds, then fails the request instead of refreshing. A lease whose holder
  crashed expires after 45 seconds. When YNAB answers 401 to a call (a token
  revoked early), the stored access token is dropped for every replica and
  the next call refreshes; the call itself is not retried. The rekey job also
  re-encrypts the stored access token, and its log line counts it. This needs
  schema 6: five nullable columns on `users`, added on startup. Rolling back
  after schema 6 means restoring the backup taken before the upgrade.
- Per-budget caches are keyed by the budget's UUID, never by the `last-used`
  or `default` alias (#66). A `budget_id` of `last-used` (or the default when
  `YNAB_BUDGET_ID` is unset) is resolved to the budget's UUID with one request
  per user, reused by reads for 5 minutes, so a change of last-used budget in
  YNAB is picked up within 5 minutes for reads. Writes always resolve fresh, and
  a write invalidates exactly the entries a read created. The budget-settings cache now has the same generation guard as the
  other caches.
- The release workflow's MCP Registry job waits up to 10 minutes for npm to
  serve the new version before it publishes `server.json`, and retries the
  publish twice on the registry's "version not found" error, so a release no
  longer needs a manual re-run when npm is slow (#121).
- Creating or updating a category target with a frequency (`goal_frequency`)
  works through the `ynab` SDK, with no direct-API workaround (#22, #44).
- Completing a sign-in is one transaction (#94): the user's stored YNAB
  token and the authorization code are written together or not at all. A
  failed or late sign-in no longer replaces the user's stored YNAB refresh
  token, and the retention sweep can no longer remove the client between the
  callback's last check and the code being saved.

## [0.4.3] - 2026-11-23

Dependency security fixes for the 0.4 line. The server's code and tools are
unchanged from 0.4.2, so there are no breaking changes.

### Security

- `hono` 4.13.14 → 4.13.21 and `@hono/node-server` 2.1.5 → 2.1.11. Both come
  in through `@modelcontextprotocol/sdk`, whose HTTP transport uses
  `@hono/node-server` to turn Node requests into web requests. The updates fix
  GHSA-jpvv-r467-5p4w and GHSA-qv5m-9pm6-hqp3 in `@hono/node-server`, and
  GHSA-46wx-v44x-9hh2, GHSA-4m76-xfj5-7975, GHSA-3gg2-335m-rxc6,
  GHSA-4h7h-rv7c-7m2v and GHSA-h7mg-cq63-vhpq in `hono`. As far as we can
  tell, ynab-mcp 0.4.2 doesn't reach any of them: the SDK doesn't route or
  authorize by request path, and nothing uses hono's `csrf()`, `mount()`,
  `validator('form')`, `css` helper, RegExpRouter or WebSocket upgrades.
- The Docker image is the artifact that carried the old versions, because it
  installs from the lockfile. npm installs (`npx ynab-mcp`) already resolved
  the fixed versions, since the SDK's version ranges allow them.
- The Docker image's `node:24-alpine3.24` base is updated to the current
  digest.

## [0.4.2] - 2026-11-04

A documentation site and dependency updates. The server's code and tools are
unchanged from 0.4.1, so there are no breaking changes.

### Added

- **Documentation site** at <https://auzroz.github.io/ynab-mcp/>: installation
  for each client, example conversations, self-hosting, security, and a tool
  reference generated from the built server's tool definitions.
  `scripts/build-site.mjs` builds it and fails on a broken internal link or
  fragment, or on anything loaded from another origin.
  `.github/workflows/pages.yml` deploys it from `main`. The README links to it.

### Security

- `express-rate-limit` 8.5.2 → 8.7.2. It rate-limits the YNAB OAuth routes in
  HTTP mode. 8.7.2 fixes GHSA-j3cq-92fq-qg5f, which only applies with
  `skipFailedRequests` or `skipSuccessfulRequests`; ynab-mcp sets neither, so
  it wasn't affected.
- Development only: an npm override pins `minimatch` to `^11.0.1` for
  GHSA-g3hv-75wg-m249, because ESLint and typescript-eslint still require
  minimatch 10. minimatch isn't in the published package or the Docker image.
  ESLint is also updated to 10.14.0.

### Changed

- The README lists `ALLOWED_HOSTS` and `ALLOWED_ORIGINS` separately, each with
  its default. An explicit `ALLOWED_HOSTS` replaces the default list, and
  requests with no `Origin` header aren't checked against `ALLOWED_ORIGINS`.
- `CONTRIBUTING.md` describes how milestones track planned releases and links
  the roadmap board.

## [0.4.1] - 2026-10-30

Closes the API coverage gaps left after 0.4.0: split transactions, clearing
fields, decoded target details, a move-money tool, YNAB 429 handling and delta
sync for list reads. All output changes only add fields, so there are no
breaking changes.

### Added

- Transactions:
  - **Split transactions on create.** `subtransactions[]` on
    `ynab_create_transaction` and on each item of `ynab_create_transactions`.
    The split amounts must sum exactly to the parent, and the parent can't also
    set a category.
  - **Clearing fields on update.** `category_id`, `payee_id` and `memo` accept
    `null` on the single and bulk updates, which is different from leaving them
    out.
  - **`import_id`.** Create accepts it, and a repeat returns
    `duplicate_import_ids` instead of failing. Bulk update items can be
    addressed by `id` or `import_id`.
  - **`type` filter** (`unapproved`, `uncategorized`) on the account, category
    and payee transaction lists.
  - **IDs for chaining calls** on every transaction list and get, and on
    scheduled transactions: account, payee, category, transfer and matched IDs,
    `import_id` and `debt_transaction_type`, with IDs on splits.
  - `flag_name` next to `flag_color`, and `total_count` / `truncated` on capped
    lists.
- Categories:
  - **A decoded `goal` object** on `ynab_get_category`,
    `ynab_get_month_category` and `ynab_list_categories`. It covers type,
    target, period (from `goal_cadence` and `goal_cadence_frequency`), due day,
    snoozed, created month, and the funded, left and under-funded amounts.
  - **`ynab_move_money`** (69 tools in total). It moves budgeted money between
    two categories in one month, using two month-category updates. It checks
    the result of each update by re-reading the category. If the second update
    fails, it restores the first only when that category is unchanged since the
    move; otherwise it reports what needs a manual check. It creates no YNAB
    money-movement record, because the API has no money-movement write.
- Accounts and budgets:
  - Accounts: `on_budget`, `closed`, `note`, `last_reconciled_at`, direct-import
    status, `transfer_payee_id` and debt details. Interest rates come with
    percent strings, because YNAB reports 18990 for 18.99%.
  - Budgets: `first_month`, `last_month` and `date_format`.
- Money movements: raw milliunit amounts, a masked `performed_by_user_id`, and
  an optional `group_by_group` on `ynab_list_money_movements`.
- **Delta sync for list reads** (accounts, categories, months, payees, scheduled
  transactions and every transaction list).
  - **How it works:** each read keeps a merged full copy per budget, endpoint
    and query. After the cache expires, the next read fetches only YNAB's
    changes (`last_knowledge_of_server`) and merges them in, so tools still
    receive complete data. Anything inconsistent falls back to a full fetch.
  - **Limits:** 32 copies and 20,000 entities per user.
  - **Cursor:** every list tool returns `server_knowledge` and accepts an
    optional `since_server_knowledge`, which returns only the changes, marked
    `delta: true`, with deleted ids and no totals.
  - **What it saves:** payload size rather than request count.
  - **Not covered:** budget aliases (`last-used`, `default`), so set
    `YNAB_BUDGET_ID` to benefit, and `ynab_get_budget`, which still always
    fetches in full.
- Tool descriptions say what YNAB only allows in its app: some target settings,
  hiding or reordering categories, editing or closing accounts, merging
  payees, and managing plans.
- `CONTRIBUTING.md`, `SECURITY.md` (private vulnerability reporting) and a
  pull request template.

### Security

- The YNAB OAuth routes (`/oauth/ynab/start`, `/oauth/ynab/callback`,
  `/oauth/cancel`) are rate-limited to 100 requests per 15 minutes per client
  IP, the same as the SDK's `/authorize`. Before, they had no limit, though the
  callback reads storage and can call YNAB's token endpoint.
  - **Behind a reverse proxy, set `TRUST_PROXY`** to the proxy hop count (for
    example `1` behind Caddy). Otherwise every client appears to come from the
    proxy and shares one limit, so one client could lock everyone out of
    signing in for up to 15 minutes. The same applies to the SDK's own OAuth
    endpoints. The Docker Compose example in `docs/REMOTE_HOSTING.md` now sets
    it.
- Configuration errors no longer quote the rejected value, so a secret pasted
  into the wrong variable can't reach the startup log. Startup and shutdown
  logs also remove the values of `YNAB_ACCESS_TOKEN`,
  `YNAB_OAUTH_CLIENT_SECRET`, `ENCRYPTION_KEY` and `DATABASE_URL` if they
  appear in an error message.

### Changed

- When YNAB answers 429, the local rate limiter pauses requests until YNAB's
  window resets (from `Retry-After`, or the rolling hour), instead of sending
  requests it knows will fail. The error includes `retry_after_seconds`, and
  `ynab_rate_limit_status` reports the pause.
- `npm run dev` loads `.env` when the file exists.

### Fixed

- The money-movement group cache is cleared after a budget assignment, also
  through `last-used` or `default`, and a read in flight during the assignment
  can't cache stale groups.
- `import_id` values in output are sanitized, and an empty `import_id` is
  rejected.
- The bulk-create audit entry records how many transactions it created.

## [0.4.0] - 2026-10-30

Platform release: a Node 22.14+ toolchain (zod 4, TypeScript 6, ESLint 10,
vitest 5), MCP tool annotations and read-only tool filtering, recurring
category targets, and a hardened HTTP/OAuth mode for self-hosted multi-user
instances. Read **Breaking** and **Upgrading** before you upgrade an HTTP
deployment.

### Breaking

- **Node 22.14.0 or later is required** (was `>=20.0.0`). `better-sqlite3` 13
  needs Node-API 10. The Docker image runs Node 24.
- **The bin and `serverInfo.name` are `ynab-mcp`** (were `ynab-mcp-server`, the
  name of an unrelated npm package). The `ynab-mcp-server` bin remains as an
  alias for this release only; `npx -y ynab-mcp` is unchanged.
- **Read-only servers and sessions list only read tools** in `tools/list`.
  Write tools called by name still return the `read_only_mode` error.
- **Update tools are marked destructive** (`destructiveHint: true`), as are the
  two delete tools. Clients that auto-approve non-destructive writes will now
  ask before running `ynab_update_*`.
- **Validation errors are generic per issue code** and never echo input values;
  messages written in this server's own schemas still come through.
- **Free-text limits follow YNAB's spec:** memo 500, payee name 200, import ID
  36, category group name 50; category and account names 200 (category names
  were 500, account names 100).
- `ynab-monthly-review` with a malformed `month` returns InvalidParams instead
  of ignoring it.
- HTTP mode:
  - **Host and Origin validation are on by default.** A proxy that rewrites
    Host, or a hostname other than `PUBLIC_URL`'s, gets 403 until the host is
    forwarded or added to `ALLOWED_HOSTS`. `ENABLE_DNS_REBINDING_PROTECTION=false`
    is the documented, unsafe opt-out.
  - **`PUBLIC_URL` is validated at startup:** an absolute https URL (http only
    on loopback), with no fragment.
  - **An unknown, expired or closed `Mcp-Session-Id` gets 404** (was 400), as
    the MCP spec requires, so clients re-initialize. A request with no session
    ID that isn't an initialize still gets 400.
  - **Session limits are enforced:** `MCP_MAX_SESSIONS` (default 100; at the cap
    `initialize` gets 503 with `Retry-After`), the new
    `MCP_MAX_SESSIONS_PER_USER` (default 10 or `MCP_MAX_SESSIONS` if smaller;
    past it the user's least recently used session is closed), and
    `MCP_SESSION_IDLE_TIMEOUT_MS` (default 30 minutes).
  - **Protected-resource metadata moved** to the RFC 9728 path
    `/.well-known/oauth-protected-resource/mcp` (the root path stays as an
    alias), and 401s from `/mcp` carry `resource_metadata`.
- OAuth mode:
  - **Tokens issued before 0.4.0 are treated as read-only** (they have no
    recorded access level). Users who had read-write access must reconnect once.
    An authorization in progress during the upgrade has to be restarted.
  - A `resource` other than this server gets `invalid_target`; a refresh that
    widens scope gets `invalid_scope`. Changing `MCP_RESOURCE_URL` or
    `PUBLIC_URL` makes users reconnect.

### Added

- Every tool has a `title` and explicit MCP annotations (`readOnlyHint`,
  `destructiveHint`, `idempotentHint`, `openWorldHint`); prompts have titles.
- `ynab_update_category_details`: rename, note, move to another group, and set
  or clear targets.
- Recurring targets: `goal_frequency` (monthly, weekly, yearly) on
  `ynab_create_category` and `ynab_update_category_details`, with
  `goal_target`, `goal_target_date` and `goal_needs_whole_amount`. The ynab SDK
  4.5 drops `goal_frequency`, so those calls go to the YNAB API directly until
  the SDK supports it (ynab/ynab-sdk-js#308).
- A `month` input (`YYYY-MM-01` or `current`) on `ynab_list_transactions` and
  `ynab_list_money_movements`, and a new `ynab_list_money_movement_groups`.
- `"default"` is accepted as a budget ID alongside `"last-used"`.
- HTTP/OAuth mode:
  - RFC 8707 resource binding from `/authorize` through `/mcp`, RFC 9207 `iss`
    on every authorization redirect, RFC 9728 protected-resource metadata.
  - `MCP_RESOURCE_URL` (default `PUBLIC_URL` + `/mcp`).
  - Per-user state: all sessions of one user share one rate limiter, cache and
    audit log (never shared between users), so reconnecting or a second client
    no longer gets a second 180/h budget.
  - The YNAB access token is resolved per request, so sessions survive YNAB's
    ~2h token expiry and a revoked grant takes effect on the next call.
  - Refresh-token rotation with reuse detection (RFC 9700): every token from
    one authorization belongs to a family, and replaying a spent refresh token
    revokes the whole family. Revoking a refresh token through `/revoke` revokes
    its family too. Two refreshes racing with the same token count as reuse,
    which is the RFC 9700 behaviour.

### Fixed

- Security: the OAuth consent page could be skipped by a crafted
  `/oauth/ynab/start` link (confused deputy). Each pending authorization is now
  bound to the browser that saw the consent page with an HttpOnly cookie
  (`__Host-` prefixed and `Secure` over https; unprefixed on a loopback http
  `PUBLIC_URL`).
- Security: write access came from the user's latest consent rather than the
  token's own grant; the access level is now stored per code and token.
- Security: MCP sessions are bound to the client, user and access level that
  created them (OAuth mode) or to the YNAB token (header mode); any other caller
  sees an unknown session.
- Internal category detection uses YNAB's `internal` flag instead of matching
  the "Internal Master Category" name.
- The cash-flow forecast reports the correct lowest projected balance and date.
- `ynab_get_budget` always fetches the full budget. A second call in a session
  used to send its delta cursor and compute net worth and the account and
  category summaries from the changed entities only. Delta-sync cursors are
  also keyed by budget, endpoint and query, so one endpoint's cursor is never
  sent to another.
- `ynab_goal_progress` derives each target's period from `goal_cadence` and
  `goal_cadence_frequency`, so weekly, yearly and every-N-months targets are no
  longer reported as monthly. Each goal reports `period` and
  `monthly_equivalent`. Snoozed targets are flagged (`snoozed`), left out of the
  underfunded totals and the overall status, and can be listed with
  `filter: "snoozed"`.

### Changed

- zod 4.6, TypeScript 6.0, ESLint 10, vitest 5, `better-sqlite3` 13 (optional),
  `@types/node` 22. CI tests on Node 24 and 22.14.0, runs the SQLite and
  Postgres storage suites for real, and the dependency audit is blocking.
- Docker image: `node:24-alpine3.24`, pinned by digest.
- The release workflow publishes through npm trusted publishing only (no token)
  and has an opt-in MCP Registry publish job.
- Removed the unused `YnabClient.importTransactions` method; the deprecated
  `ynab_import_transactions` tool is unchanged.

### Upgrading (HTTP mode)

- Back up the SQLite file or `pg_dump` first. Startup adds nullable columns
  (`resource`, `granted_scope`, `browser_binding`, `family_id`) and a
  `consumed_refresh_tokens` table.
- Set `PUBLIC_URL` to the exact public URL; have the proxy forward the original
  Host header and pass `Cookie`/`Set-Cookie` through on `/authorize` and
  `/oauth/*`.
- Ask read-write users to reconnect once.
- Review `MCP_MAX_SESSIONS`, `MCP_MAX_SESSIONS_PER_USER` and
  `MCP_SESSION_IDLE_TIMEOUT_MS`; they are now enforced.

## [0.3.5] - 2026-10-30

Republishes 0.3.4 to npm. The 0.3.4 npm publish failed because the release
workflow's npm token had expired, so `ynab-mcp@0.3.4` never reached npm (its
Docker image did). The code is identical to 0.3.4; use 0.3.5.

### Changed

- The release workflow publishes to npm through npm trusted publishing (OIDC)
  instead of a long-lived token. The publish job runs on Node 24 for npm 11;
  the package still supports Node 20.

## [0.3.4] - 2026-10-29

> Note: published to ghcr.io only. The npm publish failed; install 0.3.5 instead.


Hotfix release. It keeps Node 20 support (`engines` stays `>=20.0.0`) and stays
on zod 3.x and MCP SDK 1.x. Upgrading from 0.2.0-0.3.3 is recommended: fresh
installs of those versions resolve `ynab` 4.5.0, which breaks the type filter in
`ynab_list_transactions`.

### Security

- Upgraded `@modelcontextprotocol/sdk` to `^1.32.2`, which fixes six advisories
  in the SDK. They include bearer auth accepting tokens issued for another
  service, missing body-size and batch limits on the HTTP transport, and memory
  exhaustion from a single request.
- Upgraded `express` to `^5.3.0` and refreshed transitive dependencies with a
  non-force `npm audit fix`. This fixes `proxy-addr` (critical, IP spoofing on
  the `trust proxy` path), `ip-address`, `hono`, `qs`, `body-parser` and
  `fast-uri`.
- Moving to vitest 4 clears every advisory in the dev-dependency chain.
- One advisory remains: zod GHSA-mrhx-c7xc-m3w5, which has no 3.x fix. zod 4
  arrives in 0.4.0. Until then, a guard on `tools/call` rejects arguments over
  1 MiB, nested deeper than 8 levels, or holding an array of more than 1000
  items, before zod parses them.
- HTTP transport: the JSON body limit drops from 4 MB to 512 KB. JSON-RPC batch
  arrays are rejected with 400 and code -32600, since MCP 2025-06-18 removed
  batching. Oversized bodies return 413, and malformed JSON returns 400 with
  code -32700. Error responses carry no internal details.
- Added length caps to free-text inputs that had none: `payee_name` 200,
  `import_id` 36, `budget_id` 64, and `memo` 500 on `ynab_update_transactions`.
  Existing memo caps of 200 are unchanged.
- GitHub Actions are pinned by commit SHA to their latest major versions, moving
  off the removed `node20` action runtime. Checkout steps set
  `persist-credentials: false`.
- Added Dependabot for npm, GitHub Actions and Docker, and a non-blocking
  `npm audit --omit=dev --audit-level=high` CI step. The audit step becomes
  blocking in 0.4.0.

### Fixed

- `ynab_list_transactions` with a `type` filter (`unapproved` or
  `uncategorized`) works again with `ynab` 4.5.0, which inserted a new
  `untilDate` argument. `ynab` is now pinned to `~4.5.0`.
- `ynab_transaction_search` with only `until_date` takes `since_date` from the
  budget's first month, instead of searching only the last 12 months (the
  default since YNAB API 1.85).
- Category goal output reads `goal_target_date` first and falls back to the
  deprecated `goal_target_month`. This affects `ynab_goal_progress`,
  `ynab_get_category` and `ynab_get_month_category`.
- Install docs and the GitHub release notes template now use the published
  package name, `ynab-mcp` (`npx -y ynab-mcp`). They used to point at
  `ynab-mcp-server`, an unrelated npm package.
- The Docker image moves off the frozen `node:20-alpine3.21` base (Alpine 3.21
  reaches end of life on 2026-11-01) to `node:20-alpine3.23`, pinned by digest,
  and prunes with `npm prune --omit=dev`.

### Changed

- The transaction listing tools say that YNAB returns only the last 12 months
  when `since_date` is omitted.
- `server.json` follows the MCP Registry 2025-12-11 schema.
- Dev tooling: `vitest` and `@vitest/coverage-v8` are on `^4.1.12`. The branch
  coverage threshold drops to 75% (from 80%), because vitest 4's AST-aware
  remapping counts branches differently on the same tests.

### Deprecated

- `ynab_import_transactions`. Since API 1.88, YNAB imports linked-account
  transactions automatically and this endpoint imports nothing. The tool stays
  registered and returns `deprecated: true` without calling the API, so it also
  works in read-only mode.
- `goal.target_month` in the output of `ynab_get_category` and
  `ynab_get_month_category`. Use `goal.target_date`; `target_month` remains as
  an alias with the same value.

### Added

- `until_date` input (inclusive) on `ynab_list_transactions`,
  `ynab_list_account_transactions`, `ynab_list_category_transactions` and
  `ynab_list_payee_transactions`.
- `goal.target_date` in the output of `ynab_get_category` and
  `ynab_get_month_category`.
- A release workflow check that fails when `server.json` doesn't match the
  pushed tag, a unit test that keeps `server.json` in sync with `package.json`,
  and the Docker label `io.modelcontextprotocol.server.name`.

## [0.3.3] - 2026-07-03

### Added

- **MCP Prompts.** The server now exposes 7 guided-workflow prompts
  (`ynab-pulse-check`, `ynab-monthly-review`, `ynab-assign-money`,
  `ynab-true-expenses`, `ynab-overspending-triage`, `ynab-age-of-money`,
  `ynab-reconcile-cleanup`), grounded in YNAB's own budgeting methodology (the
  Four Rules, Age of Money, True Expenses). Available to any MCP client that
  supports the `prompts` capability, automatically, with no extra install step.
- **`skills/` — a standalone, distributable YNAB best-practices skill
  library.** 15 Claude Agent Skills covering both live-budget workflows
  (mirroring the 7 prompts above) and general budgeting/YNAB philosophy
  coaching (getting started, debt payoff, irregular income, windfalls,
  emergency funds, big goals, income-change prep) that work standalone, with
  or without this MCP server connected. Packaged as downloadable zips on each
  GitHub Release.

### Security

- Added `gitleaks` as a required CI check on every PR, scanning for
  accidentally-committed secrets.

## [0.3.2] - 2026-07-02

> Note: `0.3.1` was tagged and published to npm from a commit that skipped code
> review and was later reverted from `main`. `0.3.2` ships the same fix through
> normal review and supersedes it.

### Fixed

- HTTP mode: `express-rate-limit` logged an `ERR_ERL_UNEXPECTED_X_FORWARDED_FOR`
  validation error on every request when deployed behind a reverse proxy, because
  Express's `trust proxy` setting was left at its default (`false`) while the proxy
  set `X-Forwarded-For`. Added a `TRUST_PROXY` env var (default `0`, i.e. trust
  none) to set Express's `trust proxy` explicitly, so rate limiting keys correctly
  off the real client IP when deployed behind a known number of proxy hops.

## [0.3.1] - 2026-07-02

Superseded by 0.3.2; use 0.3.2 or later. Tagged and published from a commit that
skipped review and was later reverted. The code is identical to 0.3.2.

## [0.3.0] - 2026-07-01

### Added

- **Remote HTTP transport.** `MCP_TRANSPORT=http` runs the server over the MCP
  Streamable HTTP transport (`POST /mcp`) with a plain `GET /health`. Each session
  gets an isolated client / cache / rate limiter / audit log. stdio remains the
  default and is unchanged.
- **Multi-user YNAB OAuth.** When the YNAB OAuth app credentials + `ENCRYPTION_KEY`
  + `PUBLIC_URL` are configured, the server acts as an OAuth 2.1 Authorization
  Server (Dynamic Client Registration + PKCE) federated to YNAB. Each user connects
  their own YNAB account; identity is their YNAB user id. Users choose read-only vs
  read-write at a consent screen. YNAB refresh tokens are encrypted at rest
  (AES-256-GCM) and rotated on refresh.
- **Pluggable storage** for users + tokens: `memory` (default), `sqlite`
  (`better-sqlite3`), or `postgres` (`pg`); the durable drivers are optional
  dependencies loaded on demand.
- Interim header auth for HTTP mode (`X-YNAB-Token`) to run single-user remote
  before configuring OAuth.
- `docs/REMOTE_HOSTING.md` with deployer setup (registering a YNAB OAuth app, env,
  TLS), and DNS-rebinding/Origin protections for the HTTP transport.

### Changed

- Internal: `createServer` generalized into `buildYnabClient` / `createServerForUser`
  (per-user context); the audit log is now an injected instance (per user) rather
  than a process-global singleton.

## [0.2.0] - 2026-06-30

### Added

- New write tools unlocked by the YNAB SDK v4 surface:
  - `ynab_update_payee` — rename a payee (closes a real API coverage gap)
  - `ynab_create_payee` — create a payee
  - `ynab_create_category` — create a category within a group
  - `ynab_create_category_group` — create a category group
  - `ynab_update_category_group` — rename a category group
  - `ynab_update_transactions` — bulk update transactions (up to 100)
- New read tool `ynab_list_money_movements` for category-to-category fund moves
  (a YNAB API v1.83 / SDK v4 resource).

### Changed

- Upgraded the `ynab` SDK from `^2.10.0` to `^4.4.0`. This is an internal-only
  migration (`api.budgets` → `api.plans`, `Budget*` response types → `Plan*`); the
  MCP tool names, parameters, and output shapes are unchanged, so existing clients
  are unaffected.
- Upgraded `@modelcontextprotocol/sdk` from `^1.25.3` to `^1.29.0`, resolving a
  HIGH-severity cross-client data-leak advisory.
- `ynab_create_account` now offers only the account types the YNAB API actually
  supports creating (`checking`, `savings`, `cash`, `creditCard`, `otherAsset`,
  `otherLiability`); previously-offered loan/mortgage types always failed at the API.

### Fixed

- The server now reports its real version to MCP clients (was hardcoded to `0.1.0`;
  now read from `package.json`).
- Re-enabled the test coverage gate: the Vitest threshold config used the pre-1.0
  `thresholds.global.*` shape, which Vitest 1.x silently ignored. Thresholds are now
  enforced as a floor.
- Corrected `README.md` tool counts and listings (now 66 tools: 40 core API,
  23 analytics, 3 system), including previously omitted scheduled-transaction and
  analytics tools.
- Replaced the stale, partly-fictional `tools` list in `server.json` with the actual
  registered tool names and added a `version` field.
