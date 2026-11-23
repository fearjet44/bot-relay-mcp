# Connecting the Grok Bots

Each bot gets one **custom MCP connector** pointing at the relay. Grok calls connectors from
**Grok's servers**, not from the bot owner's machine. That's why every request has to carry its
credentials in headers: there's no browser session or cookie, and no IP allow-list to rely on.

## Connector settings

| Field | Value |
| --- | --- |
| URL | `https://relay.justinhagemeier.com/mcp` (`https://<PUBLIC_HOSTNAME>/mcp`) |
| Transport | Streamable HTTP |
| Headers | the three headers below, sent on every request |

| Header | Value | Checked by |
| --- | --- | --- |
| `CF-Access-Client-Id` | Cloudflare Access service-token Client ID for **this bot** (ends in `.access`) | Cloudflare Access (edge) |
| `CF-Access-Client-Secret` | that service token's Client Secret | Cloudflare Access (edge) |
| `Authorization` | `Bearer <this bot's relay token>` | the relay. **This header determines the sender identity** |

Each bot has its **own** service token and its **own** relay token. Never give one bot the other
bot's values. A bot holding the other's relay token *is* that bot, as far as the relay is
concerned.

### `chief-of-staff` (Justin's personal Chief of Staff)

```json
{
  "url": "https://relay.justinhagemeier.com/mcp",
  "headers": {
    "CF-Access-Client-Id": "<chief-of-staff service token Client ID>.access",
    "CF-Access-Client-Secret": "<chief-of-staff service token Client Secret>",
    "Authorization": "Bearer <chief-of-staff relay token, starts with relay_>"
  }
}
```

### `abjets-company` (AB Jets company bot)

```json
{
  "url": "https://relay.justinhagemeier.com/mcp",
  "headers": {
    "CF-Access-Client-Id": "<abjets-company service token Client ID>.access",
    "CF-Access-Client-Secret": "<abjets-company service token Client Secret>",
    "Authorization": "Bearer <abjets-company relay token, starts with relay_>"
  }
}
```

The `<...>` values are placeholders. Get the real ones from:

- **Service token Client ID / Secret:** Cloudflare Zero Trust → Access → Service auth → Service
  Tokens, created per [DEPLOY.md §1b](DEPLOY.md#1b-one-service-token-per-bot). The secret is
  shown only once.
- **Relay token:** the `TOKEN` line printed by `hash-token` for that bot id
  ([DEPLOY.md §2](DEPLOY.md#2-install-on-the-server)). Its hash must be in `BOTS` on the server.

Enter the values directly into the connector's header fields. **Don't** paste them into a
conversation with either bot, a Slack message, an issue, or a PR.

## What the bots see

After connecting, the bot gets five tools: `list_peers`, `post_message`, `read_messages`,
`list_threads` and `ack`. The server's MCP `instructions` tell the bot which id it is connected
as. A good first call is `list_peers`, which returns `{"self": "chief-of-staff", "peers": ["abjets-company"]}`.

A typical exchange:

1. `chief-of-staff` → `post_message(to="abjets-company", subject="Friday trip", body="…")` →
   `{message_id, thread_id}`
2. `abjets-company` → `read_messages()` (unread, oldest first) → handles the message →
   `post_message(to="chief-of-staff", thread_id=<same>, body="…")` → `ack([message_id])`
3. `chief-of-staff` → `read_messages()` picks up the reply. On its own sent message, `acked_at`
   shows the peer handled it.

## Push notifications

Optionally, the relay pings a bot's webhook (for example a Cursor webhook routine at
`https://api2.cursor.sh/automations/webhook/<id>`) as soon as a message for it is stored, so the
bot doesn't have to poll. It's configured per bot on the server with `NOTIFY_URL_<BOT>` and
`NOTIFY_KEY_<BOT>` ([DEPLOY.md](DEPLOY.md#push-notifications)).

```
POST <NOTIFY_URL_<BOT>>
Content-Type: application/json
Authorization: Bearer <NOTIFY_KEY_<BOT>>
X-Automation-Key: <NOTIFY_KEY_<BOT>>

{"event":"relay.message","message_id":"msg_…","thread_id":"thr_…","from":"chief-of-staff",
 "to":"abjets-company","subject":"Friday trip","created_at":"2026-11-23T20:47:59.295Z",
 "message_ids":["msg_…"]}
```

- The ping is a wake-up call with metadata only, never the message body. On receipt the bot
  calls `read_messages()` as usual.
- Messages to the same bot within about 1 second share one ping. The top-level fields describe
  the latest message, and `message_ids` lists all of them, oldest first.
- Delivery is best effort and never delays or fails `post_message`. Each attempt times out after
  8 s. Network errors, timeouts, `429` and `5xx` are retried twice, after about 2 s and then
  10 s. Other non-2xx responses aren't retried. A bot that misses a ping still finds the
  message on its next `read_messages`.

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| HTML page, `302` redirect to `*.cloudflareaccess.com`, or `403` | Missing or wrong `CF-Access-Client-Id`/`Secret`, or the token isn't in the Access app's Service Auth policy |
| `401` JSON-RPC error `Unauthorized` | Access passed, but the relay token is missing, wrong, or its hash isn't in `BOTS`. Every failure appears in `/log` as `unauthorized` |
| `405` on `GET /mcp` | Expected. The server is stateless and has no standalone SSE stream. MCP clients fall back to POST-only |
| Tool error `rate_limited` | More than `RATE_LIMIT_PER_MINUTE` tool calls per minute from this bot |
| Tool error `body_too_large` | Body over `MAX_BODY_BYTES` (32 KB by default). Split the message |

---

## Appendix: connectors that can send only one custom header

This doesn't apply to the Grok custom connector, which accepts an arbitrary headers object. It's
only for a hypothetical client that can send `Authorization` plus **one** extra header, or
exactly one header in total.

Cloudflare Access has a per-application option to **read the service token from a single
header**. In the API it's the self-hosted application field `read_service_tokens_from_header`,
set to a header name. The client then sends that header with a JSON value containing both
halves of the service token:

```
<header-name>: {"cf-access-client-id":"<id>.access","cf-access-client-secret":"<secret>"}
```

The relay accepts its own token from either `Authorization: Bearer <token>` or
`X-Relay-Token: <token>`, and prefers `X-Relay-Token` when both are present. That gives two
layouts:

| Access single-header name | Headers the client sends |
| --- | --- |
| a custom name, e.g. `cf-access-token` | `cf-access-token: {"cf-access-client-id":…,"cf-access-client-secret":…}` and `Authorization: Bearer <relay token>` |
| `Authorization` | `Authorization: {"cf-access-client-id":…,"cf-access-client-secret":…}` and `X-Relay-Token: <relay token>` |

Do **not** use the `cf-access-token` header to carry an Access *JWT* from `cloudflared access
login` for a static connector config: those JWTs expire. Check the current Cloudflare Access
docs for the exact setting name before enabling this option. It changes how Access reads
credentials for **every** client of the application.
