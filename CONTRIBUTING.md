# Contributing to YNAB MCP Server

Thanks for your interest in improving this project. Bug reports, fixes, new tools, docs and skills are all welcome. This guide covers how to set up, the standards a change has to meet, and how a pull request gets reviewed and released.

The server is built to be self-hosted: by one person, or by a household or small team sharing one instance. Changes should keep both cases working: stdio for a single user, and HTTP with OAuth for several users with isolated state.

## Ways to contribute

- **Report a bug.** Open an issue with the version (the `serverInfo` version your MCP client shows, the npm version you installed, or the Docker image tag), the transport (stdio or HTTP), what you did, what you expected and what happened. Remove tokens, budget names, payees and amounts from logs before you paste them.
- **Suggest a feature.** Open an issue describing the use case first, especially for new tools, so we can agree on the shape before you write code. Check what the YNAB API supports: some things can only be done in the YNAB app, and tools can't add them.
- **Fix something.** Issues labelled `good first issue` or `help wanted` are a good start. Comment on the issue so work isn't duplicated.
- **Improve docs or skills.** README, `docs/` and the skills under `skills/` all take pull requests.
- **Security issues:** please don't open a public issue. See [Reporting security issues](#reporting-security-issues).

## Development setup

**Requirements:**
- Node.js 22.14.0 or later. CI tests on Node 24 and 22.14.0, and `better-sqlite3` 13 needs Node-API 10.
- npm.
- A YNAB account if you want to try changes against the real API.

```bash
git clone https://github.com/<you>/ynab-mcp.git
cd ynab-mcp
npm ci
cp .env.example .env          # then set YNAB_ACCESS_TOKEN
npm run build
```

`npm run dev` loads `.env` if it exists. Everywhere else, Node doesn't load it on its own, and the server reads only real environment variables. Pass the file, as in `node --env-file=.env dist/index.js`, or export the variables in your shell. For MCP Inspector, pass them with `-e YNAB_ACCESS_TOKEN=...`.

`better-sqlite3` and `pg` are optional dependencies, used only by HTTP mode's OAuth storage. `npm ci` doesn't fail if `better-sqlite3`'s native build fails, so check it loads with `node -e "new (require('better-sqlite3'))(':memory:').close()"`.

Useful commands:

| Command | What it does |
|---|---|
| `npm run dev` | Run from source with reload (stdio), loading `.env` if present |
| `npm run build` | Compile to `dist/` |
| `npm test` | Run the test suite once |
| `npm test -- tests/unit/tools/payees/create-payee.test.ts` | Run one test file |
| `npm test -- -t "rejects an empty import_id"` | Run tests whose name matches |
| `npm run test:watch` | Re-run tests on change |
| `npm run test:coverage` | Tests with the coverage gate CI enforces |
| `npm run lint` / `npm run lint:fix` | ESLint |
| `npm run typecheck` | TypeScript, no output |
| `npx @modelcontextprotocol/inspector node dist/index.js` | Try tools interactively in MCP Inspector |

