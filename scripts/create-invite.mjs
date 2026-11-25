#!/usr/bin/env node
// Creates a bot self-registration approval / invite code directly in SQLite and prints it ONCE.
//
// Usage:
//   node --disable-warning=ExperimentalWarning scripts/create-invite.mjs
//   node --disable-warning=ExperimentalWarning scripts/create-invite.mjs --bot mac-mini --uses 1 --ttl 1h --label "Mac Mini"
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log(
    "usage: create-invite [--bot <bot-id>] [--uses <1-100>] [--ttl <15m|1h|24h|7d|never>] [--label <text>] [--db <path>]",
  );
  process.exit(0);
}

function getArg(flag) {
  const idx = args.indexOf(flag);
  if (idx === -1) return undefined;
  return args[idx + 1];
}

function parseTtlSeconds(raw) {
  if (!raw || raw === "1h") return 3600;
  if (raw === "never") return null;
  const m = raw.match(/^(\d+)([smhd])$/i);
  if (!m) {
    console.error(`invalid --ttl "${raw}" (examples: 15m, 1h, 24h, 7d, never)`);
    process.exit(1);
  }
  const n = Number(m[1]);
  const mult = { s: 1, m: 60, h: 3600, d: 86400 }[m[2].toLowerCase()];
  return n * mult;
}

const botId = getArg("--bot")?.trim() || null;
if (botId && !/^[a-z0-9][a-z0-9-]{0,62}$/.test(botId)) {
  console.error("bot id must be lowercase letters, digits and dashes (max 63 chars)");
  process.exit(1);
}

const usesRaw = getArg("--uses");
const maxUses = usesRaw ? Number(usesRaw) : 1;
if (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > 100) {
  console.error("--uses must be an integer between 1 and 100");
  process.exit(1);
}

const ttlSeconds = parseTtlSeconds(getArg("--ttl"));
const label = getArg("--label")?.trim() || "cli";
const dbPath = getArg("--db") || process.env.DB_PATH || "/data/relay.db";

mkdirSync(dirname(dbPath), { recursive: true });
const db = new DatabaseSync(dbPath);
try {
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS invite_codes (
      id           TEXT PRIMARY KEY,
      code_hash    TEXT NOT NULL UNIQUE,
      code_prefix  TEXT NOT NULL,
      bot_id       TEXT,
      label        TEXT,
      max_uses     INTEGER NOT NULL DEFAULT 1,
      uses         INTEGER NOT NULL DEFAULT 0,
      expires_at   TEXT,
      created_at   TEXT NOT NULL,
      revoked_at   TEXT,
      last_used_at TEXT
    );
  `);

  const code = `join_${randomBytes(18).toString("base64url")}`;
  const hash = createHash("sha256").update(code, "utf8").digest("hex");
  const prefix = code.slice(0, 9);
  const id = `inv_${randomUUID()}`;
  const now = new Date();
  const expiresAt = ttlSeconds === null ? null : new Date(now.getTime() + ttlSeconds * 1000).toISOString();

  db.prepare(
    `INSERT INTO invite_codes (id, code_hash, code_prefix, bot_id, label, max_uses, uses, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`,
  ).run(id, hash, prefix, botId, label, maxUses, expiresAt, now.toISOString());

  console.error("Shown once. Give this approval code to the bot to POST /register.\n");
  console.log(`CODE     ${code}`);
  console.log(`ID       ${id}`);
  console.log(`BOT      ${botId ?? "(any)"}`);
  console.log(`USES     ${maxUses}`);
  console.log(`EXPIRES  ${expiresAt ?? "never"}`);
} finally {
  db.close();
}
