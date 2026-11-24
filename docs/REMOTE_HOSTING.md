# Remote hosting (multi-user, YNAB OAuth)

The YNAB MCP server can run as a **remote, multi-user** server: you host one
instance, your users connect their own YNAB accounts via OAuth, and each user's
data stays isolated. This guide covers deploying it yourself.

> Prefer a quick single-user remote server without OAuth? See **[Interim header
> mode](#interim-header-mode-single-user)** at the bottom.

## How it works

There are two OAuth layers:

1. **MCP client ⇄ your server.** Your server is an OAuth 2.1 Authorization Server
   (Dynamic Client Registration + PKCE; since 0.5.0 built on
   [oidc-provider](https://github.com/panva/node-oidc-provider)). MCP clients
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
| `AUTH_MODE` | yes | `oauth` here (`header` is the interim single-user mode below). Required: HTTP mode refuses to start without it. All configuration problems are listed in one startup message, without values |
| `PUBLIC_URL` | yes | Public HTTPS base URL, e.g. `https://ynab-mcp.example.com`. It is also the OAuth issuer, so for local http testing use `http://localhost` or `http://127.0.0.1`: the server refuses to start with `http://[::1]` in OAuth mode |
| `YNAB_OAUTH_CLIENT_ID` | yes | From step 1 |
| `YNAB_OAUTH_CLIENT_SECRET` | yes | From step 1 |
| `ENCRYPTION_KEY` | yes | 32-byte key for at-rest token encryption — `openssl rand -base64 32`. Unless `TOKEN_PEPPER` is set, the token-hash pepper is derived from it, so changing it then also refuses to start (see "Hashed tokens and the pepper"). To change it, follow "Rotating ENCRYPTION_KEY" |
| `ENCRYPTION_KEY_ID` | no | The key id `ENCRYPTION_KEY` is stored under, 1 to 999999 (default `1`). Each new key gets a new, higher id; a different key under an id the database has seen refuses to start |
| `ENCRYPTION_KEY_PREVIOUS` | no | Older keys, as `<id>:<key>` separated by commas (e.g. `1:<old key>`), used only to read tokens stored under them while the rekey job moves those to the current key. Requires `TOKEN_PEPPER`. See "Rotating ENCRYPTION_KEY" |
| `TOKEN_PEPPER` | no | 32-byte secret (base64 or 64 hex characters) keying the hashes of stored MCP tokens, codes and state — `openssl rand -base64 32`. Default: derived from `ENCRYPTION_KEY`. Set it **before the first 0.5.0 start** if you want one; see "Hashed tokens and the pepper" |
| `YNAB_OAUTH_ALLOW_WRITE` | no | Allow writes (default `false`). Checked on every request, not only at consent: unless `true`, no connection can write, including one granted read-write earlier, so setting it back to `false` is an instant switch. Writes also need `YNAB_READ_ONLY=false`. `YNAB_ACCESS_TOKEN` and `YNAB_BUDGET_ID` must not be set in OAuth mode |
| `STORAGE_DRIVER` | no | `memory` (default, **non-durable**), `sqlite`, or `postgres` |
| `SQLITE_PATH` | if sqlite | e.g. `/data/ynab-mcp.db` |
| `DATABASE_URL` | if postgres | `postgres://user:pass@host:5432/db` |
| `MCP_RESOURCE_URL` | no | Absolute URL of the MCP endpoint (the OAuth resource/audience). Default `PUBLIC_URL` + `/mcp`. Must be https (http only for `localhost`, `127.0.0.1`, `[::1]`), no fragment |
| `ALLOWED_HOSTS` / `ALLOWED_ORIGINS` | no | Comma-separated Host / Origin allowlists. Explicit values **replace** the derived defaults. Defaults: host and origin of `PUBLIC_URL`, plus `localhost`, `127.0.0.1`, `[::1]` (bare and with `:PORT`) when `PUBLIC_URL` is unset or loopback |
| `ENABLE_DNS_REBINDING_PROTECTION` | no | Host/Origin validation, **on by default** (previously off; a breaking default in 0.4.0). `false` disables it entirely. **Unsafe**: see "Host and Origin validation" |
| `MCP_MAX_INFLIGHT_PER_USER` | no | Requests one user can have in flight at `/mcp` (integer 1-64, default `8`). Past it: `429` with `Retry-After: 1`. See "Requests, limits and timeouts" |
| `MCP_MAX_INFLIGHT_PER_CLIENT` | no | Requests one client of a user can have in flight, OAuth mode only (integer 1-64 and at most `MCP_MAX_INFLIGHT_PER_USER`, default `4`, or the per-user cap if smaller). See "Requests, limits and timeouts" |
| `MCP_MAX_INFLIGHT` | no | Requests in flight across the server (integer 1-1024 and at least `MCP_MAX_INFLIGHT_PER_USER`, default `64`). See "Requests, limits and timeouts" |
| `MCP_REQUEST_TIMEOUT_MS` | no | Longest a `/mcp` request runs (integer 5000-300000, default `60000`). See "Requests, limits and timeouts" |
| `MCP_MAX_SESSIONS` / `MCP_MAX_SESSIONS_PER_USER` / `MCP_SESSION_IDLE_TIMEOUT_MS` | no | **Deprecated, no effect** since 0.5.0 (`/mcp` is stateless). Still parsed, so a malformed value refuses to start; a set value logs a warning once at startup. Removed in 0.6 |
| `RATE_LIMIT_MAX_WAIT_MS` | no | Longest a request waits for a per-user YNAB rate-limit token (integer 0-60000, default `2000`). `0` never waits. Past that, or when another request is already waiting, the tool returns `rate_limited` with `retry_after_seconds` at once, so a burst can't pile up behind the limiter |
| `YNAB_WRITE_LIMIT_PER_HOUR` | no | Write requests one user may make per hour (integer 0-1000, default `20`; **breaking** in 0.5.0, since writes were previously unlimited). One write tool call counts as 1, so a bulk call is 1. `0` turns the cap off. Counted per user (the YNAB user in oauth mode, the token in header mode), shared by all of that user's clients and requests, in memory: a restart resets it. A refused write returns `write_limit_exceeded` naming the limit and when it resets, and takes no YNAB request. Separate from `RATE_LIMIT_PER_HOUR` |
| `TRUST_PROXY` | if behind a reverse proxy | Number of proxies between the client and this server whose `X-Forwarded-For` to trust (integer 0-10, default `0`; e.g. `1` behind a single Traefik/Caddy/nginx). Too low and every client shares one rate-limit bucket, so one client can lock out the others; too high and clients can spoof their address. Set it only when the app is reachable solely through the proxy. See "Client addresses and rate limits" |
| `TRUST_CF_CONNECTING_IP` | no | `true` to take the client address from `CF-Connecting-IP` (default `false`). Separate from `TRUST_PROXY`; turn it on only when the server is reachable solely through Cloudflare. See "Client addresses and rate limits" |
| `REGISTER_RATE_LIMIT_PER_IP` | no | `/register` requests per client address per hour (integer 1-100000, default `100`) |
| `REGISTER_RATE_LIMIT_PER_HOST` | no | `/register` requests per redirect URI host per hour (integer 1-100000, default `20`). A verified host (`MCP_VERIFIED_REDIRECT_URIS`) or loopback counts per host and client address. See "Client addresses and rate limits" |
| `SECURITY_CONTACT` | no | Where to report a security issue in **your** deployment: one or more comma-separated email addresses or `mailto:`, `tel:` or `https:` URIs (at most 5). When set, the server serves `/.well-known/security.txt` (RFC 9116) with a `Contact` line for each, an `Expires` of 180 days from each request, and `Canonical` from `PUBLIC_URL`. Unset (default): the path is a 404. A value with a control character or line break is refused at startup |
| `SECURITY_POLICY_URL` | no | An https URL for your disclosure policy, served as `Policy` in `security.txt`. Only used when `SECURITY_CONTACT` is set |
| `MCP_VERIFIED_REDIRECT_URIS` | no | Comma-separated redirect URIs of trusted clients. Default: Claude's connector callbacks, `https://claude.ai/api/mcp/auth_callback` and `https://claude.com/api/mcp/auth_callback`. An authorization error at `/authorize` is redirected back only to these (and to loopback, see below); for any other client it is shown on this server's own page with a "Return to" link, so the server can't be used as an open redirector. The consent page names a verified client plainly and any other as "calls itself". `none` empties the list. Each entry must be https (http only for loopback), at most 512 characters, with no userinfo or fragment |
| `MCP_DCR_PRIVATE_USE_SCHEMES` | no | Comma-separated private-use URI schemes (RFC 8252, e.g. `com.example.app`) a registering native app may use for its redirect URI. Default: none, so registrations need `https://` or `http://` to `localhost`, `127.0.0.1` or `[::1]` |
| `MCP_TRUST_LOOPBACK_REDIRECTS` | no | Redirect authorization errors back to loopback redirect URIs (default `true`). The consent page labels a loopback address either way |
| `MCP_INACTIVE_USER_DAYS` | no | Erase users inactive for this many days who have no live connection (integer 30-3650). Default: off. See "Erasing inactive users" |
| `MCP_REFRESH_TOKEN_IDLE_DAYS` | no | A refresh token not used for this many days expires (integer 1-3650, default `30`). Must not exceed `MCP_REFRESH_TOKEN_TTL_DAYS`. See "Retention and the sweep" |
| `MCP_REFRESH_TOKEN_TTL_DAYS` | no | A connection ends this many days after its sign-in, however often it is refreshed (integer 1-3650, default `90`) |
| `MCP_ABANDONED_CLIENT_HOURS` | no | A registered client that never completed a sign-in is deleted after this many hours (integer 1-87600, default `24`) |
| `MCP_UNUSED_CLIENT_DAYS` | no | A client with no live connection is deleted this many days after its last sign-in (integer 1-3650, default `90`) |

OAuth mode (`AUTH_MODE=oauth`) also needs `YNAB_OAUTH_CLIENT_ID`,
`YNAB_OAUTH_CLIENT_SECRET`, `ENCRYPTION_KEY`, and `PUBLIC_URL`; startup is refused if any is missing.
Numeric settings are bounds-checked (for example `RATE_LIMIT_PER_HOUR` 1-195,
`MCP_ACCESS_TOKEN_TTL_SEC` 60-3600, `MCP_AUTH_CODE_TTL_SEC` 30-600,
`MCP_REQUEST_TIMEOUT_MS` 5000-300000); an out-of-range value is refused, naming the variable and range. Use a
**durable** driver (`sqlite`/`postgres`) in production — `memory` loses all
tokens and connected accounts on restart.

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
      AUTH_MODE: oauth
      PUBLIC_URL: https://ynab-mcp.example.com
      YNAB_OAUTH_CLIENT_ID: ${YNAB_OAUTH_CLIENT_ID}
      YNAB_OAUTH_CLIENT_SECRET: ${YNAB_OAUTH_CLIENT_SECRET}
      ENCRYPTION_KEY: ${ENCRYPTION_KEY}
      STORAGE_DRIVER: sqlite
      SQLITE_PATH: /data/ynab-mcp.db
      ENABLE_DNS_REBINDING_PROTECTION: "true"
      ALLOWED_HOSTS: ynab-mcp.example.com
      # One proxy hop (Caddy). Without it every client appears to come from
      # Caddy's address and shares one rate limit, so one client could lock
      # everyone out of the OAuth endpoints.
      TRUST_PROXY: "1"
    # No published ports: only Caddy can reach the app, so X-Forwarded-For
    # can't be spoofed by connecting to it directly.
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

When a client starts authorization, `/authorize` redirects the browser to a
consent page at `/oauth/interaction/<id>` naming the client and the address
(`redirect_uri`) the browser will be sent back to. The user's choice goes to
`/oauth/interaction/<id>/start?scope=read-only|read-write`, which sends the
browser to YNAB, and **Cancel** to `/oauth/interaction/<id>/cancel`. YNAB
redirects to `/oauth/ynab/callback` (the URI registered at YNAB), which sends
the browser to `/oauth/interaction/<id>/complete`; that exchanges the YNAB code
and hands the browser back through `/authorize/<id>` to the client with its
code.

These steps only work in the browser that saw the consent page. `/authorize`
sets short-lived signed cookies (`_interaction` scoped to
`/oauth/interaction/<id>`, `_interaction_resume` scoped to `/authorize/<id>`,
and `_session`, each with a `.sig` signature; `HttpOnly`, `SameSite=Lax`,
`Secure` when `PUBLIC_URL` is https). They last as long as the sign-in may:
`MCP_AUTH_CODE_TTL_SEC` or the YNAB callback deadline plus 30 seconds,
whichever is longer, so at least 630 seconds. A sign-in that runs past the
deadline still ends with a `server_error` back to the client. They
are signed with a key derived from `ENCRYPTION_KEY`, so there is no new
setting. Without them, anyone could start an authorization for their own
client and send a victim the `start` link, skipping this server's consent
screen. A request without the cookie gets a generic `400`, before anything
reaches YNAB, and that authorization can't be resumed. Your reverse proxy must
pass `Cookie` and `Set-Cookie` through, which proxies do by default. The
consent page can't be framed (`X-Frame-Options: DENY`, `frame-ancestors
'none'`). Every authorization shows the consent page and goes through YNAB:
there is no silent sign-in, so `prompt=none` is answered with
`login_required`.

Until 0.4.x the legs were `/oauth/ynab/start` and `/oauth/cancel`, bound by a
`__Host-ynab_mcp_consent_…` cookie. Both are gone in 0.5.0, so an
authorization that was in progress during the upgrade has to start again.

Since 0.5.0 the consent page shows the host the browser returns to in bold.
A client whose redirect URI isn't on `MCP_VERIFIED_REDIRECT_URIS` appears as
"an application at *host* that calls itself *name*", and a loopback address
is labelled as one on the user's own device. The page loads nothing (a strict
`Content-Security-Policy`), isn't cached, and strips bidi and invisible
characters from the client's name.

### Client registration and authorization errors

`/register` accepts only what this server uses: 1 to 5 redirect URIs of at
most 512 characters, each `https://`, `http://` to `localhost`, `127.0.0.1` or
`[::1]`, or a private-use scheme on `MCP_DCR_PRIVATE_USE_SCHEMES`, with no
userinfo or fragment; a `client_name` of 1 to 100 printable characters; and a
few short fields (`token_endpoint_auth_method`, `grant_types`,
`response_types`, `scope`, `application_type`, `software_id`,
`software_version`). Other fields (`jwks`, `contacts`, `logo_uri`,
`software_statement` and so on) are dropped. A refusal is `400` with
`invalid_redirect_uri` or `invalid_client_metadata`; so is a
`sector_identifier_uri`. Every authorization server route refuses a body over
8 KB (`413`), and a method it doesn't serve with `405` (`/authorize` serves
only `GET`; `/token`, `/register` and `/revoke` only `POST`). The rate limits
are in "Client addresses and rate limits".

Since 0.5.0 the registration response also carries the library's defaults
(`application_type`, `subject_type`, `id_token_signed_response_alg`,
`require_auth_time`), and `client_secret_expires_at` is `0`: a client secret
no longer expires after 30 days. A client unused for 90 days is still removed.
A registered `scope`, `software_id` and `software_version` are accepted but
not kept: scopes are asked for at `/authorize`.
The token response's `token_type` is `Bearer`, and a read-write token's
`scope` is `read-only read-write`.

`/authorize` refuses a `state` over 512 characters, a `code_challenge` that
isn't 43 base64url characters, and more than 5 scopes; unknown scopes are
ignored. A `client_id` that is missing, empty, repeated or over 255
characters is refused before any lookup. The `redirect_uri` must equal a
registered one character for character; only an `http://localhost`,
`http://127.0.0.1` or `http://[::1]` URI may differ in its port. A redirect URI
with a fragment never matches. These refusals are a `400`, never a redirect.
An error found once the client and redirect URI are known is redirected back
to the client only when that redirect URI is verified
(`MCP_VERIFIED_REDIRECT_URIS`, or loopback while `MCP_TRUST_LOOPBACK_REDIRECTS`
is on). For any other client the error is shown on this server's own page,
with a link back the user can choose to follow, so a crafted link can't use
your server to bounce a browser to an arbitrary site.

Clients registered before 0.5.0 keep working, with two exceptions: a client
with an `http://` redirect URI to a host other than loopback is refused at
`/authorize`, and a redirect URI with a fragment can't be used. Such a client
has to register again. The server logs, once per client, any
other rule an older registration breaks.

### Access level per connection

The read-only / read-write choice belongs to each connection (each client
grant), not to the user. It is recorded on the authorization code and the
tokens issued from it, and a refresh never widens it. So if a user connects
client A read-only and later connects client B read-write, client A stays
read-only. A request gets write tools only when all of these hold: write is
enabled (`YNAB_READ_ONLY=false`), the token's grant is read-write, and the
user's current YNAB connection is read-write. A client that asks for the
`read-only` scope (and not `read-write`) is only offered read-only at consent.
If a read-only grant was requested with `read-write`, the issued `scope` says
`read-only`.

**Upgrade note:** tokens issued by 0.3.x carry no recorded access level and are
treated as **read-only**. Users who had read-write access must reconnect once
(remove and re-add the connector, or re-run `mcp-remote`) to get write access
back. Read access keeps working without reconnecting.

### Requests, limits and timeouts

`/mcp` is stateless (since 0.5.0). The server issues no `Mcp-Session-Id` and
keeps no session between requests: every request is authenticated by its own
token (in OAuth mode the MCP access token, in header mode `X-YNAB-Token` or the
`YNAB_ACCESS_TOKEN` fallback) and served as that client and user. A session id
a client still sends is ignored. `GET /mcp` (a server-to-client stream) and
`DELETE /mcp` (ending a session) answer `405`. Nothing needs sticky sessions at
a load balancer or proxy. Clients on protocol revision 2026-07-28 and 2025-era
clients are both served.

A request's read-only state is computed on every request, so a token or grant
downgraded to read-only loses the write tools on its next request.
`YNAB_OAUTH_ALLOW_WRITE` and `YNAB_READ_ONLY` are read at startup: changing them
takes effect on the first request after a restart.

Limits:

- **In flight.** `MCP_MAX_INFLIGHT_PER_USER` (default 8) caps the requests one
  user (the YNAB user in OAuth mode, the YNAB token in header mode) has in
  flight; `MCP_MAX_INFLIGHT_PER_CLIENT` (default 4) caps one client of that user
  in OAuth mode, so one client can't take all of a user's slots; and
  `MCP_MAX_INFLIGHT` (default 64) caps the whole server. A request past any cap
  gets `429` with `Retry-After: 1` and a JSON-RPC error, before any storage read.
- **Ceiling.** `MCP_REQUEST_TIMEOUT_MS` (default 60 s) bounds every request,
  from its first byte: a slow upload, a stalled token check and a slow tool
  call all hit the same deadline. A tool call returns a timeout result shortly
  before it; for a write tool the result says the change may still have been
  applied, so check (for example with `ynab_list_transactions`) before
  retrying. A request whose response hasn't started gets a JSON-RPC
  `Request timed out` error instead.
- A slot (and the request's hold on the user's shared state) is released only
  once the response has closed **and** the work the request started has
  finished. The YNAB call behind a timed-out or abandoned request keeps its
  slot until it completes or YNAB's own fetch timeout ends it, so abandoned
  work can't pile up past the caps.
- On shutdown (`SIGINT`/`SIGTERM`) the server stops accepting connections and
  lets the requests in flight finish, including YNAB calls that outlived their
  response (a timed-out write); the process exits after 10 s regardless.

Unauthenticated requests are bounded in time by the ceiling, but not in
number: there is no pre-authentication cap. Keep Node's own request timeouts,
and limit connections at your reverse proxy if the server is exposed. In header
mode any non-empty token counts as a user, so `MCP_MAX_INFLIGHT` is what bounds
it; don't expose header mode publicly.

`MCP_MAX_SESSIONS`, `MCP_MAX_SESSIONS_PER_USER` and
`MCP_SESSION_IDLE_TIMEOUT_MS` have no effect since 0.5.0 and are removed in 0.6.
A set value logs a warning once at startup; a malformed one still refuses to
start.

All requests of one user share one rate limit, one cache (including the
delta-sync snapshots, see README "Caching") and one audit log, so several
clients can't exceed the per-user YNAB budget (`RATE_LIMIT_PER_HOUR`), a
snapshot one request built saves the next a full fetch, and `ynab_audit_log`
shows the user's writes from every client. Users never share any of it.
Snapshots are bounded per user (32 snapshots, 20,000 entities, dropped after 30
minutes unused), so budget roughly that much memory per active user. This state
is kept for an hour after the user's last request, so a quiet hour doesn't reset
the rate limit. With several replicas, these caps, the rate limit and the caches
are per process.

The write cap (`YNAB_WRITE_LIMIT_PER_HOUR`) is the same kind of per-process,
in-memory state, held per user next to the rate limiter, the circuit breaker and
the caches, and shared by all of the user's requests and clients. A restart
resets it. In header mode, where any token counts as a user, evicting the
least recently used user entry under load (past 10,000 retained users) can reset it
too. With several replicas each process counts on its own, so a user can make up
to the limit per replica. A write call that fails input validation gives its slot
back; one that YNAB rejects keeps it. In OAuth mode every request looks up the user's YNAB grant and
access token, refreshing the token when it expires. Once the user's YNAB grant
is gone, or YNAB rejects its refresh token (`invalid_grant`), requests are
refused with `401` and the client re-authorizes, and a tool call whose token
can't be refreshed midway fails with an `auth_error`. A failure that clears by
itself (YNAB timing out or answering `5xx`, the circuit breaker being open, or
another replica's refresh taking too long) keeps the grant: the request gets
`503` with `Retry-After`, and a tool call an `upstream_unavailable` result with
`retry_after_seconds`.

### Several replicas: YNAB token refresh

YNAB issues a new refresh token on every refresh and spends the old one, so
two processes refreshing one user at the same moment would leave one of them
holding a spent token, and the user would have to reconnect. Since 0.5.0
(#48) the replicas on one database take turns:

- Each user row carries a **refresh lease** (a random holder id and an expiry).
  A replica that needs a new YNAB access token claims it with one
  compare-and-set `UPDATE`, which succeeds only while no unexpired lease is
  held. The winner calls YNAB; no database connection or transaction is held
  during that call.
- The winner stores the rotated refresh token, the new **YNAB access token**
  and its expiry in one statement, which also frees the lease. The access
  token is encrypted like the refresh token, bound to its own column
  (`users.encrypted_access_token`) and user. Every replica then uses it until
  shortly before it expires (YNAB access tokens last two hours), instead of
  refreshing on its own.
- A replica that loses the claim polls the row for up to 15 seconds and uses
  the stored access token as soon as it is there. It never calls YNAB itself
  while the lease is held. If the wait runs out, that request gets `503` with
  `Retry-After` (an `upstream_unavailable` result for a tool call), and the
  client tries again.
- A lease whose holder crashed expires after 45 seconds, and the next request
  refreshes. Requests in one process share one refresh as before. A holder
  that reaches the YNAB call with less than 5 seconds of its lease left gives
  the lease up instead of calling (`503`), since another replica may claim it
  as it runs out. This is not a fence (YNAB takes no fencing token): a process
  frozen for longer than that margin just before the call can still spend the
  refresh token twice, and the user may then have to reconnect once.
- When YNAB answers `401` to a call made with the stored access token (it was
  revoked or expired early), that token is dropped for every replica, with a
  compare-and-set so a newer one is kept. The call fails with an `auth_error`
  and is not retried, since a write could otherwise apply twice. The next call
  refreshes.

The same code runs on every driver; for several replicas, use `postgres`.
The replicas' clocks must agree to within a few seconds (use NTP),
because lease and token expiry times are compared across them. A re-consent
clears the stored access token and the lease, so the new grant's access level
applies at once. The columns come with schema 6 (0.5.0): `encrypted_access_token`,
`access_token_expires_at`, `refresh_lease_holder`, `refresh_lease_until` and
`last_seen_at` on `users`, all nullable. 0.4.x ignores them, but don't run
0.4.x and 0.5.0 replicas together (see "Encrypted YNAB tokens").

### Retention and the sweep

Credentials and registrations expire on a schedule, and a background sweep
deletes what has expired. These are the defaults (0.5.0); each window is a
setting.

| What | Expires | Setting |
| --- | --- | --- |
| Refresh token (a connection) | 30 days after it was last used (each refresh issues a new one) | `MCP_REFRESH_TOKEN_IDLE_DAYS` (1-3650) |
| Connection, in total | 90 days after its sign-in, however often it is refreshed | `MCP_REFRESH_TOKEN_TTL_DAYS` (1-3650) |
| Client that never completed a sign-in | 24 hours after registering | `MCP_ABANDONED_CLIENT_HOURS` (1-87600) |
| Client with no live connection | 90 days after its last sign-in | `MCP_UNUSED_CLIENT_DAYS` (1-3650) |
| Access token, authorization code, sign-in in progress | their own short lifetimes (`MCP_ACCESS_TOKEN_TTL_SEC`, `MCP_AUTH_CODE_TTL_SEC`) | not retention settings |
| Spent codes and refresh tokens | kept 30 days after use so a replay can still revoke its grant | fixed |

The idle window must not exceed the total window, or startup is refused. A
user whose connection expires signs in again (consent screen and YNAB); the
YNAB grant itself is untouched. A changed refresh-token window applies to
tokens issued after the change; the client windows apply at the next sweep.

The sweep runs about 30 seconds after startup, then every 15 minutes, on every
replica. On Postgres one replica sweeps at a time (an advisory lock); the
others skip that pass. It deletes, in small batches:

- expired authorization codes, access tokens, sign-ins in progress and
  sessions;
- refresh tokens past their idle or total window;
- spent codes and refresh tokens past their 30 days, once their connection has
  no live token;
- tokens whose user is gone;
- expired connections once nothing is left under them;
- abandoned and unused clients, once nothing refers to them.

It never deletes users: that is the opt-in "Erasing inactive users" below. A
failed pass is logged and the next one runs on schedule. The log gives counts
only, never a token, user or client id:

```text
[Sweep] expired-rows: deleted accessTokens=12 refreshTokens=3 oauthAbandonedClients=1
```

### Erasing inactive users

Off by default. Set `MCP_INACTIVE_USER_DAYS` (30 to 3650) to erase users who
have been inactive that long and have no live connection. A background job
runs about a minute after startup, then hourly. It erases each such user with
the same step as deleting an account: their stored YNAB grant, connections,
tokens and codes.

- **Inactive** means no sign-in, no re-consent and no YNAB token refresh. A
  refresh happens about every two hours while the user makes requests, so any
  real use resets the clock. Users who existed before the upgrade start their
  clock at the upgrade (the first 0.5.0 start), not at their older activity.
- **No live connection** means no unexpired MCP access token, refresh token or
  authorization code, and no sign-in in progress. A connection keeps the user
  however old their last activity is.
- Both conditions are checked again inside the erase's transaction, so a user
  who signs in, or whose client refreshes a token, while the job runs is kept.
- The job logs a count only, never a user id:

  ```text
  [InactiveUsers] erased 2 user(s) not seen for 365 days and with no live grant
  ```

An erased user who comes back signs in again as a new account. The YNAB grant
itself is not revoked at YNAB: the user can remove it under "Connected Apps" in
YNAB's settings.

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

Clients that send no `resource` still work. If you change `MCP_RESOURCE_URL` (or `PUBLIC_URL`
when it supplies the default), tokens issued for the old URL stop working and
users must reconnect.

### Refresh-token rotation and reuse detection (RFC 9700)

Refresh tokens are single-use: each refresh returns a new pair, and every
token issued from one authorization (one connection) belongs to the same token
family. A spent refresh token is remembered for 30 days. If it is presented
again, the server treats it as stolen: it revokes the whole family (every access
and refresh token of that connection, effective immediately) and answers
`invalid_grant`, exactly as for an unknown token, so the user must reconnect
that client. The same happens when a refresh token is presented by a client it
wasn't issued to, or revoked at `/revoke`. A client that sends two refreshes
with the same token at once also trips this: one request wins, the other looks
like reuse and revokes the family, including the pair the winner just got.
That is the intended RFC 9700 behaviour; well-behaved clients serialize their
refreshes. Other connections of the same user are unaffected. A spent refresh
token presented after it expired still counts as reuse while it is remembered.

Authorization codes get the same treatment (RFC 9700 section 4.2.4, RFC 6749
section 4.1.2). A code is single-use, and a spent code is remembered for 30
days. If it is presented again, from any client and even after it expired, the
server treats it as leaked: it revokes the connection the code started (the
tokens issued for it and every refresh since) and answers `invalid_grant` with
the same response as for an unknown code. A code presented by a client it
wasn't issued to revokes it too. This also covers a replay that arrives while
the first exchange is still running: whichever request redeemed the code
first, an attacker or the client, the connection it started is cut off and the
user must reconnect. Clients that send each code once, as OAuth requires, are
unaffected.

0.4.x tokens and codes don't carry over to 0.5.0: see "Upgrading to 0.5.0:
the authorization server".

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

## Client addresses and rate limits

The OAuth endpoints are rate limited per client, so the server has to know the
client's address. It takes it from the socket, or, behind a reverse proxy, from
`X-Forwarded-For` as far as `TRUST_PROXY` says to trust it.

**Get this wrong and one of two things happens.**

- `TRUST_PROXY` too low (the default `0` behind a proxy): every client appears
  to connect from the proxy, so all of them share one bucket and one client's
  burst locks everyone out of `/register`, `/authorize`, `/token` and `/revoke`.
  The server logs a warning at startup when `TRUST_PROXY=0` and `PUBLIC_URL` is
  not localhost.
- `TRUST_PROXY` too high: the server trusts entries that the client wrote
  itself, so anyone can pick a fresh address per request and never be limited.

### Which address is used

`TRUST_PROXY=N` trusts the last N hops, counting the socket peer as the first.
The address used is the first one past those hops: with `X-Forwarded-For:
a, b, c` and `TRUST_PROXY=1`, the socket peer is trusted and the address is
`c`; with `2` it is `b`. Entries to the left of that are ignored, because the
client could have written them.

| Your setup | `TRUST_PROXY` | `TRUST_CF_CONNECTING_IP` | Address used |
|---|---|---|---|
| Clients connect straight to the server (no proxy) | `0` (default) | `false` | The socket peer. `X-Forwarded-For` and `CF-Connecting-IP` are ignored |
| One proxy: Caddy, nginx or Traefik, no CDN | `1` | `false` | The right-most `X-Forwarded-For` entry, the address the proxy saw connect |
| Two proxies: a load balancer, then nginx | `2` | `false` | The second entry from the right, the address the first proxy saw connect |
| Cloudflare straight to the server | `1` | `false` | The right-most `X-Forwarded-For` entry, which Cloudflare appends |
| Cloudflare straight to the server, header preferred | `1` | `true` | `CF-Connecting-IP`, when it is a valid IP; else as the row above |
| Cloudflare, then one proxy of yours | `2` | `false` | The second entry from the right |
| Cloudflare, then one proxy of yours, header preferred | `2` | `true` | `CF-Connecting-IP`, when valid; else as the row above |

Rules that apply to every row:

- With two or more proxies, **each downstream proxy must append to the
  `X-Forwarded-For` chain it received, not overwrite it.** A proxy that
  replaces the header with its own socket peer discards the earlier addresses,
  and no hop count can recover them: every client then shares the address of
  the first proxy. (nginx: `proxy_set_header X-Forwarded-For
  $proxy_add_x_forwarded_for;`. Caddy and Traefik append by default.)

- `TRUST_PROXY` is the number of proxies **between the client and this server**
  (Cloudflare counts as one). A proxy of yours that overwrites
  `X-Forwarded-For` instead of appending is still one hop.
- `CF-Connecting-IP` is read **only** with `TRUST_CF_CONNECTING_IP=true`, and
  it is independent of `TRUST_PROXY`. Turn it on only when the server can be
  reached **only** through Cloudflare (a Cloudflare Tunnel, or a firewall that
  admits Cloudflare's address ranges alone). Otherwise anyone who connects
  directly can send the header and choose their own address. A header that is
  not a single valid IP is ignored.
- IPv6 clients are keyed by their `/64`, so one host cannot get a new bucket
  by changing the low 64 bits of its address. An IPv4-mapped IPv6 address
  (`::ffff:a.b.c.d`) is keyed as the IPv4.
- To check your setting, send a request through the proxy and read the
  `RateLimit` headers on a `/token` response from two different networks: they
  should count separately.

### What is limited, and by what key

An unauthenticated endpoint is keyed by **(client_id, address)**, never by
`client_id` alone: a `client_id` is public, so anyone who knew one could spend
its budget. Each such endpoint also has an address-only ceiling of ten times
its limit, so rotating `client_id` does not give one address unlimited buckets.
The ceilings and the per-address `/register` limit are checked before the body
is read, so a request past them costs no parsing.

| Endpoint | Limit | Key |
|---|---|---|
| `/authorize` | 100 per 15 minutes | (`client_id`, address) |
| `/token` | 50 per 15 minutes | (`client_id`, address) |
| `/revoke` | 50 per 15 minutes | (`client_id`, address) |
| `/oauth/*` (YNAB login legs) | 200 per 15 minutes (a sign-in takes 4) | address |
| `/register` | `REGISTER_RATE_LIMIT_PER_IP` per hour (default 100) | address |
| `/register` | `REGISTER_RATE_LIMIT_PER_HOST` per hour (default 20) | each redirect URI host |

`/register` has two limits because hosted MCP clients such as claude.ai
register from one small range of addresses, so a low per-address limit would
lock their users out of each other, while the redirect host is what they
share. A registration naming several hosts is counted against each of them.
Loopback redirects (`localhost`, `127.0.0.1`, `[::1]`) and private-use schemes
are shared by native clients everywhere, so they are keyed by host **and**
address instead of by host alone. So is a verified host: the host of an entry
on `MCP_VERIFIED_REDIRECT_URIS` (by default `claude.ai` and `claude.com`).
Every user of that client shares it and anyone can name it, so keyed by host
alone, one caller could lock that client out for everyone.

The `client_id` for `/token` and `/revoke` is the `client_id` form field (the
one client authentication checks; an HTTP Basic user is not read). For
`/authorize` it is the query parameter (only GET is served). The browser's
return from the consent page (`/authorize/<id>`) carries no `client_id` and
counts against the address, so one sign-in costs two `/authorize` requests.
The address-only ceilings are 1000 per 15 minutes on `/authorize` and 500 on
`/token` and on `/revoke`.

A registration is checked (see "Client registration and authorization
errors") before any redirect host is counted, so a refused one uses none of a
host's budget; it still counts against the per-address limit. A body with more
than 5 `redirect_uris` is refused with 400 `invalid_client_metadata`.

Any other redirect host is shared across addresses by design, so someone can
spend that host's `/register` budget by naming it; the per-address limit bounds
how fast.

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
  from any origin. The only cookies are the authorization server's signed
  `SameSite=Lax` sign-in cookies, which prove which browser saw the consent
  page and grant nothing by themselves.
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
migrates the schema in place. Migrations only add nullable columns, tables and
indexes, and are safe to re-run. 0.4.0 adds a `resource` column to
`pending_auth`, `auth_codes`, `access_tokens` and `refresh_tokens`, a
`granted_scope` column to `auth_codes`, `access_tokens` and `refresh_tokens`, a
`browser_binding` column to `pending_auth`, a `family_id` column (indexed) to
`access_tokens` and `refresh_tokens`, and a `consumed_refresh_tokens` table
(spent refresh tokens, pruned after 30 days). Existing read-write users must reconnect once to get write
access back (see "Access level per connection"). On Postgres the migration runs in one
transaction under an advisory lock, so replicas that start together don't race.
Before 0.5.0 the previous release could still read a migrated database if you
needed to roll back; 0.5.0's token hashing is the exception (see below).

### Hashed tokens and the pepper (0.5.0)

0.5.0 stores MCP access tokens, refresh tokens, authorization codes and
pending-authorization `state` only as keyed hashes (`h1.` + HMAC-SHA256), and
DCR client secrets only as `s256.` + SHA-256. On the first start it rewrites the
existing rows in place (the M3 migration, in the same transaction and lock as
the rest). Since the authorization server move (see the next section), those
0.4.x rows are no longer read, so their tokens stop working anyway; the
pepper still keys every token and code 0.5.0 issues.

- **Back up first.** The rewrite can't be undone. Rolling back to 0.4.x after
  it means every user reconnects (0.4.x can't look up hashed tokens), and
  confidential DCR clients read as public clients on 0.4.x. No YNAB data is
  lost.
- **Choose the pepper before the first 0.5.0 start.** The hashes are keyed by
  `TOKEN_PEPPER`, or, when it is unset, by a pepper derived from
  `ENCRYPTION_KEY`. The database records the pepper's fingerprint on that first
  start, and a later start with a different pepper (a new `TOKEN_PEPPER`,
  setting or removing it, or a new `ENCRYPTION_KEY` when `TOKEN_PEPPER` is
  unset) refuses to start with an error naming no value.
- **Run one version at a time.** Rows that a 0.4.x process writes into a
  migrated database aren't usable by 0.5.0.

### Upgrading to 0.5.0: the authorization server

0.5.0 replaces the OAuth authorization server (the MCP SDK's frozen
`server-legacy` handlers) with [oidc-provider](https://github.com/panva/node-oidc-provider).
Clients, tokens and codes now live in one `oauth_rows` table, which the first
0.5.0 start creates.

- **Registered clients carry over.** The first start converts every client
  registered under 0.4.x, so no client has to register again. A client that
  fails the new registration rules is dropped (the log names it, without its
  details) and has to register again. A converted client's 90-day unused
  window starts at the conversion.
- **Tokens don't: every user signs in again once per client.** 0.4.x access
  tokens, refresh tokens and authorization codes, and sign-ins in progress,
  stop working at the upgrade. A client's next request is refused, and it
  sends the user through the consent page and YNAB's approval again. That is
  one sign-in per user per client: 6 for a family instance with 3 users and 2
  clients each. The claude.ai connector shows as disconnected until it is
  reconnected. **Tell your users to expect this.**
- **The old token tables stay, unread.** `access_tokens`, `refresh_tokens`,
  `auth_codes`, `pending_auth`, `consumed_refresh_tokens` and
  `consumed_auth_codes` keep their rows, unread. The sweep keeps deleting
  expired rows from them on the usual schedule, and deleting an account
  removes the user's rows there too. 0.6 drops them.
- **Rolling back to 0.4.x means restoring the pre-upgrade backup.** 0.4.x
  can't read the schema or the encrypted data 0.5.0 writes, so take the
  backup before the first 0.5.0 start.
- **A `PUBLIC_URL` with a path** (for example `https://example.com/ynab`): the
  YNAB legs and the consent page are linked under that path (`/ynab/oauth/...`),
  but the authorization server's own endpoints are published at the root of
  the host (`/authorize`, `/token`, `/register`, `/revoke`, `/jwks` and the
  discovery documents, including the return through `/authorize/<id>`), as
  0.4.x published them. Such a deployment must route those root paths to the
  server as well as the prefixed ones.
- **What clients may notice:** `POST /authorize` answers `405`;
  `prompt=none` answers `login_required`; `token_type` is `Bearer`; a
  read-write token's `scope` is `read-only read-write`; the registration
  response has more fields and `client_secret_expires_at: 0`; discovery lists
  OIDC fields and `jwks_uri`; error descriptions read differently; and an
  `invalid_client` from the library itself is `401`. See the changelog.
- **New routes and cookies:** `/.well-known/openid-configuration`, `/jwks`,
  the consent page at `/oauth/interaction/<id>` and the return through
  `/authorize/<id>` (see "Consent screen and browser binding").
  `/oauth/ynab/start` and `/oauth/cancel` are gone. The YNAB redirect URI
  (`/oauth/ynab/callback`) is unchanged, so nothing changes at YNAB.

### Changing TOKEN_PEPPER

Changing the pepper logs every user out (every stored token stops matching).
To do it deliberately: stop the server, back up, delete the fingerprint, and
start with the new value. Clear the token tables too, since their rows can no
longer be used:

```sql
DELETE FROM schema_meta WHERE key = 'token_pepper_fingerprint';
DELETE FROM access_tokens; DELETE FROM refresh_tokens; DELETE FROM auth_codes;
DELETE FROM pending_auth; DELETE FROM consumed_refresh_tokens; DELETE FROM consumed_auth_codes;
DELETE FROM oauth_rows WHERE model <> 'Client';
```

Users and their encrypted YNAB refresh tokens are kept; every client
reconnects once.

### Encrypted YNAB tokens (0.5.0)

0.5.0 stores each user's YNAB refresh token as `v2.<key id>.<iv>.<tag>.<ct>`
(AES-256-GCM). The ciphertext is bound to its column and to the user it
belongs to, so one copied into another user's row, or restored into another
column, fails to decrypt. Tokens stored by 0.4.x (`v1.…`, no key id, no
binding) are still read, as key id 1.

A background job (the rekey job, first run about 10 seconds after startup,
then every 5 minutes) rewrites every `v1` row, and every row under an older
key id, under the current key. It logs one line with counts only, for
example:

```text
[Rekey] re-encrypted 3, 0 remaining
```

The shared YNAB access token (see "Several replicas: YNAB token refresh") is
rewritten too, under its own binding. One that has expired, or that no
configured key opens, is cleared instead (the next request refreshes), so it
never holds retirement back. The line then ends
`; shared access tokens: 2 re-encrypted, 1 dropped`. The retirement's final
check looks only at refresh tokens: a shared access token left under a
retired key (written just before the announcement) can't be read any more,
counts as absent, and the next request refreshes. It lasts two hours at most,
and nothing is lost with it.

Retirement takes two steps:

1. When a pass finds nothing left under an older key or in the `v1` format,
   it announces the retirement in the database and logs `… nothing is left
   under older keys: the v1 format and the older key ids are retired in
   about an hour, and a replica still on an older ENCRYPTION_KEY_ID now
   refuses to write`. From then on, a replica whose `ENCRYPTION_KEY_ID` is
   older refuses every new refresh and sign-in before it calls YNAB, so it
   doesn't spend a user's token on a write the others are about to stop
   reading. (One already past that check finishes and is stored; see below.)
   Its log says `Refusing to write with ENCRYPTION_KEY_ID …`. Until it is
   restarted with the current key, a request it would have to refresh a
   token for gets `503` with `Retry-After: 30` (a tool call an
   `upstream_unavailable` result), not a reconnect: the user's stored token
   is fine, and a retry may reach another replica. A sign-in through it
   fails.
2. A pass at least an hour later that still finds nothing left retires them,
   and logs:

   ```text
   [Rekey] no rows are left under older keys: the v1 format and key ids below 2 are now refused
   ```

   The raise checks the table again in the same statement: a token written
   under an older key after the pass read the table (by a 0.4.x process, for
   example, which has no key checks) holds it back, and the next pass moves
   that token to the current key (`[Rekey] a token was written under an older
   key since the pass began: retirement waits for the next pass`).

Two guards keep a token from being stored where no replica can read it:

- **At the write.** Every write of a YNAB token (a sign-in, a refresh) reads
  the retired key id in the same database transaction as the write (on
  Postgres, holding it `FOR SHARE`; the retirement takes the same row `FOR
  UPDATE` first, so one waits for the other). A write under a retired key is
  refused and nothing is stored. A sign-in fails with the usual authorization
  error. A refresh gets `503` with `Retry-After: 30`, like the key check, but
  the token YNAB rotated during the call is lost with it, so the user
  connects again once. This covers a request that passed its key check and
  then stalled past the retirement.

  A write that lands after the announcement but before the retirement (a
  refresh already in flight when the announcement came) is stored as usual.
  The old key is still configured everywhere, so the token is readable, and
  it holds the retirement back until the next pass moves it to the current
  key. Refusing it would only throw away the token YNAB has just rotated.
- **The grace outlasts every write.** The hour between the announcement and
  the retirement is longer than the longest time a token write can take
  after its check. A sign-in is bounded by the YNAB callback's 10-minute
  deadline. A refresh is bounded by its YNAB call's own timeout (10 seconds),
  not by `MCP_REQUEST_TIMEOUT_MS`: the request ceiling ends the client's
  response but doesn't cancel a refresh already under way. Then the write
  itself is bounded by the database time limits. The server adds these up,
  with the request ceiling (at most 5 minutes) as a conservative allowance,
  and refuses to start if a configuration would make the total reach the
  hour. So a write that passed its check before the announcement has always
  landed, and held the retirement back, before the retirement.
- **Accepted residual.** Only a process that stops running escapes those
  bounds. If a replica's process freezes (suspended, or stalled) for longer
  than the retirement grace during a rotation, after YNAB has rotated a
  user's token and before it is stored, that token can't be kept: the write
  is refused, nothing unreadable is stored, and that user connects again
  once.

From then on every replica refuses `v1` and those key ids, so an old
ciphertext restored from a backup can't get round the binding. The binding
protects from the upgrade on: a `v1` ciphertext carries none, so one copied
into another user's row before the upgrade is rewritten as that row's. Nothing
needs doing on upgrade.

- **Rolling back means restoring the backup** you took before upgrading. 0.4.x
  has no schema-version check, so it does start on a 0.5.0 database, but it
  can't read the tokens 0.5.0 stores (`v2` YNAB tokens, hashed MCP tokens), so
  every user would reconnect and the rows would be left half converted.
- **Don't run 0.4.x and 0.5.0 replicas against the same database**, not even
  briefly during a rolling deploy: each writes rows the other can't read, and
  `v1` rows a 0.4.x replica writes after 0.5.0 has retired `v1` are refused.
- A line ending `… unreadable (those users must connect again)` counts rows
  no configured key opens. Those users reconnect, which replaces the row.
- A line with `N under a key id that is not configured` counts rows whose key
  is missing from `ENCRYPTION_KEY_PREVIOUS`. They hold retirement back. Add
  the key back as `<id>:<key>`; if that key is lost, those users can't be
  read in any case: each one's row is replaced when they connect again, or
  goes when the account is erased (deleting the account, or #54's
  inactive-user erase). Once none are left, retirement proceeds.

### Rotating ENCRYPTION_KEY

Rotate without logging anyone out. Start 0.5.0 at least once with the
current key before rotating: that start records which key id 1 is, so a
wrong key given as `1:<old key>` later is refused instead of recorded.

1. **Pin the pepper (once).** Unless `TOKEN_PEPPER` is already set, the
   token-hash pepper is derived from `ENCRYPTION_KEY`, and a new key would
   change it (the server then refuses to start). With the **current**
   `ENCRYPTION_KEY` in the environment, run:

   ```bash
   # npm / npx
   ENCRYPTION_KEY=<current key> npx -y ynab-mcp derive-pepper
   # Docker: the entrypoint is dumb-init, so name the command in full
   docker run --rm -e ENCRYPTION_KEY ghcr.io/auzroz/ynab-mcp:latest node dist/index.js derive-pepper
   ```

   It prints the pepper (64 hex characters) on stdout and nothing else there.
   Set `TOKEN_PEPPER` to it, keep it as secret as the key, and restart. The
   pepper is unchanged, so nobody is logged out; from now on it no longer
   depends on `ENCRYPTION_KEY`. If `TOKEN_PEPPER` is already set it prints
   nothing and exits with status 2; on a missing or malformed key it exits
   with status 1.

   A script that captures the output must check the exit status before it
   stores or exports the value, and keep the existing value on failure. An
   assignment like `TOKEN_PEPPER=$(…)` takes the empty output even when the
   command fails:

   ```bash
   if pepper=$(npx -y ynab-mcp derive-pepper); then
     printf 'TOKEN_PEPPER=%s\n' "$pepper" >> .env   # or store it in your secret manager
   else
     echo "derive-pepper failed; TOKEN_PEPPER left unchanged" >&2
   fi
   ```
2. **Switch keys.** Generate a new key (`openssl rand -base64 32`) and set:

   ```bash
   ENCRYPTION_KEY=<new key>
   ENCRYPTION_KEY_ID=2                  # the old key's id + 1 (the old key was 1 unless you set an id)
   ENCRYPTION_KEY_PREVIOUS=1:<old key>  # comma-separate several: 1:<key>,2:<key>
   ```

   Restart. New tokens are written under id 2; tokens under id 1 are still
   read.

   With several replicas behind one database, do this in two rolling
   restarts, so no replica meets a row it can't read:

   1. First give every replica the new key to read only, keeping the old one
      current: `ENCRYPTION_KEY=<old key>`, `ENCRYPTION_KEY_ID=1`,
      `ENCRYPTION_KEY_PREVIOUS=2:<new key>`. Nothing is written under id 2
      yet, and the rekey job leaves rows under a newer id alone.
   2. Then switch every replica to the settings above (new key current as id
      2, `1:<old key>` previous).

   **Finish phase 2 on every replica before the old key can retire.** As
   soon as a replica on id 2 finds nothing left under id 1, it announces the
   retirement, and from then on any replica still on id 1 refuses to write
   (see "Encrypted YNAB tokens" above): no token is lost, but that replica's
   users can't refresh or sign in until it is updated. To confirm every
   replica is on the new key, check that each one was restarted with
   `ENCRYPTION_KEY_ID=2` (your deployment's config and restart times), and
   that no replica logs `Refusing to write with ENCRYPTION_KEY_ID 1`. A
   replica that restarts with the old settings after the announcement is
   refused at startup.
3. **Watch the log.** The rekey job rewrites the old rows (`[Rekey]
   re-encrypted N, M remaining`), announces the retirement once none are
   left, and about an hour later logs that key ids below 2 are now refused.
4. **Drop the old key.** Remove `ENCRYPTION_KEY_PREVIOUS` and restart.

To abandon a rotation after the announcement (going back to the old key on
every replica), stop every replica and delete the announcement:
`DELETE FROM schema_meta WHERE key = 'encryption_retiring_below';`. Once the
retirement itself has been logged, it can't be undone this way: the old key
ids are refused for good.

The server refuses to start, naming no value, when the key under an id is not
the one the database recorded for that id (a new key needs a new id), when
`ENCRYPTION_KEY_ID` is below an id that has been retired or announced for
retirement, or when
`ENCRYPTION_KEY_PREVIOUS` is set without `TOKEN_PEPPER`. Before 0.5.0 a new
`ENCRYPTION_KEY` could be swapped in place, with every user reconnecting; from
0.5.0 on, a new key always needs a new `ENCRYPTION_KEY_ID`.

If the old key is lost, set the new key under a new id without
`ENCRYPTION_KEY_PREVIOUS`: every user reconnects once. If `TOKEN_PEPPER` was
not set, the pepper was derived from the lost key and can't be recovered
(`derive-pepper` needs that key), so also follow "Changing TOKEN_PEPPER"
above, which logs every MCP client out as well.

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

- YNAB refresh tokens, and the YNAB access token the replicas share, are
  encrypted at rest with AES-256-GCM (`ENCRYPTION_KEY`), each bound to its user
  and column and tagged with its key id. Keep the key
  secret. It can be rotated without logging anyone out: follow "Rotating
  ENCRYPTION_KEY" (pin `TOKEN_PEPPER` with `ynab-mcp derive-pepper` first, or
  the server refuses to start because the derived pepper would change).
- MCP tokens, authorization codes and `state` are stored only as keyed hashes,
  and DCR client secrets only as SHA-256 hashes, so a copy of the database holds
  no usable MCP credential. A value that isn't a correctly tagged `ymcp1_` token
  (or a 0.4.x-shaped one) is refused without a database read. `/token` and
  `/revoke` verify client secrets behind a per-(client_id, address) limit (50
  per 15 minutes per route); see "Client addresses and rate limits".
- Access is read-only or read-write **per connection**, per the consent choice
  for that client; the server also honors a global `YNAB_READ_ONLY=true`
  override.
- Always run behind TLS; enable DNS-rebinding protection with an allowlist.
- `memory` storage is for evaluation only — it is not durable and not shared across
  replicas. For multiple replicas, use `postgres` (the in-flight caps, rate
  limits, write cap and caches are currently in-process; a shared store would be a future
  enhancement). YNAB token refreshes are coordinated through the database; see
  "Several replicas: YNAB token refresh".

## Interim header mode (single-user)

With `AUTH_MODE=header`, HTTP mode uses **header auth**: the
YNAB token is supplied per request via `X-YNAB-Token` (or the `YNAB_ACCESS_TOKEN`
env for a single user). This is handy for a personal remote instance:

```bash
MCP_TRANSPORT=http AUTH_MODE=header MCP_BIND_HOST=127.0.0.1 YNAB_ACCESS_TOKEN=… npm start
npx mcp-remote http://localhost:3000/mcp --header "X-YNAB-Token: <token>"
```

Serve behind TLS; this mode has no per-user isolation beyond the token you send.

> **Behind a reverse proxy on the same host, a loopback bind does not protect
> `YNAB_ACCESS_TOKEN`.** The proxy connects over loopback, so the startup check
> passes while every request through it without `X-YNAB-Token` acts as you.
> Behind a proxy, omit `YNAB_ACCESS_TOKEN` or restrict access at the proxy.

Any non-empty token is accepted as a user, so anyone who can reach `/mcp` can use up
`MCP_MAX_INFLIGHT` (see [Requests, limits and timeouts](#requests-limits-and-timeouts)); keep it off the public internet or
restrict access at the proxy.
