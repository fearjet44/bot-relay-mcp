import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { bearer, connectClient, startServer, type ServerHarness } from "./helpers.ts";

interface SseEvent {
  id?: string;
  event?: string;
  data?: string;
}

async function openSse(
  url: string,
  headers: Record<string, string>,
): Promise<{
  status: number;
  nextEvent(timeoutMs?: number): Promise<SseEvent>;
  waitForClose(timeoutMs?: number): Promise<void>;
  close(): void;
}> {
  const controller = new AbortController();
  const res = await fetch(url, { headers, signal: controller.signal });
  if (!res.ok || !res.body) {
    controller.abort();
    return {
      status: res.status,
      nextEvent: () => Promise.reject(new Error(`HTTP ${res.status}`)),
      waitForClose: () => Promise.resolve(),
      close: () => {},
    };
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const queue: SseEvent[] = [];
  const waiters: ((ev: SseEvent) => void)[] = [];
  let closed = false;
  let closeResolve!: () => void;
  const closePromise = new Promise<void>((r) => (closeResolve = r));

  void (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        for (;;) {
          const idx = buffer.indexOf("\n\n");
          if (idx === -1) break;
          const block = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const ev: SseEvent = {};
          for (const line of block.split("\n")) {
            if (line.startsWith(":")) continue;
            if (line.startsWith("id:")) ev.id = line.slice(3).trim();
            else if (line.startsWith("event:")) ev.event = line.slice(6).trim();
            else if (line.startsWith("data:")) ev.data = line.slice(5).trim();
          }
          if (ev.event || ev.data) {
            const w = waiters.shift();
            if (w) w(ev);
            else queue.push(ev);
          }
        }
      }
    } catch {
      // Aborted by caller.
    } finally {
      closed = true;
      closeResolve();
    }
  })();

  return {
    status: res.status,
    nextEvent(timeoutMs = 2000) {
      if (queue.length > 0) return Promise.resolve(queue.shift()!);
      return new Promise<SseEvent>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("SSE timeout")), timeoutMs);
        waiters.push((ev) => {
          clearTimeout(timer);
          resolve(ev);
        });
      });
    },
    async waitForClose(timeoutMs = 2000) {
      if (closed) return;
      await Promise.race([
        closePromise,
        new Promise<void>((_r, reject) => setTimeout(() => reject(new Error("SSE close timeout")), timeoutMs)),
      ]);
    },
    close() {
      controller.abort();
    },
  };
}

describe("SSE push stream (GET /events)", () => {
  let s: ServerHarness;
  before(async () => {
    s = await startServer();
  });
  after(async () => {
    await s.close();
  });

  it("rejects unauthenticated requests with 401", async () => {
    const res = await fetch(`${s.baseUrl}/events`);
    assert.equal(res.status, 401);
  });

  it("streams ready and metadata-only message notifications in real time", async () => {
    const stream = await openSse(`${s.baseUrl}/events`, bearer("abjets-company"));
    const cos = await connectClient(s.baseUrl, bearer("chief-of-staff"));
    try {
      assert.equal(stream.status, 200);
      const ready = await stream.nextEvent();
      assert.equal(ready.event, "ready");
      const readyData = JSON.parse(ready.data!) as { bot_id: string; unread_count: number };
      assert.equal(readyData.bot_id, "abjets-company");
      assert.equal(readyData.unread_count, 0);

      await cos.callTool({
        name: "post_message",
        arguments: { to: "abjets-company", subject: "Wake up", body: "top-secret-body-never-in-sse" },
      });

      const msg = await stream.nextEvent();
      assert.equal(msg.event, "message");
      assert.ok(msg.id && Number(msg.id) > 0);
      const data = JSON.parse(msg.data!) as Record<string, unknown>;
      assert.equal(data.event, "relay.message");
      assert.equal(data.from, "chief-of-staff");
      assert.equal(data.to, "abjets-company");
      assert.equal(data.subject, "Wake up");
      assert.ok(!msg.data!.includes("top-secret-body-never-in-sse"));
    } finally {
      stream.close();
      await cos.close();
    }
  });

  it("replays missed unread messages on reconnect via Last-Event-ID", async () => {
    const first = s.store.postMessage("chief-of-staff", { to: "abjets-company", body: "m1", subject: "First" });
    const second = s.store.postMessage("chief-of-staff", { to: "abjets-company", body: "m2", subject: "Second" });

    const stream = await openSse(`${s.baseUrl}/events`, {
      ...bearer("abjets-company"),
      "Last-Event-ID": String(first.seq),
    });
    try {
      const ready = await stream.nextEvent();
      assert.equal(ready.event, "ready");
      const replayed = await stream.nextEvent();
      assert.equal(replayed.event, "message");
      assert.equal(replayed.id, String(second.seq));
      const data = JSON.parse(replayed.data!) as { message_id: string; subject: string };
      assert.equal(data.message_id, second.message_id);
      assert.equal(data.subject, "Second");
    } finally {
      stream.close();
    }
  });

  it("disconnects active SSE clients immediately when a DB bot is revoked", async () => {
    const created = s.store.createBot({ id: "ephemeral-bot" });
    const stream = await openSse(`${s.baseUrl}/events`, { Authorization: `Bearer ${created.token}` });
    try {
      const ready = await stream.nextEvent();
      assert.equal(ready.event, "ready");
      assert.equal(s.events.connectedCounts()["ephemeral-bot"], 1);

      s.store.revokeBot("ephemeral-bot");
      s.events.disconnectBot("ephemeral-bot");
      await stream.waitForClose();
      assert.equal(s.events.connectedCounts()["ephemeral-bot"], undefined);
    } finally {
      stream.close();
    }
  });
});
