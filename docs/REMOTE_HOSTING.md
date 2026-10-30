# Remote hosting (multi-user, YNAB OAuth)

The YNAB MCP server can run as a **remote, multi-user** server: you host one
instance, your users connect their own YNAB accounts via OAuth, and each user's
data stays isolated. This guide covers deploying it yourself.

> Prefer a quick single-user remote server without OAuth? See **[Interim header
> mode](#interim-header-mode-single-user)** at the bottom.

## How it works

There are two OAuth layers:

1. **MCP client ⇄ your server.** Your server is an OAuth 2.1 Authorization Server
   (Dynamic Client Registration + PKCE, provided by the MCP SDK). MCP clients
   (claude.ai, Claude Desktop) authenticate to it and receive an MCP access token.
2. **Your server ⇄ YNAB.** Your server is a confidential OAuth client of YNAB. When
   a user connects, they pick **read-only** or **read-write**, are sent to YNAB to
   authorize, and your server stores their (encrypted) YNAB refresh token.

Identity is the user's **YNAB user id** — no separate accounts or passwords.

## 1. Register a YNAB OAuth application

1. Go to <https://app.ynab.com/settings/developer> → **New OAuth Application**.
2. Set the **Redirect URI** to exactly:
   ```
   https://YOUR_PUBLIC_URL/oauth/ynab/callback
   ```
3. Copy the **Client ID** and **Client Secret**.

## 2. Configure the server

Set these environment variables (see `.env.example`):

| Variable | Required | Description |
|----------|----------|-------------|
| `MCP_TRANSPORT` | yes | `http` |
| `PUBLIC_URL` | yes | Public HTTPS base URL, e.g. `https://ynab-mcp.example.com`. It is also the OAuth issuer, so for local http testing use `http://localhost` or `http://127.0.0.1`: the server refuses to start with `http://[::1]` in OAuth mode |
| `YNAB_OAUTH_CLIENT_ID` | yes | From step 1 |
| `YNAB_OAUTH_CLIENT_SECRET` | yes | From step 1 |
| `ENCRYPTION_KEY` | yes | 32-byte key for at-rest token encryption — `openssl rand -base64 32` |
| `YNAB_OAUTH_ALLOW_WRITE` | no | Offer read-write at consent (default `true`; set `false` to force read-only) |
| `STORAGE_DRIVER` | no | `memory` (default, **non-durable**), `sqlite`, or `postgres` |
| `SQLITE_PATH` | if sqlite | e.g. `/data/ynab-mcp.db` |
| `DATABASE_URL` | if postgres | `postgres://user:pass@host:5432/db` |
| `MCP_RESOURCE_URL` | no | Absolute URL of the MCP endpoint (the OAuth resource/audience). Default `PUBLIC_URL` + `/mcp`. Must be https (http only for `localhost`, `127.0.0.1`, `[::1]`), no fragment |
| `ALLOWED_HOSTS` / `ALLOWED_ORIGINS` | no | Comma-separated Host / Origin allowlists. Explicit values **replace** the derived defaults. Defaults: host and origin of `PUBLIC_URL`, plus `localhost`, `127.0.0.1`, `[::1]` (bare and with `:PORT`) when `PUBLIC_URL` is unset or loopback |
| `ENABLE_DNS_REBINDING_PROTECTION` | no | Host/Origin validation, **on by default** (previously off; a breaking default in 0.4.0). `false` disables it entirely. **Unsafe**: see "Host and Origin validation" |
| `MCP_MAX_SESSIONS` | no | Global cap on concurrent MCP sessions (integer >= 1, default `100`). At the cap an `initialize` is refused with `503` and `Retry-After`. See "Sessions" |
| `MCP_MAX_SESSIONS_PER_USER` | no | Cap on one user's concurrent sessions (integer >= 1 and at most `MCP_MAX_SESSIONS`, default `10` or `MCP_MAX_SESSIONS` if smaller). Past it the user's least recently used session is closed to make room. Set it below `MCP_MAX_SESSIONS` so one user can't take every slot. See "Sessions" |
| `MCP_SESSION_IDLE_TIMEOUT_MS` | no | Idle time before a session is closed (integer >= 1, default `1800000`, 30 min). See "Sessions" |
| `TRUST_PROXY` | if behind a reverse proxy | Hop count to trust for `X-Forwarded-*` (e.g. `1` behind a single Traefik/Caddy/nginx) — needed for accurate per-client rate limiting |

OAuth mode activates automatically once `YNAB_OAUTH_CLIENT_ID`,
`YNAB_OAUTH_CLIENT_SECRET`, `ENCRYPTION_KEY`, and `PUBLIC_URL` are all set. Use a
**durable** driver (`sqlite`/`postgres`) in production — `memory` loses all
sessions and connected accounts on restart.

## 3. Serve over TLS

OAuth requires HTTPS. Terminate TLS at a reverse proxy in front of the app. Example
with Caddy (automatic TLS):

```
ynab-mcp.example.com {
    reverse_proxy localhost:3000
}
```

Docker Compose sketch:

```yaml
services:
  ynab-mcp:
    image: ghcr.io/auzroz/ynab-mcp:latest
    environment:
      MCP_TRANSPORT: http
      PUBLIC_URL: https://ynab-mcp.example.com
      YNAB_OAUTH_CLIENT_ID: ${YNAB_OAUTH_CLIENT_ID}
      YNAB_OAUTH_CLIENT_SECRET: ${YNAB_OAUTH_CLIENT_SECRET}
      ENCRYPTION_KEY: ${ENCRYPTION_KEY}
      STORAGE_DRIVER: sqlite
      SQLITE_PATH: /data/ynab-mcp.db
      ENABLE_DNS_REBINDING_PROTECTION: "true"
      ALLOWED_HOSTS: ynab-mcp.example.com
    volumes: [ "ynab-data:/data" ]
  caddy:
    image: caddy:2
    ports: [ "443:443" ]
    # ... mount a Caddyfile as above
volumes: { ynab-data: {} }
```

## 4. Connect a client

- **claude.ai** — add a custom/remote connector pointing at
  `https://YOUR_PUBLIC_URL/mcp`. Its OAuth flow discovers your AS metadata,
  registers, and walks the user through the YNAB consent screen.
- **Claude Desktop / stdio-only clients** — use the `mcp-remote` shim, which drives
  the same OAuth flow:
  ```bash
  npx mcp-remote https://YOUR_PUBLIC_URL/mcp
  ```

### Consent screen and browser binding

When a client starts authorization, `/authorize` shows a consent page naming
the client and the address (`redirect_uri`) the browser will be sent back to,
and sets a short-lived cookie (`__Host-ynab_mcp_consent_…`; `HttpOnly`,
`Secure`, `SameSite=Lax`, lifetime `MCP_AUTH_CODE_TTL_SEC`). The next steps
(`/oauth/ynab/start`, the YNAB callback at `/oauth/ynab/callback`, and
`/oauth/cancel`) only work in a browser that carries that cookie. Without it,
anyone could start an authorization for their own client and send a victim the
`/oauth/ynab/start` link, skipping this server's consent screen. A request
without the cookie gets a generic `400`, and that authorization can't be
resumed. Over plain http (loopback only) the cookie has no `__Host-` prefix and
no `Secure` flag. Your reverse proxy must pass `Cookie` and `Set-Cookie`
through, which proxies do by default. The consent page can't be framed
(`X-Frame-Options: DENY`, `frame-ancestors 'none'`). An authorization that was
in progress during an upgrade to 0.4.0 has no binding, so the user has to
start it again.

### Access level per connection

The read-only / read-write choice belongs to each connection (each client
grant), not to the user. It is recorded on the authorization code and the
tokens issued from it, and a refresh never widens it. So if a user connects
client A read-only and later connects client B read-write, client A stays
read-only. A session gets write tools only when all of these hold: write is
enabled (`YNAB_READ_ONLY=false`), the token's grant is read-write, and the
user's current YNAB connection is read-write. A client that asks for the
`read-only` scope (and not `read-write`) is only offered read-only at consent.
If a read-only grant was requested with `read-write`, the issued `scope` says
`read-only`.

**Upgrade note:** tokens issued by 0.3.x carry no recorded access level and are
treated as **read-only**. Users who had read-write access must reconnect once
(remove and re-add the connector, or re-run `mcp-remote`) to get write access
back. Read access keeps working without reconnecting.

### Sessions

Each MCP session (`mcp-session-id`) belongs to the client and user whose token
created it. A request that presents a session id with a token for a different
user or client gets the same `404` as an unknown session id, so a leaked
session id (from proxy or access logs) can't be used to drive someone else's
session. In header-auth mode a session belongs to the YNAB token that opened it
(`X-YNAB-Token`, or the `YNAB_ACCESS_TOKEN` fallback): a request presenting a
different token, or none when there is no fallback, gets the same `404`.

A request with an `Mcp-Session-Id` the server doesn't hold (expired, closed,
never existed, or owned by someone else) gets `404`, as the MCP spec says, so
the client initializes a new session. A request with no session id that isn't an
`initialize` stays `400`.

