# Security Policy

## Reporting a vulnerability

Please report vulnerabilities privately through [GitHub's private vulnerability reporting](https://github.com/auzroz/ynab-mcp/security/advisories/new) (the Security tab, then "Report a vulnerability"). Don't open a public issue, and don't post details in a discussion or pull request.

- **Include:** the affected version, how the server gets its YNAB credentials (stdio with `YNAB_ACCESS_TOKEN`, HTTP header mode, or HTTP OAuth mode), and steps to reproduce.
- **Leave out:** real tokens, budget data, and working exploits against anyone else's instance.

## What to expect

This is a single-maintainer, volunteer-run project. These are targets, not a service-level agreement, and there is no 24/7 cover.

| Step | Target |
|---|---|
| Acknowledge your report | within 3 business days |
| Triage: confirm or decline, and tell you the severity | within 10 business days |
| Fix for a critical issue | within 30 days of the report |

Lower-severity issues are fixed in the next appropriate release. A fix ships as a patch release, or as a minor release if the fix has to change behaviour. If a target is going to slip, the maintainer will say so on the report. An advisory is published once the fix is available, and you are credited unless you ask not to be.

## Supported versions

| Version | Security fixes |
|---|---|
| Latest release | Yes |
| 0.4.x | Yes, until at least 2027-01-27 |
| Anything older | No |

Security fixes go into the latest release first. A fix for 0.4.x is backported when the issue affects what 0.4.x ships, and it is a maintainer decision made per advisory (see "Dependency advisories" in [CONTRIBUTING.md](CONTRIBUTING.md#dependency-advisories-and-triage)). Older versions are deprecated on npm when a fix supersedes them. Please upgrade to the latest version.

## Scope

In scope: the software in this repository, as released on npm and as `ghcr.io/auzroz/ynab-mcp` images. The areas that matter most:
- handling of YNAB tokens, and their encryption at rest in OAuth storage;
- the OAuth flow: consent, resource binding, refresh-token rotation and reuse detection;
- isolation between users and sessions in HTTP mode;
- read-only enforcement;
- anything that could expose one user's budget data to another.

Out of scope:
- the YNAB API itself and YNAB's OAuth service (report problems there to YNAB);
- other people's deployments of this server (see "If you run the HTTP server" below);
- denial of service by volume, social engineering, and physical attacks;
- findings that need an already-compromised host, a leaked `ENCRYPTION_KEY`, or a malicious operator.

## Testing rules and safe harbor

Test only against your own installation and your own YNAB account (a throwaway budget is best). Don't test against anyone else's deployment, and don't send anything to YNAB's services that you wouldn't send in normal use of your own account. Don't read, change or keep data that isn't yours; if you reach someone else's data by accident, stop and tell us.

If you follow these rules and report in good faith, the maintainer will:
- treat your research as authorized, and won't pursue or support legal action against you for it;
- work with you to understand and fix the issue; and
- agree a disclosure date with you, rather than asking you to keep the report secret indefinitely.

This is the maintainer's statement for this project only. It can't bind YNAB, a hosting provider, or anyone running their own copy of the server.

## If you run the HTTP server

Anyone can self-host this server, and the maintainer doesn't operate or have access to your deployment. That splits reports in two:
- **A flaw in the software** (it behaves insecurely with a correct configuration): report it here, as above.
- **A problem with a particular deployment** (a weak config, an exposed port, a leaked key, a user's lost access): that belongs to whoever runs it. Report it to them. Don't report it here, and don't test it without the operator's permission.

Operators: publish somewhere your users can find it where to report problems with your instance, and what you will and won't do for them. You can adapt this:

```text
Security contact for this YNAB MCP instance

Report problems with this instance to: <your email or reporting URL>
We aim to acknowledge within <n> business days.
Please test only your own account here. Don't access other people's data.
Problems in the ynab-mcp software itself are better reported to its maintainer:
https://github.com/auzroz/ynab-mcp/security/advisories/new
(you may report it to both).
```

Running an up-to-date release, setting `ENCRYPTION_KEY`, serving over HTTPS and keeping writes off unless you need them are covered in [docs/REMOTE_HOSTING.md](docs/REMOTE_HOSTING.md).
