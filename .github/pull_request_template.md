## Summary

<!-- What changed and why. Link the issue if there is one (Fixes #123). -->

## Breaking changes

<!-- Anything that changes tool output, configuration, defaults or behaviour users rely on. "None" if none. -->

## Test plan

<!-- What you ran and what you checked. -->

- [ ] `npm run typecheck`
- [ ] `npm run lint`
- [ ] `npm test`
- [ ] Storage or auth changes: full suite against Postgres (`DATABASE_URL=... REQUIRE_DB_TESTS=1 npm test`, see CONTRIBUTING.md)
- [ ] Checked against the real YNAB API (say how, without tokens or budget data)

## Checklist

- [ ] Money math uses `decimal.js`; tool inputs are validated with zod; free-text inputs have a `maxLength`
- [ ] User strings in output are sanitized; no tokens or secrets in logs, errors or tests
- [ ] New or changed write paths call `assertWriteAllowed()` and write an audit entry
- [ ] New tools have an entry in `src/tools/annotations.ts` and appear in the README tool list
- [ ] Output changes only add fields (or are listed under Breaking changes)
