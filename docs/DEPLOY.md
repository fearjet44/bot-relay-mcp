# Deploying Bot Relay

Bot Relay supports three deployment styles using the exact same container image:

1. **[My Own Data Center (Omarchy Server)](#1-my-own-data-center-omarchy-server)** — 1-click app store install with automatic MODC sign-in on the Admin UI and direct LAN/Tailnet access for bots.
2. **[Standard Docker / Podman Compose](#2-standard-docker--podman-compose)** — zero-config standalone deployment on any Linux, macOS, or homelab machine.
3. **[Optional Cloudflare Tunnel + Access](#3-optional-cloudflare-tunnel--access)** — for internet-hosted bots (such as cloud-hosted Grok/Cursor automations) without opening router ports.

---

## 1. My Own Data Center (Omarchy Server)

The server project is [My Own Data Center](https://github.com/MyOwnDataCenter/Server). This repository includes ready-to-use manifests under [`modc/bot-relay-mcp/`](../modc/bot-relay-mcp/):

- **Admin UI (`port: 8391` → container `8081`):** Declared as `web: { service: relay, port: 8081 }`. My Own Data Center binds it privately on `127.0.0.1`, puts its own sign-in gateway in front of it, and forwards a verified `x-omarchy-gateway` header (`${APP_GATEWAY_KEY}`). Opening **Bot Relay** from your MODC desktop or phone signs you straight into the Admin Dashboard with no extra login prompt.
- **Admin password:** `ADMIN_PASSWORD` is set to `${APP_PASSWORD}`. The listing sets `deterministicPassword: true` and `defaultUsername: "admin"`, so the password shown on the app's page is the Admin Dashboard password, with username `admin`. The gateway sign-in does not ask for it. The password matters when that gateway is bypassed: starting this compose file yourself publishes port `8391`, and the Admin API accepts the password as a bearer token.
- **Bot API (`openPorts: [8390]` → container `8080`):** Opened directly on your LAN and Tailnet so bots can reach `/mcp`, `/register`, and `/events` using Bearer tokens without hitting MODC's browser login gate.
- **Addresses returned to bots:** `PUBLIC_URL` is `http://${SERVER_IP:-localhost}:8390`. My Own Data Center sets `SERVER_IP` to the host's first non-bridge IPv4 address. It skips docker, podman, cni, veth, and br- interfaces, and addresses in `10.88.`, `10.89.`, and `172.17.`. It does not skip Tailscale, and it uses the host's interface order, so a machine with several addresses may advertise a LAN address or a Tailscale address. `POST /register` builds `mcp_url` and `events_url` from that base. The `localhost` fallback applies only when this compose file is started without My Own Data Center's environment. My Own Data Center itself uses `127.0.0.1` when the host has no other IPv4 address.
- **Persistent storage:** Stored under `${APP_DATA_DIR}/data`, which My Own Data Center backs up with the app. The container runs as `user: "1000:1000"`, the same uid as the image's `node` user. On install, My Own Data Center creates that folder and runs `podman unshare chown -R 1000:1000` on it before the first start, so the container user can create `relay.db` and `.relay.key`. Keep the bind mount. A named volume would sit outside `${APP_DATA_DIR}` and would not be part of that backup. If you run this compose file yourself, create the data directory first. With rootless Podman, `podman unshare chown -R 1000:1000` that directory. With rootful Docker, `sudo chown -R 1000:1000` it.
- **Encrypted secrets:** Wired to `${APP_SEED}` so DB-stored webhook secrets are AES-256-GCM encrypted at rest.
- **Hardening:** The compose file sets `read_only`, a `/tmp` tmpfs, `cap_drop: [ALL]`, `no-new-privileges`, and the same healthcheck as the root file (`node scripts/healthcheck.mjs`, which checks `PORT` and `ADMIN_PORT`). My Own Data Center's store check treats `no-new-privileges` as tighter confinement, not as extra access, and it passes the other settings through.

### Testing or submitting to the community store

The catalog My Own Data Center ships with is [MyOwnDataCenter/app-store](https://github.com/MyOwnDataCenter/app-store). New apps are submitted to the community store, [MyOwnDataCenter/Modc-app-store](https://github.com/MyOwnDataCenter/Modc-app-store). `https://github.com/TouchWorkStation/Modc-app-store` redirects there. Do not open a submission against the built-in catalog.

Submit only after the `v2.0.0` tag is on GitHub and the GHCR package is public. The listing pins both of these, and neither exists before that:

- image `ghcr.io/fearjet44/bot-relay-mcp:2.0.0`
- icon `https://raw.githubusercontent.com/fearjet44/bot-relay-mcp/v2.0.0/docs/icon.svg`

1. Merge the release branch, then publish the tag (`git tag v2.0.0 && git push origin v2.0.0`) so `.github/workflows/release.yml` pushes the multi-arch image.
2. Set the `bot-relay-mcp` package on GitHub Packages (`ghcr.io/fearjet44/bot-relay-mcp`) to **Public**.
3. Submit `modc/bot-relay-mcp/omarchy-app.yml` and `modc/bot-relay-mcp/docker-compose.yml` to [Modc-app-store](https://github.com/MyOwnDataCenter/Modc-app-store), or push the contents of `modc/` to a standalone store repository and add it in MODC under **App Store → Stores → Add by link**.

---

## 2. Standard Docker / Podman Compose

No `.env` file or third-party account is required:

```bash
git clone https://github.com/fearjet44/bot-relay-mcp.git
cd bot-relay-mcp
docker compose up -d --build   # or: podman compose up -d --build
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

`--ttl` defaults to `1h`. A duration is `<n>s`, `<n>m`, `<n>h`, or `<n>d`, from 60 seconds through 365 days (`90s`, `15m`, `1h`, `24h`, `7d`), or `never`. `--ttl 30s` and `--ttl 400d` exit 1 with that rule on stderr and do not write a code. `create-invite --help` prints the same window.

Or set `BOOTSTRAP_INVITE_CODE` in `.env`. On startup the relay inserts that code once, if it is not already in the database. By default the seeded row allows **1** registration, expires after **24h**, and is not locked to a `bot_id`. Override with `BOOTSTRAP_INVITE_USES` (`1`–`100`), `BOOTSTRAP_INVITE_TTL` (`60s`–`365d` as `<n>s`/`<n>m`/`<n>h`/`<n>d`, or `never`), and `BOOTSTRAP_INVITE_BOT` (optional locked `bot_id`). A restart does not reset its use count or extend its expiry. Anyone who can read the env value can use the code while it is active.

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
docker compose up -d --build
```

`pull_policy: build` in the root compose file makes a plain `up` rebuild from this checkout on Compose implementations that honor it. `--build` is the command that also works when an implementation ignores `pull_policy`. `docker compose pull` fetches `ghcr.io/fearjet44/bot-relay-mcp:latest`, which is not published until the first release, and the next `up` still rebuilds while `pull_policy` is `build`.

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
docker compose --profile cloudflare up -d --build
```

To bind the local host ports to loopback only when using Cloudflare exclusively, override
`ports:` to `127.0.0.1:8390:8080` and `127.0.0.1:8391:8081`.
