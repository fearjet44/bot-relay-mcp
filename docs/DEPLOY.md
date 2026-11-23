# Deploying bot-relay on Omarchy Server

The relay runs as a custom app: two containers under **rootless Podman** in one compose project.

- **`relay`**: the MCP server. It listens on `8080` on the compose network only and publishes
  no host ports. It uses a read-only root filesystem, drops all capabilities and sets
  `no-new-privileges`. Its only writable mount is the named volume `relay-data` at `/data`
  (with `:Z` for SELinux).
- **`cloudflared`**: the Cloudflare Tunnel connector (`tunnel run`). It makes outbound-only
  connections to Cloudflare and forwards `https://relay.justinhagemeier.com` to `http://relay:8080`.

Nothing else is exposed. The host needs no inbound firewall rules.

> **Hard limits on Omarchy**
> - **Never restart `omarchyd` from within Omarchy.** Nothing in this guide requires it. Only
>   the relay's own containers are started, stopped or rebuilt.
> - **Never print secrets.** Don't print tokens or the keys in Omarchy's `keys.json`, and don't
>   `cat` `.env`, `echo $TUNNEL_TOKEN`, paste secrets into chats, or include them in bug
>   reports. To check whether a value is set, use `grep -c '^TUNNEL_TOKEN=.\+' .env`.

Contents:

