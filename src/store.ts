import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { generateInviteCode, generateToken, sha256 } from "./auth.ts";
import type { BotEntry, NotifyTarget } from "./config.ts";
import { decryptSecret, encryptSecret } from "./crypto.ts";
import { transaction } from "./db.ts";
import {
  DEFAULT_WEBHOOK_POLICY,
  validateWebhookSecret,
  validateWebhookUrl,
  WebhookUrlError,
  type WebhookPolicy,
} from "./webhook-url.ts";

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

export interface RelayStoreOptions {
  now?: (() => Date) | undefined;
  encryptionKey?: Buffer | undefined;
  webhookPolicy?: WebhookPolicy | undefined;
  envNotify?: ReadonlyMap<string, NotifyTarget> | undefined;
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

export interface MessageMeta {
  seq: number;
  message_id: string;
  thread_id: string;
  from: string;
  to: string;
  subject: string | null;
  created_at: string;
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

export type AuditStatus = "ok" | "error" | "rate_limited" | "unauthorized" | "forbidden" | "delivered" | "failed";

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

export interface WebhookInfo {
  url: string | null;
  enabled: boolean;
  has_secret: boolean;
  source: "db" | "env" | "none";
  last_status: string | null;
  last_at: string | null;
}

export interface BotSummary {
  id: string;
  display_name: string | null;
  source: "db" | "env";
  status: "active" | "revoked";
  created_at: string | null;
  last_seen_at: string | null;
  revoked_at: string | null;
  active_tokens: number;
  unread_count: number;
  webhook: WebhookInfo;
}

export interface InviteSummary {
  id: string;
  code_prefix: string;
  bot_id: string | null;
  label: string | null;
  max_uses: number;
  uses: number;
  expires_at: string | null;
  created_at: string;
  revoked_at: string | null;
  last_used_at: string | null;
  status: "active" | "expired" | "exhausted" | "revoked";
}

export interface RegistrationResult {
  bot_id: string;
  display_name: string | null;
  token: string;
  webhook: { url: string; secret: string | null; enabled: boolean } | null;
}

interface MessageRow {
  seq?: number;
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

interface BotRow {
  id: string;
  display_name: string | null;
  created_at: string;
  last_seen_at: string | null;
  revoked_at: string | null;
  webhook_url: string | null;
  webhook_secret_enc: string | null;
  webhook_enabled: number;
  webhook_last_status: string | null;
  webhook_last_at: string | null;
}

interface InviteRow {
  id: string;
  code_hash: string;
  code_prefix: string;
  bot_id: string | null;
  label: string | null;
  max_uses: number;
  uses: number;
  expires_at: string | null;
  created_at: string;
  revoked_at: string | null;
  last_used_at: string | null;
}

export const MAX_READ_LIMIT = 200;
export const MAX_ACK_IDS = 200;
const BOT_ID_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const LAST_SEEN_THROTTLE_MS = 60_000;

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

function normalizeDisplayName(raw: string | null | undefined): string | null {
  if (raw === undefined || raw === null) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.length > 100) throw new RelayError("invalid_display_name", "display_name must be at most 100 characters");
  return trimmed;
}

export class RelayStore {
  private readonly db: DatabaseSync;
  private readonly envBotIds: ReadonlySet<string>;
  private readonly envBotEntries: readonly BotEntry[];
  private readonly envNotify: ReadonlyMap<string, NotifyTarget>;
  private readonly limits: StoreLimits;
  private readonly now: () => Date;
  private readonly encryptionKey: Buffer;
  private readonly webhookPolicy: WebhookPolicy;
  private readonly lastSeenCache = new Map<string, number>();

  constructor(
    db: DatabaseSync,
    envBots: Iterable<string | BotEntry>,
    limits: StoreLimits,
    optsOrNow?: (() => Date) | RelayStoreOptions,
  ) {
    this.db = db;
    const ids = new Set<string>();
    const entries: BotEntry[] = [];
    for (const item of envBots) {
      if (typeof item === "string") {
        ids.add(item);
      } else {
        ids.add(item.id);
        entries.push(item);
      }
    }
    this.envBotIds = ids;
    this.envBotEntries = entries;
    this.limits = limits;
    if (typeof optsOrNow === "function") {
      this.now = optsOrNow;
      this.encryptionKey = randomBytes(32);
      this.webhookPolicy = DEFAULT_WEBHOOK_POLICY;
      this.envNotify = new Map();
    } else {
      this.now = optsOrNow?.now ?? (() => new Date());
      this.encryptionKey = optsOrNow?.encryptionKey ?? randomBytes(32);
      this.webhookPolicy = optsOrNow?.webhookPolicy ?? DEFAULT_WEBHOOK_POLICY;
      this.envNotify = optsOrNow?.envNotify ?? new Map();
    }
  }

