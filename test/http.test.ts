import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { bearer, rpc, startServer, TOKENS, VIEWER_TOKEN, type ServerHarness } from "./helpers.ts";

const INIT = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "curl", version: "0" } },
};

describe("HTTP surface", () => {
  let s: ServerHarness;
  before(async () => {
    s = await startServer();
  });
  after(async () => {
    await s.close();
  });

  it("GET /healthz needs no auth and returns no data", async () => {
    const res = await fetch(`${s.baseUrl}/healthz`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { status: "ok" });
  });

  it("POST /mcp rejects a missing token with 401", async () => {
    const res = await rpc(s.baseUrl, {}, INIT);
    assert.equal(res.status, 401);
    assert.match(res.headers.get("www-authenticate") ?? "", /^Bearer/);
    const body = (await res.json()) as { error: { message: string } };
    assert.equal(body.error.message, "Unauthorized");
  });

  it("POST /mcp rejects a bad token, a non-Bearer scheme, and the viewer token", async () => {
    const attempts: Record<string, string>[] = [
      { Authorization: "Bearer relay_not-a-real-token" },
      { Authorization: `Basic ${Buffer.from(`x:${TOKENS["chief-of-staff"]}`).toString("base64")}` },
      { Authorization: `Bearer ${VIEWER_TOKEN}` },
      { "X-Relay-Token": "relay_wrong" },
    ];
    for (const headers of attempts) {
      const res = await rpc(s.baseUrl, headers, INIT);
      assert.equal(res.status, 401, JSON.stringify(Object.keys(headers)));
    }
  });

  it("POST /mcp accepts a valid bearer token", async () => {
    const res = await rpc(s.baseUrl, bearer("chief-of-staff"), INIT);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { result: { serverInfo: { name: string } } };
    assert.equal(body.result.serverInfo.name, "bot-relay");
  });

  it("POST /mcp accepts X-Relay-Token even when Authorization carries something else", async () => {
    const res = await rpc(
      s.baseUrl,
      {
        Authorization: '{"cf-access-client-id":"id.access","cf-access-client-secret":"secret"}',
        "X-Relay-Token": TOKENS["abjets-company"],
      },
      INIT,
    );
    assert.equal(res.status, 200);
  });

  it("unauthenticated attempts are audited without the presented token", async () => {
    await rpc(s.baseUrl, { Authorization: "Bearer relay_leak-canary" }, INIT);
    const entries = s.store.recentAudit(50).filter((e) => e.status === "unauthorized");
    assert.ok(entries.length > 0);
    assert.ok(entries.every((e) => e.bot_id === null));
    const dump = JSON.stringify(s.store.recentAudit(500));
    assert.ok(!dump.includes("relay_leak-canary"));
    assert.ok(!dump.includes(TOKENS["chief-of-staff"]));
  });

  it("GET and DELETE /mcp return 405 for authenticated bots, 401 otherwise", async () => {
    assert.equal((await rpc(s.baseUrl, bearer("chief-of-staff"), undefined, "GET")).status, 405);
    assert.equal((await rpc(s.baseUrl, bearer("chief-of-staff"), undefined, "DELETE")).status, 405);
    assert.equal((await rpc(s.baseUrl, {}, undefined, "GET")).status, 401);
  });

  it("rejects malformed JSON with 400", async () => {
    const res = await fetch(`${s.baseUrl}/mcp`, {
      method: "POST",
      headers: { ...bearer("chief-of-staff"), "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: "{not json",
    });
    assert.equal(res.status, 400);
  });

  describe("GET /log viewer", () => {
    it("requires the viewer token", async () => {
      const res = await fetch(`${s.baseUrl}/log`);
      assert.equal(res.status, 401);
      assert.match(res.headers.get("www-authenticate") ?? "", /^Basic/);
      assert.equal((await fetch(`${s.baseUrl}/log`, { headers: bearer("chief-of-staff") })).status, 401);
    });

    it("renders escaped HTML for Bearer and Basic auth", async () => {
      s.store.postMessage("chief-of-staff", { to: "abjets-company", body: "<script>alert(1)</script>", subject: "x&y" });
      const viaBearer = await fetch(`${s.baseUrl}/log`, { headers: { Authorization: `Bearer ${VIEWER_TOKEN}` } });
      assert.equal(viaBearer.status, 200);
      assert.match(viaBearer.headers.get("content-type") ?? "", /text\/html/);
      assert.match(viaBearer.headers.get("content-security-policy") ?? "", /default-src 'none'/);
      const html = await viaBearer.text();
      assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
      assert.ok(!html.includes("<script>"));
      assert.ok(html.includes("x&amp;y"));
      assert.ok(html.includes("Audit log"));

      const basic = Buffer.from(`justin:${VIEWER_TOKEN}`).toString("base64");
      const viaBasic = await fetch(`${s.baseUrl}/log`, { headers: { Authorization: `Basic ${basic}` } });
      assert.equal(viaBasic.status, 200);
    });

    it("only supports GET", async () => {
      const res = await fetch(`${s.baseUrl}/log`, { method: "POST", headers: { Authorization: `Bearer ${VIEWER_TOKEN}` } });
      assert.equal(res.status, 404);
    });
  });
});

describe("HTTP surface with the viewer disabled", () => {
  it("returns 404 for /log when VIEWER_TOKEN_SHA256 is unset", async () => {
    const s = await startServer({ VIEWER_TOKEN_SHA256: "" });
    try {
      const res = await fetch(`${s.baseUrl}/log`, { headers: { Authorization: `Bearer ${VIEWER_TOKEN}` } });
      assert.equal(res.status, 404);
    } finally {
      await s.close();
    }
  });
});
