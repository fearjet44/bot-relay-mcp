// Black-box tests derived from README.md, docs/CONNECTORS.md and docs/DEPLOY.md.
// They exercise only the documented HTTP / MCP / CLI surface (plus the same harness helpers
// the other suites use), so each failure here is a mismatch between the docs and behaviour.
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHmac, timingSafeEqual } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, describe, it } from "node:test";
import { createApp } from "../src/app.ts";
import { sha256 } from "../src/auth.ts";
import { EventHub } from "../src/events.ts";
import { Notifier } from "../src/notify.ts";
import { RateLimiter } from "../src/ratelimit.ts";
import { validateWebhookUrl, WebhookUrlError } from "../src/webhook-url.ts";
import {
  ADMIN_TOKEN,
  bearer,
  connectClient,
  makeHarness,
  payload,
  startServer,
  startSplitServer,
  type ServerHarness,
} from "./helpers.ts";

const JSON_HEADERS = { "Content-Type": "application/json" };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function register(baseUrl: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(`${baseUrl}/register`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body) });
}

/** The verification snippet from docs/CONNECTORS.md, copied verbatim. */
function verifyRelayWebhook(rawBody: string, headers: IncomingHttpHeaders, secret: string): boolean {
  const ts = headers["x-relay-timestamp"] as string | undefined;
  const sig = headers["x-relay-signature-256"] as string | undefined;
  if (!ts || !sig) return false;
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;
  const expected = `sha256=${createHmac("sha256", secret).update(`${ts}.${rawBody}`).digest("hex")}`;
  return expected.length === sig.length && timingSafeEqual(Buffer.from(expected), Buffer.from(sig));
}

interface Hook {
  headers: IncomingHttpHeaders;
  raw: string;
  body: Record<string, unknown>;
}

