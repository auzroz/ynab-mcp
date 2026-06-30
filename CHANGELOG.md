# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
