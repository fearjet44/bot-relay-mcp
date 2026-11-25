import { createHash } from "node:crypto";
import {
  DEFAULT_WEBHOOK_POLICY,
  validateWebhookSecret,
  validateWebhookUrl,
  WebhookUrlError,
  type WebhookHttpPolicy,
  type WebhookPolicy,
} from "./webhook-url.ts";

export interface BotEntry {
  id: string;
  tokenHash: Buffer;
}

export interface NotifyTarget {
  url: string;
  key: string | null;
}

export interface Config {
  host: string;
  port: number;
  adminHost: string;
  adminPort: number | undefined;
  dbPath: string;
  publicHostname: string | undefined;
  publicUrl: string | undefined;
  bots: BotEntry[];
  /** Bot id -> static env webhook to ping when a message lands for that bot. */
  notify: Map<string, NotifyTarget>;
  viewerTokenHash: Buffer | undefined;
  adminTokenHash: Buffer | undefined;
  adminGatewayKey: string | undefined;
  encryptionKey: string | undefined;
  bootstrapInviteCode: string | undefined;
  webhookPolicy: WebhookPolicy;
  maxBodyBytes: number;
  maxSubjectChars: number;
  rateLimitPerMinute: number;
  registerRateLimitPerMinute: number;
}

export function botIds(config: Pick<Config, "bots">): string[] {
  return [...new Set(config.bots.map((b) => b.id))];
}

export const BOT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

export class ConfigError extends Error {}

export function parseHash(value: string, label: string): Buffer {
  const hex = value.trim().toLowerCase();
  if (!SHA256_HEX_PATTERN.test(hex)) {
    throw new ConfigError(`${label} must be a 64-character hex SHA-256 digest`);
  }
  return Buffer.from(hex, "hex");
}

/**
 * Parses `BOTS="bot-a:<sha256>,bot-b:<sha256>"`. Optional in v2 (returns `[]`
 * when unset/empty so bots can be registered dynamically in SQLite). An id may
 * appear more than once (with different hashes) to rotate its token without downtime.
 */
export function parseBots(value: string | undefined): BotEntry[] {
  if (!value || !value.trim()) {
    return [];
  }
  const bots: BotEntry[] = [];
  const seenHashes = new Set<string>();
  for (const raw of value.split(",")) {
    const entry = raw.trim();
    if (!entry) continue;
    const sep = entry.indexOf(":");
    if (sep <= 0) throw new ConfigError(`BOTS entry #${bots.length + 1} must look like id:sha256hex`);
    const id = entry.slice(0, sep).trim();
    if (!BOT_ID_PATTERN.test(id)) {
      throw new ConfigError(`BOTS id "${id}" must match ${BOT_ID_PATTERN}`);
    }
    const tokenHash = parseHash(entry.slice(sep + 1), `BOTS hash for "${id}"`);
    if (seenHashes.has(tokenHash.toString("hex"))) {
      throw new ConfigError(`BOTS hash for "${id}" duplicates another entry's hash`);
    }
    seenHashes.add(tokenHash.toString("hex"));
    bots.push({ id, tokenHash });
  }
  if (bots.length === 0) throw new ConfigError("BOTS must list at least one bot when set");
  return bots;
}

/** `chief-of-staff` -> `CHIEF_OF_STAFF`, as used in NOTIFY_URL_<BOT> / NOTIFY_KEY_<BOT>. */
export function notifyEnvSuffix(botId: string): string {
  return botId.toUpperCase().replace(/[^A-Z0-9]/g, "_");
}

/** Error messages name the variable but never echo its value: NOTIFY_KEY_* are secrets. */
export function parseNotifyTargets(
  env: NodeJS.ProcessEnv,
  ids: string[],
  webhookPolicy: WebhookPolicy = DEFAULT_WEBHOOK_POLICY,
): Map<string, NotifyTarget> {
  const targets = new Map<string, NotifyTarget>();
  const known = new Set<string>();
  for (const id of ids) {
    const urlName = `NOTIFY_URL_${notifyEnvSuffix(id)}`;
    const keyName = `NOTIFY_KEY_${notifyEnvSuffix(id)}`;
    known.add(urlName).add(keyName);
    const rawUrl = env[urlName]?.trim();
    const rawKey = env[keyName]?.trim();
    if (!rawUrl && !rawKey) continue;
    if (!rawUrl) throw new ConfigError(`${keyName} is set but ${urlName} is not`);
    if (!rawKey) throw new ConfigError(`${urlName} is set but ${keyName} is not`);
    let href: string;
    try {
      href = validateWebhookUrl(rawUrl, webhookPolicy);
    } catch (err) {
      const msg = err instanceof WebhookUrlError ? err.message : "must be a valid webhook URL";
      throw new ConfigError(`${urlName} ${msg}`);
    }
    let key: string;
    try {
      key = validateWebhookSecret(rawKey);
    } catch {
      throw new ConfigError(`${keyName} must be printable ASCII without spaces`);
    }
    targets.set(id, { url: href, key });
  }
  for (const name of Object.keys(env)) {
    if (/^NOTIFY_(URL|KEY)_/.test(name) && env[name]?.trim() && !known.has(name)) {
      throw new ConfigError(`${name} does not match any bot id in BOTS`);
    }
  }
  return targets;
}

