import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { ConfigError, loadConfig } from "../src/config.ts";
import { connectClient, payload, startServer, type ServerHarness } from "./helpers.ts";

describe("bot self-registration and self-service endpoints", () => {
  let s: ServerHarness;
  before(async () => {
    s = await startServer({ BOTS: "", VIEWER_TOKEN_SHA256: "" });
  });
  after(async () => {
    await s.close();
  });

  it("registers a bot with a valid invite code, returns token once, and lets it use MCP", async () => {
    const { code } = s.store.createInviteCode({ label: "Mac Mini", maxUses: 1, expiresInSeconds: 3600 });
    const res = await fetch(`${s.baseUrl}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code,
        bot_id: "mac-mini",
        display_name: "Mac Mini Bot",
        webhook_url: "http://mac-mini.tail1234.ts.net:9090/hook",
      }),
    });
    assert.equal(res.status, 201);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const body = (await res.json()) as {
      bot_id: string;
      display_name: string;
      token: string;
      mcp_url: string;
      events_url: string;
      webhook: { url: string; secret: string; enabled: boolean };
    };
    assert.equal(body.bot_id, "mac-mini");
    assert.equal(body.display_name, "Mac Mini Bot");
    assert.match(body.token, /^relay_/);
    assert.match(body.mcp_url, /\/mcp$/);
    assert.match(body.events_url, /\/events$/);
    assert.equal(body.webhook.url, "http://mac-mini.tail1234.ts.net:9090/hook");
    assert.match(body.webhook.secret, /^whsec_/);

    // Reusing single-use code fails with 403
    const reuse = await fetch(`${s.baseUrl}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, bot_id: "another-bot" }),
    });
    assert.equal(reuse.status, 403);

    // Newly registered bot can authenticate over MCP and /me
    const client = await connectClient(s.baseUrl, { Authorization: `Bearer ${body.token}` });
    try {
      const peers = payload<{ self: string; peers: string[] }>(await client.callTool({ name: "list_peers", arguments: {} }));
      assert.equal(peers.self, "mac-mini");
      assert.deepEqual(peers.peers, []);
    } finally {
      await client.close();
    }

    const me = await fetch(`${s.baseUrl}/me`, { headers: { Authorization: `Bearer ${body.token}` } });
    assert.equal(me.status, 200);
    const meBody = (await me.json()) as { bot_id: string; webhook: { url: string; has_secret: boolean } };
    assert.equal(meBody.bot_id, "mac-mini");
    assert.equal(meBody.webhook.url, "http://mac-mini.tail1234.ts.net:9090/hook");
    assert.equal(meBody.webhook.has_secret, true);

    // Neither the invite code, bearer token, nor plaintext webhook secret appears in SQLite files
    s.db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    for (const file of readdirSync(s.dir)) {
      if (file === ".relay.key") continue;
      const raw = readFileSync(join(s.dir, file)).toString("latin1");
      assert.ok(!raw.includes(code), `invite code leaked in ${file}`);
      assert.ok(!raw.includes(body.token), `bearer token leaked in ${file}`);
      assert.ok(!raw.includes(body.webhook.secret), `plaintext webhook secret leaked in ${file}`);
    }
  });

  it("enforces bot-locked invites, expiry, revocation, and duplicate bot rejection", async () => {
    const locked = s.store.createInviteCode({ botId: "locked-bot" });
    const mismatch = await fetch(`${s.baseUrl}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: locked.code, bot_id: "wrong-bot" }),
    });
    assert.equal(mismatch.status, 400);

    // Omitting bot_id inherits locked bot_id
    const ok = await fetch(`${s.baseUrl}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: locked.code }),
    });
    assert.equal(ok.status, 201);
    assert.equal(((await ok.json()) as { bot_id: string }).bot_id, "locked-bot");

    // Revoked invite fails with 401
    const rev = s.store.createInviteCode({});
    s.store.revokeInviteCode(rev.invite.id);
    const revRes = await fetch(`${s.baseUrl}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: rev.code, bot_id: "bot-c" }),
    });
    assert.equal(revRes.status, 401);

    // Duplicate bot_id fails with 409
    const dup = s.store.createInviteCode({});
    const dupRes = await fetch(`${s.baseUrl}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: dup.code, bot_id: "locked-bot" }),
    });
    assert.equal(dupRes.status, 409);
  });

  it("supports PUT /me/webhook, MCP set_webhook/get_webhook, and POST /me/token/rotate", async () => {
    const { code } = s.store.createInviteCode({ botId: "self-bot" });
    const reg = (await (
      await fetch(`${s.baseUrl}/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      })
    ).json()) as { token: string };

    // PUT /me/webhook rejects public http://
    const badWh = await fetch(`${s.baseUrl}/me/webhook`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${reg.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ url: "http://example.com/hook" }),
    });
    assert.equal(badWh.status, 400);

    // PUT /me/webhook accepts LAN http://
    const goodWh = await fetch(`${s.baseUrl}/me/webhook`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${reg.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ url: "http://192.168.1.42:8787/hook", secret: "my-secret-123" }),
    });
    assert.equal(goodWh.status, 200);
    const whJson = (await goodWh.json()) as { url: string; enabled: boolean; has_secret: boolean };
    assert.equal(whJson.url, "http://192.168.1.42:8787/hook");
    assert.equal(whJson.enabled, true);
    assert.equal(whJson.has_secret, true);

    // MCP get_webhook & set_webhook
    const client = await connectClient(s.baseUrl, { Authorization: `Bearer ${reg.token}` });
    try {
      const info = payload<{ url: string; has_secret: boolean }>(
        await client.callTool({ name: "get_webhook", arguments: {} }),
      );
      assert.equal(info.url, "http://192.168.1.42:8787/hook");
      assert.equal(info.has_secret, true);

      const cleared = payload<{ url: string | null; enabled: boolean }>(
        await client.callTool({ name: "set_webhook", arguments: { url: null } }),
      );
      assert.equal(cleared.url, null);
      assert.equal(cleared.enabled, false);
    } finally {
      await client.close();
    }

    // Self token rotation (with revoke_others: true)
    const rotRes = await fetch(`${s.baseUrl}/me/token/rotate`, {
      method: "POST",
      headers: { Authorization: `Bearer ${reg.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ revoke_others: true }),
    });
    assert.equal(rotRes.status, 200);
    const rot = (await rotRes.json()) as { token: string; revoked_count: number };
    assert.match(rot.token, /^relay_/);
    assert.equal(rot.revoked_count, 1);

    // Old token is now rejected, new token works
    assert.equal((await fetch(`${s.baseUrl}/me`, { headers: { Authorization: `Bearer ${reg.token}` } })).status, 401);
    assert.equal((await fetch(`${s.baseUrl}/me`, { headers: { Authorization: `Bearer ${rot.token}` } })).status, 200);
  });

  it("rate-limits /register per IP", async () => {
    const limited = await startServer({ BOTS: "", REGISTER_RATE_LIMIT_PER_MINUTE: "2" });
    try {
      for (let i = 0; i < 2; i++) {
        const res = await fetch(`${limited.baseUrl}/register`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code: "join_wrong", bot_id: "x" }),
        });
        assert.equal(res.status, 401);
      }
      const blocked = await fetch(`${limited.baseUrl}/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: "join_wrong", bot_id: "x" }),
      });
      assert.equal(blocked.status, 429);
    } finally {
      await limited.close();
    }
  });

  it("CLI scripts/create-invite.mjs inserts a working invite into SQLite", async () => {
    const out = execFileSync(
      process.execPath,
      [
        "--disable-warning=ExperimentalWarning",
        "scripts/create-invite.mjs",
        "--db",
        s.config.dbPath,
        "--bot",
        "cli-bot",
        "--ttl",
        "15m",
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    const code = out.match(/^CODE\s+(\S+)$/m)?.[1];
    assert.ok(code?.startsWith("join_"));
    const res = await fetch(`${s.baseUrl}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });
    assert.equal(res.status, 201);
    assert.equal(((await res.json()) as { bot_id: string }).bot_id, "cli-bot");
  });

  it("parses and validates BOOTSTRAP_INVITE_* config options", () => {
    const defaults = loadConfig({ BOOTSTRAP_INVITE_CODE: "join_defaults" });
    assert.deepEqual(defaults.bootstrapInvite, {
      code: "join_defaults",
      maxUses: 1,
      expiresInSeconds: 86400,
      botId: null,
    });

    const custom = loadConfig({
      BOOTSTRAP_INVITE_CODE: "join_custom",
      BOOTSTRAP_INVITE_USES: "5",
      BOOTSTRAP_INVITE_TTL: "90s",
      BOOTSTRAP_INVITE_BOT: "worker-1",
    });
    assert.deepEqual(custom.bootstrapInvite, {
      code: "join_custom",
      maxUses: 5,
      expiresInSeconds: 90,
      botId: "worker-1",
    });

    const never = loadConfig({
      BOOTSTRAP_INVITE_CODE: "join_never",
      BOOTSTRAP_INVITE_TTL: "never",
    });
    assert.equal(never.bootstrapInvite?.expiresInSeconds, null);

    // Bounds 60s and 365d succeed; out-of-range values fail fast with ConfigError.
    assert.equal(loadConfig({ BOOTSTRAP_INVITE_CODE: "join_min", BOOTSTRAP_INVITE_TTL: "60s" }).bootstrapInvite?.expiresInSeconds, 60);
    assert.equal(
      loadConfig({ BOOTSTRAP_INVITE_CODE: "join_max", BOOTSTRAP_INVITE_TTL: "365d" }).bootstrapInvite?.expiresInSeconds,
      365 * 86400,
    );

    for (const badEnv of [
      { BOOTSTRAP_INVITE_USES: "0" },
      { BOOTSTRAP_INVITE_USES: "101" },
      { BOOTSTRAP_INVITE_TTL: "59s" },
      { BOOTSTRAP_INVITE_TTL: "366d" },
      { BOOTSTRAP_INVITE_TTL: "soon" },
      { BOOTSTRAP_INVITE_BOT: "Bad_Id" },
    ]) {
      assert.throws(() => loadConfig(badEnv), ConfigError, JSON.stringify(badEnv));
    }
  });
});
