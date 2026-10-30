# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
