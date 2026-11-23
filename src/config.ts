export interface BotEntry {
  id: string;
  tokenHash: Buffer;
}

export interface NotifyTarget {
  url: string;
  key: string;
}

export interface Config {
  host: string;
  port: number;
  dbPath: string;
  publicHostname: string | undefined;
  bots: BotEntry[];
  /** Bot id -> webhook to ping when a message lands for that bot. */
  notify: Map<string, NotifyTarget>;
  viewerTokenHash: Buffer | undefined;
  maxBodyBytes: number;
  maxSubjectChars: number;
  rateLimitPerMinute: number;
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
 * Parses `BOTS="chief-of-staff:<sha256>,abjets-company:<sha256>"`. An id may
 * appear more than once (with different hashes) to rotate its token without downtime.
 */
export function parseBots(value: string | undefined): BotEntry[] {
  if (!value || !value.trim()) {
    throw new ConfigError("BOTS is required (format: id:sha256hex,id:sha256hex)");
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
  if (bots.length === 0) throw new ConfigError("BOTS must list at least one bot");
  return bots;
}

/** `chief-of-staff` -> `CHIEF_OF_STAFF`, as used in NOTIFY_URL_<BOT> / NOTIFY_KEY_<BOT>. */
export function notifyEnvSuffix(botId: string): string {
  return botId.toUpperCase().replace(/[^A-Z0-9]/g, "_");
}

const NOTIFY_KEY_PATTERN = /^[\x21-\x7e]+$/;

/** Error messages name the variable but never echo its value: NOTIFY_KEY_* are secrets. */
export function parseNotifyTargets(env: NodeJS.ProcessEnv, ids: string[]): Map<string, NotifyTarget> {
  const targets = new Map<string, NotifyTarget>();
  const known = new Set<string>();
  for (const id of ids) {
    const urlName = `NOTIFY_URL_${notifyEnvSuffix(id)}`;
    const keyName = `NOTIFY_KEY_${notifyEnvSuffix(id)}`;
    known.add(urlName).add(keyName);
    const rawUrl = env[urlName]?.trim();
    const key = env[keyName]?.trim();
    if (!rawUrl && !key) continue;
    if (!rawUrl) throw new ConfigError(`${keyName} is set but ${urlName} is not`);
    if (!key) throw new ConfigError(`${urlName} is set but ${keyName} is not`);
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      throw new ConfigError(`${urlName} must be a valid https:// URL`);
    }
    if (url.protocol !== "https:") throw new ConfigError(`${urlName} must be an https:// URL`);
    if (url.username || url.password) throw new ConfigError(`${urlName} must not contain credentials`);
    if (!NOTIFY_KEY_PATTERN.test(key)) {
      throw new ConfigError(`${keyName} must be printable ASCII without spaces`);
    }
    targets.set(id, { url: url.href, key });
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

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const viewerHash = env.VIEWER_TOKEN_SHA256?.trim();
  const bots = parseBots(env.BOTS);
  return {
    host: env.HOST?.trim() || "0.0.0.0",
    port: intFromEnv(env, "PORT", 8080, 1, 65535),
    dbPath: env.DB_PATH?.trim() || "/data/relay.db",
    publicHostname: env.PUBLIC_HOSTNAME?.trim() || undefined,
    bots,
    notify: parseNotifyTargets(env, botIds({ bots })),
    viewerTokenHash: viewerHash ? parseHash(viewerHash, "VIEWER_TOKEN_SHA256") : undefined,
    maxBodyBytes: intFromEnv(env, "MAX_BODY_BYTES", 32 * 1024, 1, 1024 * 1024),
    maxSubjectChars: intFromEnv(env, "MAX_SUBJECT_CHARS", 200, 1, 2000),
    rateLimitPerMinute: intFromEnv(env, "RATE_LIMIT_PER_MINUTE", 120, 1, 100_000),
  };
}
