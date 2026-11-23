#!/usr/bin/env node
// Writes a consistent, compacted copy of the live database (safe while the
// relay is running in WAL mode) to /data/backups/relay-<timestamp>.db, or to
// the path given as the first argument.
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const source = process.env.DB_PATH || "/data/relay.db";
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const target = process.argv[2] || join(dirname(source), "backups", `relay-${stamp}.db`);

mkdirSync(dirname(target), { recursive: true });
const db = new DatabaseSync(source, { readOnly: true });
try {
  db.prepare("VACUUM INTO ?").run(target);
} finally {
  db.close();
}
console.log(target);
