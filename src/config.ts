export interface BotEntry {
  id: string;
  tokenHash: Buffer;
}

export interface Config {
  host: string;
  port: number;
  dbPath: string;
  publicHostname: string | undefined;
  bots: BotEntry[];
  viewerTokenHash: Buffer | undefined;
  maxBodyBytes: number;
  maxSubjectChars: number;
  rateLimitPerMinute: number;
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

/** Parses `BOTS="chief-of-staff:<sha256>,abjets-company:<sha256>"`. */
export function parseBots(value: string | undefined): BotEntry[] {
  if (!value || !value.trim()) {
    throw new ConfigError("BOTS is required (format: id:sha256hex,id:sha256hex)");
  }
  const bots: BotEntry[] = [];
  const seenIds = new Set<string>();
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
    if (seenIds.has(id)) throw new ConfigError(`BOTS id "${id}" is listed twice`);
    if (seenHashes.has(tokenHash.toString("hex"))) {
      throw new ConfigError(`BOTS hash for "${id}" duplicates another bot's hash`);
    }
    seenIds.add(id);
    seenHashes.add(tokenHash.toString("hex"));
    bots.push({ id, tokenHash });
  }
  if (bots.length === 0) throw new ConfigError("BOTS must list at least one bot");
  return bots;
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
  return {
    host: env.HOST?.trim() || "0.0.0.0",
    port: intFromEnv(env, "PORT", 8080, 1, 65535),
    dbPath: env.DB_PATH?.trim() || "/data/relay.db",
    publicHostname: env.PUBLIC_HOSTNAME?.trim() || undefined,
    bots: parseBots(env.BOTS),
    viewerTokenHash: viewerHash ? parseHash(viewerHash, "VIEWER_TOKEN_SHA256") : undefined,
    maxBodyBytes: intFromEnv(env, "MAX_BODY_BYTES", 32 * 1024, 1, 1024 * 1024),
    maxSubjectChars: intFromEnv(env, "MAX_SUBJECT_CHARS", 200, 1, 2000),
    rateLimitPerMinute: intFromEnv(env, "RATE_LIMIT_PER_MINUTE", 120, 1, 100_000),
  };
}