1. [Cloudflare setup](#1-cloudflare-setup)
2. [Install on the server](#2-install-on-the-server)
3. [Verify](#3-verify)
4. [Operations](#4-operations): logs, upgrades, backups, restore, token rotation
5. [Running without the cloudflared sidecar](#5-running-without-the-cloudflared-sidecar)

---

## 1. Cloudflare setup

All steps are in the Cloudflare **Zero Trust** dashboard, using the account that hosts DNS for
`justinhagemeier.com`.

### 1a. Tunnel + public hostname

1. **Networks → Tunnels → Create a tunnel**, then choose **Cloudflared**. Name it `bot-relay`.
2. On the "install connector" screen, copy **only the token**: the long string after
   `--token` / `tunnel run` in the displayed command. It goes into `.env` as `TUNNEL_TOKEN`.
   Don't run the displayed install command, because the compose sidecar runs the connector.
3. Add a public hostname. Depending on the dashboard version, this is under **Public Hostname**
   or **Published application routes**:
   - Subdomain `relay`, domain `justinhagemeier.com`, path empty.
   - Service type `HTTP`, URL `relay:8080`.

   Cloudflare creates the proxied `relay.justinhagemeier.com` CNAME to the tunnel.
4. Don't add other hostnames or routes to this tunnel.

### 1b. One service token per bot

**Access → Service auth → Service Tokens → Create Service Token**, twice:

| Name | Used by |
| --- | --- |
| `relay-chief-of-staff` | the `chief-of-staff` connector |
| `relay-abjets-company` | the `abjets-company` connector |

Pick a duration, such as 1 year, and add a calendar reminder to rotate before it expires. Each
token has a **Client ID**, which ends in `.access`, and a **Client Secret**. The secret is shown
**only once**. Enter it directly into the bot's connector config; don't store it elsewhere.

### 1c. Access application

**Access → Applications → Add an application → Self-hosted**:

1. Application name `bot-relay`. Application domain: `relay.justinhagemeier.com`, path empty,
   so the whole hostname is covered, including `/mcp`, `/log` and `/healthz`.
2. **Policies**:
   - **`bots` policy**: Action **Service Auth**. Include → **Service Token** →
     `relay-chief-of-staff` and `relay-abjets-company`.
   - Optional, only if you want to open `/log` in a browser: a **`justin` policy** with Action
     **Allow**, Include → **Emails** → Justin's address. Without it, `/log` is reachable only
     with service-token headers plus the viewer token.
3. Leave the other settings at their defaults. Don't add a Bypass policy.

Each request then needs to pass two independent checks:

| Layer | Header(s) | Checked by |
| --- | --- | --- |
| Cloudflare Access | `CF-Access-Client-Id`, `CF-Access-Client-Secret` | Cloudflare edge. Requests without them never reach the server |
| Relay | `Authorization: Bearer <bot relay token>` | the relay, which maps the token hash to a bot id |

[CONNECTORS.md](CONNECTORS.md) lists the exact headers for each bot.

## 2. Install on the server

These are generic steps for an Omarchy Server custom app. Run them as the unprivileged user
that owns the app, **not root**. Podman stays rootless.

```bash
# 1. Clone (private repo; use whatever Git credential Omarchy already has configured)
git clone https://github.com/fearjet44/bot-relay-mcp.git
cd bot-relay-mcp

# 2. Build the image
podman compose build            # or: podman-compose build

# 3. Generate tokens. Each TOKEN is printed once: put it straight into that
#    bot's connector config (see CONNECTORS.md). Keep only the hashes here.
podman run --rm localhost/bot-relay-mcp:latest node scripts/hash-token.mjs chief-of-staff
podman run --rm localhost/bot-relay-mcp:latest node scripts/hash-token.mjs abjets-company
podman run --rm localhost/bot-relay-mcp:latest node scripts/hash-token.mjs viewer

# 4. Create .env from the template and fill it in with an editor, not with echo
cp .env.example .env
chmod 600 .env
${EDITOR:-nano} .env
#   PUBLIC_HOSTNAME=relay.justinhagemeier.com
#   BOTS=chief-of-staff:<sha256>,abjets-company:<sha256>
#   VIEWER_TOKEN_SHA256=<sha256>        (or leave empty to disable /log)
#   TUNNEL_TOKEN=<token from step 1a>

# 5. Start
podman compose up -d
```

Notes:

- `podman compose` delegates to `podman-compose` or `docker-compose`, whichever is installed.
  Both work with this file, which has been tested with podman-compose 1.0.6 on Podman 4.9 in
  rootless mode.
- `TUNNEL_TOKEN` reaches only the `cloudflared` container, through `env_file`. podman-compose
  echoes every `podman run` command it executes, but those commands contain only the
  `BOTS`/viewer **hashes**, never the tunnel token.
- To start the stack after a reboot, rootless containers with `restart: unless-stopped` need
  Podman's restart service and user lingering:
  `systemctl --user enable podman-restart.service` and `loginctl enable-linger "$USER"`.
  Skip this if Omarchy already manages app startup.

## 3. Verify

```bash
podman compose ps                                   # relay should become "healthy"
podman compose logs relay | tail                    # "bot-relay listening on 0.0.0.0:8080 ..."
podman compose logs cloudflared | tail              # "Registered tunnel connection ..." (x4)

# From anywhere: Access must block requests without the service-token headers
curl -s -o /dev/null -w '%{http_code}\n' https://relay.justinhagemeier.com/healthz
#   -> 302 or 403 (Access login or denial), never 200

# Health through the full path, without typing secrets on the command line:
# put the service-token headers in a file only you can read, then delete it.
umask 077; ${EDITOR:-nano} /tmp/cf-headers.txt
#   CF-Access-Client-Id: <id>.access
#   CF-Access-Client-Secret: <secret>
curl -s -H @/tmp/cf-headers.txt https://relay.justinhagemeier.com/healthz   # {"status":"ok"}
shred -u /tmp/cf-headers.txt
```

There is no host port to curl directly, which is intentional. To check the relay from inside
the stack, run `podman compose exec relay node scripts/healthcheck.mjs && echo ok`.

The best end-to-end test is from the bots themselves. Have `chief-of-staff` call `list_peers`,
then `post_message` to `abjets-company`, and have `abjets-company` call `read_messages`.

## 4. Operations

### Logs

```bash
podman compose logs -f relay        # one line per request: method, path, status, ms, bot id
podman compose logs -f cloudflared
```

The relay never logs headers, tokens or message bodies. The audit trail lives in SQLite, and
`/log` shows it.

### Upgrade

```bash
cd bot-relay-mcp
git pull
podman compose build
podman compose down        # stops and removes the containers; the relay-data volume is kept
podman compose up -d
```

Use `down` then `up` rather than relying on `up -d` alone: podman-compose 1.0.x doesn't recreate
containers when only the image changed. **Never** run `podman compose down -v` or
`podman volume rm`, because that deletes the database. The schema is created and upgraded on
startup.

### Backup

The database runs in WAL mode, so don't copy `relay.db` alone while the relay is running. Use
the backup script, which writes a consistent, compacted snapshot with SQLite `VACUUM INTO`:

```bash
podman compose exec relay node --disable-warning=ExperimentalWarning scripts/backup.mjs
#   -> /data/backups/relay-2026-11-23T20-47-59-295Z.db
podman ps --format '{{.Names}}' | grep relay        # e.g. bot-relay_relay_1 (or bot-relay-relay-1)
podman cp bot-relay_relay_1:/data/backups ./backups
```

Alternatively, stop the stack and copy the whole volume:
`podman compose down && podman volume export bot-relay_relay-data -o relay-data.tar && podman compose up -d`.

Backups contain every message body. Store them like any other secret, and prune old ones from
`/data/backups`.

### Restore

```bash
podman compose down
podman run --rm -v bot-relay_relay-data:/data:Z -v "$PWD/backups/relay-XYZ.db:/restore.db:ro,Z" \
  localhost/bot-relay-mcp:latest sh -c 'rm -f /data/relay.db-wal /data/relay.db-shm && cp /restore.db /data/relay.db'
podman compose up -d
```

### Rotating a bot token without downtime

1. `podman run --rm localhost/bot-relay-mcp:latest node scripts/hash-token.mjs chief-of-staff`
2. In `.env`, **add** the new entry next to the old one:
   `BOTS=chief-of-staff:<old>,chief-of-staff:<new>,abjets-company:<...>`. Then run
   `podman compose down && podman compose up -d`.
3. Put the new token in the connector's `Authorization` header.
4. Remove the old hash from `BOTS` and restart the same way.

To rotate Cloudflare service tokens, use **Access → Service auth → Service Tokens → Refresh**
(or create a new token, add it to the policy, switch the connector, then delete the old one).
For the tunnel token, see Cloudflare's tunnel token rotation in the tunnel's settings, then
update `TUNNEL_TOKEN` and restart `cloudflared`.

### Revoking a bot immediately

Remove its entry from `BOTS` and restart the relay. Also remove or revoke its service token in
Cloudflare, which blocks it at the edge.

## 5. Running without the cloudflared sidecar

If Omarchy already runs and manages `cloudflared` for the host, run without the sidecar:

1. Delete the `cloudflared:` service from `docker-compose.yml`. `TUNNEL_TOKEN` is then no longer
   needed.
2. Point the existing tunnel's public hostname for `relay.justinhagemeier.com` at the relay
   container. That cloudflared has to reach the relay **without** publishing a port to the
   outside world:
   - If the host's cloudflared runs as a container, attach it to the `bot-relay_default`
     network and use `http://relay:8080`.
   - If it runs directly on the host, add `ports: ["127.0.0.1:8080:8080"]` to `relay` so the
     port binds to loopback only, and use `http://127.0.0.1:8080`.
3. The Cloudflare Access application and the headers in [CONNECTORS.md](CONNECTORS.md) stay
   exactly the same.