  private timestamp(): string {
    return this.now().toISOString();
  }

  private allActiveBotIds(): Set<string> {
    const active = new Set<string>(this.envBotIds);
    const rows = this.db.prepare("SELECT id FROM bots WHERE revoked_at IS NULL").all() as unknown as { id: string }[];
    for (const row of rows) active.add(row.id);
    return active;
  }

  isBotActive(botId: string): boolean {
    if (this.envBotIds.has(botId)) return true;
    const row = this.db
      .prepare("SELECT 1 AS ok FROM bots WHERE id = ? AND revoked_at IS NULL")
      .get(botId) as { ok: number } | undefined;
    return row !== undefined;
  }

  listActiveAuthEntries(): BotEntry[] {
    const entries: BotEntry[] = [...this.envBotEntries];
    const rows = this.db
      .prepare(
        `SELECT t.bot_id, t.token_hash
         FROM bot_tokens t
         JOIN bots b ON b.id = t.bot_id
         WHERE t.revoked_at IS NULL AND b.revoked_at IS NULL`,
      )
      .all() as unknown as { bot_id: string; token_hash: string }[];
    for (const row of rows) {
      entries.push({ id: row.bot_id, tokenHash: Buffer.from(row.token_hash, "hex") });
    }
    return entries;
  }

  touchBotSeen(botId: string, tokenHashHex?: string): void {
    const nowMs = this.now().getTime();
    const prev = this.lastSeenCache.get(botId);
    if (prev !== undefined && nowMs - prev < LAST_SEEN_THROTTLE_MS) return;
    this.lastSeenCache.set(botId, nowMs);
    const ts = new Date(nowMs).toISOString();
    try {
      this.db.prepare("UPDATE bots SET last_seen_at = ? WHERE id = ?").run(ts, botId);
      if (tokenHashHex) {
        this.db.prepare("UPDATE bot_tokens SET last_used_at = ? WHERE token_hash = ?").run(ts, tokenHashHex);
      }
    } catch {
      // Best-effort telemetry; never break a request.
    }
  }

  listPeers(me: string): { self: string; peers: string[] } {
    return { self: me, peers: [...this.allActiveBotIds()].filter((id) => id !== me).sort() };
  }

  postMessage(
    me: string,
    input: { to: string; body: string; subject?: string | undefined; thread_id?: string | undefined },
  ): { seq: number; message_id: string; thread_id: string; created_at: string } {
    const to = input.to.trim();
    if (!this.isBotActive(to)) throw new RelayError("unknown_recipient", `unknown recipient "${to}"; call list_peers`);
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
      const inserted = this.db
        .prepare(
          `INSERT INTO messages (id, thread_id, sender, recipient, subject, body, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(messageId, threadId, me, to, subject, input.body, createdAt);
      this.db.prepare("INSERT INTO receipts (message_id, bot_id) VALUES (?, ?)").run(messageId, to);
      return { seq: Number(inserted.lastInsertRowid), message_id: messageId, thread_id: threadId, created_at: createdAt };
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

  unreadCount(me: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM messages m JOIN receipts r ON r.message_id = m.id
         WHERE m.recipient = ? AND r.read_at IS NULL`,
      )
      .get(me) as { count: number } | undefined;
    return Number(row?.count ?? 0);
  }

