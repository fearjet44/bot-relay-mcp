import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { openDatabase } from "../src/db.ts";
import { RelayError, RelayStore } from "../src/store.ts";
import { makeHarness, type Harness } from "./helpers.ts";

const COS = "chief-of-staff";
const ABJ = "abjets-company";
const EVE = "intruder";

function assertRelayError(fn: () => unknown, code: string): void {
  assert.throws(fn, (err: unknown) => err instanceof RelayError && err.code === code);
}

describe("RelayStore", () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });
  afterEach(() => h.cleanup());

  it("uses WAL journal mode", () => {
    const row = h.db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
    assert.equal(row.journal_mode, "wal");
  });

  it("lists peers excluding self", () => {
    assert.deepEqual(h.store.listPeers(COS), { self: COS, peers: [ABJ, EVE] });
  });

  it("records the authenticated bot as sender and creates a thread", () => {
    const posted = h.store.postMessage(COS, { to: ABJ, body: "hello", subject: "Ops" });
    assert.match(posted.message_id, /^msg_/);
    assert.match(posted.thread_id, /^thr_/);
    const { messages } = h.store.readMessages(ABJ, {});
    assert.equal(messages.length, 1);
    assert.equal(messages[0]!.from, COS);
    assert.equal(messages[0]!.to, ABJ);
    assert.equal(messages[0]!.subject, "Ops");
    assert.equal(messages[0]!.direction, "incoming");
  });

  it("rejects unknown recipients, self-messages and empty bodies", () => {
    assertRelayError(() => h.store.postMessage(COS, { to: "nobody", body: "x" }), "unknown_recipient");
    assertRelayError(() => h.store.postMessage(COS, { to: COS, body: "x" }), "invalid_recipient");
    assertRelayError(() => h.store.postMessage(COS, { to: ABJ, body: "" }), "empty_body");
  });

  it("enforces the body size cap in UTF-8 bytes", () => {
    const max = h.config.maxBodyBytes;
    h.store.postMessage(COS, { to: ABJ, body: "a".repeat(max) });
    assertRelayError(() => h.store.postMessage(COS, { to: ABJ, body: "a".repeat(max + 1) }), "body_too_large");
    // 'é' is 2 bytes: max/2 + 1 characters exceed the byte cap.
    assertRelayError(
      () => h.store.postMessage(COS, { to: ABJ, body: "é".repeat(max / 2 + 1) }),
      "body_too_large",
    );
  });

  it("caps subject length", () => {
    assertRelayError(
      () => h.store.postMessage(COS, { to: ABJ, body: "x", subject: "s".repeat(h.config.maxSubjectChars + 1) }),
      "subject_too_long",
    );
  });

  describe("unread / mark_read / ack semantics", () => {
    it("reading does not mark read unless mark_read=true", () => {
      h.store.postMessage(COS, { to: ABJ, body: "one" });
      h.store.postMessage(COS, { to: ABJ, body: "two" });
      assert.equal(h.store.readMessages(ABJ, {}).messages.length, 2);
      assert.equal(h.store.readMessages(ABJ, {}).messages.length, 2, "plain reads are idempotent");

      const marked = h.store.readMessages(ABJ, { mark_read: true });
      assert.equal(marked.marked_read, 2);
      assert.ok(marked.messages.every((m) => m.read_at !== null && m.acked_at === null));
      assert.equal(h.store.readMessages(ABJ, {}).messages.length, 0);
      assert.equal(h.store.readMessages(ABJ, { unread_only: false }).messages.length, 2);
    });

    it("returns unread messages oldest first and pages with limit/has_more", () => {
      for (let i = 1; i <= 5; i++) h.store.postMessage(COS, { to: ABJ, body: `m${i}` });
      const page1 = h.store.readMessages(ABJ, { limit: 2, mark_read: true });
      assert.deepEqual(page1.messages.map((m) => m.body), ["m1", "m2"]);
      assert.equal(page1.has_more, true);
      const page2 = h.store.readMessages(ABJ, { limit: 10, mark_read: true });
      assert.deepEqual(page2.messages.map((m) => m.body), ["m3", "m4", "m5"]);
      assert.equal(page2.has_more, false);
    });

    it("unread_only=false without since returns the latest messages in chronological order", () => {
      for (let i = 1; i <= 5; i++) h.store.postMessage(COS, { to: ABJ, body: `m${i}` });
      const latest = h.store.readMessages(ABJ, { unread_only: false, limit: 2 });
      assert.deepEqual(latest.messages.map((m) => m.body), ["m4", "m5"]);
      assert.equal(latest.has_more, true);
    });

    it("mark_read never marks the caller's outgoing messages", () => {
      h.store.postMessage(COS, { to: ABJ, body: "out" });
      const res = h.store.readMessages(COS, { unread_only: false, mark_read: true });
      assert.equal(res.marked_read, 0);
      assert.equal(res.messages[0]!.direction, "outgoing");
      assert.equal(h.store.readMessages(ABJ, {}).messages.length, 1, "recipient still sees it unread");
    });

    it("ack marks read+acked, is idempotent, and exposes the receipt to the sender", () => {
      const a = h.store.postMessage(COS, { to: ABJ, body: "a" });
      const b = h.store.postMessage(COS, { to: ABJ, body: "b" });
      assert.deepEqual(h.store.ack(ABJ, [a.message_id]), { acked: [a.message_id], not_found: [] });
      assert.deepEqual(h.store.ack(ABJ, [a.message_id]), { acked: [a.message_id], not_found: [] });
      const unread = h.store.readMessages(ABJ, {});
      assert.deepEqual(unread.messages.map((m) => m.message_id), [b.message_id]);

      const sent = h.store.readMessages(COS, { unread_only: false });
      const receipt = sent.messages.find((m) => m.message_id === a.message_id)!;
      assert.ok(receipt.read_at && receipt.acked_at);
      assert.equal(sent.messages.find((m) => m.message_id === b.message_id)!.acked_at, null);
    });

    it("filters by since and thread_id", () => {
      let t = Date.parse("2026-01-01T00:00:00.000Z");
      const store = new RelayStore(
        h.db,
        h.config.bots.map((b) => b.id),
        h.config,
        () => new Date((t += 1000)),
      );
      const first = store.postMessage(COS, { to: ABJ, body: "first" });
      const cutoff = new Date(t).toISOString();
      store.postMessage(COS, { to: ABJ, body: "second" });
      store.postMessage(COS, { to: ABJ, body: "reply", thread_id: first.thread_id });
      assert.deepEqual(store.readMessages(ABJ, { since: cutoff }).messages.map((m) => m.body), ["second", "reply"]);
      assert.deepEqual(
        store.readMessages(ABJ, { thread_id: first.thread_id }).messages.map((m) => m.body),
        ["first", "reply"],
      );
      assertRelayError(() => store.readMessages(ABJ, { since: "yesterday-ish" }), "invalid_since");
    });
  });

  describe("isolation between bots", () => {
    it("a third bot cannot read, ack, or reply into others' threads", () => {
      const posted = h.store.postMessage(COS, { to: ABJ, body: "private" });
      assert.equal(h.store.readMessages(EVE, { unread_only: false }).messages.length, 0);
      assert.equal(h.store.listThreads(EVE, {}).threads.length, 0);
      assert.deepEqual(h.store.ack(EVE, [posted.message_id]), { acked: [], not_found: [posted.message_id] });
      assertRelayError(() => h.store.readMessages(EVE, { thread_id: posted.thread_id }), "thread_not_found");
      assertRelayError(
        () => h.store.postMessage(EVE, { to: ABJ, body: "x", thread_id: posted.thread_id }),
        "thread_not_found",
      );
      assert.equal(h.store.readMessages(ABJ, {}).messages[0]!.read_at, null, "intruder ack had no effect");
    });

    it("the sender cannot ack its own outgoing message on the recipient's behalf", () => {
      const posted = h.store.postMessage(COS, { to: ABJ, body: "x" });
      assert.deepEqual(h.store.ack(COS, [posted.message_id]), { acked: [], not_found: [posted.message_id] });
    });

    it("replies must go to the thread's other participant", () => {
      const posted = h.store.postMessage(COS, { to: ABJ, body: "x" });
      assertRelayError(
        () => h.store.postMessage(COS, { to: EVE, body: "x", thread_id: posted.thread_id }),
        "thread_mismatch",
      );
      const reply = h.store.postMessage(ABJ, { to: COS, body: "y", thread_id: posted.thread_id });
      assert.equal(reply.thread_id, posted.thread_id);
    });
  });

  it("lists threads with peer and unread counts", () => {
    const t1 = h.store.postMessage(COS, { to: ABJ, body: "x", subject: "First" });
    h.store.postMessage(ABJ, { to: COS, body: "y", thread_id: t1.thread_id });
    h.store.postMessage(ABJ, { to: COS, body: "z", subject: "Second" });
    const { threads } = h.store.listThreads(COS, {});
    assert.equal(threads.length, 2);
    assert.equal(threads[0]!.subject, "Second");
    assert.equal(threads[0]!.peer, ABJ);
    const first = threads.find((t) => t.thread_id === t1.thread_id)!;
    assert.equal(first.message_count, 2);
    assert.equal(first.unread_count, 1);
    assert.equal(h.store.listThreads(COS, { limit: 1 }).threads.length, 1);
  });

  describe("audit log", () => {
    it("is append-only: UPDATE and DELETE are blocked by triggers", () => {
      h.store.audit(COS, "post_message", ["msg_1"], "ok");
      assert.throws(() => h.db.exec("UPDATE audit_log SET status = 'tampered'"), /append-only/);
      assert.throws(() => h.db.exec("DELETE FROM audit_log"), /append-only/);
      assert.throws(() => h.db.exec("UPDATE audit_log SET bot_id = NULL WHERE id = 1"), /append-only/);
      const entries = h.store.recentAudit(10);
      assert.equal(entries.length, 1);
      assert.equal(entries[0]!.status, "ok");
      assert.deepEqual(entries[0]!.message_ids, ["msg_1"]);
    });

    it("survives reopening the database (triggers persist)", () => {
      h.store.audit(COS, "ack", [], "ok");
      const path = h.config.dbPath;
      h.db.close();
      const reopened = openDatabase(path);
      try {
        assert.throws(() => reopened.exec("DELETE FROM audit_log"), /append-only/);
      } finally {
        reopened.close();
      }
      h.db = openDatabase(path);
    });
  });
});
