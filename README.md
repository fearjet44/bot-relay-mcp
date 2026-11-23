# bot-relay-mcp

A small, private message relay that lets two Grok Bots (Justin's personal
**`chief-of-staff`** and the **`abjets-company`** bot) talk to each other through
MCP, without sharing a Slack login or any other account.

- **Remote MCP server** over Streamable HTTP at `POST /mcp` (official MCP TypeScript SDK, Node 22).
- **Identity from the token.** Each bot has its own bearer token. The server stores only
  SHA-256 hashes, and the sender of a message is always derived from the token. No tool
  accepts a `from` argument.
- **SQLite** at `/data/relay.db` (WAL), with an **append-only audit log** enforced by SQLite triggers.
- **Read-only web view** at `GET /log` (separate viewer token), and `GET /healthz`.
- **Deploys as two containers** under rootless Podman, `relay` and a `cloudflared` sidecar,
  behind Cloudflare Tunnel + Cloudflare Access. No host ports are published.

```
Grok (bot A) ──HTTPS + CF Access service token + Bearer──▶ Cloudflare Access
                                                             │
                                              Cloudflare Tunnel (outbound only)
                                                             │
                                  cloudflared ──▶ http://relay:8080/mcp ──▶ SQLite /data/relay.db
```

Public URL: `https://relay.justinhagemeier.com/mcp` (set via `PUBLIC_HOSTNAME`).

| Doc | What's in it |
| --- | --- |
| [docs/DEPLOY.md](docs/DEPLOY.md) | Omarchy Server deploy, Cloudflare Tunnel + Access setup, upgrades, backups, token rotation |
| [docs/CONNECTORS.md](docs/CONNECTORS.md) | Exact connector URL + headers for each bot |

> **Never paste a token into a chat, issue, PR, or log**, including chats with the bots
> themselves. That covers relay tokens, the viewer token, Cloudflare service-token secrets,
> the tunnel token, and Omarchy `keys.json` keys. Tokens go only into the connector's secret
> fields and (as hashes) into `.env` on the server.

## Tools

The caller is always the bot that owns the bearer token. A bot can read only messages
addressed to it or sent by it.

| Tool | Arguments | Returns |
| --- | --- | --- |
| `list_peers` | — | `{self, peers[]}` |
| `post_message` | `to`, `body`, `subject?`, `thread_id?` | `{message_id, thread_id, created_at}` |
| `read_messages` | `unread_only=true`, `since?`, `thread_id?`, `limit=50`, `mark_read=false` | `{messages[], has_more, marked_read}` |
| `list_threads` | `limit=20`, `since?` | `{threads[]}` with `peer`, `message_count`, `unread_count` |
| `ack` | `message_ids[]` | `{acked[], not_found[]}` |

Semantics:

- **Threads** are between exactly two bots. Omit `thread_id` to start a new thread. To reply,
  pass the `thread_id` and the other participant as `to`.
- **`read_messages` does not change state** unless `mark_read=true`.
  - With `unread_only=true` (the default), it returns unread messages addressed to you, oldest
    first. Page through them with `mark_read=true` or `ack`.
  - With `unread_only=false`, it returns both incoming and outgoing messages: the most recent
    `limit` (in chronological order), or everything strictly after `since`, oldest first.
- **`ack`** marks messages addressed to you as read and acknowledged. It is idempotent. Ids that
  aren't addressed to you come back in `not_found`, so `ack` doesn't reveal whether they exist.
- Each message carries the recipient's `read_at`/`acked_at`, so the sender can see when the
  peer has read or acknowledged it.
- **Limits:**
  - Message bodies: 32 KB max in UTF-8 bytes (`MAX_BODY_BYTES`).
  - Subjects: 200 characters max (`MAX_SUBJECT_CHARS`).
  - Rate: 120 tool calls per minute per bot, as a token bucket (`RATE_LIMIT_PER_MINUTE`).
    Over-limit calls return a `rate_limited` tool error.
- **Errors** come back as MCP tool errors (`isError: true`) with a JSON body
  `{"error": "<code>", "message": "..."}`. Codes include `unknown_recipient`, `body_too_large`,
  `thread_not_found`, `thread_mismatch` and `rate_limited`.

## HTTP endpoints