**Working against real data:**
- Create a [personal access token](https://app.ynab.com/settings/developer), and prefer a test budget over your real one.
- Leave `YNAB_READ_ONLY=true`, the default, unless you are testing a write tool.
- YNAB allows 200 requests per hour per token. The server budgets 180, so heavy manual testing can run out.
- Never commit `.env` or paste a token into an issue, PR, test or log.

**HTTP mode:** see [`docs/REMOTE_HOSTING.md`](docs/REMOTE_HOSTING.md). Header mode (`X-YNAB-Token`) is the quickest way to try HTTP locally. OAuth mode needs a YNAB OAuth application.

## Project layout

See [Architecture in the README](README.md#architecture). In short:
- `src/tools/<resource>/` has one file per tool.
- `src/services/ynab-client.ts` is the only place that calls the YNAB budget API. `src/auth/ynab-oauth.ts` separately handles YNAB's OAuth token endpoints.
- `src/auth/`, `src/storage/` and `src/http.ts` are the HTTP and OAuth mode.
- `tests/unit/` mirrors `src/`.

## Standards every change must meet

These are the rules reviewers check, and most of them have tests that enforce them.

### Money and data
- **Never use JavaScript floats for money.** YNAB amounts are integer milliunits ($10.00 = 10000). Do all arithmetic with `decimal.js`. Convert tool inputs, which are in dollars, with `toMilliunits`, and format outputs with `formatCurrency`.
- **Dates** are `YYYY-MM-DD`; month endpoints use the first of the month. Date math is in UTC.
- **Outputs only grow.** Add fields, never rename or remove existing ones; clients and prompts depend on them. A change that has to break output goes in a major or minor release with a CHANGELOG "Breaking" entry.

### Inputs
- **Validate every tool input with zod** before using it.
- **IDs** use `ynabId()`, and budget IDs use `budgetId()`, which also accepts `"last-used"` and `"default"`. Both are in `src/utils/schemas.ts`.
- **Every free-text input needs a `maxLength`**; a test fails otherwise. Use the caps in `src/utils/schemas.ts`, which follow YNAB's own limits where YNAB states one: `MEMO_MAX_LENGTH`, `TXN_PAYEE_NAME_MAX_LENGTH`, `PAYEE_NAME_MAX_LENGTH`, `IMPORT_ID_MAX_LENGTH`, `CATEGORY_GROUP_NAME_MAX_LENGTH` and so on. Keep the zod `.max()` and the JSON-schema `maxLength` in sync.

### Output, errors and secrets
- **Sanitize user strings in output** (names, memos, notes, flag names) with the helpers in `src/utils/sanitize.ts`.
- **Never log or return a token or secret.** Client-facing errors are generic and mapped (`src/utils/errors.ts`). Detailed errors go to the sanitized internal log only, and upstream error text never reaches the client.
- **Audit entries record which fields were present, never their contents.** For example `has_memo`, never the memo itself.

### Calling YNAB
- **All budget API requests go through `YnabClient`.** It acquires the rate limiter, applies the cache and delta sync, and maps errors.
- **Write methods call `assertWriteAllowed()` and write an audit entry.** A new write path must do both.
- **Check what the SDK actually sends.** The `ynab` SDK can drop fields it doesn't know. The pinned SDK 4.5 drops `goal_frequency`, so `YnabClient` sends those calls directly. If your change relies on a field reaching the API, add a test that inspects the outgoing request with a stubbed `fetch`. `tests/unit/services/ynab-client-transactions-wire.test.ts` shows the pattern.

### HTTP mode
- **Keep users isolated.** A user's sessions share one rate limiter, cache and audit log, which are never shared between users.
- **Keep sessions bound to their owner.** Don't introduce module-level state that would leak between users.

### Tests
- **Add tests with every change.** Coverage is gated at 80% lines, functions and statements, and 75% branches.
- **Tests use mocks, never the network or real tokens.** Mock the client, or stub `fetch` for wire-level tests.
- **A test should fail if the bug comes back.** For races and failure paths, check it actually fails against the old code.

### Style
- Match the surrounding code: naming, structure and comment density.
- Comments explain why, not what.
- ESLint must pass. The codebase isn't Prettier-formatted yet, so don't run `npm run format`: it rewrites all of `src/`. If you use Prettier, use your editor's format-selection on the lines you changed.

## Adding a tool

1. **Create the file:** `src/tools/<resource>/<action>-<thing>.ts`. Names are `ynab_<action>_<resource>`, such as `ynab_list_accounts`, `ynab_get_account` and `ynab_update_category`.
2. **Define the input** as a zod schema, plus the matching JSON schema for the tool definition.
3. **Write a description that says when to use the tool** (`Use when the user asks: ...`). If YNAB can't do part of what a user might ask, say so ("Not possible through the YNAB API ...").
4. **Add the tool's title and hints** to `src/tools/annotations.ts`; typecheck fails without them.
   - Reads are `READ`.
   - Writes are `CREATE`, `UPDATE`, `DELETE` or `MOVE`.
   - Update and delete tools are destructive, because YNAB has no undo.
   - A write tool's name must contain `_create_`, `_update_`, `_delete_` or `_move_`. `tests/unit/tools/annotations.test.ts` derives the expected hints from the name.
5. **Register the tool and its handler** in `src/tools/index.ts`. Read-only sessions hide write tools automatically, based on the annotations.
6. **Add tests** under `tests/unit/tools/<resource>/`.
7. **Update the tool count**, in `tests/unit/tools/annotations.test.ts` and in the README headings, and **add the tool to the README list**.

## Storage tests (SQLite and Postgres)

The OAuth storage drivers have one conformance suite that runs against memory, SQLite and Postgres.
- **Locally:** the Postgres part is skipped unless `DATABASE_URL` is set, and the SQLite part is skipped if `better-sqlite3` didn't build (see [Development setup](#development-setup)). Set `REQUIRE_DB_TESTS=1` to make a skip fail instead.
- **CI:** it runs with `REQUIRE_DB_TESTS=1`, so a missing driver or database fails the run instead of skipping.

If you touch `src/storage/` or `src/auth/`, run the full suite against a throwaway Postgres:

```bash
docker run --rm -d --name ynab-mcp-pg -p 127.0.0.1:5432:5432 \
  -e POSTGRES_USER=ynab -e POSTGRES_DB=ynab_test -e POSTGRES_HOST_AUTH_METHOD=trust \
  postgres:18-alpine
until docker exec ynab-mcp-pg pg_isready -U ynab -d ynab_test >/dev/null 2>&1; do sleep 1; done
DATABASE_URL=postgres://ynab@localhost:5432/ynab_test REQUIRE_DB_TESTS=1 npm test
docker stop ynab-mcp-pg
```

Schema changes must be additive and idempotent: nullable columns, `IF NOT EXISTS`. Existing 0.3.x databases have to keep working, and a test upgrades a 0.3.x schema in place.

## Commits and pull requests

**Branches.** Fork, then branch from `main`: `feature/<short-name>`, `fix/<short-name>` or `docs/<short-name>`. Open your PR against `main`. During a release cycle, a maintainer may retarget it to the active `release/x.y.z` branch.

**Commits** follow [Conventional Commits](https://www.conventionalcommits.org/):

```text
feat(transactions): split transactions on create
fix(client): invalidate money movement groups after the write
docs: describe delta sync
```

Common types are `feat`, `fix`, `docs`, `test`, `refactor`, `build`, `ci` and `chore`. The scope is the area touched.
- Keep each commit to one logical change.
- Explain *why* in the body when it isn't obvious.

**Pull requests** should be focused: one feature or fix per PR. The PR template asks for:
- **A summary** of what changed and why.
- **Breaking changes**, if any, for the CHANGELOG.
- **A test plan:** what you ran, and how you checked behaviour against YNAB if you did.

**Checks.** Every PR must pass these CI checks: Lint, Type Check, Test, Test (Node 22), Build, Docker Build, Gitleaks and Dependency Audit. Run `npm run typecheck && npm run lint && npm test` before pushing.

**Review.**
- **CodeRabbit** reviews PRs automatically. Address each finding, or reply on its thread explaining why you disagree. Its review allowance is limited, so push your fixes together instead of one commit per finding, and avoid re-requesting reviews.
- **The maintainer** reviews and merges. Expect questions on anything touching money, auth, storage or HTTP sessions.

**AI-assisted contributions** are welcome, and much of this codebase was written with AI help. The bar is the same either way: you are responsible for every line, you should understand it, and it has to meet the standards above. Mention significant AI assistance in the PR description.

## Releases

- **Versioning:** [Semantic Versioning](https://semver.org/). Breaking changes go in a minor release while the project is 0.x, with a "Breaking" section in the CHANGELOG.
- **CHANGELOG:** the maintainer writes `CHANGELOG.md` ([Keep a Changelog](https://keepachangelog.com/)) when preparing a release. Describe user-visible and breaking changes in your PR, and they'll be picked up.
- **Publishing:** the maintainer tags a release, and the release workflow publishes:
  - npm, through trusted publishing with provenance;
  - multi-arch images to `ghcr.io/auzroz/ynab-mcp`;
  - a GitHub release.

## Reporting security issues

See [SECURITY.md](SECURITY.md). In short: report vulnerabilities privately through [GitHub's private vulnerability reporting](https://github.com/auzroz/ynab-mcp/security/advisories/new) (the Security tab, then "Report a vulnerability"), not in a public issue.
- **Include:** the affected version, the transport and auth mode, and steps to reproduce.
- **Leave out:** a working exploit against someone else's instance.

Areas that matter most:
- token handling and encryption at rest;
- OAuth (consent, resource binding, refresh-token rotation);
- session isolation between users;
- read-only enforcement;
- anything that could leak budget data across users.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE), the same license as the project.
