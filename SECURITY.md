# Security Policy

## Reporting a vulnerability

Please report vulnerabilities privately through [GitHub's private vulnerability reporting](https://github.com/auzroz/ynab-mcp/security/advisories/new) (the Security tab, then "Report a vulnerability"). Don't open a public issue.

- **Include:** the affected version, how the server gets its YNAB credentials (stdio with `YNAB_ACCESS_TOKEN`, HTTP header mode, or HTTP OAuth mode), and steps to reproduce.
- **Leave out:** real tokens, budget data, and working exploits against anyone else's instance.

You'll get an acknowledgement as soon as the maintainer sees the report. A fix ships in the next appropriate release: a patch release, or a minor release if the fix has to change behaviour. An advisory is published once the fix is available.

## Supported versions

Security fixes go into the latest release. Older versions are deprecated on npm when a fix supersedes them, so please upgrade to the latest version.

## Scope

The areas that matter most:
- handling of YNAB tokens, and their encryption at rest in OAuth storage;
- the OAuth flow: consent, resource binding, refresh-token rotation and reuse detection;
- isolation between users and sessions in HTTP mode;
- read-only enforcement;
- anything that could expose one user's budget data to another.

The YNAB API itself, and YNAB's OAuth service, are out of scope. Report problems there to YNAB.
