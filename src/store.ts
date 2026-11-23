import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { transaction } from "./db.ts";

export class RelayError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export interface StoreLimits {
  maxBodyBytes: number;
  maxSubjectChars: number;
}

export interface MessageView {
  message_id: string;
  thread_id: string;
  from: string;
  to: string;
  subject: string | null;
  body: string;
  created_at: string;
  direction: "incoming" | "outgoing";
  /** When the recipient marked it read / acked it (for outgoing: the peer's receipt). */
  read_at: string | null;
  acked_at: string | null;
}

export interface ThreadView {
  thread_id: string;
  subject: string | null;
  peer: string;
  created_by: string;
  created_at: string;
  last_message_at: string;
  message_count: number;
  unread_count: number;
}

export type AuditStatus = "ok" | "error" | "rate_limited" | "unauthorized" | "forbidden";

export interface AuditEntry {
  id: number;
  ts: string;
  bot_id: string | null;
  tool: string;
  message_ids: string[];
  status: string;
  detail: string | null;
}

export interface ViewerMessage {
  message_id: string;
  thread_id: string;
  from: string;
  to: string;
  subject: string | null;
  body: string;
  created_at: string;
  read_at: string | null;
  acked_at: string | null;
}

interface MessageRow {
  id: string;
  thread_id: string;
  sender: string;
  recipient: string;
  subject: string | null;
  body: string;
  created_at: string;
  read_at: string | null;
  acked_at: string | null;
}

interface ThreadRow {
  id: string;
  subject: string | null;
  participant_a: string;
  participant_b: string;
  created_by: string;
  created_at: string;
  last_message_at: string;
}

export const MAX_READ_LIMIT = 200;
export const MAX_ACK_IDS = 200;

function normalizeSince(since: string | undefined): string | undefined {
  if (since === undefined) return undefined;
  const ms = Date.parse(since);
  if (Number.isNaN(ms)) throw new RelayError("invalid_since", "since must be an ISO-8601 timestamp");
  return new Date(ms).toISOString();
}

function clampLimit(limit: number | undefined, fallback: number): number {
  if (limit === undefined) return fallback;
  return Math.max(1, Math.min(MAX_READ_LIMIT, Math.floor(limit)));
}

export class RelayStore {
  private readonly db: DatabaseSync;
  private readonly botIds: ReadonlySet<string>;
  private readonly limits: StoreLimits;
  private readonly now: () => Date;

  constructor(db: DatabaseSync, botIds: Iterable<string>, limits: StoreLimits, now: () => Date = () => new Date()) {
    this.db = db;
    this.botIds = new Set(botIds);
    this.limits = limits;
    this.now = now;
  }

  private timestamp(): string {
    return this.now().toISOString();
  }

  listPeers(me: string): { self: string; peers: string[] } {
    return { self: me, peers: [...this.botIds].filter((id) => id !== me).sort() };
  }

