# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.4] - 2026-10-29

Hotfix release. It keeps Node 20 support (`engines` remains `>=20.0.0`) and the
zod 3.x and MCP SDK 1.x lines. Upgrading from 0.3.3 is recommended, mainly
because 0.3.x installs resolved `ynab` 4.5.0, which broke the transaction type
filter in `ynab_list_transactions`.

### Security

- Dev-dependency vulnerabilities in the old vitest chain (3 critical, 2 high,
  2 moderate) are resolved by moving to vitest 4. Only the zod advisory
  GHSA-mrhx-c7xc-m3w5 remains, and zod stays on 3.x because it has no 3.x fix.
  Mitigation: a pre-parse guard on `tools/call` rejects oversized (about 1 MB),
  over-deep (depth 8), or over-long (1000 items) arguments before zod runs.
- Added length caps to free-text inputs: `payee_name` 200, `import_id` 36,
  `memo` 500 (200 in create tools), `budget_id` 64.
- Added a non-blocking `npm audit --omit=dev --audit-level=high` CI job. It is
  planned to become blocking in 0.4.0.
- CI and release workflows are pinned by full commit SHA to the latest major
  versions, moving off the removed `node20` action runtime. Checkout steps now
  set `persist-credentials: false`.
- Dependabot (`.github/dependabot.yml`) checks npm, GitHub Actions, and Docker
  weekly. Minor and patch updates are grouped. Major updates are ignored for
  zod, the MCP SDK, TypeScript, vitest, ESLint, `@eslint/js`, better-sqlite3,
  and `@types/node`, and all `ynab` updates are ignored.

### Fixed

- `ynab_transaction_search` with only `until_date` now derives `since_date` from
  the budget's first month instead of searching only the last year.
- `goal_target_date` is read first, with a fallback to the deprecated
  `goal_target_month`, in `ynab_goal_progress`, `ynab_get_category`, and
  `ynab_get_month_category`.
- The HTTP transport error handler logs a sanitized `[HttpError]` line to stderr
  for 500 and generic 4xx errors. Responses remain generic.
- Install docs and the GitHub release body use the published package name
  `ynab-mcp` (`npx -y ynab-mcp`, `npm install -g ynab-mcp@<version>`, Claude
  Desktop args `["-y", "ynab-mcp"]`). They previously referenced the unrelated
  `ynab-mcp-server` package.
- `server.json` is rewritten to the MCP Registry 2025-12-11 schema. The name is
  `io.github.auzroz/ynab-mcp`, packages use `registryType`/`identifier`/`transport`
  fields, env vars use `isRequired`/`isSecret`, and the npm and OCI packages are
  pinned to the release version.
- The Docker image moves off the frozen `node:20-alpine3.21` base (Alpine EOL
  2026-11-01) to `node:20-alpine3.23`, pinned by multi-arch digest. The Dockerfile
  uses `npm prune --omit=dev`.

### Changed

- Upgraded `@modelcontextprotocol/sdk` to `^1.32.2` and `express` to `^5.3.0`
  through a non-force `npm audit fix`.
- Upgraded the `ynab` SDK to `~4.5.0`. `YnabClient.getTransactions` accepts an
  optional `untilDate`. Its positional argument order is now
  `since, until, type, knowledge`.
- Upgraded the dev tooling `vitest` and `@vitest/coverage-v8` to `^4.1.12`.
  Coverage now counts all of `src/**/*.ts`. The branch threshold is 75 (was 80)
  because v4 counts branches more strictly.
- Transaction listing tools document that YNAB returns only the last 12 months
  when `since_date` is omitted.
### Deprecated

- `ynab_import_transactions` is deprecated. YNAB API 1.88 no longer performs
  file-based imports. The tool returns `deprecated: true` and stays registered.
- `goal.target_month` in category outputs (`ynab_get_category` and
  `ynab_get_month_category`). Use `goal.target_date`. `target_month` remains
  as a backward-compatible alias with the same value.

### Added

- `until_date` input on `ynab_list_transactions`, `ynab_list_account_transactions`,
  `ynab_list_category_transactions`, and `ynab_list_payee_transactions`. The
  upper bound is inclusive. Use ISO dates, with today or yesterday recommended.
- `target_date` field in the goal output of `ynab_get_category` and
  `ynab_get_month_category`.
- A unit test that keeps `server.json` in sync with `package.json` (version,
  `mcpName`, npm identifier, and OCI tag).
- A release workflow step that fails when the `server.json` version or the
  package versions differ from the pushed tag.
- A Dockerfile label `io.modelcontextprotocol.server.name` that matches
  `package.json` `mcpName`.

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
> review and was later reverted from `main`. `0.3.2` has identical code and
> supersedes it; use `0.3.2` or later.

## [0.3.1] - 2026-07-02

Superseded by 0.3.2. This version was tagged and published from a commit that
skipped review and was later reverted. Its code is identical to 0.3.2. Use 0.3.2
or later.

### Fixed

- HTTP mode: `express-rate-limit` logged an `ERR_ERL_UNEXPECTED_X_FORWARDED_FOR`
  validation error on every request when deployed behind a reverse proxy, because
  Express's `trust proxy` setting was left at its default (`false`) while the proxy
  set `X-Forwarded-For`. Added a `TRUST_PROXY` env var (default `0`, i.e. trust
  none) to set Express's `trust proxy` explicitly, so rate limiting keys correctly
  off the real client IP when deployed behind a known number of proxy hops.

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
