import { setTimeout as sleep } from "node:timers/promises";
import { createApp } from "./app.ts";
import { botIds, ConfigError, loadConfig } from "./config.ts";
import { openDatabase } from "./db.ts";
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

  const db = openDatabase(config.dbPath);
  const store = new RelayStore(db, botIds(config), config);
  const notifier = new Notifier(config.notify, store, { log: true });
  const app = createApp({ config, store, notifier, logRequests: true });

  const server = app.listen(config.port, config.host, () => {
    console.log(
      `bot-relay listening on ${config.host}:${config.port} ` +
        `(db=${config.dbPath}, bots=${botIds(config).join(",")}, ` +
        `viewer=${config.viewerTokenHash ? "on" : "off"}, ` +
        `notify=${[...config.notify.keys()].join(",") || "off"}` +
        `${config.publicHostname ? `, public=https://${config.publicHostname}/mcp` : ""})`,
    );
  });

  const shutdown = (signal: string) => {
    console.log(`${signal} received, shutting down`);
    server.close(() => {
      void Promise.race([notifier.drain(), sleep(8_000, undefined, { ref: false })]).finally(() => {
        db.close();
        process.exit(0);
      });
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main();