  /** Metadata-only unread messages after `afterSeq`, for SSE `Last-Event-ID` catch-up. */
  unreadMessagesAfterSeq(me: string, afterSeq: number, limit = 100): MessageMeta[] {
    const rows = this.db
      .prepare(
        `SELECT m.seq, m.id, m.thread_id, m.sender, m.recipient, m.subject, m.created_at
         FROM messages m JOIN receipts r ON r.message_id = m.id
         WHERE m.recipient = ? AND r.read_at IS NULL AND m.seq > ?
         ORDER BY m.seq ASC
         LIMIT ?`,
      )
      .all(me, Math.max(0, Math.floor(afterSeq)), clampLimit(limit, 100)) as unknown as {
      seq: number;
      id: string;
      thread_id: string;
      sender: string;
      recipient: string;
      subject: string | null;
      created_at: string;
    }[];
    return rows.map((r) => ({
      seq: Number(r.seq),
      message_id: r.id,
      thread_id: r.thread_id,
      from: r.sender,
      to: r.recipient,
      subject: r.subject,
      created_at: r.created_at,
    }));
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

  // --- Dynamic Bot & Token Management ---

  listBots(): BotSummary[] {
    const dbRows = this.db.prepare("SELECT * FROM bots ORDER BY created_at DESC").all() as unknown as BotRow[];
    const dbById = new Map<string, BotRow>(dbRows.map((r) => [r.id, r]));

    const tokenCounts = new Map<string, number>();
    const tokenRows = this.db
      .prepare("SELECT bot_id, COUNT(*) AS c FROM bot_tokens WHERE revoked_at IS NULL GROUP BY bot_id")
      .all() as unknown as { bot_id: string; c: number }[];
    for (const r of tokenRows) tokenCounts.set(r.bot_id, Number(r.c));

    const envTokenCounts = new Map<string, number>();
    for (const e of this.envBotEntries) {
      envTokenCounts.set(e.id, (envTokenCounts.get(e.id) ?? 0) + 1);
    }

    const unreadCounts = new Map<string, number>();
    const unreadRows = this.db
      .prepare(
        `SELECT m.recipient AS bot_id, COUNT(*) AS c
         FROM messages m JOIN receipts r ON r.message_id = m.id
         WHERE r.read_at IS NULL
         GROUP BY m.recipient`,
      )
      .all() as unknown as { bot_id: string; c: number }[];
    for (const r of unreadRows) unreadCounts.set(r.bot_id, Number(r.c));

    const allIds = new Set<string>([...this.envBotIds, ...dbById.keys()]);
    const result: BotSummary[] = [];
    for (const id of [...allIds].sort()) {
      const row = dbById.get(id);
      const isEnv = this.envBotIds.has(id);
      result.push({
        id,
        display_name: row?.display_name ?? null,
        source: isEnv ? "env" : "db",
        status: isEnv || !row?.revoked_at ? "active" : "revoked",
        created_at: row?.created_at ?? null,
        last_seen_at: row?.last_seen_at ?? null,
        revoked_at: isEnv ? null : (row?.revoked_at ?? null),
        active_tokens: (tokenCounts.get(id) ?? 0) + (envTokenCounts.get(id) ?? 0),
        unread_count: unreadCounts.get(id) ?? 0,
        webhook: this.webhookInfoForRow(id, row),
      });
    }
    return result;
  }

  getBotDisplayName(botId: string): string | null {
    const row = this.db.prepare("SELECT display_name FROM bots WHERE id = ?").get(botId) as
      | { display_name: string | null }
      | undefined;
    return row?.display_name ?? null;
  }

  createBot(input: {
    id: string;
    displayName?: string | undefined;
    webhookUrl?: string | undefined;
    webhookSecret?: string | undefined;
  }): RegistrationResult {
    const id = input.id.trim();
    if (!BOT_ID_RE.test(id)) {
      throw new RelayError("invalid_bot_id", "bot_id must be lowercase letters, digits and dashes (max 63 chars)");
    }
    const displayName = normalizeDisplayName(input.displayName);
    const webhook = this.prepareWebhookFields(input.webhookUrl, input.webhookSecret);

    return transaction(this.db, () => {
      if (this.envBotIds.has(id) || this.db.prepare("SELECT 1 FROM bots WHERE id = ?").get(id)) {
        throw new RelayError("bot_already_exists", `bot "${id}" already exists`);
      }
      const now = this.timestamp();
      const token = generateToken("relay_");
      const tokenHash = sha256(token).toString("hex");
      this.db
        .prepare(
          `INSERT INTO bots (id, display_name, created_at, webhook_url, webhook_secret_enc, webhook_enabled)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(id, displayName, now, webhook.url, webhook.secretEnc, webhook.url ? 1 : 0);
      this.db
        .prepare("INSERT INTO bot_tokens (id, bot_id, token_hash, label, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(`tok_${randomUUID()}`, id, tokenHash, "admin-created", now);
      this.audit(id, "admin.create_bot", [], "ok");
      return {
        bot_id: id,
        display_name: displayName,
        token,
        webhook: webhook.url ? { url: webhook.url, secret: webhook.secretPlain, enabled: true } : null,
      };
    });
  }

  rotateBotToken(botId: string, opts: { revokeOthers?: boolean | undefined; label?: string | undefined } = {}): {
    token_id: string;
    token: string;
    revoked_count: number;
  } {
    if (this.envBotIds.has(botId) && !this.db.prepare("SELECT 1 FROM bots WHERE id = ?").get(botId)) {
      throw new RelayError("managed_by_env", `bot "${botId}" is configured via BOTS env var`);
    }
    return transaction(this.db, () => {
      const bot = this.db.prepare("SELECT id, revoked_at FROM bots WHERE id = ?").get(botId) as
        | { id: string; revoked_at: string | null }
        | undefined;
      if (!bot) throw new RelayError("unknown_bot", `bot "${botId}" not found`);
      if (bot.revoked_at) throw new RelayError("bot_revoked", `bot "${botId}" is revoked`);

      const now = this.timestamp();
      let revokedCount = 0;
      if (opts.revokeOthers) {
        const res = this.db
          .prepare("UPDATE bot_tokens SET revoked_at = ? WHERE bot_id = ? AND revoked_at IS NULL")
          .run(now, botId);
        revokedCount = Number(res.changes);
      }
      const tokenId = `tok_${randomUUID()}`;
      const token = generateToken("relay_");
      const tokenHash = sha256(token).toString("hex");
      this.db
        .prepare("INSERT INTO bot_tokens (id, bot_id, token_hash, label, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(tokenId, botId, tokenHash, opts.label ?? "rotated", now);
      this.audit(botId, "rotate_token", [], "ok", opts.revokeOthers ? "revoke_others" : "overlap");
      return { token_id: tokenId, token, revoked_count: revokedCount };
    });
  }

  revokeBot(botId: string): void {
    if (this.envBotIds.has(botId)) {
      throw new RelayError("managed_by_env", `bot "${botId}" is configured via BOTS env var; remove it from .env`);
    }
    transaction(this.db, () => {
      const bot = this.db.prepare("SELECT id FROM bots WHERE id = ?").get(botId);
      if (!bot) throw new RelayError("unknown_bot", `bot "${botId}" not found`);
      const now = this.timestamp();
      this.db.prepare("UPDATE bots SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?").run(now, botId);
      this.db.prepare("UPDATE bot_tokens SET revoked_at = COALESCE(revoked_at, ?) WHERE bot_id = ?").run(now, botId);
      this.audit(botId, "admin.revoke_bot", [], "ok");
    });
  }

  restoreBot(botId: string): { token: string } {
    if (this.envBotIds.has(botId)) {
      throw new RelayError("managed_by_env", `bot "${botId}" is configured via BOTS env var`);
    }
    return transaction(this.db, () => {
      const bot = this.db.prepare("SELECT id FROM bots WHERE id = ?").get(botId);
      if (!bot) throw new RelayError("unknown_bot", `bot "${botId}" not found`);
      const now = this.timestamp();
      this.db.prepare("UPDATE bots SET revoked_at = NULL WHERE id = ?").run(botId);
      const token = generateToken("relay_");
      const tokenHash = sha256(token).toString("hex");
      this.db
        .prepare("INSERT INTO bot_tokens (id, bot_id, token_hash, label, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(`tok_${randomUUID()}`, botId, tokenHash, "restored", now);
      this.audit(botId, "admin.restore_bot", [], "ok");
      return { token };
    });
  }

  // --- Invite / Approval Codes ---

  createInviteCode(input: {
    botId?: string | null | undefined;
    label?: string | null | undefined;
    maxUses?: number | undefined;
    expiresInSeconds?: number | null | undefined;
  }): { invite: InviteSummary; code: string } {
    const botId = input.botId?.trim() || null;
    if (botId !== null && !BOT_ID_RE.test(botId)) {
      throw new RelayError("invalid_bot_id", "bot_id must be lowercase letters, digits and dashes (max 63 chars)");
    }
    const label = normalizeDisplayName(input.label);
    const maxUses = input.maxUses === undefined ? 1 : Math.floor(input.maxUses);
    if (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > 100) {
      throw new RelayError("invalid_max_uses", "max_uses must be an integer between 1 and 100");
    }
    let expiresAt: string | null = null;
    if (input.expiresInSeconds !== null) {
      const ttl = input.expiresInSeconds === undefined ? 3600 : Math.floor(input.expiresInSeconds);
      if (!Number.isInteger(ttl) || ttl < 60 || ttl > 365 * 86400) {
        throw new RelayError("invalid_ttl", "expires_in_seconds must be between 60 seconds and 365 days");
      }
      expiresAt = new Date(this.now().getTime() + ttl * 1000).toISOString();
    }

    const code = generateInviteCode();
    const codeHash = sha256(code).toString("hex");
    const codePrefix = code.slice(0, 9);
    const id = `inv_${randomUUID()}`;
    const now = this.timestamp();

    transaction(this.db, () => {
      this.db
        .prepare(
          `INSERT INTO invite_codes (id, code_hash, code_prefix, bot_id, label, max_uses, uses, expires_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`,
        )
        .run(id, codeHash, codePrefix, botId, label, maxUses, expiresAt, now);
      this.audit(botId, "admin.create_invite", [], "ok", id);
    });

    return {
      code,
      invite: {
        id,
        code_prefix: codePrefix,
        bot_id: botId,
        label,
        max_uses: maxUses,
        uses: 0,
        expires_at: expiresAt,
        created_at: now,
        revoked_at: null,
        last_used_at: null,
        status: "active",
      },
    };
  }

  ensureBootstrapInviteCode(
    rawCode: string,
    opts: {
      maxUses?: number | undefined;
      expiresInSeconds?: number | null | undefined;
      botId?: string | null | undefined;
    } = {},
  ): void {
    const trimmed = rawCode.trim();
    if (!trimmed) return;
    const maxUses = opts.maxUses === undefined ? 1 : Math.floor(opts.maxUses);
    if (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > 100) {
      throw new RelayError("invalid_max_uses", "max_uses must be an integer between 1 and 100");
    }
    const botId = opts.botId?.trim() || null;
    if (botId !== null && !BOT_ID_RE.test(botId)) {
      throw new RelayError("invalid_bot_id", "bot_id must be lowercase letters, digits and dashes (max 63 chars)");
    }
    let expiresAt: string | null = null;
    if (opts.expiresInSeconds !== null) {
      const ttl = opts.expiresInSeconds === undefined ? 86400 : Math.floor(opts.expiresInSeconds);
      if (!Number.isInteger(ttl) || ttl < 60 || ttl > 365 * 86400) {
        throw new RelayError("invalid_ttl", "expires_in_seconds must be between 60 seconds and 365 days");
      }
      expiresAt = new Date(this.now().getTime() + ttl * 1000).toISOString();
    }
    const hash = sha256(trimmed).toString("hex");
    const existing = this.db.prepare("SELECT id FROM invite_codes WHERE code_hash = ?").get(hash);
    if (existing) return;
    const now = this.timestamp();
    this.db
      .prepare(
        `INSERT INTO invite_codes (id, code_hash, code_prefix, bot_id, label, max_uses, uses, expires_at, created_at)
         VALUES (?, ?, ?, ?, 'bootstrap (env)', ?, 0, ?, ?)`,
      )
      .run(`inv_${randomUUID()}`, hash, `${trimmed.slice(0, 6)}…`, botId, maxUses, expiresAt, now);
  }

  listInviteCodes(): InviteSummary[] {
    const rows = this.db
      .prepare("SELECT * FROM invite_codes ORDER BY created_at DESC LIMIT 100")
      .all() as unknown as InviteRow[];
    const nowMs = this.now().getTime();
    return rows.map((r) => {
      let status: InviteSummary["status"] = "active";
      if (r.revoked_at) status = "revoked";
      else if (r.uses >= r.max_uses) status = "exhausted";
      else if (r.expires_at && Date.parse(r.expires_at) <= nowMs) status = "expired";
      return {
        id: r.id,
        code_prefix: r.code_prefix,
        bot_id: r.bot_id,
        label: r.label,
        max_uses: Number(r.max_uses),
        uses: Number(r.uses),
        expires_at: r.expires_at,
        created_at: r.created_at,
        revoked_at: r.revoked_at,
        last_used_at: r.last_used_at,
        status,
      };
    });
  }

  revokeInviteCode(id: string): void {
    const res = this.db
      .prepare("UPDATE invite_codes SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?")
      .run(this.timestamp(), id);
    if (Number(res.changes) === 0) {
      throw new RelayError("invite_not_found", `invite "${id}" not found`);
    }
    this.audit(null, "admin.revoke_invite", [], "ok", id);
  }

  redeemInviteCode(input: {
    code: string;
    botId?: string | undefined;
    displayName?: string | undefined;
    webhookUrl?: string | undefined;
    webhookSecret?: string | undefined;
  }): RegistrationResult {
    const rawCode = input.code.trim();
    if (!rawCode || rawCode.length > 512) {
      throw new RelayError("invalid_invite_code", "invalid or expired approval code");
    }
    const presentedDigest = sha256(rawCode);
    const displayName = normalizeDisplayName(input.displayName);
    const webhook = this.prepareWebhookFields(input.webhookUrl, input.webhookSecret, true);

    return transaction(this.db, () => {
      const candidates = this.db
        .prepare("SELECT * FROM invite_codes WHERE revoked_at IS NULL")
        .all() as unknown as InviteRow[];
      let matched: InviteRow | undefined;
      for (const row of candidates) {
        const stored = Buffer.from(row.code_hash, "hex");
        if (stored.length === presentedDigest.length && timingSafeEqual(presentedDigest, stored) && !matched) {
          matched = row;
        }
      }

      const nowMs = this.now().getTime();
      if (!matched) {
        throw new RelayError("invalid_invite_code", "invalid or expired approval code");
      }
      if (matched.expires_at && Date.parse(matched.expires_at) <= nowMs) {
        throw new RelayError("invite_expired", "approval code has expired");
      }
      if (Number(matched.uses) >= Number(matched.max_uses)) {
        throw new RelayError("invite_exhausted", "approval code has already been used");
      }

      const requestedId = input.botId?.trim();
      let botId: string;
      if (matched.bot_id) {
        if (requestedId && requestedId !== matched.bot_id) {
          throw new RelayError("bot_id_mismatch", `this approval code is locked to bot "${matched.bot_id}"`);
        }
        botId = matched.bot_id;
      } else {
        if (!requestedId || !BOT_ID_RE.test(requestedId)) {
          throw new RelayError("invalid_bot_id", "bot_id must be lowercase letters, digits and dashes (max 63 chars)");
        }
        botId = requestedId;
      }

      if (this.envBotIds.has(botId) || this.db.prepare("SELECT 1 FROM bots WHERE id = ?").get(botId)) {
        throw new RelayError("bot_already_exists", `bot "${botId}" already exists`);
      }

      const now = new Date(nowMs).toISOString();
      const token = generateToken("relay_");
      const tokenHash = sha256(token).toString("hex");
      this.db
        .prepare(
          `INSERT INTO bots (id, display_name, created_at, last_seen_at, webhook_url, webhook_secret_enc, webhook_enabled)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(botId, displayName, now, now, webhook.url, webhook.secretEnc, webhook.url ? 1 : 0);
      this.db
        .prepare("INSERT INTO bot_tokens (id, bot_id, token_hash, label, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(`tok_${randomUUID()}`, botId, tokenHash, `invite:${matched.id}`, now);
      this.db
        .prepare("UPDATE invite_codes SET uses = uses + 1, last_used_at = ? WHERE id = ?")
        .run(now, matched.id);
      this.audit(botId, "register", [], "ok", matched.id);

      return {
        bot_id: botId,
        display_name: displayName,
        token,
        webhook: webhook.url ? { url: webhook.url, secret: webhook.secretPlain, enabled: true } : null,
      };
    });
  }

  // --- Dynamic Webhooks ---

  getWebhookTarget(botId: string): (NotifyTarget & { source: "db" | "env" }) | undefined {
    if (!this.isBotActive(botId)) return undefined;
    const row = this.db
      .prepare("SELECT webhook_url, webhook_secret_enc, webhook_enabled, revoked_at FROM bots WHERE id = ?")
      .get(botId) as
      | {
          webhook_url: string | null;
          webhook_secret_enc: string | null;
          webhook_enabled: number;
          revoked_at: string | null;
        }
      | undefined;
    if (row && !row.revoked_at && row.webhook_url) {
      if (!row.webhook_enabled) return undefined;
      let key: string | null = null;
      if (row.webhook_secret_enc) {
        key = decryptSecret(row.webhook_secret_enc, this.encryptionKey);
      }
      return { url: row.webhook_url, key, source: "db" };
    }
    const envTarget = this.envNotify.get(botId);
    if (envTarget) return { ...envTarget, source: "env" };
    return undefined;
  }

  getWebhookInfo(botId: string): WebhookInfo {
    const row = this.db.prepare("SELECT * FROM bots WHERE id = ?").get(botId) as BotRow | undefined;
    return this.webhookInfoForRow(botId, row);
  }

  setWebhook(
    botId: string,
    input: { url: string | null; secret?: string | null | undefined; enabled?: boolean | undefined },
  ): WebhookInfo {
    if (!this.isBotActive(botId)) {
      throw new RelayError("unknown_bot", `bot "${botId}" not found or revoked`);
    }
    let normalizedUrl: string | null = null;
    if (input.url !== null && input.url.trim() !== "") {
      try {
        normalizedUrl = validateWebhookUrl(input.url, this.webhookPolicy);
      } catch (err) {
        throw new RelayError(
          "invalid_webhook_url",
          err instanceof WebhookUrlError ? err.message : "invalid webhook URL",
        );
      }
    }

    let nextSecretEnc: string | null | undefined;
    if (normalizedUrl === null) {
      nextSecretEnc = null;
    } else if (input.secret === null || input.secret === "") {
      nextSecretEnc = null;
    } else if (typeof input.secret === "string") {
      try {
        const clean = validateWebhookSecret(input.secret);
        nextSecretEnc = encryptSecret(clean, this.encryptionKey);
      } catch (err) {
        throw new RelayError(
          "invalid_webhook_secret",
          err instanceof WebhookUrlError ? err.message : "invalid webhook secret",
        );
      }
    }

    const enabled = normalizedUrl === null ? 0 : input.enabled === false ? 0 : 1;

    transaction(this.db, () => {
      const existing = this.db.prepare("SELECT id, webhook_secret_enc FROM bots WHERE id = ?").get(botId) as
        | { id: string; webhook_secret_enc: string | null }
        | undefined;
      if (!existing) {
        this.db
          .prepare(
            `INSERT INTO bots (id, created_at, webhook_url, webhook_secret_enc, webhook_enabled)
             VALUES (?, ?, ?, ?, ?)`,
          )
          .run(botId, this.timestamp(), normalizedUrl, nextSecretEnc ?? null, enabled);
      } else {
        const secretToStore = nextSecretEnc === undefined ? existing.webhook_secret_enc : nextSecretEnc;
        this.db
          .prepare("UPDATE bots SET webhook_url = ?, webhook_secret_enc = ?, webhook_enabled = ? WHERE id = ?")
          .run(normalizedUrl, secretToStore, enabled, botId);
      }
    });

    return this.getWebhookInfo(botId);
  }

  recordWebhookOutcome(botId: string, status: string): void {
    try {
      const existing = this.db.prepare("SELECT 1 FROM bots WHERE id = ?").get(botId);
      const ts = this.timestamp();
      if (existing) {
        this.db
          .prepare("UPDATE bots SET webhook_last_status = ?, webhook_last_at = ? WHERE id = ?")
          .run(status, ts, botId);
      } else if (this.envBotIds.has(botId)) {
        this.db
          .prepare(
            "INSERT INTO bots (id, created_at, webhook_enabled, webhook_last_status, webhook_last_at) VALUES (?, ?, 1, ?, ?)",
          )
          .run(botId, ts, status, ts);
      }
    } catch {
      // Best-effort status telemetry; DB may be closing during shutdown.
    }
  }

  // --- Settings ---

  getSetting(key: string): string | undefined {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value;
  }

  setSetting(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, value, this.timestamp());
  }

  // --- Audit & Viewer ---

  audit(botId: string | null, tool: string, messageIds: string[], status: AuditStatus, detail?: string): void {
    this.db
      .prepare("INSERT INTO audit_log (ts, bot_id, tool, message_ids, status, detail) VALUES (?, ?, ?, ?, ?, ?)")
      .run(this.timestamp(), botId, tool, JSON.stringify(messageIds), status, detail ?? null);
  }

  recentAudit(limit: number, botFilter?: string): AuditEntry[] {
    const clamped = Math.max(1, Math.min(500, Math.floor(limit)));
    const rows = botFilter
      ? (this.db
          .prepare("SELECT * FROM audit_log WHERE bot_id = ? ORDER BY id DESC LIMIT ?")
          .all(botFilter, clamped) as unknown as (Omit<AuditEntry, "message_ids"> & { message_ids: string })[])
      : (this.db
          .prepare("SELECT * FROM audit_log ORDER BY id DESC LIMIT ?")
          .all(clamped) as unknown as (Omit<AuditEntry, "message_ids"> & { message_ids: string })[]);
    return rows.map((row) => ({ ...row, message_ids: JSON.parse(row.message_ids) as string[] }));
  }

  recentMessages(limit: number, botFilter?: string): ViewerMessage[] {
    const clamped = Math.max(1, Math.min(500, Math.floor(limit)));
    const rows = botFilter
      ? (this.db
          .prepare(
            `SELECT m.id, m.thread_id, m.sender, m.recipient, m.subject, m.body, m.created_at, r.read_at, r.acked_at
             FROM messages m JOIN receipts r ON r.message_id = m.id
             WHERE m.sender = ? OR m.recipient = ?
             ORDER BY m.seq DESC LIMIT ?`,
          )
          .all(botFilter, botFilter, clamped) as unknown as MessageRow[])
      : (this.db
          .prepare(
            `SELECT m.id, m.thread_id, m.sender, m.recipient, m.subject, m.body, m.created_at, r.read_at, r.acked_at
             FROM messages m JOIN receipts r ON r.message_id = m.id
             ORDER BY m.seq DESC LIMIT ?`,
          )
          .all(clamped) as unknown as MessageRow[]);
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

  private prepareWebhookFields(
    rawUrl: string | undefined,
    rawSecret: string | undefined,
    autoGenerateSecret = false,
  ): { url: string | null; secretPlain: string | null; secretEnc: string | null } {
    const trimmedUrl = rawUrl?.trim();
    if (!trimmedUrl) {
      return { url: null, secretPlain: null, secretEnc: null };
    }
    let url: string;
    try {
      url = validateWebhookUrl(trimmedUrl, this.webhookPolicy);
    } catch (err) {
      throw new RelayError(
        "invalid_webhook_url",
        err instanceof WebhookUrlError ? err.message : "invalid webhook URL",
      );
    }
    const trimmedSecret = rawSecret?.trim();
    let secretPlain: string | null = null;
    if (trimmedSecret) {
      try {
        secretPlain = validateWebhookSecret(trimmedSecret);
      } catch (err) {
        throw new RelayError(
          "invalid_webhook_secret",
          err instanceof WebhookUrlError ? err.message : "invalid webhook secret",
        );
      }
    } else if (autoGenerateSecret) {
      secretPlain = generateToken("whsec_");
    }
    const secretEnc = secretPlain ? encryptSecret(secretPlain, this.encryptionKey) : null;
    return { url, secretPlain, secretEnc };
  }

  private webhookInfoForRow(botId: string, row: BotRow | undefined): WebhookInfo {
    if (row?.webhook_url) {
      return {
        url: row.webhook_url,
        enabled: Boolean(row.webhook_enabled),
        has_secret: Boolean(row.webhook_secret_enc),
        source: "db",
        last_status: row.webhook_last_status,
        last_at: row.webhook_last_at,
      };
    }
    const envTarget = this.envNotify.get(botId);
    if (envTarget) {
      return {
        url: envTarget.url,
        enabled: true,
        has_secret: Boolean(envTarget.key),
        source: "env",
        last_status: row?.webhook_last_status ?? null,
        last_at: row?.webhook_last_at ?? null,
      };
    }
    return {
      url: null,
      enabled: false,
      has_secret: false,
      source: "none",
      last_status: row?.webhook_last_status ?? null,
      last_at: row?.webhook_last_at ?? null,
    };
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