  postMessage(
    me: string,
    input: { to: string; body: string; subject?: string | undefined; thread_id?: string | undefined },
  ): { message_id: string; thread_id: string; created_at: string } {
    const to = input.to.trim();
    if (!this.botIds.has(to)) throw new RelayError("unknown_recipient", `unknown recipient "${to}"; call list_peers`);
    if (to === me) throw new RelayError("invalid_recipient", "cannot send a message to yourself");
    if (input.body.length === 0) throw new RelayError("empty_body", "body must not be empty");
    const bodyBytes = Buffer.byteLength(input.body, "utf8");
    if (bodyBytes > this.limits.maxBodyBytes) {
      throw new RelayError(
        "body_too_large",
        `body is ${bodyBytes} bytes; the limit is ${this.limits.maxBodyBytes} bytes`,
      );
    }
    const subject = input.subject?.trim() || null;
    if (subject !== null && subject.length > this.limits.maxSubjectChars) {
      throw new RelayError("subject_too_long", `subject exceeds ${this.limits.maxSubjectChars} characters`);
    }

    return transaction(this.db, () => {
      const createdAt = this.timestamp();
      let threadId: string;
      if (input.thread_id) {
        const thread = this.getThreadFor(me, input.thread_id);
        const peer = thread.participant_a === me ? thread.participant_b : thread.participant_a;
        if (peer !== to) {
          throw new RelayError("thread_mismatch", `thread ${thread.id} is with "${peer}", not "${to}"`);
        }
        threadId = thread.id;
        this.db.prepare("UPDATE threads SET last_message_at = ? WHERE id = ?").run(createdAt, threadId);
      } else {
        threadId = `thr_${randomUUID()}`;
        const [a, b] = [me, to].sort() as [string, string];
        this.db
          .prepare(
            `INSERT INTO threads (id, subject, participant_a, participant_b, created_by, created_at, last_message_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(threadId, subject, a, b, me, createdAt, createdAt);
      }
      const messageId = `msg_${randomUUID()}`;
      this.db
        .prepare(
          `INSERT INTO messages (id, thread_id, sender, recipient, subject, body, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(messageId, threadId, me, to, subject, input.body, createdAt);
      this.db.prepare("INSERT INTO receipts (message_id, bot_id) VALUES (?, ?)").run(messageId, to);
      return { message_id: messageId, thread_id: threadId, created_at: createdAt };
    });
  }

  /**
   * - `unread_only` (default): messages addressed to `me` that are not yet read, oldest first.
   * - otherwise with `since`: incoming and outgoing messages after `since`, oldest first.
   * - otherwise: the most recent `limit` incoming and outgoing messages, in chronological order.
   */
  readMessages(
    me: string,
    input: {
      unread_only?: boolean | undefined;
      since?: string | undefined;
      thread_id?: string | undefined;
      limit?: number | undefined;
      mark_read?: boolean | undefined;
    },
  ): { messages: MessageView[]; has_more: boolean; marked_read: number } {
    const unreadOnly = input.unread_only ?? true;
    const since = normalizeSince(input.since);
    const limit = clampLimit(input.limit, 50);
    if (input.thread_id) this.getThreadFor(me, input.thread_id);

    const where: string[] = [];
    const params: (string | number)[] = [];
    if (unreadOnly) {
      where.push("m.recipient = ?", "r.read_at IS NULL");
      params.push(me);
    } else {
      where.push("(m.recipient = ? OR m.sender = ?)");
      params.push(me, me);
    }
    if (since) {
      where.push("m.created_at > ?");
      params.push(since);
    }
    if (input.thread_id) {
      where.push("m.thread_id = ?");
      params.push(input.thread_id);
    }
    const newestFirst = !unreadOnly && !since;
    const sql = `
      SELECT m.id, m.thread_id, m.sender, m.recipient, m.subject, m.body, m.created_at, r.read_at, r.acked_at
      FROM messages m JOIN receipts r ON r.message_id = m.id
      WHERE ${where.join(" AND ")}
      ORDER BY m.seq ${newestFirst ? "DESC" : "ASC"}
      LIMIT ?`;

    return transaction(this.db, () => {
      const rows = this.db.prepare(sql).all(...params, limit + 1) as unknown as MessageRow[];
      const hasMore = rows.length > limit;
      const page = rows.slice(0, limit);
      if (newestFirst) page.reverse();

      let markedRead = 0;
      if (input.mark_read) {
        const readAt = this.timestamp();
        const mark = this.db.prepare(
          "UPDATE receipts SET read_at = ? WHERE message_id = ? AND bot_id = ? AND read_at IS NULL",
        );
        for (const row of page) {
          if (row.recipient === me && row.read_at === null) {
            mark.run(readAt, row.id, me);
            row.read_at = readAt;
            markedRead++;
          }
        }
      }
      return { messages: page.map((row) => this.toView(me, row)), has_more: hasMore, marked_read: markedRead };
    });
  }

  listThreads(me: string, input: { limit?: number | undefined; since?: string | undefined }): { threads: ThreadView[] } {
    const since = normalizeSince(input.since);
    const limit = clampLimit(input.limit, 20);
    const params: (string | number)[] = [me, me, me];
    let sinceClause = "";
    if (since) {
      sinceClause = "AND t.last_message_at > ?";
      params.push(since);
    }
    params.push(limit);
    const rows = this.db
      .prepare(
        `SELECT t.*,
           (SELECT COUNT(*) FROM messages m WHERE m.thread_id = t.id) AS message_count,
           (SELECT COUNT(*) FROM messages m JOIN receipts r ON r.message_id = m.id
             WHERE m.thread_id = t.id AND m.recipient = ? AND r.read_at IS NULL) AS unread_count
         FROM threads t
         WHERE (t.participant_a = ? OR t.participant_b = ?) ${sinceClause}
         ORDER BY (SELECT MAX(m.seq) FROM messages m WHERE m.thread_id = t.id) DESC
         LIMIT ?`,
      )
      .all(...params) as unknown as (ThreadRow & { message_count: number; unread_count: number })[];
    return {
      threads: rows.map((t) => ({
        thread_id: t.id,
        subject: t.subject,
        peer: t.participant_a === me ? t.participant_b : t.participant_a,
        created_by: t.created_by,
        created_at: t.created_at,
        last_message_at: t.last_message_at,
        message_count: Number(t.message_count),
        unread_count: Number(t.unread_count),
      })),
    };
  }

  /** Marks messages addressed to `me` as read and acknowledged. Idempotent. */
  ack(me: string, messageIds: string[]): { acked: string[]; not_found: string[] } {
    const ids = [...new Set(messageIds)];
    if (ids.length === 0) throw new RelayError("no_ids", "message_ids must not be empty");
    if (ids.length > MAX_ACK_IDS) throw new RelayError("too_many_ids", `at most ${MAX_ACK_IDS} message_ids per call`);
    return transaction(this.db, () => {
      const at = this.timestamp();
      const update = this.db.prepare(
        `UPDATE receipts SET read_at = COALESCE(read_at, ?), acked_at = COALESCE(acked_at, ?)
         WHERE message_id = ? AND bot_id = ?`,
      );
      const acked: string[] = [];
      const notFound: string[] = [];
      for (const id of ids) {
        const result = update.run(at, at, id, me);
        (Number(result.changes) > 0 ? acked : notFound).push(id);
      }
      return { acked, not_found: notFound };
    });
  }

  audit(botId: string | null, tool: string, messageIds: string[], status: AuditStatus, detail?: string): void {
    this.db
      .prepare("INSERT INTO audit_log (ts, bot_id, tool, message_ids, status, detail) VALUES (?, ?, ?, ?, ?, ?)")
      .run(this.timestamp(), botId, tool, JSON.stringify(messageIds), status, detail ?? null);
  }

  recentAudit(limit: number): AuditEntry[] {
    const rows = this.db
      .prepare("SELECT * FROM audit_log ORDER BY id DESC LIMIT ?")
      .all(limit) as unknown as (Omit<AuditEntry, "message_ids"> & { message_ids: string })[];
    return rows.map((row) => ({ ...row, message_ids: JSON.parse(row.message_ids) as string[] }));
  }

  recentMessages(limit: number): ViewerMessage[] {
    const rows = this.db
      .prepare(
        `SELECT m.id, m.thread_id, m.sender, m.recipient, m.subject, m.body, m.created_at, r.read_at, r.acked_at
         FROM messages m JOIN receipts r ON r.message_id = m.id
         ORDER BY m.seq DESC LIMIT ?`,
      )
      .all(limit) as unknown as MessageRow[];
    return rows.map((row) => ({
      message_id: row.id,
      thread_id: row.thread_id,
      from: row.sender,
      to: row.recipient,
      subject: row.subject,
      body: row.body,
      created_at: row.created_at,
      read_at: row.read_at,
      acked_at: row.acked_at,
    }));
  }

  ping(): boolean {
    return this.db.prepare("SELECT 1 AS ok").get() !== undefined;
  }

  private getThreadFor(me: string, threadId: string): ThreadRow {
    const thread = this.db.prepare("SELECT * FROM threads WHERE id = ?").get(threadId) as ThreadRow | undefined;
    if (!thread || (thread.participant_a !== me && thread.participant_b !== me)) {
      throw new RelayError("thread_not_found", `thread ${threadId} not found`);
    }
    return thread;
  }

  private toView(me: string, row: MessageRow): MessageView {
    return {
      message_id: row.id,
      thread_id: row.thread_id,
      from: row.sender,
      to: row.recipient,
      subject: row.subject,
      body: row.body,
      created_at: row.created_at,
      direction: row.recipient === me ? "incoming" : "outgoing",
      read_at: row.read_at,
      acked_at: row.acked_at,
    };
  }
}
