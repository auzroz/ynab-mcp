# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0]

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

## [0.2.0]

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
