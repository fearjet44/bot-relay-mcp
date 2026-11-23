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

type AttemptResult = { ok: true; detail: string } | { ok: false; retry: boolean; detail: string };

function describeError(err: unknown): string {
  if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) return "timeout";
  const code = (err as { cause?: { code?: unknown } } | null)?.cause?.code;
  return typeof code === "string" ? `network_error:${code}` : "network_error";
}

/**
 * Fire-and-forget webhook pings telling a bot that mail is waiting. The ping
 * carries metadata only (never the body), and its outcome goes to the audit log.
 * Nothing here can throw into, or delay, the post_message call that triggered it.
 */
export class Notifier {
  private readonly targets: ReadonlyMap<string, NotifyTarget>;
  private readonly store: RelayStore;
  private readonly timeoutMs: number;
  private readonly retryDelaysMs: number[];
  private readonly coalesceMs: number;
  private readonly log: boolean;
  private readonly pending = new Map<string, { events: MessageEvent[]; timer: NodeJS.Timeout }>();
  private readonly inflight = new Set<Promise<void>>();

  constructor(targets: ReadonlyMap<string, NotifyTarget>, store: RelayStore, opts: NotifierOptions = {}) {
    this.targets = targets;
    this.store = store;
    this.timeoutMs = opts.timeoutMs ?? 8_000;
    this.retryDelaysMs = opts.retryDelaysMs ?? [2_000, 10_000];
    this.coalesceMs = opts.coalesceMs ?? 1_000;
    this.log = opts.log ?? false;
  }

  messagePosted(event: MessageEvent): void {
    if (!this.targets.has(event.to)) return;
    const batch = this.pending.get(event.to);
    if (batch) {
      batch.events.push(event);
      return;
    }
    const timer = setTimeout(() => this.flush(event.to), this.coalesceMs).unref();
    this.pending.set(event.to, { events: [event], timer });
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
    const target = this.targets.get(to)!;
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
      result = await this.attempt(target, body);
      attempts++;
      if (result.ok || !result.retry || attempts > this.retryDelaysMs.length) break;
      const delay = this.retryDelaysMs[attempts - 1]!;
      await new Promise((resolve) => setTimeout(resolve, delay).unref());
    }

    const status = result.ok ? "delivered" : "failed";
    const detail = `${result.detail} attempts=${attempts}`;
    if (this.log) console.log(`notify bot=${to} ${status} ${detail} messages=${messageIds.length}`);
    try {
      this.store.audit(to, "notify", messageIds, status, detail);
    } catch {
      // The database may already be closed during shutdown.
    }
  }

  private async attempt(target: NotifyTarget, body: string): Promise<AttemptResult> {
    try {
      const res = await fetch(target.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${target.key}`,
          "X-Automation-Key": target.key,
        },
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
