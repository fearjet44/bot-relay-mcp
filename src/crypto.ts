import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const HKDF_SALT = Buffer.from("bot-relay-mcp-v2", "utf8");
const HKDF_INFO = Buffer.from("webhook-secret-encryption", "utf8");
const HEX_KEY_PATTERN = /^[0-9a-f]{64}$/i;

export function deriveEncryptionKey(seed: string): Buffer {
  return Buffer.from(hkdfSync("sha256", Buffer.from(seed, "utf8"), HKDF_SALT, HKDF_INFO, 32));
}

/**
 * Loads or generates a 32-byte AES-256 key used to encrypt DB-stored webhook
 * secrets at rest. Never stores the key inside SQLite so DB backups do not
 * contain plaintext webhook secrets.
 */
export function loadOrCreateEncryptionKey(opts: { envKey?: string | undefined; dbPath: string }): Buffer {
  const fromEnv = opts.envKey?.trim();
  if (fromEnv) return deriveEncryptionKey(fromEnv);
  if (opts.dbPath === ":memory:") return randomBytes(32);

  const keyPath = join(dirname(opts.dbPath), ".relay.key");
  try {
    return parseStoredKey(readFileSync(keyPath, "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  mkdirSync(dirname(keyPath), { recursive: true });
  const key = randomBytes(32);
  try {
    writeFileSync(keyPath, `${key.toString("hex")}\n`, { mode: 0o600, flag: "wx" });
    return key;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      return parseStoredKey(readFileSync(keyPath, "utf8"));
    }
    throw err;
  }
}

function parseStoredKey(raw: string): Buffer {
  const trimmed = raw.trim();
  if (HEX_KEY_PATTERN.test(trimmed)) return Buffer.from(trimmed, "hex");
  return deriveEncryptionKey(trimmed);
}

export function encryptSecret(plaintext: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64url")}:${tag.toString("base64url")}:${ct.toString("base64url")}`;
}

export function decryptSecret(encoded: string, key: Buffer): string {
  const parts = encoded.split(":");
  if (parts.length !== 4 || parts[0] !== "v1") {
    throw new Error("unsupported encrypted secret format");
  }
  const iv = Buffer.from(parts[1]!, "base64url");
  const tag = Buffer.from(parts[2]!, "base64url");
  const ct = Buffer.from(parts[3]!, "base64url");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}