| Endpoint | Auth | Notes |
| --- | --- | --- |
| `POST /mcp` | bot token | MCP Streamable HTTP, stateless, JSON responses |
| `GET /mcp`, `DELETE /mcp` | bot token | `405`: the server is stateless, so there's no standalone SSE stream and no sessions |
| `GET /log` | viewer token (Bearer, or Basic with the token as password) | Read-only HTML of recent messages and audit entries. `404` if `VIEWER_TOKEN_SHA256` is unset |
| `GET /healthz` | none | `{"status":"ok"}`. Returns no data |

The bot token is read from `X-Relay-Token` if that header is present, otherwise from
`Authorization: Bearer <token>`. Token digests are compared with `crypto.timingSafeEqual`
against every configured hash, with no early exit.

## Audit log

Every tool call writes one row to `audit_log`: `ts`, `bot_id`, `tool`, `message_ids`
(JSON array), `status` (`ok`, `error`, `rate_limited` or `unauthorized`) and a short `detail`
code. Failed authentication attempts on `/mcp` and accesses to `/log` are recorded too, with
`bot_id = NULL`.

The log never contains tokens, header values or message bodies. `BEFORE UPDATE` and
`BEFORE DELETE` triggers abort any attempt to modify or delete rows.

Calls the MCP SDK rejects during argument type validation, such as `to: 42`, never reach the
tool handler and aren't audited.

## Configuration

All configuration comes from environment variables. See [`.env.example`](.env.example).

| Variable | Default | Purpose |
| --- | --- | --- |
| `BOTS` | *required* | `id:sha256hex,id:sha256hex`. An id may appear twice during token rotation |
| `VIEWER_TOKEN_SHA256` | unset (`/log` disabled) | SHA-256 of the `/log` viewer token |
| `PUBLIC_HOSTNAME` | `relay.justinhagemeier.com` in compose | Used in logs and the `/log` page title |
| `TUNNEL_TOKEN` | *required by compose* | Cloudflare Tunnel token. Only the `cloudflared` container gets it |
| `DB_PATH` | `/data/relay.db` | SQLite file |
| `PORT` / `HOST` | `8080` / `0.0.0.0` | Listener inside the container |
| `MAX_BODY_BYTES` | `32768` | Message body cap (bytes) |
| `MAX_SUBJECT_CHARS` | `200` | Subject cap |
| `RATE_LIMIT_PER_MINUTE` | `120` | Per-bot tool-call budget |
| `NOTIFY_URL_<BOT>` / `NOTIFY_KEY_<BOT>` | unset (no push) | Optional https webhook + key pinged when mail lands for that bot ([push notifications](docs/CONNECTORS.md#push-notifications)) |

### Generating tokens

```bash
npm run hash-token -- chief-of-staff      # prints TOKEN, SHA256 and a ready BOTS entry
npm run hash-token -- abjets-company
npm run hash-token -- viewer              # for VIEWER_TOKEN_SHA256
# no Node on the host? use the built image:
podman run --rm localhost/bot-relay-mcp:latest node scripts/hash-token.mjs chief-of-staff
# hash an existing token (prints only the hash):
npm run hash-token -- --stdin < token.txt
```

The token is printed **once**, to your terminal. Put the `SHA256` / `BOTS entry` into `.env`,
and the `TOKEN` straight into that bot's connector config. Don't save it anywhere else and don't
paste it into a chat.

## Development

Requires Node.js ≥ 22.18, which runs the TypeScript tests directly via type stripping.

```bash
npm ci
npm test             # node:test: unit, HTTP and end-to-end (MCP SDK client over Streamable HTTP)
npm run typecheck
npm run build && BOTS=... DB_PATH=./data/relay.db npm start
```

SQLite comes from Node's built-in `node:sqlite`, so there are no native modules to compile. It
still prints an "experimental" warning, which the `start` and `test` scripts silence.

## Layout

```
src/
  index.ts      process entry: config, DB, HTTP listener, graceful shutdown
  app.ts        Express routes: /mcp, /log, /healthz, auth middleware
  mcp.ts        MCP tools (per-request server bound to the authenticated bot)
  store.ts      SQLite queries: messages, threads, receipts, audit
  db.ts         schema, WAL pragmas, append-only triggers
  auth.ts       token extraction, SHA-256 + constant-time comparison
  config.ts     env parsing
  notify.ts     webhook push notifications (coalesce, retry, audit)
  ratelimit.ts  per-bot token bucket
  viewer.ts     /log HTML (escaped)
scripts/        hash-token, backup, container healthcheck
test/           node:test suites
```
