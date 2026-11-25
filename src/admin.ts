import { createHash } from "node:crypto";
import express, { type NextFunction, type Request, type Response, Router } from "express";
import {
  ADMIN_COOKIE_NAME,
  authenticateAdmin,
  extractViewerToken,
  signAdminSession,
  tokenMatchesHash,
  type AdminAuthMethod,
} from "./auth.ts";
import type { Config } from "./config.ts";
import type { EventHub } from "./events.ts";
import { SERVER_VERSION } from "./mcp.ts";
import type { Notifier } from "./notify.ts";
import { RateLimiter } from "./ratelimit.ts";
import { RelayError, type RelayStore } from "./store.ts";
import { ADMIN_CSS, ADMIN_JS, renderAdminPage, renderLoginPage } from "./ui/admin.ts";
import { renderLogPage } from "./viewer.ts";

export interface AdminRouterDeps {
  config: Config;
  store: RelayStore;
  notifier?: Notifier | undefined;
  events?: EventHub | undefined;
  sessionSecret: Buffer;
  /** True when mounted on the dedicated admin listener or when gateway auth is explicitly allowed. */
  allowGatewayAuth: boolean;
  /** Optional DB-stored hash from zero-config first boot. */
  fallbackAdminTokenHash?: Buffer | undefined;
}

const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

export function resolvePublicBaseUrl(config: Config, req: Request): string {
  if (config.publicUrl) return config.publicUrl;
  const host = req.headers.host || `127.0.0.1:${config.port}`;
  const isTls = Boolean((req.socket as { encrypted?: boolean } | undefined)?.encrypted);
  return `${isTls ? "https" : "http"}://${host}`;
}

export function relayErrorStatus(code: string): number {
  switch (code) {
    case "invalid_invite_code":
      return 401;
    case "invite_expired":
    case "invite_exhausted":
      return 403;
    case "unknown_bot":
    case "invite_not_found":
    case "thread_not_found":
      return 404;
    case "bot_already_exists":
    case "managed_by_env":
    case "bot_revoked":
      return 409;
    default:
      return 400;
  }
}

function setSecurityHeaders(res: Response, allowAssets = false): void {
  res.set({
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
    "Content-Security-Policy": allowAssets
      ? "default-src 'none'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; img-src 'self' data:; form-action 'self'; frame-ancestors 'none'"
      : "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
  });
}

