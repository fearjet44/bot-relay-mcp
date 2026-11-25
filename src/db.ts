import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

const SCHEMA_VERSION = 2;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS threads (
  id              TEXT PRIMARY KEY,
  subject         TEXT,
  participant_a   TEXT NOT NULL,
  participant_b   TEXT NOT NULL,
  created_by      TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  last_message_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS threads_a ON threads(participant_a, last_message_at);
CREATE INDEX IF NOT EXISTS threads_b ON threads(participant_b, last_message_at);

CREATE TABLE IF NOT EXISTS messages (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  id         TEXT NOT NULL UNIQUE,
  thread_id  TEXT NOT NULL REFERENCES threads(id),
  sender     TEXT NOT NULL,
  recipient  TEXT NOT NULL,
  subject    TEXT,
  body       TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_recipient ON messages(recipient, seq);
CREATE INDEX IF NOT EXISTS messages_sender ON messages(sender, seq);
CREATE INDEX IF NOT EXISTS messages_thread ON messages(thread_id, seq);

CREATE TABLE IF NOT EXISTS receipts (
  message_id TEXT PRIMARY KEY REFERENCES messages(id),
  bot_id     TEXT NOT NULL,
  read_at    TEXT,
  acked_at   TEXT
);

CREATE TABLE IF NOT EXISTS audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          TEXT NOT NULL,
  bot_id      TEXT,
  tool        TEXT NOT NULL,
  message_ids TEXT NOT NULL DEFAULT '[]',
  status      TEXT NOT NULL,
  detail      TEXT
);

CREATE TRIGGER IF NOT EXISTS audit_log_no_update
BEFORE UPDATE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only');
END;

CREATE TRIGGER IF NOT EXISTS audit_log_no_delete
BEFORE DELETE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only');
END;

CREATE TABLE IF NOT EXISTS bots (
  id                  TEXT PRIMARY KEY,
  display_name        TEXT,
  created_at          TEXT NOT NULL,
  last_seen_at        TEXT,
  revoked_at          TEXT,
  webhook_url         TEXT,
  webhook_secret_enc  TEXT,
  webhook_enabled     INTEGER NOT NULL DEFAULT 1,
  webhook_last_status TEXT,
  webhook_last_at     TEXT
);

CREATE TABLE IF NOT EXISTS bot_tokens (
  id           TEXT PRIMARY KEY,
  bot_id       TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  token_hash   TEXT NOT NULL UNIQUE,
  label        TEXT,
  created_at   TEXT NOT NULL,
  revoked_at   TEXT,
  last_used_at TEXT
);
CREATE INDEX IF NOT EXISTS bot_tokens_bot ON bot_tokens(bot_id, revoked_at);

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

CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

export function openDatabase(path: string): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = NORMAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec("BEGIN;");
  try {
    db.exec(SCHEMA);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`);
    db.exec("COMMIT;");
  } catch (err) {
    db.exec("ROLLBACK;");
    throw err;
  }
  return db;
}

export function transaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE;");
  try {
    const result = fn();
    db.exec("COMMIT;");
    return result;
  } catch (err) {
    db.exec("ROLLBACK;");
    throw err;
  }
}
