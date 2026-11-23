import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ConfigError, loadConfig, notifyEnvSuffix } from "../src/config.ts";
import { Notifier, type NotifierOptions } from "../src/notify.ts";
import { bearer, connectClient, payload, startServer, testEnv, type ServerHarness } from "./helpers.ts";

const KEY = "notify-test-key-3f9a1c";
const FAST: NotifierOptions = { timeoutMs: 300, retryDelaysMs: [20, 50], coalesceMs: 0 };

interface Received {
  headers: IncomingHttpHeaders;
  body: Record<string, unknown>;
}

/** Answers with `responses` in order (the last one repeats); "hang" never responds. */
async function mockReceiver(responses: (number | "hang")[] = [204]) {
  const received: Received[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      received.push({ headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString()) });
      const r = responses[Math.min(received.length - 1, responses.length - 1)]!;
      if (r !== "hang") res.writeHead(r).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/hook`,
    received,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

interface Setup {
  s: ServerHarness;
  cos: Client;
  notifier: Notifier;
  post(body?: string): Promise<{ message_id: string; thread_id: string; created_at: string }>;
  notifyAudit(): ReturnType<ServerHarness["store"]["recentAudit"]>;
  close(): Promise<void>;
}

async function setup(url: string | undefined, opts: NotifierOptions = FAST): Promise<Setup> {
  let notifier!: Notifier;
  const targets = new Map(url ? [["abjets-company", { url, key: KEY }]] : []);
  const s = await startServer({}, (h) => (notifier = new Notifier(targets, h.store, opts)));
  const cos = await connectClient(s.baseUrl, bearer("chief-of-staff"));
  return {
    s,
    cos,
    notifier,
    async post(body = "secret body text") {
      const res = await cos.callTool({
        name: "post_message",
        arguments: { to: "abjets-company", subject: "Tail N123AB", body },
      });
      assert.notEqual(res.isError, true);
      return payload(res);
    },
    notifyAudit: () => s.store.recentAudit(100).filter((e) => e.tool === "notify"),
    async close() {
      await notifier.drain();
      await cos.close();
      await s.close();
    },
  };
}

describe("push notification config", () => {
  it("maps bot ids to NOTIFY_URL_<BOT> / NOTIFY_KEY_<BOT>", () => {
    assert.equal(notifyEnvSuffix("chief-of-staff"), "CHIEF_OF_STAFF");
    assert.equal(notifyEnvSuffix("abjets-company"), "ABJETS_COMPANY");
    const config = loadConfig(
      testEnv({
        NOTIFY_URL_CHIEF_OF_STAFF: "https://api2.cursor.sh/automations/webhook/abc",
        NOTIFY_KEY_CHIEF_OF_STAFF: KEY,
        NOTIFY_URL_ABJETS_COMPANY: "",
      }),
    );
    assert.deepEqual([...config.notify.keys()], ["chief-of-staff"]);
    assert.equal(config.notify.get("chief-of-staff")!.url, "https://api2.cursor.sh/automations/webhook/abc");
  });

  it("is off when unset", () => {
    assert.equal(loadConfig(testEnv()).notify.size, 0);
  });

  it("fails fast on http URLs, half-configured bots and unknown bot names, without echoing the key", () => {
    const bad: Record<string, string>[] = [
      { NOTIFY_URL_CHIEF_OF_STAFF: "http://example.test/hook", NOTIFY_KEY_CHIEF_OF_STAFF: KEY },
      { NOTIFY_URL_CHIEF_OF_STAFF: "not a url", NOTIFY_KEY_CHIEF_OF_STAFF: KEY },
      { NOTIFY_URL_CHIEF_OF_STAFF: "https://example.test/hook" },
      { NOTIFY_KEY_CHIEF_OF_STAFF: KEY },
      { NOTIFY_URL_CHIEF_OF_STAFF: "https://example.test/hook", NOTIFY_KEY_CHIEF_OF_STAFF: `${KEY} x` },
      { NOTIFY_URL_CHIEF_OF_STAF: "https://example.test/hook", NOTIFY_KEY_CHIEF_OF_STAF: KEY },
    ];
    for (const env of bad) {
      assert.throws(
        () => loadConfig(testEnv(env)),
        (err: unknown) => err instanceof ConfigError && /NOTIFY_(URL|KEY)_/.test(err.message) && !err.message.includes(KEY),
        JSON.stringify(Object.keys(env)),
      );
    }
  });
});

describe("push notifications", () => {
  it("POSTs metadata only, with both auth headers, and audits the delivery", async () => {
    const rx = await mockReceiver([204]);
    const t = await setup(rx.url);
    try {
      const posted = await t.post();
      await t.notifier.drain();
      assert.equal(rx.received.length, 1);
      const { headers, body } = rx.received[0]!;
      assert.equal(headers.authorization, `Bearer ${KEY}`);
      assert.equal(headers["x-automation-key"], KEY);
      assert.match(headers["content-type"] ?? "", /^application\/json/);
      assert.deepEqual(body, {
        event: "relay.message",
        message_id: posted.message_id,
        thread_id: posted.thread_id,
        from: "chief-of-staff",
        to: "abjets-company",
        subject: "Tail N123AB",
        created_at: posted.created_at,
        message_ids: [posted.message_id],
      });
      assert.ok(!JSON.stringify(body).includes("secret body text"));

      const [entry] = t.notifyAudit();
      assert.equal(entry!.status, "delivered");
      assert.equal(entry!.bot_id, "abjets-company");
      assert.deepEqual(entry!.message_ids, [posted.message_id]);
      assert.equal(entry!.detail, "http_204 attempts=1");
    } finally {
      await t.close();
      await rx.close();
    }
  });

  it("retries 5xx and 429, then records the delivery", async () => {
    const rx = await mockReceiver([503, 429, 200]);
    const t = await setup(rx.url);
    try {
      await t.post();
      await t.notifier.drain();
      assert.equal(rx.received.length, 3);
      assert.equal(t.notifyAudit()[0]!.detail, "http_200 attempts=3");
    } finally {
      await t.close();
      await rx.close();
    }
  });

  it("gives up after 3 attempts", async () => {
    const rx = await mockReceiver([500]);
    const t = await setup(rx.url);
    try {
      await t.post();
      await t.notifier.drain();
      assert.equal(rx.received.length, 3);
      const [entry] = t.notifyAudit();
      assert.equal(entry!.status, "failed");
      assert.equal(entry!.detail, "http_500 attempts=3");
    } finally {
      await t.close();
      await rx.close();
    }
  });

  it("does not retry other 4xx", async () => {
    const rx = await mockReceiver([401]);
    const t = await setup(rx.url);
    try {
      await t.post();
      await t.notifier.drain();
      assert.equal(rx.received.length, 1);
      assert.equal(t.notifyAudit()[0]!.detail, "http_401 attempts=1");
    } finally {
      await t.close();
      await rx.close();
    }
  });

  it("post_message succeeds quickly when the receiver is down; network errors are retried", async () => {
    const rx = await mockReceiver();
    await rx.close();
    const t = await setup(rx.url);
    try {
      const started = Date.now();
      await t.post();
      assert.ok(Date.now() - started < 250, "post_message waited on the webhook");
      await t.notifier.drain();
      const [entry] = t.notifyAudit();
      assert.equal(entry!.status, "failed");
      assert.equal(entry!.detail, "network_error:ECONNREFUSED attempts=3");
    } finally {
      await t.close();
    }
  });

  it("post_message succeeds quickly when the receiver hangs; each attempt times out", async () => {
    const rx = await mockReceiver(["hang"]);
    const t = await setup(rx.url, { ...FAST, timeoutMs: 1_000 });
    try {
      const started = Date.now();
      await t.post();
      await t.post();
      assert.ok(Date.now() - started < 500, "post_message waited on the webhook");
      await t.notifier.drain();
      const entries = t.notifyAudit();
      assert.equal(entries.length, 2);
      assert.ok(entries.every((e) => e.status === "failed" && e.detail === "timeout attempts=3"));
    } finally {
      await t.close();
      await rx.close();
    }
  });

  it("coalesces messages to the same recipient into one ping", async () => {
    const rx = await mockReceiver([204]);
    const t = await setup(rx.url, { ...FAST, coalesceMs: 200 });
    try {
      const ids = [(await t.post("one")).message_id, (await t.post("two")).message_id, (await t.post("three")).message_id];
      await t.notifier.drain();
      assert.equal(rx.received.length, 1);
      assert.equal(rx.received[0]!.body.message_id, ids[2]);
      assert.deepEqual(rx.received[0]!.body.message_ids, ids);
      assert.deepEqual(t.notifyAudit()[0]!.message_ids, ids);
    } finally {
      await t.close();
      await rx.close();
    }
  });

  it("sends nothing for bots without a NOTIFY_URL", async () => {
    const rx = await mockReceiver([204]);
    const t = await setup(rx.url);
    const abj = await connectClient(t.s.baseUrl, bearer("abjets-company"));
    try {
      const res = await abj.callTool({ name: "post_message", arguments: { to: "chief-of-staff", body: "reply" } });
      assert.notEqual(res.isError, true);
      await t.notifier.drain();
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(rx.received.length, 0);
      assert.equal(t.notifyAudit().length, 0);
    } finally {
      await abj.close();
      await t.close();
      await rx.close();
    }
  });

  it("never writes the key to the database", async () => {
    const rx = await mockReceiver([500, 204]);
    const t = await setup(rx.url);
    try {
      await t.post();
      await t.notifier.drain();
      assert.equal(t.notifyAudit().length, 1);
      t.s.db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
      for (const file of readdirSync(t.s.dir)) {
        assert.ok(!readFileSync(join(t.s.dir, file)).toString("latin1").includes(KEY), `key found in ${file}`);
      }
    } finally {
      await t.close();
      await rx.close();
    }
  });
});
