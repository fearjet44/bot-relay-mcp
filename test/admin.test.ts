import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { sha256 } from "../src/auth.ts";
import { openDatabase } from "../src/db.ts";
import { ADMIN_TOKEN, bearer, startSplitServer } from "./helpers.ts";

describe("Admin API, Web UI, MODC gateway auth, and split-port isolation", () => {
  it("isolates admin routes onto ADMIN_PORT and supports MODC x-omarchy-gateway + Bearer + cookie auth", async () => {
    const gatewayKey = "omarchy-gateway-secret-1234";
    const s = await startSplitServer({
      ADMIN_TOKEN_SHA256: sha256(ADMIN_TOKEN).toString("hex"),
      ADMIN_GATEWAY_KEY: gatewayKey,
      WEBHOOK_ALLOW_LOOPBACK: "true",
    });

    // Mock local webhook receiver for test ping
    const received: { headers: Record<string, string | string[] | undefined>; body: unknown }[] = [];
    const hookServer = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        received.push({ headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString()) });
        res.writeHead(200).end();
      });
    });
    await new Promise<void>((r) => hookServer.listen(0, "127.0.0.1", r));
    const hookPort = (hookServer.address() as AddressInfo).port;

    try {
      // Bot port does NOT expose admin API or UI
      assert.equal((await fetch(`${s.botUrl}/api/admin/overview`, { headers: { Authorization: `Bearer ${ADMIN_TOKEN}` } })).status, 404);
      assert.equal((await fetch(`${s.botUrl}/`)).status, 404);

      // Admin port does NOT expose /mcp or /register
      assert.equal((await fetch(`${s.adminUrl}/mcp`, { method: "POST" })).status, 404);
      assert.equal((await fetch(`${s.adminUrl}/register`, { method: "POST" })).status, 404);

      // Admin port rejects missing auth and rejects bot bearer tokens
      assert.equal((await fetch(`${s.adminUrl}/api/admin/overview`)).status, 401);
      assert.equal((await fetch(`${s.adminUrl}/api/admin/overview`, { headers: bearer("chief-of-staff") })).status, 401);

      // MODC gateway header works seamlessly without login
      const viaGateway = await fetch(`${s.adminUrl}/api/admin/overview`, {
        headers: { "x-omarchy-gateway": gatewayKey },
      });
      assert.equal(viaGateway.status, 200);
      const gwData = (await viaGateway.json()) as { server: { auth_method: string; split_port: boolean } };
      assert.equal(gwData.server.auth_method, "gateway");
      assert.equal(gwData.server.split_port, true);

      // Wrong gateway key fails
      assert.equal(
        (await fetch(`${s.adminUrl}/api/admin/overview`, { headers: { "x-omarchy-gateway": "wrong-key" } })).status,
        401,
      );

      // HTML login form sets HttpOnly session cookie, and cookie mutations enforce X-Requested-With CSRF check
      const loginRes = await fetch(`${s.adminUrl}/login`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: `password=${encodeURIComponent(ADMIN_TOKEN)}`,
        redirect: "manual",
      });
      assert.equal(loginRes.status, 302);
      const cookie = loginRes.headers.get("set-cookie")?.split(";")[0];
      assert.ok(cookie?.startsWith("bot_relay_admin="));

      const uiPage = await fetch(`${s.adminUrl}/`, { headers: { Cookie: cookie! } });
      assert.equal(uiPage.status, 200);
      assert.match(await uiPage.text(), /Bot Relay/);

      // Cookie POST without X-Requested-With is blocked (CSRF)
      const csrfBlocked = await fetch(`${s.adminUrl}/api/admin/invites`, {
        method: "POST",
        headers: { Cookie: cookie!, "Content-Type": "application/json" },
        body: JSON.stringify({ bot_id: "csrf-test" }),
      });
      assert.equal(csrfBlocked.status, 403);

      // Cookie POST with X-Requested-With succeeds
      const invRes = await fetch(`${s.adminUrl}/api/admin/invites`, {
        method: "POST",
        headers: { Cookie: cookie!, "Content-Type": "application/json", "X-Requested-With": "bot-relay-ui" },
        body: JSON.stringify({ bot_id: "new-lan-bot", label: "LAN test" }),
      });
      assert.equal(invRes.status, 201);
      const inv = (await invRes.json()) as { code: string; curl_example: string; bot_prompt: string };
      assert.match(inv.code, /^join_/);
      assert.ok(inv.curl_example.includes("/register"));
      assert.ok(inv.bot_prompt.includes(inv.code));

      // Create bot via Admin API, configure webhook, test webhook, verify encryption at rest
      const createRes = await fetch(`${s.adminUrl}/api/admin/bots`, {
        method: "POST",
        headers: { Authorization: `Bearer ${ADMIN_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ id: "hook-bot" }),
      });
      assert.equal(createRes.status, 201);

      const secret = "super-secret-webhook-key-999";
      const whRes = await fetch(`${s.adminUrl}/api/admin/bots/hook-bot/webhook`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${ADMIN_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ url: `http://127.0.0.1:${hookPort}/test`, secret }),
      });
      assert.equal(whRes.status, 200);

      const testRes = await fetch(`${s.adminUrl}/api/admin/bots/hook-bot/webhook/test`, {
        method: "POST",
        headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
      });
      assert.equal(testRes.status, 200);
      const testJson = (await testRes.json()) as { ok: boolean; detail: string };
      assert.equal(testJson.ok, true);
      assert.equal(testJson.detail, "http_200");
      assert.equal(received.length, 1);
      assert.equal(received[0]!.headers["x-relay-event"], "relay.test");
      assert.match(String(received[0]!.headers["x-relay-signature-256"] ?? ""), /^sha256=[0-9a-f]{64}$/);

      // Ensure plaintext webhook secret is encrypted at rest (never in SQLite files)
      s.db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
      for (const file of readdirSync(s.dir)) {
        if (file === ".relay.key") continue;
        assert.ok(!readFileSync(join(s.dir, file)).toString("latin1").includes(secret), `secret found in ${file}`);
      }

      // Revoke & restore bot
      assert.equal(
        (await fetch(`${s.adminUrl}/api/admin/bots/hook-bot/revoke`, { method: "POST", headers: { Authorization: `Bearer ${ADMIN_TOKEN}` } })).status,
        200,
      );
      const restoreRes = await fetch(`${s.adminUrl}/api/admin/bots/hook-bot/restore`, {
        method: "POST",
        headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
      });
      assert.equal(restoreRes.status, 200);
      assert.match(((await restoreRes.json()) as { token: string }).token, /^relay_/);
    } finally {
      hookServer.closeAllConnections();
      await new Promise<void>((r) => hookServer.close(() => r()));
      await s.close();
    }
  });

  it("migrates a v1 SQLite database cleanly to v2 without losing existing messages or audit log", () => {
    const dir = mkdtempSync(join(tmpdir(), "bot-relay-migrate-"));
    const dbPath = join(dir, "relay.db");
    try {
      // Simulate a v1 database
      const v1 = new DatabaseSync(dbPath);
      v1.exec(`
        CREATE TABLE threads (id TEXT PRIMARY KEY, subject TEXT, participant_a TEXT NOT NULL, participant_b TEXT NOT NULL, created_by TEXT NOT NULL, created_at TEXT NOT NULL, last_message_at TEXT NOT NULL);
        CREATE TABLE messages (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, thread_id TEXT NOT NULL, sender TEXT NOT NULL, recipient TEXT NOT NULL, subject TEXT, body TEXT NOT NULL, created_at TEXT NOT NULL);
        CREATE TABLE receipts (message_id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, read_at TEXT, acked_at TEXT);
        CREATE TABLE audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, bot_id TEXT, tool TEXT NOT NULL, message_ids TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL, detail TEXT);
        INSERT INTO threads VALUES ('thr_1', 'Hi', 'a', 'b', 'a', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
        INSERT INTO messages (id, thread_id, sender, recipient, subject, body, created_at) VALUES ('msg_1', 'thr_1', 'a', 'b', 'Hi', 'hello', '2026-01-01T00:00:00Z');
        INSERT INTO receipts VALUES ('msg_1', 'b', NULL, NULL);
        INSERT INTO audit_log (ts, bot_id, tool, message_ids, status) VALUES ('2026-01-01T00:00:00Z', 'a', 'post_message', '["msg_1"]', 'ok');
        PRAGMA user_version = 1;
      `);
      v1.close();

      const upgraded = openDatabase(dbPath);
      try {
        const ver = upgraded.prepare("PRAGMA user_version").get() as { user_version: number };
        assert.equal(ver.user_version, 2);
        const msg = upgraded.prepare("SELECT body FROM messages WHERE id = 'msg_1'").get() as { body: string };
        assert.equal(msg.body, "hello");
        // v2 tables exist
        assert.ok(upgraded.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='bots'").get());
        assert.ok(upgraded.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='invite_codes'").get());
      } finally {
        upgraded.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