async function hookReceiver() {
  const received: Hook[] = [];
  const waiters: (() => void)[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString();
      received.push({ headers: req.headers, raw, body: JSON.parse(raw) as Record<string, unknown> });
      res.writeHead(204).end();
      waiters.splice(0).forEach((w) => w());
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/hook`,
    received,
    async waitFor(n: number, timeoutMs = 3000) {
      const deadline = Date.now() + timeoutMs;
      while (received.length < n) {
        if (Date.now() > deadline) throw new Error(`expected ${n} webhook deliveries, got ${received.length}`);
        await new Promise<void>((r) => {
          waiters.push(r);
          setTimeout(r, 50);
        });
      }
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

/** Minimal SSE reader that also records comment lines (heartbeats). */
async function sse(url: string, headers: Record<string, string>) {
  const controller = new AbortController();
  const res = await fetch(url, { headers, signal: controller.signal });
  const events: { id?: string; event?: string; data?: string }[] = [];
  const comments: string[] = [];
  let closed = false;
  if (res.ok && res.body) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    void (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let idx: number;
          while ((idx = buf.indexOf("\n\n")) !== -1) {
            const block = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            const ev: { id?: string; event?: string; data?: string } = {};
            for (const line of block.split("\n")) {
              if (line.startsWith(":")) comments.push(line);
              else if (line.startsWith("id:")) ev.id = line.slice(3).trim();
              else if (line.startsWith("event:")) ev.event = line.slice(6).trim();
              else if (line.startsWith("data:")) ev.data = line.slice(5).trim();
            }
            if (ev.event || ev.data) events.push(ev);
          }
        }
      } catch {
        // aborted
      } finally {
        closed = true;
      }
    })();
  }
  return {
    status: res.status,
    contentType: res.headers.get("content-type"),
    events,
    comments,
    get closed() {
      return closed;
    },
    async until(pred: () => boolean, timeoutMs = 2000) {
      const deadline = Date.now() + timeoutMs;
      while (!pred()) {
        if (Date.now() > deadline) throw new Error("SSE condition timeout");
        await sleep(10);
      }
    },
    close: () => controller.abort(),
  };
}

// ---------------------------------------------------------------------------------------------

describe("docs contract: POST /register", () => {
  let s: ServerHarness;
  before(async () => {
    s = await startServer({ VIEWER_TOKEN_SHA256: "", WEBHOOK_ALLOW_LOOPBACK: "true" });
  });
  after(async () => {
    await s.close();
  });

  it("rejects an expired invite code", async () => {
    // The API enforces a 60s minimum TTL, so backdate the row instead of waiting.
    const { code, invite } = s.store.createInviteCode({ expiresInSeconds: 3600 });
    s.db
      .prepare("UPDATE invite_codes SET expires_at = ? WHERE id = ?")
      .run(new Date(Date.now() - 1000).toISOString(), invite.id);
    const res = await register(s.baseUrl, { code, bot_id: "too-late" });
    assert.notEqual(res.status, 201);
    assert.ok(res.status >= 400 && res.status < 500, `expected 4xx, got ${res.status}`);
  });

  it("honours multi-use invite codes up to maxUses", async () => {
    const { code } = s.store.createInviteCode({ maxUses: 2, expiresInSeconds: 3600 });
    assert.equal((await register(s.baseUrl, { code, bot_id: "multi-1" })).status, 201);
    assert.equal((await register(s.baseUrl, { code, bot_id: "multi-2" })).status, 201);
    const third = await register(s.baseUrl, { code, bot_id: "multi-3" });
    assert.notEqual(third.status, 201);
  });

  it("refuses a bot_id that already exists as a static BOTS entry", async () => {
    const { code } = s.store.createInviteCode({});
    const res = await register(s.baseUrl, { code, bot_id: "chief-of-staff" });
    assert.equal(res.status, 409);
  });

  it("rejects a disallowed webhook_url without burning a single-use code", async () => {
    const { code } = s.store.createInviteCode({ maxUses: 1 });
    const bad = await register(s.baseUrl, { code, bot_id: "typo-bot", webhook_url: "http://example.com/hook" });
    assert.equal(bad.status, 400);
    const retry = await register(s.baseUrl, { code, bot_id: "typo-bot" });
    assert.equal(retry.status, 201, "a rejected request must not consume the single-use code");
  });

  it("rejects missing or malformed bodies with 400 (not 500)", async () => {
    for (const body of ["{}", "not json", JSON.stringify({ code: 42 })]) {
      const res = await fetch(`${s.baseUrl}/register`, { method: "POST", headers: JSON_HEADERS, body });
      assert.ok(res.status === 400 || res.status === 401, `body ${body}: got ${res.status}`);
    }
  });

  it("self-registered bots and static BOTS bots see each other as peers and can message", async () => {
    const { code } = s.store.createInviteCode({});
    const reg = (await (await register(s.baseUrl, { code, bot_id: "dyn-peer" })).json()) as { token: string };
    const cos = await connectClient(s.baseUrl, bearer("chief-of-staff"));
    const dyn = await connectClient(s.baseUrl, { Authorization: `Bearer ${reg.token}` });
    try {
      const cosPeers = payload<{ peers: string[] }>(await cos.callTool({ name: "list_peers", arguments: {} }));
      assert.ok(cosPeers.peers.includes("dyn-peer"));
      const dynPeers = payload<{ peers: string[] }>(await dyn.callTool({ name: "list_peers", arguments: {} }));
      assert.ok(dynPeers.peers.includes("chief-of-staff"));
      const sent = await cos.callTool({ name: "post_message", arguments: { to: "dyn-peer", body: "hello dyn" } });
      assert.notEqual(sent.isError, true);
      const inbox = payload<{ messages: { body: string; from?: string; sender?: string }[] }>(
        await dyn.callTool({ name: "read_messages", arguments: {} }),
      );
      assert.equal(inbox.messages.length, 1);
      assert.equal(inbox.messages[0]!.body, "hello dyn");
    } finally {
      await cos.close();
      await dyn.close();
    }
  });
});

// ---------------------------------------------------------------------------------------------

describe("docs contract: /me and token rotation", () => {
  let s: ServerHarness;
  let token: string;
  before(async () => {
    s = await startServer({ VIEWER_TOKEN_SHA256: "" });
    const { code } = s.store.createInviteCode({ botId: "me-bot" });
    token = ((await (await register(s.baseUrl, { code, display_name: "Me Bot" })).json()) as { token: string }).token;
  });
  after(async () => {
    await s.close();
  });

  it("GET /me returns every documented field, with a live unread_count", async () => {
    s.store.postMessage("chief-of-staff", { to: "me-bot", body: "one" });
    s.store.postMessage("chief-of-staff", { to: "me-bot", body: "two" });
    const res = await fetch(`${s.baseUrl}/me`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(res.status, 200);
    const me = (await res.json()) as Record<string, unknown>;
    for (const key of ["bot_id", "display_name", "mcp_url", "events_url", "unread_count", "webhook", "sse_connections"]) {
      assert.ok(key in me, `GET /me is missing documented field "${key}"`);
    }
    assert.equal(me.bot_id, "me-bot");
    assert.equal(me.display_name, "Me Bot");
    assert.equal(me.unread_count, 2);
    assert.match(String(me.mcp_url), /\/mcp$/);
    assert.match(String(me.events_url), /\/events$/);
  });

  it("GET /me rejects missing and bad tokens", async () => {
    assert.equal((await fetch(`${s.baseUrl}/me`)).status, 401);
    assert.equal((await fetch(`${s.baseUrl}/me`, { headers: { Authorization: "Bearer relay_nope" } })).status, 401);
  });

  it("accepts X-Relay-Token on /me and /events (documented alternative header)", async () => {
    assert.equal((await fetch(`${s.baseUrl}/me`, { headers: { "X-Relay-Token": token } })).status, 200);
    const stream = await sse(`${s.baseUrl}/events`, { "X-Relay-Token": token, Authorization: "Basic Zm9vOmJhcg==" });
    try {
      assert.equal(stream.status, 200);
    } finally {
      stream.close();
    }
  });

  it("POST /me/token/rotate without revoke_others keeps the old token working (zero-downtime)", async () => {
    const res = await fetch(`${s.baseUrl}/me/token/rotate`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, ...JSON_HEADERS },
      body: "{}",
    });
    assert.equal(res.status, 200);
    const { token: fresh } = (await res.json()) as { token: string };
    assert.match(fresh, /^relay_/);
    assert.notEqual(fresh, token);
    assert.equal((await fetch(`${s.baseUrl}/me`, { headers: { Authorization: `Bearer ${token}` } })).status, 200);
    assert.equal((await fetch(`${s.baseUrl}/me`, { headers: { Authorization: `Bearer ${fresh}` } })).status, 200);
  });

  it("PUT /me/webhook with url:null removes the webhook", async () => {
    const put = (body: unknown) =>
      fetch(`${s.baseUrl}/me/webhook`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${token}`, ...JSON_HEADERS },
        body: JSON.stringify(body),
      });
    assert.equal((await put({ url: "http://10.1.2.3:9000/hook" })).status, 200);
    const cleared = await put({ url: null });
    assert.equal(cleared.status, 200);
    const me = (await (await fetch(`${s.baseUrl}/me`, { headers: { Authorization: `Bearer ${token}` } })).json()) as {
      webhook: { url: string | null } | null;
    };
    assert.ok(me.webhook === null || me.webhook.url === null);
  });
});

