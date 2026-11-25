import type { Server } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { createAdminApp, createBotApp } from "./app.ts";
import { generateAdminPassword, sha256 } from "./auth.ts";
import { botIds, ConfigError, loadConfig } from "./config.ts";
import { loadOrCreateEncryptionKey } from "./crypto.ts";
import { openDatabase } from "./db.ts";
import { EventHub } from "./events.ts";
import { Notifier } from "./notify.ts";
import { RelayStore } from "./store.ts";

function main(): void {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`config error: ${err.message}`);
      process.exit(2);
    }
    throw err;
  }

  const encryptionKey = loadOrCreateEncryptionKey({ envKey: config.encryptionKey, dbPath: config.dbPath });
  const db = openDatabase(config.dbPath);
  const store = new RelayStore(db, config.bots, config, {
    encryptionKey,
    webhookPolicy: config.webhookPolicy,
    envNotify: config.notify,
  });

  if (config.bootstrapInvite) {
    store.ensureBootstrapInviteCode(config.bootstrapInvite.code, {
      maxUses: config.bootstrapInvite.maxUses,
      expiresInSeconds: config.bootstrapInvite.expiresInSeconds,
      botId: config.bootstrapInvite.botId,
    });
  }

  // Zero-config first-run admin password when no admin/gateway/viewer auth is configured via env.
  let fallbackAdminTokenHash: Buffer | undefined;
  if (!config.adminTokenHash && !config.adminGatewayKey && !config.viewerTokenHash) {
    const existing = store.getSetting("admin_password_sha256");
    if (existing && /^[0-9a-f]{64}$/i.test(existing)) {
      fallbackAdminTokenHash = Buffer.from(existing, "hex");
    } else {
      const generated = generateAdminPassword();
      const digest = sha256(generated);
      store.setSetting("admin_password_sha256", digest.toString("hex"));
      fallbackAdminTokenHash = digest;
      const uiPort = config.adminPort ?? config.port;
      console.log(
        `\n========================================================================\n` +
          `First-run Admin Password (shown once; stored only as a SHA-256 hash):\n` +
          `  ${generated}\n` +
          `Sign in at http://localhost:${uiPort}/ (or set ADMIN_PASSWORD / ADMIN_TOKEN_SHA256)\n` +
          `========================================================================\n`,
      );
    }
  }

  const events = new EventHub(store);
  const notifier = new Notifier((botId) => store.getWebhookTarget(botId), store, { log: true });

  const sharedDeps = {
    config,
    store,
    notifier,
    events,
    encryptionKey,
    fallbackAdminTokenHash,
    logRequests: true,
  };

  const botApp = createBotApp({ ...sharedDeps, mountAdmin: config.adminPort === undefined });
  const servers: Server[] = [];

  const botServer = botApp.listen(config.port, config.host, () => {
    const activeBots = store.listBots().filter((b) => b.status === "active").map((b) => b.id);
    const adminDesc = config.adminPort
      ? `${config.adminHost}:${config.adminPort}`
      : config.adminTokenHash || config.adminGatewayKey || fallbackAdminTokenHash
        ? "unified"
        : "off";
    console.log(
      `bot-relay listening on ${config.host}:${config.port} ` +
        `(db=${config.dbPath}, bots=${activeBots.join(",") || "none"}, ` +
        `env_bots=${botIds(config).length}, ` +
        `admin=${adminDesc}, ` +
        `viewer=${config.viewerTokenHash ? "on" : "off"}, ` +
        `webhook_http=${config.webhookPolicy.allowHttp}` +
        `${config.publicUrl ? `, public=${config.publicUrl}` : ""})`,
    );
  });
  servers.push(botServer);

  if (config.adminPort !== undefined) {
    const adminApp = createAdminApp(sharedDeps);
    const adminServer = adminApp.listen(config.adminPort, config.adminHost, () => {
      console.log(
        `bot-relay admin listening on ${config.adminHost}:${config.adminPort} ` +
          `(gateway=${config.adminGatewayKey ? "on" : "off"}, password=${config.adminTokenHash || fallbackAdminTokenHash ? "on" : "off"})`,
      );
    });
    servers.push(adminServer);
  }

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`${signal} received, shutting down`);
    events.closeAll();
    const closers = servers.map(
      (srv) =>
        new Promise<void>((resolve) => {
          srv.close(() => resolve());
        }),
    );
    void Promise.all(closers)
      .then(() => Promise.race([notifier.drain(), sleep(8_000, undefined, { ref: false })]))
      .finally(() => {
        db.close();
        process.exit(0);
      });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main();
