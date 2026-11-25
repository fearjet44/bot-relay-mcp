import { randomBytes } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { type NextFunction, type Request, type Response } from "express";
import { createAdminRouter, deriveSessionSecret, relayErrorStatus, resolvePublicBaseUrl } from "./admin.ts";
import { authenticateBot, extractBotToken, sha256 } from "./auth.ts";
import type { Config } from "./config.ts";
import type { EventHub } from "./events.ts";
import { buildMcpServer } from "./mcp.ts";
import type { Notifier } from "./notify.ts";
import { RateLimiter } from "./ratelimit.ts";
import { RelayError, type RelayStore } from "./store.ts";

export interface AppDeps {
  config: Config;
  store: RelayStore;
  limiter?: RateLimiter | undefined;
  registerLimiter?: RateLimiter | undefined;
  notifier?: Notifier | undefined;
  events?: EventHub | undefined;
  encryptionKey?: Buffer | undefined;
  fallbackAdminTokenHash?: Buffer | undefined;
  logRequests?: boolean | undefined;
  /** Mount admin & viewer routes on the bot app (default: true when config.adminPort is unset). */
  mountAdmin?: boolean | undefined;
}

function jsonRpcError(res: Response, status: number, code: number, message: string): void {
  res.status(status).json({ jsonrpc: "2.0", error: { code, message }, id: null });
}

function attachCommonMiddleware(app: express.Express, logRequests: boolean | undefined, label: string): void {
  app.disable("x-powered-by");
  app.set("trust proxy", false);
  if (logRequests) {
    app.use((req, res, next) => {
      const started = Date.now();
      res.on("finish", () => {
        const bot = typeof res.locals.botId === "string" ? ` bot=${res.locals.botId}` : "";
        console.log(`${label}${req.method} ${req.path} ${res.statusCode} ${Date.now() - started}ms${bot}`);
      });
      next();
    });
  }
}

function attachHealthz(app: express.Express, store: RelayStore): void {
  app.get("/healthz", (_req, res) => {
    let ok = false;
    try {
      ok = store.ping();
    } catch {
      ok = false;
    }
    res.set("Cache-Control", "no-store");
    res.status(ok ? 200 : 503).json({ status: ok ? "ok" : "unavailable" });
  });
}

function attachFallbackAndErrorHandler(app: express.Express): void {
  app.use((_req, res) => {
    res.status(404).type("text/plain").send("Not found");
  });

  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    const status = (err as { status?: number }).status;
    if (res.headersSent) return;
    if (req.path === "/mcp") {
      if (status === 413) return jsonRpcError(res, 413, -32600, "Request body too large");
      if (status === 400) return jsonRpcError(res, 400, -32700, "Parse error");
      console.error("unhandled error:", err instanceof Error ? err.message : err);
      return jsonRpcError(res, 500, -32603, "Internal error");
    }
    if (status === 413) return void res.status(413).json({ error: "payload_too_large", message: "Request body too large" });
    if (status === 400) return void res.status(400).json({ error: "invalid_json", message: "Malformed JSON body" });
    console.error("unhandled error:", err instanceof Error ? err.message : err);
    res.status(500).json({ error: "internal_error", message: "Internal error" });
  });
}