Session limits:

- `MCP_MAX_SESSIONS` is a global cap. When it is reached, `initialize` is
  answered `503` with a `Retry-After` header and a generic JSON-RPC error;
  existing sessions are not touched.
- `MCP_MAX_SESSIONS_PER_USER` caps each user (in OAuth mode the YNAB user, in
  header mode the YNAB token). A new session beyond it closes that user's least
  recently used session instead of being refused, so a client that leaks
  sessions doesn't lock itself out. It must not exceed `MCP_MAX_SESSIONS`
  (startup fails otherwise); left unset, it defaults to 10 or
  `MCP_MAX_SESSIONS`, whichever is smaller. Only a per-user cap below the
  global one stops one family member from taking every slot.
- `MCP_SESSION_IDLE_TIMEOUT_MS` closes a session with no request for that long.
  A session with an open request, including the standalone `GET` stream clients
  hold open for server notifications, counts as active and is not closed; the
  clock starts when its last request ends. Clients get `404` on their next
  request and re-initialize.
- On shutdown (`SIGINT`/`SIGTERM`) all sessions are closed.

In header mode `initialize` doesn't validate the token, so any client that can
reach `/mcp` can fill the global cap with made-up tokens and get other clients
`503`. Don't expose header mode publicly: use OAuth mode, or restrict access at
the proxy. A lower `MCP_SESSION_IDLE_TIMEOUT_MS` shortens the lockout on
exposed instances.