// ---------------------------------------------------------------------------------------------

describe("docs contract: GET /events", () => {
  let s: ServerHarness;
  before(async () => {
    s = await startServer({ VIEWER_TOKEN_SHA256: "" });
  });
  after(async () => {
    await s.close();
  });

  it("serves text/event-stream and a message event carrying the documented metadata", async () => {
    const stream = await sse(`${s.baseUrl}/events`, bearer("abjets-company"));
    try {
      assert.equal(stream.status, 200);
      assert.match(stream.contentType ?? "", /^text\/event-stream/);
      await stream.until(() => stream.events.length >= 1);
      const ready = JSON.parse(stream.events[0]!.data!) as Record<string, unknown>;
      assert.equal(typeof ready.server_time, "string");

      // Live push is triggered by the MCP post_message path (store.postMessage alone does not publish).
      const cos = await connectClient(s.baseUrl, bearer("chief-of-staff"));
      let posted: { message_id: string };
      try {
        posted = payload(
          await cos.callTool({ name: "post_message", arguments: { to: "abjets-company", body: "b", subject: "S" } }),
        );
      } finally {
        await cos.close();
      }
      await stream.until(() => stream.events.length >= 2);
      const ev = stream.events[1]!;
      assert.equal(ev.event, "message");
      const data = JSON.parse(ev.data!) as Record<string, unknown>;
      assert.equal(String(data.seq), ev.id, "data.seq must match the SSE id");
      assert.equal(data.message_id, posted.message_id);
      assert.equal(typeof data.thread_id, "string");
      assert.equal(typeof data.created_at, "string");
      assert.ok(!("body" in data));
    } finally {
      stream.close();
    }
  });

  it("does not push messages addressed to other bots", async () => {
    const stream = await sse(`${s.baseUrl}/events`, bearer("intruder"));
    try {
      await stream.until(() => stream.events.length >= 1);
      const cos = await connectClient(s.baseUrl, bearer("chief-of-staff"));
      try {
        await cos.callTool({ name: "post_message", arguments: { to: "abjets-company", body: "private" } });
      } finally {
        await cos.close();
      }
      await sleep(150);
      assert.equal(stream.events.filter((e) => e.event === "message").length, 0);
    } finally {
      stream.close();
    }
  });

  it("supports ?since_seq= catch-up and replays only messages that are still unread", async () => {
    const base = s.store.postMessage("chief-of-staff", { to: "intruder", body: "base" });
    const acked = s.store.postMessage("chief-of-staff", { to: "intruder", body: "acked" });
    const unread = s.store.postMessage("chief-of-staff", { to: "intruder", body: "unread" });
    const client = await connectClient(s.baseUrl, bearer("intruder"));
    try {
      await client.callTool({ name: "ack", arguments: { message_ids: [acked.message_id] } });
    } finally {
      await client.close();
    }
    const stream = await sse(`${s.baseUrl}/events?since_seq=${base.seq}`, bearer("intruder"));
    try {
      await stream.until(() => stream.events.some((e) => e.event === "message"));
      await sleep(100);
      const replayed = stream.events.filter((e) => e.event === "message").map((e) => e.id);
      assert.deepEqual(replayed, [String(unread.seq)]);
    } finally {
      stream.close();
    }
  });
});

