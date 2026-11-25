import type { Response } from "express";
import type { MessageMeta, RelayStore } from "./store.ts";

export interface EventHubOptions {
  heartbeatMs?: number | undefined;
  maxPerBot?: number | undefined;
}

/**
 * In-memory Server-Sent Events (SSE) push hub for bots connected to `GET /events`.
 * Streams metadata-only message notifications in real time (never message bodies)
 * and supports `Last-Event-ID` catch-up on reconnect.
 */
export class EventHub {
  private readonly store: RelayStore;
  private readonly maxPerBot: number;
  private readonly clients = new Map<string, Set<Response>>();
  private readonly heartbeatTimer: NodeJS.Timeout;

  constructor(store: RelayStore, opts: EventHubOptions = {}) {
    this.store = store;
    this.maxPerBot = opts.maxPerBot ?? 5;
    const heartbeatMs = opts.heartbeatMs ?? 25_000;
    this.heartbeatTimer = setInterval(() => this.heartbeat(), heartbeatMs);
    this.heartbeatTimer.unref();
  }

  subscribe(botId: string, res: Response, lastEventId?: number): void {
    res.status(200);
    res.set({
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-store, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders();

    let set = this.clients.get(botId);
    if (!set) {
      set = new Set<Response>();
      this.clients.set(botId, set);
    }
    while (set.size >= this.maxPerBot) {
      const oldest = set.values().next().value;
      if (!oldest) break;
      set.delete(oldest);
      try {
        oldest.end();
      } catch {
        // Ignore already-closed stream.
      }
    }
    set.add(res);

    res.on("close", () => {
      const current = this.clients.get(botId);
      if (!current) return;
      current.delete(res);
      if (current.size === 0) this.clients.delete(botId);
    });

    const ready = JSON.stringify({
      bot_id: botId,
      unread_count: this.store.unreadCount(botId),
      server_time: new Date().toISOString(),
    });
    this.safeWrite(botId, res, `event: ready\ndata: ${ready}\n\n`);

    if (lastEventId !== undefined && Number.isInteger(lastEventId) && lastEventId >= 0) {
      const missed = this.store.unreadMessagesAfterSeq(botId, lastEventId);
      for (const msg of missed) {
        this.safeWrite(botId, res, formatMessageFrame(msg));
      }
    }
  }

  publish(event: MessageMeta): void {
    const set = this.clients.get(event.to);
    if (!set || set.size === 0) return;
    const frame = formatMessageFrame(event);
    for (const res of [...set]) {
      this.safeWrite(event.to, res, frame);
    }
  }

  disconnectBot(botId: string): void {
    const set = this.clients.get(botId);
    if (!set) return;
    this.clients.delete(botId);
    for (const res of set) {
      try {
        res.end();
      } catch {
        // Ignore already-closed stream.
      }
    }
  }

  connectedCounts(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const [botId, set] of this.clients) {
      if (set.size > 0) counts[botId] = set.size;
    }
    return counts;
  }

  closeAll(): void {
    clearInterval(this.heartbeatTimer);
    for (const [, set] of this.clients) {
      for (const res of set) {
        try {
          res.end();
        } catch {
          // Ignore already-closed stream.
        }
      }
    }
    this.clients.clear();
  }

  private heartbeat(): void {
    for (const [botId, set] of this.clients) {
      for (const res of [...set]) {
        this.safeWrite(botId, res, ": ping\n\n");
      }
    }
  }

  private safeWrite(botId: string, res: Response, chunk: string): void {
    if (res.writableEnded || res.destroyed) {
      this.removeClient(botId, res);
      return;
    }
    try {
      res.write(chunk);
    } catch {
      this.removeClient(botId, res);
      try {
        res.end();
      } catch {
        // Ignore.
      }
    }
  }

  private removeClient(botId: string, res: Response): void {
    const set = this.clients.get(botId);
    if (!set) return;
    set.delete(res);
    if (set.size === 0) this.clients.delete(botId);
  }
}

function formatMessageFrame(event: MessageMeta): string {
  const payload = JSON.stringify({
    event: "relay.message",
    seq: event.seq,
    message_id: event.message_id,
    thread_id: event.thread_id,
    from: event.from,
    to: event.to,
    subject: event.subject,
    created_at: event.created_at,
  });
  return `id: ${event.seq}\nevent: message\ndata: ${payload}\n\n`;
}
