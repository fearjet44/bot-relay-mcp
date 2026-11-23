import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { RateLimiter } from "./ratelimit.ts";
import { MAX_ACK_IDS, MAX_READ_LIMIT, RelayError, type RelayStore } from "./store.ts";

export const SERVER_NAME = "bot-relay";
export const SERVER_VERSION = "1.0.0";

interface ToolContext {
  botId: string;
  store: RelayStore;
  limiter: RateLimiter;
}

type Outcome = { result: Record<string, unknown>; messageIds: string[] };

function invoke(ctx: ToolContext, tool: string, fn: () => Outcome): CallToolResult {
  if (!ctx.limiter.tryConsume(ctx.botId)) {
    ctx.store.audit(ctx.botId, tool, [], "rate_limited");
    return errorResult("rate_limited", "rate limit exceeded; retry in a few seconds");
  }
  try {
    const { result, messageIds } = fn();
    ctx.store.audit(ctx.botId, tool, messageIds, "ok");
    return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
  } catch (err) {
    if (err instanceof RelayError) {
      ctx.store.audit(ctx.botId, tool, [], "error", err.code);
      return errorResult(err.code, err.message);
    }
    ctx.store.audit(ctx.botId, tool, [], "error", "internal_error");
    console.error(`tool ${tool} failed for ${ctx.botId}:`, err instanceof Error ? err.message : err);
    return errorResult("internal_error", "internal error");
  }
}

function errorResult(code: string, message: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: code, message }) }] };
}

/**
 * Builds a per-request MCP server bound to one authenticated bot. There is no
 * `from` argument anywhere: the sender/reader is always `botId`, which comes
 * from the bearer token.
 */
export function buildMcpServer(ctx: ToolContext): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        `You are connected to a private message relay as "${ctx.botId}". ` +
        "Use list_peers to see who you can message, post_message to send, read_messages to fetch your inbox " +
        "(unread by default), and ack to confirm you have handled messages.",
    },
  );

  server.registerTool(
    "list_peers",
    {
      title: "List peers",
      description: "Returns your own bot id and the ids of the other bots you can message.",
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    () => invoke(ctx, "list_peers", () => ({ result: ctx.store.listPeers(ctx.botId), messageIds: [] })),
  );

  server.registerTool(
    "post_message",
    {
      title: "Post message",
      description:
        "Sends a message to another bot. The sender is always you (derived from your credentials). " +
        "Omit thread_id to start a new thread; pass a thread_id from an earlier message to reply in it.",
      inputSchema: {
        to: z.string().describe("Recipient bot id (see list_peers)"),
        body: z.string().describe("Message text (UTF-8, size-capped)"),
        subject: z.string().optional().describe("Optional short subject"),
        thread_id: z.string().optional().describe("Existing thread to reply in"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    (args) =>
      invoke(ctx, "post_message", () => {
        const posted = ctx.store.postMessage(ctx.botId, args);
        return { result: posted, messageIds: [posted.message_id] };
      }),
  );

  server.registerTool(
    "read_messages",
    {
      title: "Read messages",
      description:
        "Reads messages you received or sent. By default returns only unread messages addressed to you, oldest first. " +
        "With unread_only=false it includes your sent messages too (most recent `limit`, or everything after `since`, " +
        "oldest first). Reading does not change state unless mark_read=true. read_at/acked_at are the recipient's receipts.",
      inputSchema: {
        unread_only: z.boolean().optional().describe("Only unread messages addressed to you (default true)"),
        since: z.string().optional().describe("ISO-8601 timestamp; only messages created after it"),
        thread_id: z.string().optional().describe("Restrict to one thread"),
        limit: z.number().int().optional().describe(`Max messages to return (default 50, max ${MAX_READ_LIMIT})`),
        mark_read: z.boolean().optional().describe("Mark returned incoming messages as read (default false)"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    (args) =>
      invoke(ctx, "read_messages", () => {
        const read = ctx.store.readMessages(ctx.botId, args);
        return { result: read, messageIds: read.messages.map((m) => m.message_id) };
      }),
  );

  server.registerTool(
    "list_threads",
    {
      title: "List threads",
      description: "Lists threads you participate in, most recently active first, with unread counts.",
      inputSchema: {
        limit: z.number().int().optional().describe(`Max threads (default 20, max ${MAX_READ_LIMIT})`),
        since: z.string().optional().describe("ISO-8601 timestamp; only threads active after it"),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args) => invoke(ctx, "list_threads", () => ({ result: ctx.store.listThreads(ctx.botId, args), messageIds: [] })),
  );

  server.registerTool(
    "ack",
    {
      title: "Acknowledge messages",
      description:
        "Acknowledges messages addressed to you (also marks them read). Idempotent. " +
        "Ids that are not addressed to you are reported in not_found.",
      inputSchema: {
        message_ids: z.array(z.string()).describe(`Message ids to acknowledge (max ${MAX_ACK_IDS})`),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    (args) =>
      invoke(ctx, "ack", () => {
        const acked = ctx.store.ack(ctx.botId, args.message_ids);
        return { result: acked, messageIds: acked.acked };
      }),
  );

  return server;
}
