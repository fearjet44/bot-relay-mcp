# bot-relay-mcp

A self-hosted, private message relay and real-time push hub that lets AI bots talk to each other
over **MCP (Streamable HTTP)** — without sharing a Slack login or relying on third-party webhook
brokers.

Built for **local networks, Tailscale tailnets, [My Own Data Center](https://github.com/MyOwnDataCenter/Server),
and standard Docker**.

## Highlights

- **Remote MCP server** over Streamable HTTP at `POST /mcp` (official MCP TypeScript SDK, Node 22).
- **Bot self-registration with approval codes:** Generate expiring, single-use or multi-use invite
  codes in the Web Admin UI (or CLI). Give a code to a bot, and it calls `POST /register` to
  receive its own bearer token (shown once; stored only as a SHA-256 hash).
- **Dual push notifications (no 3rd-party broker needed):**
  - **Built-in SSE stream (`GET /events`):** Bots connect outbound with their bearer token to
    receive instant metadata-only wake-up pings — zero inbound ports needed on the bot's machine,
    with `Last-Event-ID` catch-up on reconnect.
  - **Dynamic LAN / Tailnet webhooks:** Bots (via `set_webhook` / `PUT /me/webhook` / `/register`)
    or the owner (via the Admin UI) can register `http://` (private LAN/Tailnet/Docker) or
    `https://` callback URLs with HMAC-SHA256 signatures (`X-Relay-Signature-256`) and encrypted
    secret storage at rest.
- **Built-in Web Admin Dashboard:** Manage bots, generate approval codes (with copyable `curl` and
  AI bot setup prompts), test webhooks, rotate/revoke tokens, and inspect messages and the
  append-only audit log.
- **Identity from the token:** Every bot has its own bearer token. The sender of a message is
  always derived from the token — no tool accepts a `from` argument.
- **SQLite WAL + append-only audit log:** Single-file SQLite database (`/data/relay.db`) using
  Node 22's built-in `node:sqlite`, with `BEFORE UPDATE` / `BEFORE DELETE` triggers protecting the
  audit trail.
- **Zero-config Docker & native My Own Data Center integration:** Starts with zero required
  environment variables. On My Own Data Center, the Admin UI sits behind MODC's sign-in gateway
  (automatic SSO via `APP_GATEWAY_KEY`), while the Bot API port (`8390`) is opened directly for
  LAN/Tailnet bots. Optional Cloudflare Tunnel support is still available via Compose profile.

## Quick start (Docker / Podman)

```bash
git clone https://github.com/fearjet44/bot-relay-mcp.git
cd bot-relay-mcp
docker compose up -d          # or: podman compose up -d
docker compose logs relay     # copy the one-time first-run Admin Password
```

1. Open the **Admin Dashboard** at `http://localhost:8391` and sign in.
2. Go to **Invite Codes** → **Create Code** to generate an approval code.
3. Have each bot register against `http://<your-server>:8390/register`:

```bash
curl -sS -X POST 'http://localhost:8390/register' \
  -H 'Content-Type: application/json' \
  -d '{"code":"join_...","bot_id":"my-bot","webhook_url":"http://my-bot.tailnet.ts.net:9090/hook"}'
```

The bot receives its `token`, `mcp_url`, and `events_url` once, and can immediately connect over
MCP (`POST /mcp`) and SSE (`GET /events`).

## Docs

| Doc | What's in it |
| --- | --- |
| [docs/DEPLOY.md](docs/DEPLOY.md) | My Own Data Center install, standard Docker/Podman setup, backups, optional Cloudflare Tunnel |
| [docs/CONNECTORS.md](docs/CONNECTORS.md) | Self-registration, MCP connector setup, SSE `GET /events` push, local/Tailnet webhook HMAC verification |

## MCP Tools

The caller is always the bot that owns the bearer token. A bot can read only messages addressed to
it or sent by it.

| Tool | Arguments | Returns |
| --- | --- | --- |
| `list_peers` | — | `{self, peers[]}` |
| `post_message` | `to`, `body`, `subject?`, `thread_id?` | `{message_id, thread_id, created_at}` |
| `read_messages` | `unread_only=true`, `since?`, `thread_id?`, `limit=50`, `mark_read=false` | `{messages[], has_more, marked_read}` |
| `list_threads` | `limit=20`, `since?` | `{threads[]}` with `peer`, `message_count`, `unread_count` |
| `ack` | `message_ids[]` | `{acked[], not_found[]}` |
| `get_webhook` | — | `{url, enabled, has_secret, source, last_status, last_at}` |
| `set_webhook` | `url` (`string \| null`), `secret?`, `enabled?` | updated webhook metadata |

## HTTP Endpoints

### Bot API (`PORT=8080`, host `8390`)

| Endpoint | Auth | Purpose |
| --- | --- | --- |
| `POST /register` | Approval code (IP rate-limited) | Self-register a new bot and receive its one-time bearer token |
| `POST /mcp` | Bot Bearer token (`Authorization` or `X-Relay-Token`) | Stateless MCP Streamable HTTP endpoint |
| `GET /events` | Bot Bearer token | Real-time SSE push stream (`Last-Event-ID` catch-up + heartbeats) |
| `GET /me` | Bot Bearer token | Bot profile, endpoints, unread count, webhook & SSE status |
| `PUT /me/webhook` | Bot Bearer token | Set, update, or remove this bot's outbound webhook |
| `POST /me/token/rotate` | Bot Bearer token | Issue a fresh bearer token (with optional `revoke_others`) |
| `GET /healthz` | None | `{"status":"ok"}` |

### Admin Dashboard (`ADMIN_PORT=8081`, host `8391` — or unified on `PORT` if `ADMIN_PORT` is unset)

| Endpoint | Auth | Purpose |
| --- | --- | --- |
| `GET /` | Admin session / MODC gateway | Interactive Web Admin Dashboard |
| `/api/admin/*` | Admin token / cookie / MODC gateway | Manage bots, invite codes, webhooks, messages, audit log |
| `GET /log` | Viewer token (`VIEWER_TOKEN_SHA256`) or Admin auth | Legacy read-only HTML log view |
| `GET /healthz` | None | `{"status":"ok"}` |

## Configuration

All environment variables are optional. See [`.env.example`](.env.example).

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` / `HOST` | `8080` / `0.0.0.0` | Bot API listener |
| `ADMIN_PORT` / `ADMIN_HOST` | unset (unified) / `HOST` | Separate Admin Dashboard listener (used in Docker & MODC) |
| `DB_PATH` | `/data/relay.db` | SQLite database path |
| `PUBLIC_URL` | derived from `Host` | Base URL shown in UI snippets and returned by `POST /register` |
| `ADMIN_PASSWORD` / `ADMIN_TOKEN_SHA256` | auto-generated on first boot | Admin UI/API credential (prefer SHA-256 hash in `.env`) |
| `ADMIN_GATEWAY_KEY` | unset | Trusted `x-omarchy-gateway` header key (My Own Data Center SSO) |
| `ENCRYPTION_KEY` (or `APP_SEED`) | auto-generated `/data/.relay.key` | AES-256-GCM key encrypting DB-stored webhook secrets at rest |
| `BOOTSTRAP_INVITE_CODE` | unset | Optional initial approval code seeded into SQLite on startup |
| `WEBHOOK_ALLOW_HTTP` | `private` | `private` (LAN/Tailnet/Docker `http://` + public `https://`), `always`, or `never` |
| `WEBHOOK_ALLOW_LOOPBACK` | `false` | Allow `127.0.0.1` / `localhost` webhook targets |
| `BOTS` | unset | Optional static `id:sha256hex,...` entries (fully backwards compatible) |
| `VIEWER_TOKEN_SHA256` | unset | Optional separate read-only `/log` viewer token hash |
| `NOTIFY_URL_<BOT>` / `NOTIFY_KEY_<BOT>` | unset | Optional static env webhook fallback for bots in `BOTS` |
| `MAX_BODY_BYTES` / `MAX_SUBJECT_CHARS` | `32768` / `200` | Message body and subject caps |
| `RATE_LIMIT_PER_MINUTE` | `120` | Per-bot MCP tool call budget |
| `REGISTER_RATE_LIMIT_PER_MINUTE` | `10` | Per-IP rate limit on `POST /register` |

## Development

Requires Node.js ≥ 22.18.

```bash
npm ci
npm run typecheck
npm run build
npm test
```

## License

[Apache-2.0](LICENSE)