function buildCookieHeader(value: string, maxAgeSeconds: number, secure: boolean): string {
  const parts = [
    `${ADMIN_COOKIE_NAME}=${value}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function createAdminRouter(deps: AdminRouterDeps): Router {
  const { config, store } = deps;
  const router = Router();
  const loginLimiter = new RateLimiter(10);

  const effectiveAdminHash = (): Buffer | undefined => config.adminTokenHash ?? deps.fallbackAdminTokenHash;
  const isAdminEnabled = (): boolean => Boolean(effectiveAdminHash() || (deps.allowGatewayAuth && config.adminGatewayKey));

  const checkAdmin = (req: Request): AdminAuthMethod | null => {
    if (!isAdminEnabled()) return null;
    return authenticateAdmin(req.headers, {
      gatewayKey: config.adminGatewayKey,
      allowGateway: deps.allowGatewayAuth,
      adminTokenHash: effectiveAdminHash(),
      sessionSecret: deps.sessionSecret,
    });
  };

  // Static assets (CSS & JS)
  router.get("/assets/admin.css", (_req, res) => {
    res.set({ "Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff" });
    res.type("text/css").send(ADMIN_CSS);
  });
  router.get("/assets/admin.js", (_req, res) => {
    res.set({ "Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff" });
    res.type("application/javascript").send(ADMIN_JS);
  });

  // Login / Logout for standalone browser sessions
  router.get("/login", (req, res) => {
    if (!isAdminEnabled()) {
      res.status(404).type("text/plain").send("Not found");
      return;
    }
    if (checkAdmin(req)) {
      res.redirect(302, "/");
      return;
    }
    setSecurityHeaders(res, true);
    res.type("text/html").send(renderLoginPage());
  });

  router.post("/login", express.urlencoded({ extended: false, limit: "16kb" }), (req, res) => {
    if (!isAdminEnabled()) {
      res.status(404).type("text/plain").send("Not found");
      return;
    }
    setSecurityHeaders(res, true);
    const ip = req.socket.remoteAddress || "unknown";
    if (!loginLimiter.tryConsume(ip)) {
      store.audit(null, "POST /login", [], "rate_limited");
      res.status(429).type("text/html").send(renderLoginPage("Too many sign-in attempts. Please wait a minute."));
      return;
    }
    const password = typeof (req.body as Record<string, unknown> | undefined)?.password === "string"
      ? String((req.body as Record<string, unknown>).password)
      : undefined;
    const adminHash = effectiveAdminHash();
    if (!adminHash || !tokenMatchesHash(password, adminHash)) {
      store.audit(null, "POST /login", [], "unauthorized");
      res.status(401).type("text/html").send(renderLoginPage("Invalid admin password or token."));
      return;
    }
    const isSecure = Boolean((req.socket as { encrypted?: boolean } | undefined)?.encrypted);
    const token = signAdminSession(deps.sessionSecret, Date.now() + SESSION_TTL_MS);
    res.set("Set-Cookie", buildCookieHeader(token, Math.floor(SESSION_TTL_MS / 1000), isSecure));
    store.audit(null, "POST /login", [], "ok");
    res.redirect(302, "/");
  });

  router.post("/logout", (req, res) => {
    const isSecure = Boolean((req.socket as { encrypted?: boolean } | undefined)?.encrypted);
    res.set("Set-Cookie", buildCookieHeader("", 0, isSecure));
    res.status(200).json({ ok: true });
  });

  // Main Admin Dashboard HTML
  router.get("/", (req, res) => {
    if (!isAdminEnabled()) {
      res.status(404).type("text/plain").send("Not found");
      return;
    }
    const method = checkAdmin(req);
    if (!method) {
      res.redirect(302, "/login");
      return;
    }
    setSecurityHeaders(res, true);
    res.type("text/html").send(renderAdminPage(config.publicHostname));
  });

  // Legacy /log viewer (accepts VIEWER_TOKEN_SHA256 OR valid Admin auth)
  router.get("/log", (req, res) => {
    const hasViewer = Boolean(config.viewerTokenHash);
    if (!hasViewer && !isAdminEnabled()) {
      res.status(404).type("text/plain").send("Not found");
      return;
    }
    res.set("Cache-Control", "no-store");
    const viewerOk = hasViewer && tokenMatchesHash(extractViewerToken(req.headers), config.viewerTokenHash);
    const adminOk = checkAdmin(req) !== null;
    if (!viewerOk && !adminOk) {
      store.audit(null, "GET /log", [], "unauthorized");
      res.set("WWW-Authenticate", 'Basic realm="bot-relay log", charset="UTF-8"');
      res.status(401).type("text/plain").send("Unauthorized");
      return;
    }
    const requested = Number(req.query.limit ?? 100);
    const limit = Number.isInteger(requested) ? Math.max(1, Math.min(500, requested)) : 100;
    store.audit(null, "GET /log", [], "ok");
    setSecurityHeaders(res, false);
    res.type("text/html").send(
      renderLogPage({
        hostname: config.publicHostname,
        messages: store.recentMessages(limit),
        audit: store.recentAudit(limit),
        generatedAt: new Date().toISOString(),
      }),
    );
  });

  // Admin JSON API middleware
  const requireAdminApi = (req: Request, res: Response, next: NextFunction): void => {
    res.set("Cache-Control", "no-store");
    if (!isAdminEnabled()) {
      res.status(404).json({ error: "not_found", message: "Admin API disabled" });
      return;
    }
    const method = checkAdmin(req);
    if (!method) {
      store.audit(null, `${req.method} ${req.path}`, [], "unauthorized");
      res.set("WWW-Authenticate", 'Bearer realm="bot-relay-admin"');
      res.status(401).json({ error: "unauthorized", message: "Admin authentication required" });
      return;
    }
    // Require explicit custom header on browser cookie mutations to block CSRF
    if (method === "cookie" && req.method !== "GET" && req.method !== "HEAD") {
      if (req.headers["x-requested-with"] !== "bot-relay-ui") {
        res.status(403).json({ error: "csrf_required", message: "Missing X-Requested-With header" });
        return;
      }
    }
    res.locals.adminAuthMethod = method;
    next();
  };

  const jsonBody = express.json({ limit: "64kb" });

  function handleAdmin(fn: (req: Request, res: Response) => void | Promise<void>) {
    return async (req: Request, res: Response): Promise<void> => {
      try {
        await fn(req, res);
      } catch (err) {
        if (err instanceof RelayError) {
          res.status(relayErrorStatus(err.code)).json({ error: err.code, message: err.message });
          return;
        }
        console.error(`admin ${req.method} ${req.path} failed:`, err instanceof Error ? err.message : err);
        res.status(500).json({ error: "internal_error", message: "Internal error" });
      }
    };
  }

  router.get(
    "/api/admin/overview",
    requireAdminApi,
    handleAdmin((req, res) => {
      const base = resolvePublicBaseUrl(config, req);
      res.json({
        server: {
          version: SERVER_VERSION,
          public_url: base,
          mcp_url: `${base}/mcp`,
          events_url: `${base}/events`,
          register_url: `${base}/register`,
          split_port: config.adminPort !== undefined,
          auth_method: res.locals.adminAuthMethod,
        },
        bots: store.listBots(),
        sse_connections: deps.events?.connectedCounts() ?? {},
        invites: store.listInviteCodes(),
        messages: store.recentMessages(100),
        audit: store.recentAudit(100),
      });
    }),
  );

  router.get(
    "/api/admin/bots",
    requireAdminApi,
    handleAdmin((_req, res) => {
      res.json({ bots: store.listBots(), sse_connections: deps.events?.connectedCounts() ?? {} });
    }),
  );

  router.post(
    "/api/admin/bots",
    requireAdminApi,
    jsonBody,
    handleAdmin((req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      if (typeof body.id !== "string" || !body.id.trim()) {
        res.status(400).json({ error: "invalid_bot_id", message: "id is required" });
        return;
      }
      const created = store.createBot({
        id: body.id,
        displayName: typeof body.display_name === "string" ? body.display_name : undefined,
        webhookUrl: typeof body.webhook_url === "string" ? body.webhook_url : undefined,
        webhookSecret: typeof body.webhook_secret === "string" ? body.webhook_secret : undefined,
      });
      res.status(201).json(created);
    }),
  );

  router.put(
    "/api/admin/bots/:id/webhook",
    requireAdminApi,
    jsonBody,
    handleAdmin((req, res) => {
      const botId = String(req.params.id ?? "");
      const body = (req.body ?? {}) as Record<string, unknown>;
      const url = body.url === null ? null : typeof body.url === "string" ? body.url : null;
      const secret = body.secret === undefined ? undefined : body.secret === null ? null : String(body.secret);
      const enabled = typeof body.enabled === "boolean" ? body.enabled : undefined;
      const info = store.setWebhook(botId, { url, secret, enabled });
      store.audit(botId, "admin.set_webhook", [], "ok");
      res.json(info);
    }),
  );

  router.post(
    "/api/admin/bots/:id/webhook/test",
    requireAdminApi,
    handleAdmin(async (req, res) => {
      const botId = String(req.params.id ?? "");
      if (!store.isBotActive(botId)) {
        res.status(404).json({ error: "unknown_bot", message: `bot "${botId}" not found` });
        return;
      }
      if (!deps.notifier) {
        res.status(503).json({ error: "notifier_unavailable", message: "Notifier is not initialized" });
        return;
      }
      const result = await deps.notifier.sendTest(botId);
      res.json(result);
    }),
  );

  router.post(
    "/api/admin/bots/:id/rotate-token",
    requireAdminApi,
    jsonBody,
    handleAdmin((req, res) => {
      const botId = String(req.params.id ?? "");
      const body = (req.body ?? {}) as Record<string, unknown>;
      const revokeOthers = body.revoke_others !== false;
      const rotated = store.rotateBotToken(botId, { revokeOthers, label: "admin-rotated" });
      res.json(rotated);
    }),
  );

  router.post(
    "/api/admin/bots/:id/revoke",
    requireAdminApi,
    handleAdmin((req, res) => {
      const botId = String(req.params.id ?? "");
      store.revokeBot(botId);
      deps.events?.disconnectBot(botId);
      res.json({ ok: true, bot_id: botId });
    }),
  );

  router.post(
    "/api/admin/bots/:id/restore",
    requireAdminApi,
    handleAdmin((req, res) => {
      const botId = String(req.params.id ?? "");
      const restored = store.restoreBot(botId);
      res.json({ ok: true, bot_id: botId, token: restored.token });
    }),
  );

  router.get(
    "/api/admin/invites",
    requireAdminApi,
    handleAdmin((_req, res) => {
      res.json({ invites: store.listInviteCodes() });
    }),
  );

  router.post(
    "/api/admin/invites",
    requireAdminApi,
    jsonBody,
    handleAdmin((req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const created = store.createInviteCode({
        botId: typeof body.bot_id === "string" ? body.bot_id : null,
        label: typeof body.label === "string" ? body.label : null,
        maxUses: typeof body.max_uses === "number" ? body.max_uses : undefined,
        expiresInSeconds:
          body.expires_in_seconds === null
            ? null
            : typeof body.expires_in_seconds === "number"
              ? body.expires_in_seconds
              : undefined,
      });
      const base = resolvePublicBaseUrl(config, req);
      const sampleBotId = created.invite.bot_id ?? "my-bot";
      const regPayload = JSON.stringify({ code: created.code, bot_id: sampleBotId });
      const curlExample = `curl -sS -X POST '${base}/register' \\\n  -H 'Content-Type: application/json' \\\n  -d '${regPayload}'`;
      const botPrompt =
        `Register yourself with Bot Relay by sending a POST request to ${base}/register ` +
        `with JSON {"code":"${created.code}","bot_id":"${sampleBotId}"} (optionally include "webhook_url" for push pings). ` +
        `Save the returned bearer token securely, then connect your MCP client to ${base}/mcp ` +
        `and subscribe to ${base}/events for real-time message notifications.`;
      res.status(201).json({
        ...created,
        register_url: `${base}/register`,
        curl_example: curlExample,
        bot_prompt: botPrompt,
      });
    }),
  );

  router.delete(
    "/api/admin/invites/:id",
    requireAdminApi,
    handleAdmin((req, res) => {
      const id = String(req.params.id ?? "");
      store.revokeInviteCode(id);
      res.json({ ok: true, id });
    }),
  );

  router.get(
    "/api/admin/messages",
    requireAdminApi,
    handleAdmin((req, res) => {
      const limit = Number(req.query.limit ?? 100);
      const bot = typeof req.query.bot === "string" && req.query.bot.trim() ? req.query.bot.trim() : undefined;
      res.json({ messages: store.recentMessages(Number.isFinite(limit) ? limit : 100, bot) });
    }),
  );

  router.get(
    "/api/admin/audit",
    requireAdminApi,
    handleAdmin((req, res) => {
      const limit = Number(req.query.limit ?? 100);
      const bot = typeof req.query.bot === "string" && req.query.bot.trim() ? req.query.bot.trim() : undefined;
      res.json({ audit: store.recentAudit(Number.isFinite(limit) ? limit : 100, bot) });
    }),
  );

  return router;
}

export function deriveSessionSecret(encryptionKey: Buffer, adminTokenHash?: Buffer): Buffer {
  const hash = createHash("sha256").update("bot-relay-admin-session-v2").update(encryptionKey);
  if (adminTokenHash) hash.update(adminTokenHash);
  return hash.digest();
}