export function createBotApp(deps: AppDeps): express.Express {
  const { config, store } = deps;
  const limiter = deps.limiter ?? new RateLimiter(config.rateLimitPerMinute);
  const registerLimiter = deps.registerLimiter ?? new RateLimiter(config.registerRateLimitPerMinute);
  const jsonLimit = Math.max(256 * 1024, config.maxBodyBytes * 8);
  const mountAdmin = deps.mountAdmin ?? config.adminPort === undefined;

  const app = express();
  attachCommonMiddleware(app, deps.logRequests, "");
  attachHealthz(app, store);

  // --- Self-registration via owner-issued approval / invite code ---
  app.post("/register", express.json({ limit: "32kb" }), (req, res) => {
    res.set("Cache-Control", "no-store");
    const ip = req.socket.remoteAddress || "unknown";
    if (!registerLimiter.tryConsume(ip)) {
      store.audit(null, "POST /register", [], "rate_limited");
      res.status(429).json({ error: "rate_limited", message: "Too many registration attempts; retry later" });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const code = typeof body.code === "string" ? body.code : "";
    if (!code.trim()) {
      store.audit(null, "POST /register", [], "unauthorized", "missing_code");
      res.status(400).json({ error: "missing_code", message: "code is required" });
      return;
    }
    try {
      const result = store.redeemInviteCode({
        code,
        botId: typeof body.bot_id === "string" ? body.bot_id : undefined,
        displayName: typeof body.display_name === "string" ? body.display_name : undefined,
        webhookUrl: typeof body.webhook_url === "string" ? body.webhook_url : undefined,
        webhookSecret: typeof body.webhook_secret === "string" ? body.webhook_secret : undefined,
      });
      res.locals.botId = result.bot_id;
      const base = resolvePublicBaseUrl(config, req);
      res.status(201).json({
        bot_id: result.bot_id,
        display_name: result.display_name,
        token: result.token,
        mcp_url: `${base}/mcp`,
        events_url: `${base}/events`,
        webhook: result.webhook,
      });
    } catch (err) {
      if (err instanceof RelayError) {
        const auditStatus =
          err.code === "invalid_invite_code" || err.code === "invite_expired" || err.code === "invite_exhausted"
            ? "unauthorized"
            : "error";
        store.audit(null, "POST /register", [], auditStatus, err.code);
        res.status(relayErrorStatus(err.code)).json({ error: err.code, message: err.message });
        return;
      }
      console.error("register failed:", err instanceof Error ? err.message : err);
      res.status(500).json({ error: "internal_error", message: "Internal error" });
    }
  });

  // --- Bot bearer token authentication (checks env BOTS + active SQLite tokens) ---
  const requireBot = (req: Request, res: Response, next: NextFunction): void => {
    const token = extractBotToken(req.headers);
    const botId = authenticateBot(store.listActiveAuthEntries(), token);
    if (!botId) {
      store.audit(null, `${req.method} ${req.path}`, [], "unauthorized", token ? "invalid_token" : "missing_token");
      res.set("WWW-Authenticate", 'Bearer realm="bot-relay"');
      if (req.path === "/mcp") {
        jsonRpcError(res, 401, -32001, "Unauthorized");
      } else {
        res.status(401).json({ error: "unauthorized", message: "Unauthorized" });
      }
      return;
    }
    res.locals.botId = botId;
    store.touchBotSeen(botId, token ? sha256(token).toString("hex") : undefined);
    next();
  };

  // --- MCP Streamable HTTP ---
  app.post("/mcp", requireBot, express.json({ limit: jsonLimit }), async (req, res) => {
    const botId = res.locals.botId as string;
    const server = buildMcpServer({ botId, store, limiter, notifier: deps.notifier, events: deps.events });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  // Stateless server: no standalone SSE stream on /mcp (use GET /events) and no sessions to delete.
  const methodNotAllowed = (_req: Request, res: Response): void => {
    res.set("Allow", "POST");
    jsonRpcError(res, 405, -32000, "Method not allowed; this server is stateless and only accepts POST /mcp");
  };
  app.get("/mcp", requireBot, methodNotAllowed);
  app.delete("/mcp", requireBot, methodNotAllowed);

  // --- Real-time SSE push stream for bots ---
  app.get("/events", requireBot, (req, res) => {
    const botId = res.locals.botId as string;
    if (!deps.events) {
      res.status(503).json({ error: "events_unavailable", message: "Event stream is not enabled" });
      return;
    }
    const headerId = req.headers["last-event-id"];
    const rawLastId =
      typeof headerId === "string" && headerId.trim()
        ? headerId.trim()
        : typeof req.query.since_seq === "string" && req.query.since_seq.trim()
          ? req.query.since_seq.trim()
          : undefined;
    const lastEventId = rawLastId !== undefined && /^\d+$/.test(rawLastId) ? Number(rawLastId) : undefined;
    deps.events.subscribe(botId, res, lastEventId);
  });

  // --- Self-service bot endpoints ---
  app.get("/me", requireBot, (req, res) => {
    res.set("Cache-Control", "no-store");
    const botId = res.locals.botId as string;
    const base = resolvePublicBaseUrl(config, req);
    res.json({
      bot_id: botId,
      display_name: store.getBotDisplayName(botId),
      mcp_url: `${base}/mcp`,
      events_url: `${base}/events`,
      unread_count: store.unreadCount(botId),
      webhook: store.getWebhookInfo(botId),
      sse_connections: deps.events?.connectedCounts()[botId] ?? 0,
    });
  });

  app.put("/me/webhook", requireBot, express.json({ limit: "32kb" }), (req, res) => {
    res.set("Cache-Control", "no-store");
    const botId = res.locals.botId as string;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const url = body.url === null ? null : typeof body.url === "string" ? body.url : null;
    const secret = body.secret === undefined ? undefined : body.secret === null ? null : String(body.secret);
    const enabled = typeof body.enabled === "boolean" ? body.enabled : undefined;
    try {
      const info = store.setWebhook(botId, { url, secret, enabled });
      store.audit(botId, "PUT /me/webhook", [], "ok");
      res.json(info);
    } catch (err) {
      if (err instanceof RelayError) {
        store.audit(botId, "PUT /me/webhook", [], "error", err.code);
        res.status(relayErrorStatus(err.code)).json({ error: err.code, message: err.message });
        return;
      }
      throw err;
    }
  });

  app.post("/me/token/rotate", requireBot, express.json({ limit: "16kb" }), (req, res) => {
    res.set("Cache-Control", "no-store");
    const botId = res.locals.botId as string;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const revokeOthers = body.revoke_others === true;
    try {
      const rotated = store.rotateBotToken(botId, { revokeOthers, label: "self-rotated" });
      res.json(rotated);
    } catch (err) {
      if (err instanceof RelayError) {
        store.audit(botId, "POST /me/token/rotate", [], "error", err.code);
        res.status(relayErrorStatus(err.code)).json({ error: err.code, message: err.message });
        return;
      }
      throw err;
    }
  });

  if (mountAdmin) {
    const encKey = deps.encryptionKey ?? randomBytes(32);
    const sessionSecret = deriveSessionSecret(encKey, config.adminTokenHash ?? deps.fallbackAdminTokenHash);
    app.use(
      createAdminRouter({
        config,
        store,
        notifier: deps.notifier,
        events: deps.events,
        sessionSecret,
        // Never trust x-omarchy-gateway on the shared public bot port unless split-port isn't used and gateway key is set
        allowGatewayAuth: Boolean(config.adminGatewayKey),
        fallbackAdminTokenHash: deps.fallbackAdminTokenHash,
      }),
    );
  }

  attachFallbackAndErrorHandler(app);
  return app;
}

export function createAdminApp(deps: AppDeps): express.Express {
  const { config, store } = deps;
  const app = express();
  attachCommonMiddleware(app, deps.logRequests, "[admin] ");
  attachHealthz(app, store);

  const encKey = deps.encryptionKey ?? randomBytes(32);
  const sessionSecret = deriveSessionSecret(encKey, config.adminTokenHash ?? deps.fallbackAdminTokenHash);
  app.use(
    createAdminRouter({
      config,
      store,
      notifier: deps.notifier,
      events: deps.events,
      sessionSecret,
      allowGatewayAuth: Boolean(config.adminGatewayKey),
      fallbackAdminTokenHash: deps.fallbackAdminTokenHash,
    }),
  );

  attachFallbackAndErrorHandler(app);
  return app;
}

/** Backwards-compatible unified app factory. */
export function createApp(deps: AppDeps): express.Express {
  return createBotApp(deps);
}
