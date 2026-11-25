import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createAdminApp, createApp, createBotApp } from "../src/app.ts";
import { sha256 } from "../src/auth.ts";
import { loadConfig, type Config } from "../src/config.ts";
import { loadOrCreateEncryptionKey } from "../src/crypto.ts";
import { openDatabase } from "../src/db.ts";
import { EventHub } from "../src/events.ts";
import { Notifier } from "../src/notify.ts";
import { RateLimiter } from "../src/ratelimit.ts";
import { RelayStore } from "../src/store.ts";

export const TOKENS = {
  "chief-of-staff": "relay_test-token-chief-of-staff",
  "abjets-company": "relay_test-token-abjets-company",
  intruder: "relay_test-token-intruder",
} as const;
export const VIEWER_TOKEN = "relay_test-viewer-token";
export const ADMIN_TOKEN = "relay_test-admin-token";

export type BotId = keyof typeof TOKENS;

export function testEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    BOTS: Object.entries(TOKENS)
      .map(([id, token]) => `${id}:${sha256(token).toString("hex")}`)
      .join(","),
    VIEWER_TOKEN_SHA256: sha256(VIEWER_TOKEN).toString("hex"),
    PUBLIC_HOSTNAME: "relay.example.test",
    ...overrides,
  };
}

export interface Harness {
  dir: string;
  config: Config;
  db: DatabaseSync;
  store: RelayStore;
  encryptionKey: Buffer;
  cleanup(): void;
}

export function makeHarness(envOverrides: Record<string, string> = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), "bot-relay-test-"));
  const config = loadConfig(testEnv({ DB_PATH: join(dir, "relay.db"), ...envOverrides }));
  const encryptionKey = loadOrCreateEncryptionKey({ envKey: config.encryptionKey, dbPath: config.dbPath });
  const db = openDatabase(config.dbPath);
  const store = new RelayStore(db, config.bots, config, {
    encryptionKey,
    webhookPolicy: config.webhookPolicy,
    envNotify: config.notify,
  });
  return {
    dir,
    config,
    db,
    store,
    encryptionKey,
    cleanup(this: Harness) {
      if (this.db.isOpen) this.db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export interface ServerHarness extends Harness {
  baseUrl: string;
  events: EventHub;
  notifier: Notifier;
  close(): Promise<void>;
}

export async function startServer(
  envOverrides: Record<string, string> = {},
  makeNotifier?: (h: Harness) => Notifier,
): Promise<ServerHarness> {
  const h = makeHarness(envOverrides);
  const events = new EventHub(h.store, { heartbeatMs: 60_000 });
  const notifier =
    makeNotifier?.(h) ??
    new Notifier((id) => h.store.getWebhookTarget(id), h.store, {
      timeoutMs: 300,
      retryDelaysMs: [20, 50],
      coalesceMs: 0,
    });
  const app = createApp({
    config: h.config,
    store: h.store,
    limiter: new RateLimiter(h.config.rateLimitPerMinute),
    notifier,
    events,
    encryptionKey: h.encryptionKey,
  });
  const server = await new Promise<import("node:http").Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  return {
    ...h,
    baseUrl: `http://127.0.0.1:${port}`,
    events,
    notifier,
    async close() {
      events.closeAll();
      await notifier.drain();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      h.cleanup();
    },
  };
}

export interface SplitServerHarness extends Harness {
  botUrl: string;
  adminUrl: string;
  events: EventHub;
  notifier: Notifier;
  close(): Promise<void>;
}

export async function startSplitServer(envOverrides: Record<string, string> = {}): Promise<SplitServerHarness> {
  const h = makeHarness({ ADMIN_PORT: "8081", ...envOverrides });
  const events = new EventHub(h.store, { heartbeatMs: 60_000 });
  const notifier = new Notifier((id) => h.store.getWebhookTarget(id), h.store, {
    timeoutMs: 300,
    retryDelaysMs: [20, 50],
    coalesceMs: 0,
  });
  const shared = {
    config: h.config,
    store: h.store,
    limiter: new RateLimiter(h.config.rateLimitPerMinute),
    notifier,
    events,
    encryptionKey: h.encryptionKey,
  };
  const botApp = createBotApp({ ...shared, mountAdmin: false });
  const adminApp = createAdminApp(shared);

  const botServer = await new Promise<import("node:http").Server>((resolve) => {
    const s = botApp.listen(0, "127.0.0.1", () => resolve(s));
  });
  const adminServer = await new Promise<import("node:http").Server>((resolve) => {
    const s = adminApp.listen(0, "127.0.0.1", () => resolve(s));
  });
  const botPort = (botServer.address() as AddressInfo).port;
  const adminPort = (adminServer.address() as AddressInfo).port;
  return {
    ...h,
    botUrl: `http://127.0.0.1:${botPort}`,
    adminUrl: `http://127.0.0.1:${adminPort}`,
    events,
    notifier,
    async close() {
      events.closeAll();
      await notifier.drain();
      botServer.closeAllConnections();
      adminServer.closeAllConnections();
      await Promise.all([
        new Promise<void>((resolve) => botServer.close(() => resolve())),
        new Promise<void>((resolve) => adminServer.close(() => resolve())),
      ]);
      h.cleanup();
    },
  };
}

export async function connectClient(
  baseUrl: string,
  headers: Record<string, string>,
): Promise<Client> {
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), { requestInit: { headers } });
  await client.connect(transport);
  return client;
}

export function bearer(bot: BotId): Record<string, string> {
  return { Authorization: `Bearer ${TOKENS[bot]}` };
}

/** Parses the JSON text payload of a tool result. */
export function payload<T = Record<string, unknown>>(result: unknown): T {
  const content = (result as { content: { type: string; text: string }[] }).content;
  return JSON.parse(content[0]!.text) as T;
}

export async function rpc(
  baseUrl: string,
  headers: Record<string, string>,
  body: unknown,
  method = "POST",
): Promise<Response> {
  return fetch(`${baseUrl}/mcp`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...headers,
    },
    body: method === "POST" ? JSON.stringify(body) : undefined,
  });
}
