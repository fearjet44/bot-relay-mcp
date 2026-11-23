import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createApp } from "../src/app.ts";
import { sha256 } from "../src/auth.ts";
import { loadConfig, type Config } from "../src/config.ts";
import { openDatabase } from "../src/db.ts";
import { RateLimiter } from "../src/ratelimit.ts";
import { RelayStore } from "../src/store.ts";

export const TOKENS = {
  "chief-of-staff": "relay_test-token-chief-of-staff",
  "abjets-company": "relay_test-token-abjets-company",
  intruder: "relay_test-token-intruder",
} as const;
export const VIEWER_TOKEN = "relay_test-viewer-token";

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
  cleanup(): void;
}

export function makeHarness(envOverrides: Record<string, string> = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), "bot-relay-test-"));
  const config = loadConfig(testEnv({ DB_PATH: join(dir, "relay.db"), ...envOverrides }));
  const db = openDatabase(config.dbPath);
  const store = new RelayStore(db, config.bots.map((b) => b.id), config);
  return {
    dir,
    config,
    db,
    store,
    cleanup(this: Harness) {
      if (this.db.isOpen) this.db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export interface ServerHarness extends Harness {
  baseUrl: string;
  close(): Promise<void>;
}

export async function startServer(envOverrides: Record<string, string> = {}): Promise<ServerHarness> {
  const h = makeHarness(envOverrides);
  const app = createApp({ config: h.config, store: h.store, limiter: new RateLimiter(h.config.rateLimitPerMinute) });
  const server = await new Promise<import("node:http").Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  return {
    ...h,
    baseUrl: `http://127.0.0.1:${port}`,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
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