describe("docs contract: SSE heartbeat", () => {
  it("emits ': ping' comment lines on the heartbeat interval", async () => {
    const h = makeHarness({ VIEWER_TOKEN_SHA256: "" });
    const events = new EventHub(h.store, { heartbeatMs: 50 });
    const notifier = new Notifier((id) => h.store.getWebhookTarget(id), h.store, { coalesceMs: 0 });
    const app = createApp({
      config: h.config,
      store: h.store,
      limiter: new RateLimiter(h.config.rateLimitPerMinute),
      notifier,
      events,
      encryptionKey: h.encryptionKey,
    });
    const server = await new Promise<Server>((r) => {
      const srv = app.listen(0, "127.0.0.1", () => r(srv));
    });
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/events`;
    const stream = await sse(url, bearer("chief-of-staff"));
    try {
      await stream.until(() => stream.comments.some((c) => /^:\s*ping/.test(c)), 1000);
    } finally {
      stream.close();
      events.closeAll();
      await notifier.drain();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      h.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------------------------

describe("docs contract: dynamic webhooks end-to-end", () => {
  let s: ServerHarness;
  let rx: Awaited<ReturnType<typeof hookReceiver>>;
  before(async () => {
    rx = await hookReceiver();
    s = await startServer({ VIEWER_TOKEN_SHA256: "", WEBHOOK_ALLOW_LOOPBACK: "true" });
  });
  after(async () => {
    await s.close();
    await rx.close();
  });

  it("delivers a signed, metadata-only ping to a webhook set at /register (auto-generated secret)", async () => {
    const { code } = s.store.createInviteCode({ botId: "hooked" });
    const reg = (await (await register(s.baseUrl, { code, webhook_url: rx.url })).json()) as {
      token: string;
      webhook: { secret: string };
    };
    const before = rx.received.length;
    const cos = await connectClient(s.baseUrl, bearer("chief-of-staff"));
    let posted: { message_id: string; thread_id: string };
    try {
      posted = payload(
        await cos.callTool({ name: "post_message", arguments: { to: "hooked", subject: "Hi", body: "body-never-sent" } }),
      );
    } finally {
      await cos.close();
    }
    await s.notifier.drain();
    await rx.waitFor(before + 1);
    const hit = rx.received.at(-1)!;
    const secret = reg.webhook.secret;
    assert.ok(verifyRelayWebhook(hit.raw, hit.headers, secret), "documented verify snippet must accept the delivery");
    assert.equal(hit.headers["x-relay-event"], "relay.message");
    assert.match(String(hit.headers["x-relay-delivery"]), /^del_/);
    assert.equal(hit.headers.authorization, `Bearer ${secret}`);
    assert.equal(hit.headers["x-automation-key"], secret);
    assert.equal(hit.body.event, "relay.message");
    assert.equal(hit.body.message_id, posted.message_id);
    assert.equal(hit.body.thread_id, posted.thread_id);
    assert.equal(hit.body.from, "chief-of-staff");
    assert.equal(hit.body.to, "hooked");
    assert.deepEqual(hit.body.message_ids, [posted.message_id]);
    assert.ok(!hit.raw.includes("body-never-sent"));

    // Delivery outcome is surfaced through get_webhook
    const bot = await connectClient(s.baseUrl, { Authorization: `Bearer ${reg.token}` });
    try {
      const info = payload<{ last_status: unknown; last_at: unknown; enabled: boolean }>(
        await bot.callTool({ name: "get_webhook", arguments: {} }),
      );
      assert.equal(info.enabled, true);
      assert.ok(info.last_status, "last_status should be recorded after a delivery");
      assert.ok(info.last_at, "last_at should be recorded after a delivery");
    } finally {
      await bot.close();
    }
  });

  it("signs with the caller-supplied webhook_secret, and set_webhook enabled:false pauses delivery", async () => {
    const mySecret = "bot-chosen-secret-abc123";
    const { code } = s.store.createInviteCode({ botId: "hooked-2" });
    const reg = (await (
      await register(s.baseUrl, { code, webhook_url: rx.url, webhook_secret: mySecret })
    ).json()) as { token: string };

    let n = rx.received.length;
    const cos = await connectClient(s.baseUrl, bearer("chief-of-staff"));
    try {
      await cos.callTool({ name: "post_message", arguments: { to: "hooked-2", body: "y" } });
      await s.notifier.drain();
      await rx.waitFor(n + 1);
      const hit = rx.received.at(-1)!;
      assert.equal(hit.body.to, "hooked-2");
      assert.ok(verifyRelayWebhook(hit.raw, hit.headers, mySecret));

      const bot = await connectClient(s.baseUrl, { Authorization: `Bearer ${reg.token}` });
      try {
        const paused = payload<{ enabled: boolean; url: string }>(
          await bot.callTool({ name: "set_webhook", arguments: { url: rx.url, enabled: false } }),
        );
        assert.equal(paused.enabled, false);
      } finally {
        await bot.close();
      }
      n = rx.received.length;
      await cos.callTool({ name: "post_message", arguments: { to: "hooked-2", body: "z" } });
      await s.notifier.drain();
      await sleep(150);
      assert.equal(rx.received.length, n, "a paused webhook must not be called");
    } finally {
      await cos.close();
    }
  });
});

// ---------------------------------------------------------------------------------------------

describe("docs contract: webhook URL policy", () => {
  it("allows every documented private suffix under the default policy", () => {
    for (const url of [
      "http://nas.lan:8080/hook",
      "http://box.home.arpa/hook",
      "http://svc.internal/hook",
      "http://host.containers.internal:9000/hook",
      "http://172.31.255.254/hook",
      "http://100.127.255.254/hook",
      "http://[fc00::1]/hook",
    ]) {
      assert.equal(validateWebhookUrl(url), url, url);
    }
  });

  it("treats addresses just outside the private ranges as public", () => {
    for (const url of [
      "http://172.32.0.1/hook",
      "http://172.15.255.255/hook",
      "http://100.128.0.1/hook",
      "http://100.63.255.255/hook",
      "http://192.169.0.1/hook",
      "http://11.0.0.1/hook",
    ]) {
      assert.throws(() => validateWebhookUrl(url), WebhookUrlError, url);
    }
  });

  it("blocks the whole 169.254.0.0/16 link-local range, not just .169.254", () => {
    for (const url of ["http://169.254.0.1/", "https://169.254.42.42/", "http://169.254.170.2/v2/credentials"]) {
      assert.throws(() => validateWebhookUrl(url), WebhookUrlError, url);
    }
  });

  it("WEBHOOK_ALLOW_HTTP=never requires https even on the LAN", () => {
    assert.throws(
      () => validateWebhookUrl("http://192.168.1.50/hook", { allowHttp: "never", allowLoopback: false }),
      WebhookUrlError,
    );
    assert.equal(
      validateWebhookUrl("https://192.168.1.50/hook", { allowHttp: "never", allowLoopback: false }),
      "https://192.168.1.50/hook",
    );
  });

  it("WEBHOOK_ALLOW_HTTP=always permits public http but still blocks metadata and loopback", () => {
    const opts = { allowHttp: "always" as const, allowLoopback: false };
    assert.equal(validateWebhookUrl("http://example.com/hook", opts), "http://example.com/hook");
    assert.throws(() => validateWebhookUrl("http://169.254.169.254/", opts), WebhookUrlError);
    assert.throws(() => validateWebhookUrl("http://metadata.google.internal/", opts), WebhookUrlError);
    assert.throws(() => validateWebhookUrl("http://127.0.0.1/", opts), WebhookUrlError);
  });

  it("metadata stays blocked even when loopback is allowed", () => {
    assert.throws(
      () => validateWebhookUrl("http://169.254.169.254/", { allowHttp: "private", allowLoopback: true }),
      WebhookUrlError,
    );
  });
});

// ---------------------------------------------------------------------------------------------

describe("docs contract: Admin surface", () => {
  it("serves the Admin API on PORT when ADMIN_PORT is unset (unified mode)", async () => {
    const s = await startServer({ ADMIN_TOKEN_SHA256: sha256(ADMIN_TOKEN).toString("hex") });
    try {
      const res = await fetch(`${s.baseUrl}/api/admin/overview`, { headers: { Authorization: `Bearer ${ADMIN_TOKEN}` } });
      assert.equal(res.status, 200);
      const body = (await res.json()) as { server: { split_port: boolean } };
      assert.equal(body.server.split_port, false);
      // Bot surface still works on the same port
      assert.equal((await fetch(`${s.baseUrl}/me`, { headers: bearer("chief-of-staff") })).status, 200);
    } finally {
      await s.close();
    }
  });

  it("GET /log accepts Admin auth as well as the viewer token", async () => {
    const s = await startServer({ ADMIN_TOKEN_SHA256: sha256(ADMIN_TOKEN).toString("hex") });
    try {
      const res = await fetch(`${s.baseUrl}/log`, { headers: { Authorization: `Bearer ${ADMIN_TOKEN}` } });
      assert.equal(res.status, 200);
      assert.match(res.headers.get("content-type") ?? "", /text\/html/);
    } finally {
      await s.close();
    }
  });

  it("split mode: /healthz is served on both ports; a bot token is not admin auth on /log", async () => {
    const s = await startSplitServer({ ADMIN_TOKEN_SHA256: sha256(ADMIN_TOKEN).toString("hex") });
    try {
      assert.equal((await fetch(`${s.botUrl}/healthz`)).status, 200);
      assert.equal((await fetch(`${s.adminUrl}/healthz`)).status, 200);
      assert.equal((await fetch(`${s.adminUrl}/log`, { headers: bearer("chief-of-staff") })).status, 401);
    } finally {
      await s.close();
    }
  });

  it("rejects a wrong admin password at /login without issuing a session cookie", async () => {
    const s = await startSplitServer({ ADMIN_TOKEN_SHA256: sha256(ADMIN_TOKEN).toString("hex") });
    try {
      const res = await fetch(`${s.adminUrl}/login`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "password=wrong",
        redirect: "manual",
      });
      assert.ok(!(res.headers.get("set-cookie") ?? "").includes("bot_relay_admin="));
      // Must not redirect into the dashboard with a valid session
      const ui = await fetch(`${s.adminUrl}/api/admin/overview`, {
        headers: { Cookie: (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "" },
      });
      assert.equal(ui.status, 401);
    } finally {
      await s.close();
    }
  });

  it("admin revoke invalidates the bot's token and drops its live SSE stream; restore issues a working token", async () => {
    const s = await startSplitServer({ ADMIN_TOKEN_SHA256: sha256(ADMIN_TOKEN).toString("hex") });
    const auth = { Authorization: `Bearer ${ADMIN_TOKEN}` };
    try {
      const created = await fetch(`${s.adminUrl}/api/admin/bots`, {
        method: "POST",
        headers: { ...auth, ...JSON_HEADERS },
        body: JSON.stringify({ id: "doomed" }),
      });
      assert.equal(created.status, 201);
      const { token } = (await created.json()) as { token: string };
      assert.match(token, /^relay_/);

      const stream = await sse(`${s.botUrl}/events`, { Authorization: `Bearer ${token}` });
      try {
        await stream.until(() => stream.events.length >= 1);
        const revoked = await fetch(`${s.adminUrl}/api/admin/bots/doomed/revoke`, { method: "POST", headers: auth });
        assert.equal(revoked.status, 200);
        await stream.until(() => stream.closed, 2000);
      } finally {
        stream.close();
      }
      assert.equal((await fetch(`${s.botUrl}/me`, { headers: { Authorization: `Bearer ${token}` } })).status, 401);

      const restored = await fetch(`${s.adminUrl}/api/admin/bots/doomed/restore`, { method: "POST", headers: auth });
      const { token: fresh } = (await restored.json()) as { token: string };
      assert.equal((await fetch(`${s.botUrl}/me`, { headers: { Authorization: `Bearer ${fresh}` } })).status, 200);
    } finally {
      await s.close();
    }
  });
});

// ---------------------------------------------------------------------------------------------

describe("docs contract: CLI and process", () => {
  it("create-invite honours DB_PATH from the environment (as in DEPLOY.md) and --uses", async () => {
    const s = await startServer({ VIEWER_TOKEN_SHA256: "" });
    try {
      const out = execFileSync(
        process.execPath,
        ["--disable-warning=ExperimentalWarning", "scripts/create-invite.mjs", "--ttl", "1h", "--uses", "2"],
        { encoding: "utf8", env: { ...process.env, DB_PATH: s.config.dbPath }, stdio: ["ignore", "pipe", "ignore"] },
      );
      const code = out.match(/^CODE\s+(\S+)$/m)?.[1];
      assert.ok(code?.startsWith("join_"), out);
      assert.equal((await register(s.baseUrl, { code, bot_id: "cli-a" })).status, 201);
      assert.equal((await register(s.baseUrl, { code, bot_id: "cli-b" })).status, 201);
      assert.notEqual((await register(s.baseUrl, { code, bot_id: "cli-c" })).status, 201);
    } finally {
      await s.close();
    }
  });

  it("create-invite rejects an invalid --ttl and --bot", () => {
    for (const args of [["--ttl", "soon"], ["--bot", "Bad_Id"]]) {
      assert.throws(() =>
        execFileSync(process.execPath, ["--disable-warning=ExperimentalWarning", "scripts/create-invite.mjs", ...args], {
          env: { ...process.env, DB_PATH: join(tmpdir(), "never-created.db") },
          stdio: "ignore",
        }),
      );
    }
  });

  it("create-invite rejects TTLs outside 60 seconds–365 days with exit 1 and no stack trace", () => {
    const dir = mkdtempSync(join(tmpdir(), "bot-relay-ttl-"));
    try {
      for (const ttl of ["30s", "59s", "366d", "400d"]) {
        const dbPath = join(dir, ttl, "relay.db");
        let err: unknown;
        try {
          execFileSync(
            process.execPath,
            ["--disable-warning=ExperimentalWarning", "scripts/create-invite.mjs", "--db", dbPath, "--ttl", ttl],
            { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
          );
        } catch (e) {
          err = e;
        }
        assert.ok(err instanceof Error, ttl);
        const failure = err as Error & { status?: number; stderr?: string };
        assert.equal(failure.status, 1, ttl);
        const stderr = String(failure.stderr ?? "");
        assert.match(stderr, /60 seconds/, stderr);
        assert.match(stderr, /365 days/, stderr);
        assert.doesNotMatch(stderr, /\n\s+at /);
        assert.equal(existsSync(dbPath), false, `${ttl} must not create a database`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("create-invite accepts the TTL bounds 60s and 365d", () => {
    const dir = mkdtempSync(join(tmpdir(), "bot-relay-ttl-ok-"));
    try {
      for (const ttl of ["60s", "365d"]) {
        const out = execFileSync(
          process.execPath,
          ["--disable-warning=ExperimentalWarning", "scripts/create-invite.mjs", "--db", join(dir, `${ttl}.db`), "--ttl", ttl],
          { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
        );
        assert.match(out, /^EXPIRES\s+\d{4}-/m, out);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

async function freePort(): Promise<number> {
  const srv = createServer();
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const { port } = srv.address() as AddressInfo;
  await new Promise<void>((r) => srv.close(() => r()));
  return port;
}

async function boot(env: Record<string, string>): Promise<{ proc: ChildProcess; output: () => string; stop(): Promise<void> }> {
  const proc = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "src/index.ts"], {
    env: { PATH: process.env.PATH ?? "", HOST: "127.0.0.1", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  proc.stdout!.on("data", (d: Buffer) => (out += d.toString()));
  proc.stderr!.on("data", (d: Buffer) => (out += d.toString()));
  const deadline = Date.now() + 10_000;
  for (;;) {
    if (proc.exitCode !== null) throw new Error(`relay exited early (${proc.exitCode}):\n${out}`);
    try {
      if ((await fetch(`http://127.0.0.1:${env.PORT}/healthz`)).ok) break;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) {
      proc.kill("SIGKILL");
      throw new Error(`relay did not become healthy:\n${out}`);
    }
    await sleep(100);
  }
  return {
    proc,
    output: () => out,
    async stop() {
      if (proc.exitCode !== null) return;
      const exited = new Promise<void>((r) => proc.once("exit", () => r()));
      proc.kill("SIGTERM");
      await Promise.race([exited, sleep(5000).then(() => proc.kill("SIGKILL"))]);
    },
  };
}

describe("docs contract: zero-config boot (src/index.ts)", () => {
  let dir: string;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), "bot-relay-boot-"));
  });
  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("boots with no BOTS, prints a one-time admin password, seeds BOOTSTRAP_INVITE_CODE, and survives restart", async () => {
    const PORT = String(await freePort());
    const ADMIN_PORT = String(await freePort());
    const env = {
      PORT,
      ADMIN_PORT,
      DB_PATH: join(dir, "relay.db"),
      BOOTSTRAP_INVITE_CODE: "join_boot_test_code_1234567890",
      WEBHOOK_ALLOW_LOOPBACK: "true",
    };
    const bot = `http://127.0.0.1:${PORT}`;
    const admin = `http://127.0.0.1:${ADMIN_PORT}`;

    const first = await boot(env);
    let password: string | undefined;
    let regToken: string;
    try {
      assert.equal((await fetch(`${admin}/healthz`)).status, 200);
      assert.equal((await fetch(`${bot}/api/admin/overview`)).status, 404);
      const log = first.output();
      assert.match(log, /password/i, `first boot should print an admin password:\n${log}`);
      // Find a token-looking word on the line that mentions the password.
      const line = log.split("\n").find((l) => /password/i.test(l)) ?? "";
      password = line.match(/[:=]\s*([A-Za-z0-9_\-]{12,})/)?.[1] ??
        log.slice(log.search(/password/i)).match(/\b([A-Za-z0-9_\-]{16,})\b/)?.[1];
      assert.ok(password, `could not find the printed password in:\n${log}`);
      assert.equal(
        (await fetch(`${admin}/api/admin/overview`, { headers: { Authorization: `Bearer ${password}` } })).status,
        200,
        "printed first-run password must authenticate",
      );
      assert.ok(existsSync(join(dir, ".relay.key")), "encryption key should be auto-generated next to the DB");

      const reg = await register(bot, { code: env.BOOTSTRAP_INVITE_CODE, bot_id: "boot-bot" });
      assert.equal(reg.status, 201);
      regToken = ((await reg.json()) as { token: string }).token;
      // Current seed: 50 uses, no expiry, any bot id. A second bot is accepted.
      assert.equal((await register(bot, { code: env.BOOTSTRAP_INVITE_CODE, bot_id: "boot-bot-2" })).status, 201);
    } finally {
      await first.stop();
    }

    const second = await boot(env);
    try {
      assert.ok(
        !second.output().includes(password!),
        "the first-run admin password must not be printed again on restart",
      );
      assert.equal(
        (await fetch(`${admin}/api/admin/overview`, { headers: { Authorization: `Bearer ${password}` } })).status,
        200,
        "first-run password must keep working after restart",
      );
      assert.equal((await fetch(`${bot}/me`, { headers: { Authorization: `Bearer ${regToken!}` } })).status, 200);
    } finally {
      await second.stop();
    }
    // Restart must not re-seed / reset the bootstrap invite's usage counter.
    const db = new DatabaseSync(env.DB_PATH);
    try {
      const rows = db.prepare(
        "SELECT max_uses, expires_at, bot_id, uses FROM invite_codes WHERE label = 'bootstrap (env)'",
      ).all() as { max_uses: number; expires_at: string | null; bot_id: string | null; uses: number }[];
      assert.equal(rows.length, 1, "bootstrap invite must be seeded exactly once");
      assert.equal(rows[0]!.max_uses, 50);
      assert.equal(rows[0]!.expires_at, null);
      assert.equal(rows[0]!.bot_id, null);
      assert.equal(rows[0]!.uses, 2);
    } finally {
      db.close();
    }
  });

  it("scripts/healthcheck.mjs exits 0 when both ports are healthy and 1 when the relay is down", async () => {
    const PORT = String(await freePort());
    const ADMIN_PORT = String(await freePort());
    const sub = mkdtempSync(join(dir, "hc-"));
    const env = { PORT, ADMIN_PORT, DB_PATH: join(sub, "relay.db"), ADMIN_PASSWORD: "hc-pass-123456" };
    const run = () =>
      spawn(process.execPath, ["scripts/healthcheck.mjs"], { env: { PATH: process.env.PATH ?? "", PORT, ADMIN_PORT } });
    const code = (p: ChildProcess) => new Promise<number | null>((r) => p.once("exit", (c) => r(c)));
    const relay = await boot(env);
    try {
      assert.equal(await code(run()), 0);
    } finally {
      await relay.stop();
    }
    assert.equal(await code(run()), 1);
  });

  it("exits non-zero on a malformed BOTS value instead of starting", async () => {
    const PORT = String(await freePort());
    const sub = mkdtempSync(join(dir, "bad-"));
    const proc = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "src/index.ts"], {
      env: { PATH: process.env.PATH ?? "", PORT, HOST: "127.0.0.1", DB_PATH: join(sub, "relay.db"), BOTS: "nope" },
      stdio: "ignore",
    });
    const exit = await Promise.race([
      new Promise<number | null>((r) => proc.once("exit", (c) => r(c))),
      sleep(5000).then(() => "running" as const),
    ]);
    if (exit === "running") proc.kill("SIGKILL");
    assert.notEqual(exit, "running");
    assert.notEqual(exit, 0);
  });
});
