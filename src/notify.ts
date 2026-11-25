import { createHmac, randomUUID } from "node:crypto";
import type { NotifyTarget } from "./config.ts";
import type { RelayStore } from "./store.ts";

export interface MessageEvent {
  message_id: string;
  thread_id: string;
  from: string;
  to: string;
  subject: string | null;
  created_at: string;
}

export interface NotifierOptions {
  timeoutMs?: number;
  /** Delays before the 2nd, 3rd, ... attempt; its length + 1 is the attempt count. */
  retryDelaysMs?: number[];
  /** Messages to the same recipient within this window share one ping. */
  coalesceMs?: number;
  log?: boolean;
}

export type TargetResolver = ReadonlyMap<string, NotifyTarget> | ((botId: string) => NotifyTarget | undefined);

type AttemptResult = { ok: true; detail: string } | { ok: false; retry: boolean; detail: string };

export function signWebhookPayload(secret: string, timestamp: string, body: string): string {
  const digest = createHmac("sha256", secret).update(`${timestamp}.${body}`, "utf8").digest("hex");
  return `sha256=${digest}`;
}

function describeError(err: unknown): string {
  if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) return "timeout";
  const code = (err as { cause?: { code?: unknown } } | null)?.cause?.code;
  return typeof code === "string" ? `network_error:${code}` : "network_error";
}

/**
 * Fire-and-forget webhook pings telling a bot that mail is waiting. The ping
 * carries metadata only (never the body), signs payloads with HMAC-SHA256 when
 * a secret is configured, and records its outcome in the audit log.
 * Nothing here can throw into, or delay, the post_message call that triggered it.
 */
export class Notifier {
  private readonly resolveTarget: (botId: string) => NotifyTarget | undefined;
  private readonly store: RelayStore;
  private readonly timeoutMs: number;
  private readonly retryDelaysMs: number[];
  private readonly coalesceMs: number;
  private readonly log: boolean;
  private readonly pending = new Map<string, { events: MessageEvent[]; timer: NodeJS.Timeout }>();
  private readonly inflight = new Set<Promise<void>>();

  constructor(targetSource: TargetResolver, store: RelayStore, opts: NotifierOptions = {}) {
    this.resolveTarget =
      typeof targetSource === "function" ? targetSource : (botId: string) => targetSource.get(botId);
    this.store = store;
    this.timeoutMs = opts.timeoutMs ?? 8_000;
    this.retryDelaysMs = opts.retryDelaysMs ?? [2_000, 10_000];
    this.coalesceMs = opts.coalesceMs ?? 1_000;
    this.log = opts.log ?? false;
  }

  messagePosted(event: MessageEvent): void {
    let target: NotifyTarget | undefined;
    try {
      target = this.resolveTarget(event.to);
    } catch {
      return;
    }
    if (!target) return;
    const batch = this.pending.get(event.to);
    if (batch) {
      batch.events.push(event);
      return;
    }
    const timer = setTimeout(() => this.flush(event.to), this.coalesceMs).unref();
    this.pending.set(event.to, { events: [event], timer });
  }

  /** Sends a single non-retried test ping to a bot's configured webhook. */
  async sendTest(botId: string): Promise<{ ok: boolean; detail: string; durationMs: number }> {
    const target = this.resolveTarget(botId);
    if (!target) return { ok: false, detail: "no_webhook_configured", durationMs: 0 };
    const started = Date.now();
    const body = JSON.stringify({
      event: "relay.test",
      to: botId,
      created_at: new Date().toISOString(),
    });
    const result = await this.attempt(target, body, "relay.test");
    const durationMs = Date.now() - started;
    const status = result.ok ? "delivered" : "failed";
    this.store.recordWebhookOutcome(botId, `test_${status}:${result.detail}`);
    try {
      this.store.audit(botId, "notify.test", [], status, result.detail);
    } catch {
      // Ignore if DB closing.
    }
    return { ok: result.ok, detail: result.detail, durationMs };
  }

  /** Sends any coalescing batches now and waits for every delivery (including retries) to finish. */
  async drain(): Promise<void> {
    for (const to of [...this.pending.keys()]) this.flush(to);
    await Promise.all(this.inflight);
  }

  private flush(to: string): void {
    const batch = this.pending.get(to);
    if (!batch) return;
    this.pending.delete(to);
    clearTimeout(batch.timer);
    const delivery = this.deliver(to, batch.events)
      .catch((err: unknown) => console.error(`notify ${to}: ${err instanceof Error ? err.message : "error"}`))
      .finally(() => this.inflight.delete(delivery));
    this.inflight.add(delivery);
  }

  private async deliver(to: string, events: MessageEvent[]): Promise<void> {
    const target = this.resolveTarget(to);
    if (!target) return;
    const latest = events.at(-1)!;
    const messageIds = events.map((e) => e.message_id);
    const body = JSON.stringify({
      event: "relay.message",
      message_id: latest.message_id,
      thread_id: latest.thread_id,
      from: latest.from,
      to: latest.to,
      subject: latest.subject,
      created_at: latest.created_at,
      message_ids: messageIds,
    });

    let attempts = 0;
    let result: AttemptResult;
    for (;;) {
      result = await this.attempt(target, body, "relay.message");
      attempts++;
      if (result.ok || !result.retry || attempts > this.retryDelaysMs.length) break;
      const delay = this.retryDelaysMs[attempts - 1]!;
      await new Promise((resolve) => setTimeout(resolve, delay).unref());
    }

    const status = result.ok ? "delivered" : "failed";
    const detail = `${result.detail} attempts=${attempts}`;
    if (this.log) console.log(`notify bot=${to} ${status} ${detail} messages=${messageIds.length}`);
    this.store.recordWebhookOutcome(to, `${status}:${result.detail}`);
    try {
      this.store.audit(to, "notify", messageIds, status, detail);
    } catch {
      // The database may already be closed during shutdown.
    }
  }

  private async attempt(target: NotifyTarget, body: string, eventName: string): Promise<AttemptResult> {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "X-Relay-Event": eventName,
      "X-Relay-Delivery": `del_${randomUUID()}`,
      "X-Relay-Timestamp": timestamp,
    };
    if (target.key) {
      headers.Authorization = `Bearer ${target.key}`;
      headers["X-Automation-Key"] = target.key;
      headers["X-Relay-Signature-256"] = signWebhookPayload(target.key, timestamp, body);
    }
    try {
      const res = await fetch(target.url, {
        method: "POST",
        headers,
        body,
        redirect: "manual",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      await res.body?.cancel().catch(() => {});
      if (res.ok) return { ok: true, detail: `http_${res.status}` };
      return { ok: false, retry: res.status === 429 || res.status >= 500, detail: `http_${res.status}` };
    } catch (err) {
      return { ok: false, retry: true, detail: describeError(err) };
    }
  }
}
