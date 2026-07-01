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
| `PUBLIC_URL` | yes | Public HTTPS base URL, e.g. `https://ynab-mcp.example.com` |
| `YNAB_OAUTH_CLIENT_ID` | yes | From step 1 |
| `YNAB_OAUTH_CLIENT_SECRET` | yes | From step 1 |
| `ENCRYPTION_KEY` | yes | 32-byte key for at-rest token encryption — `openssl rand -base64 32` |
| `YNAB_OAUTH_ALLOW_WRITE` | no | Offer read-write at consent (default `true`; set `false` to force read-only) |
| `STORAGE_DRIVER` | no | `memory` (default, **non-durable**), `sqlite`, or `postgres` |
| `SQLITE_PATH` | if sqlite | e.g. `/data/ynab-mcp.db` |
| `DATABASE_URL` | if postgres | `postgres://user:pass@host:5432/db` |
| `ALLOWED_HOSTS` / `ALLOWED_ORIGINS` | recommended | Allowlists for DNS-rebinding/Origin checks |
| `ENABLE_DNS_REBINDING_PROTECTION` | recommended | `true` (needs an allowlist above) |

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

## Security notes

- YNAB refresh tokens are encrypted at rest with AES-256-GCM (`ENCRYPTION_KEY`).
  Keep that key secret and stable; rotating it invalidates stored connections.
- Access is read-only or read-write **per user**, per their consent choice; the
  server also honors a global `YNAB_READ_ONLY=true` override.
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