All sessions of one user (in OAuth mode the YNAB user, in header mode the YNAB
token) share one rate limit, one cache and one audit log, so several clients or
a reconnecting client can't exceed the per-user YNAB budget
(`RATE_LIMIT_PER_HOUR`), and `ynab_audit_log` shows the user's writes from every
session. This state is kept for an hour after the user's last session closes,
so reconnecting doesn't reset the rate limit. In OAuth mode a session looks up
the user's YNAB access token on every request, refreshing it when it expires,
so long sessions keep working; once the user's YNAB grant is gone (or the token
can't be refreshed), tool calls fail with an `auth_error`.

### Discovery (RFC 9728 / RFC 8414)

In OAuth mode the server publishes protected-resource metadata for the MCP
endpoint at the path-aware URL, e.g.
`https://YOUR_PUBLIC_URL/.well-known/oauth-protected-resource/mcp` (derived from
`MCP_RESOURCE_URL`), with a root alias at
`/.well-known/oauth-protected-resource`. It lists the resource, the authorization
server (this server's issuer), `bearer_methods_supported: ["header"]` and the
scopes. Every `401` from `/mcp` carries
`WWW-Authenticate: Bearer ..., resource_metadata="<that URL>"`, so MCP clients can
discover the authorization server automatically. Header-auth mode serves neither.
No new environment variables.

### Token audience (RFC 8707)

Every authorization code, access token and refresh token is bound to the MCP
resource (`MCP_RESOURCE_URL`). Clients may send a `resource` parameter to
`/authorize` and `/token`. If they do, it must name this server's resource. The
comparison ignores the case of the scheme and host, a default port, a fragment
and one trailing slash. Any other value is refused with `invalid_target`. A
refresh may ask for a narrower scope than the original grant but never a wider
one (`invalid_scope`). `/mcp` returns `401 invalid_token` for a token bound to a
different resource.

Clients that send no `resource` still work. Tokens issued by 0.3.x (stored
without a resource) keep working against this server until they expire, so
existing users stay connected. If you change `MCP_RESOURCE_URL` (or `PUBLIC_URL`
when it supplies the default), tokens issued for the old URL stop working and
users must reconnect.

### Issuer identification (RFC 9207)

Every redirect back to an MCP client's `redirect_uri` carries
`iss=<issuer>`, the `issuer` from `/.well-known/oauth-authorization-server`
(`PUBLIC_URL` in URL form, e.g. `https://YOUR_PUBLIC_URL/`). That covers the
success redirect with `code` and every error redirect: `/authorize` validation
errors, `invalid_target`, the consent screen's **Cancel** (`access_denied`), a
denial at YNAB (`access_denied`; any other YNAB error becomes `server_error`),
and a failed YNAB code exchange (`server_error`). The metadata advertises
`authorization_response_iss_parameter_supported: true`, so clients can detect
mix-up attacks. The redirect to YNAB's own authorize page carries no `iss`.
Error descriptions are fixed text; nothing from YNAB is forwarded. If you put
the server behind a proxy, set `PUBLIC_URL` to the exact URL clients use: it
is both the issuer and the `iss` value. No new environment variables.

## Host and Origin validation

On by default. One middleware (`src/middleware/origin-validation.ts`) runs before
everything else and is the only place these checks happen (the MCP SDK
transport's own DNS-rebinding option is not used, so the two can't disagree).

- **Host** must be in `ALLOWED_HOSTS` or the request gets `403` with a generic
  JSON-RPC error. Comparison is case-insensitive, IPv6 literals are
  canonicalised, and an entry without a port also matches the default port
  (`mcp.example.com` matches `mcp.example.com:443`). It applies to every route
  (MCP, OAuth endpoints, well-known metadata) except `/health`, so orchestrator
  probes by pod IP keep working.
- **Origin**, when present, must match `ALLOWED_ORIGINS` exactly on scheme, host
  and port, else `403`. Requests with no `Origin` (CLI and server-side clients)
  are allowed. `Origin: null` is rejected. It applies to `/mcp` only: the OAuth
  endpoints carry no ambient credentials (PKCE and client authentication) and
  are deliberately CORS-open, and the well-known metadata must stay readable
  from any origin. The only cookie is the `SameSite=Lax` consent cookie, which
  proves which browser saw the consent page and grants nothing by itself.
- With no `ALLOWED_ORIGINS` and no `PUBLIC_URL`, origins are derived from the
  allowed hosts (`https://` for each, plus `http://` for loopback hosts).
- A malformed `ALLOWED_HOSTS` / `ALLOWED_ORIGINS` entry (a scheme in a host, a
  path in an origin) stops the server at startup.

**Reverse proxies:** set `PUBLIC_URL` to the exact public URL; its host and origin
are allowed automatically. The proxy must forward the original `Host` header
(nginx: `proxy_set_header Host $host;`, Traefik and Caddy do by default). If it
rewrites `Host` to an internal name, either stop it from doing so or add that
name to `ALLOWED_HOSTS` (an explicit list replaces the defaults, so include the
public host too). Symptom of getting this wrong: every request returns `403`.

**Opt-out (unsafe):** `ENABLE_DNS_REBINDING_PROTECTION=false` turns both checks
off, and the server logs a warning at startup. Without them, any web page can
reach a server on a private network through DNS rebinding. Prefer fixing
`ALLOWED_HOSTS`.

## Upgrading

**Back up your database before upgrading** (copy the SQLite file while the
server is stopped, or `pg_dump` the Postgres database). On startup the server
migrates the schema in place. Migrations only add nullable columns and are safe
to re-run. 0.4.0 adds a `resource` column to `pending_auth`, `auth_codes`,
`access_tokens` and `refresh_tokens`, a `granted_scope` column to `auth_codes`,
`access_tokens` and `refresh_tokens`, and a `browser_binding` column to
`pending_auth`. Existing read-write users must reconnect once to get write
access back (see "Access level per connection"). On Postgres the migration runs in one
transaction under an advisory lock, so replicas that start together don't race.
The previous release can still read a migrated database if you need to roll back.

## Prompts

The server also exposes 7 MCP Prompts — guided, YNAB-methodology-grounded
workflows that orchestrate several tools into a single review. Available in
any MCP client that supports the `prompts` capability:

| Prompt | What it does |
|---|---|
| `ynab-pulse-check` | Fast daily-style status: Ready to Assign, health score, overspending, spending pace |
| `ynab-monthly-review` | Full end-of-month review: budget vs. actuals, goals, net worth, next month's suggested budget |
| `ynab-assign-money` | Give Every Dollar a Job — allocates unassigned Ready to Assign money |
| `ynab-true-expenses` | Embrace Your True Expenses — plans for irregular/annual costs and missing recurring bills |
| `ynab-overspending-triage` | Roll With the Punches — finds overspending and suggests moves to fix it |
| `ynab-age-of-money` | Age Your Money — checks cash cushion, credit card float, near-term cash flow |
| `ynab-reconcile-cleanup` | Weekly hygiene: uncleared transactions and unused/sprawling categories |

## Security notes

- YNAB refresh tokens are encrypted at rest with AES-256-GCM (`ENCRYPTION_KEY`).
  Keep that key secret and stable; rotating it invalidates stored connections.
- Access is read-only or read-write **per connection**, per the consent choice
  for that client; the server also honors a global `YNAB_READ_ONLY=true`
  override.
- Always run behind TLS; enable DNS-rebinding protection with an allowlist.
- `memory` storage is for evaluation only — it is not durable and not shared across
  replicas. For multiple replicas, use `postgres` (session/token cache is currently
  in-process; a shared cache would be a future enhancement).

## Interim header mode (single-user)

If you don't set the OAuth variables, HTTP mode falls back to **header auth**: the
YNAB token is supplied per request via `X-YNAB-Token` (or the `YNAB_ACCESS_TOKEN`
env for a single user). This is handy for a personal remote instance:

```bash
MCP_TRANSPORT=http YNAB_ACCESS_TOKEN=… npm start
npx mcp-remote http://localhost:3000/mcp --header "X-YNAB-Token: <token>"
```

Serve behind TLS; this mode has no per-user isolation beyond the token you send.
Tokens aren't validated at `initialize`, so anyone who can reach `/mcp` can use up
`MCP_MAX_SESSIONS` (see [Sessions](#sessions)); keep it off the public internet or
restrict access at the proxy.
