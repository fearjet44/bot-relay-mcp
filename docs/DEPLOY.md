# Deploying Bot Relay

Bot Relay supports three deployment styles using the exact same container image:

1. **[My Own Data Center (Omarchy Server)](#1-my-own-data-center-omarchy-server)** — 1-click app store install with automatic MODC sign-in on the Admin UI and direct LAN/Tailnet access for bots.
2. **[Standard Docker / Podman Compose](#2-standard-docker--podman-compose)** — zero-config standalone deployment on any Linux, macOS, or homelab machine.
3. **[Optional Cloudflare Tunnel + Access](#3-optional-cloudflare-tunnel--access)** — for internet-hosted bots (such as cloud-hosted Grok/Cursor automations) without opening router ports.

---

## 1. My Own Data Center (Omarchy Server)

This repository includes ready-to-use My Own Data Center manifests under [`modc/bot-relay-mcp/`](../modc/bot-relay-mcp/):

- **Admin UI (`port: 8391` → container `8081`):** Declared as `web: { service: relay, port: 8081 }`. My Own Data Center binds it privately on `127.0.0.1`, puts its own sign-in gateway in front of it, and forwards a verified `x-omarchy-gateway` header (`${APP_GATEWAY_KEY}`). Opening **Bot Relay** from your MODC desktop or phone signs you straight into the Admin Dashboard with no extra login prompt.
- **Bot API (`openPorts: [8390]` → container `8080`):** Opened directly on your LAN and Tailnet so bots can reach `/mcp`, `/register`, and `/events` using Bearer tokens without hitting MODC's browser login gate.
- **Persistent storage:** Stored under `${APP_DATA_DIR}/data` (backed up automatically with MODC). Container runs rootless as `user: "1000:1000"` (`node`).
- **Encrypted secrets:** Wired to `${APP_SEED}` so DB-stored webhook secrets are AES-256-GCM encrypted at rest.

### Testing or submitting to MODC App Store

1. Publish a tagged release (`git tag v2.0.0 && git push origin v2.0.0`) so `.github/workflows/release.yml` pushes the multi-arch image `ghcr.io/fearjet44/bot-relay-mcp:2.0.0`.
2. Ensure the `bot-relay-mcp` package on GitHub Packages (`ghcr.io/fearjet44/bot-relay-mcp`) has **Public** visibility.
3. Submit `modc/bot-relay-mcp/omarchy-app.yml` and `modc/bot-relay-mcp/docker-compose.yml` to [Modc-app-store](https://github.com/TouchWorkStation/Modc-app-store), or push the contents of `modc/` to a standalone store repository and add it in MODC under **App Store → Stores → Add by link**.

---

## 2. Standard Docker / Podman Compose

No `.env` file or third-party account is required:

```bash
git clone https://github.com/fearjet44/bot-relay-mcp.git
cd bot-relay-mcp
docker compose up -d            # or: podman compose up -d
docker compose logs relay       # copy the one-time First-run Admin Password
```

Open `http://<server-ip>:8391` in your browser and sign in with the printed password (or set
`ADMIN_PASSWORD` / `ADMIN_TOKEN_SHA256` in `.env` beforehand).

If you want `POST /register` and UI snippets to advertise your server's LAN IP or Tailscale
hostname automatically, set `PUBLIC_URL` in `.env`:

```bash
PUBLIC_URL=http://my-server.tail1234.ts.net:8390
```

### Creating an invite code from the CLI (headless)

```bash
docker compose exec relay node --disable-warning=ExperimentalWarning \
  scripts/create-invite.mjs --bot mac-mini --ttl 1h --uses 1
```

Or seed an initial code via `BOOTSTRAP_INVITE_CODE` in `.env`.

### Operations

#### Backups

SQLite runs in WAL mode. Always take consistent snapshots with `scripts/backup.mjs` (`VACUUM INTO`):

```bash
docker compose exec relay node --disable-warning=ExperimentalWarning scripts/backup.mjs
# -> /data/backups/relay-2026-11-25T12-00-00-000Z.db
```

Backups contain message bodies (and encrypted webhook secrets, whose key lives separately in
`/data/.relay.key` or `ENCRYPTION_KEY`). Store backups securely.

#### Upgrades

```bash
git pull
docker compose pull   # or: docker compose build
docker compose down
docker compose up -d
```

Never run `docker compose down -v`, which deletes the `relay-data` volume. SQLite migrations run
automatically on startup.

#### Static `BOTS` env vars (optional / legacy)

You can still pre-provision static bots via `BOTS=bot-a:<sha256>,bot-b:<sha256>` (generated with
`npm run hash-token -- <bot-id>`). Static env bots coexist cleanly with dynamically self-registered
DB bots.

---

## 3. Optional Cloudflare Tunnel + Access

If some bots run in external cloud environments that cannot join your LAN or Tailnet, you can
optionally expose the Bot API (`http://relay:8080`) via Cloudflare Tunnel + Cloudflare Access:

1. Create a Cloudflare Tunnel and route your public hostname (e.g., `relay.example.com`) to
   `http://relay:8080` (do **not** route the Admin port `8081` publicly).
2. Protect the hostname with a Cloudflare Access **Self-Hosted** application and **Service Auth**
   policy using per-bot Service Tokens (`CF-Access-Client-Id` / `CF-Access-Client-Secret`).
3. Set `TUNNEL_TOKEN` and `PUBLIC_URL=https://relay.example.com` in `.env`, then start with the
   `cloudflare` profile:

```bash
docker compose --profile cloudflare up -d
```

To bind the local host ports to loopback only when using Cloudflare exclusively, override
`ports:` to `127.0.0.1:8390:8080` and `127.0.0.1:8391:8081`.