function intFromEnv(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new ConfigError(`${name} must be an integer between ${min} and ${max}`);
  }
  return n;
}

function optionalIntFromEnv(env: NodeJS.ProcessEnv, name: string, min: number, max: number): number | undefined {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new ConfigError(`${name} must be an integer between ${min} and ${max}`);
  }
  return n;
}

function boolFromEnv(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (raw === "true" || raw === "1" || raw === "yes") return true;
  if (raw === "false" || raw === "0" || raw === "no") return false;
  throw new ConfigError(`${name} must be true or false`);
}

function parseWebhookHttpPolicy(env: NodeJS.ProcessEnv): WebhookHttpPolicy {
  const raw = env.WEBHOOK_ALLOW_HTTP?.trim().toLowerCase();
  if (!raw) return "private";
  if (raw === "private" || raw === "always" || raw === "never") return raw;
  if (raw === "true") return "always";
  if (raw === "false") return "never";
  throw new ConfigError('WEBHOOK_ALLOW_HTTP must be "private", "always", or "never"');
}

function parsePublicUrl(raw: string | undefined, hostname: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) return hostname ? `https://${hostname}` : undefined;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new ConfigError("PUBLIC_URL must be a valid http:// or https:// URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ConfigError("PUBLIC_URL must use http:// or https://");
  }
  return trimmed.replace(/\/+$/, "");
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const host = env.HOST?.trim() || "0.0.0.0";
  const port = intFromEnv(env, "PORT", 8080, 1, 65535);
  const adminHost = env.ADMIN_HOST?.trim() || host;
  const adminPort = optionalIntFromEnv(env, "ADMIN_PORT", 1, 65535);
  if (adminPort !== undefined && adminPort === port && adminHost === host) {
    throw new ConfigError("ADMIN_PORT must differ from PORT when bound to the same host");
  }

  const viewerHash = env.VIEWER_TOKEN_SHA256?.trim();
  const adminHashRaw = env.ADMIN_TOKEN_SHA256?.trim();
  const adminPassword = env.ADMIN_PASSWORD?.trim();
  const adminTokenHash = adminHashRaw
    ? parseHash(adminHashRaw, "ADMIN_TOKEN_SHA256")
    : adminPassword
      ? createHash("sha256").update(adminPassword, "utf8").digest()
      : undefined;

  const webhookPolicy: WebhookPolicy = {
    allowHttp: parseWebhookHttpPolicy(env),
    allowLoopback: boolFromEnv(env, "WEBHOOK_ALLOW_LOOPBACK", false),
  };

  const bots = parseBots(env.BOTS);
  const publicHostname = env.PUBLIC_HOSTNAME?.trim() || undefined;
  const publicUrl = parsePublicUrl(env.PUBLIC_URL, publicHostname);

  return {
    host,
    port,
    adminHost,
    adminPort,
    dbPath: env.DB_PATH?.trim() || "/data/relay.db",
    publicHostname,
    publicUrl,
    bots,
    notify: parseNotifyTargets(env, botIds({ bots }), webhookPolicy),
    viewerTokenHash: viewerHash ? parseHash(viewerHash, "VIEWER_TOKEN_SHA256") : undefined,
    adminTokenHash,
    adminGatewayKey: env.ADMIN_GATEWAY_KEY?.trim() || undefined,
    encryptionKey: env.ENCRYPTION_KEY?.trim() || env.APP_SEED?.trim() || undefined,
    bootstrapInviteCode: env.BOOTSTRAP_INVITE_CODE?.trim() || undefined,
    webhookPolicy,
    maxBodyBytes: intFromEnv(env, "MAX_BODY_BYTES", 32 * 1024, 1, 1024 * 1024),
    maxSubjectChars: intFromEnv(env, "MAX_SUBJECT_CHARS", 200, 1, 2000),
    rateLimitPerMinute: intFromEnv(env, "RATE_LIMIT_PER_MINUTE", 120, 1, 100_000),
    registerRateLimitPerMinute: intFromEnv(env, "REGISTER_RATE_LIMIT_PER_MINUTE", 10, 1, 1_000),
  };
}
