import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { type NextFunction, type Request, type Response } from "express";
import { authenticateBot, extractBotToken, extractViewerToken, tokenMatchesHash } from "./auth.ts";
import type { Config } from "./config.ts";
import { buildMcpServer } from "./mcp.ts";
import type { Notifier } from "./notify.ts";
import { RateLimiter } from "./ratelimit.ts";
import type { RelayStore } from "./store.ts";
import { renderLogPage } from "./viewer.ts";

export interface AppDeps {
  config: Config;
  store: RelayStore;
  limiter?: RateLimiter;
  notifier?: Notifier;
  logRequests?: boolean;
}

function jsonRpcError(res: Response, status: number, code: number, message: string): void {
  res.status(status).json({ jsonrpc: "2.0", error: { code, message }, id: null });
}

export function createApp(deps: AppDeps): express.Express {
  const { config, store } = deps;
  const limiter = deps.limiter ?? new RateLimiter(config.rateLimitPerMinute);
  const jsonLimit = Math.max(256 * 1024, config.maxBodyBytes * 8);

  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", false);

  if (deps.logRequests) {
    app.use((req, res, next) => {
      const started = Date.now();
      res.on("finish", () => {
        const bot = typeof res.locals.botId === "string" ? ` bot=${res.locals.botId}` : "";
        console.log(`${req.method} ${req.path} ${res.statusCode} ${Date.now() - started}ms${bot}`);
      });
      next();
    });
  }

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

  app.get("/log", (req, res) => {
    if (!config.viewerTokenHash) {
      res.status(404).type("text/plain").send("Not found");
      return;
    }
    res.set("Cache-Control", "no-store");
    if (!tokenMatchesHash(extractViewerToken(req.headers), config.viewerTokenHash)) {
      store.audit(null, "GET /log", [], "unauthorized");
      res.set("WWW-Authenticate", 'Basic realm="bot-relay log", charset="UTF-8"');
      res.status(401).type("text/plain").send("Unauthorized");
      return;
    }
    const requested = Number(req.query.limit ?? 100);
    const limit = Number.isInteger(requested) ? Math.max(1, Math.min(500, requested)) : 100;
    store.audit(null, "GET /log", [], "ok");
    res.set({
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "X-Frame-Options": "DENY",
    });
    res.type("text/html").send(
      renderLogPage({
        hostname: config.publicHostname,
        messages: store.recentMessages(limit),
        audit: store.recentAudit(limit),
        generatedAt: new Date().toISOString(),
      }),
    );
  });

  const requireBot = (req: Request, res: Response, next: NextFunction): void => {
    const token = extractBotToken(req.headers);
    const botId = authenticateBot(config.bots, token);
    if (!botId) {
      store.audit(null, `${req.method} /mcp`, [], "unauthorized", token ? "invalid_token" : "missing_token");
      res.set("WWW-Authenticate", 'Bearer realm="bot-relay"');
      jsonRpcError(res, 401, -32001, "Unauthorized");
      return;
    }
    res.locals.botId = botId;
    next();
  };

  app.post("/mcp", requireBot, express.json({ limit: jsonLimit }), async (req, res) => {
    const botId = res.locals.botId as string;
    const server = buildMcpServer({ botId, store, limiter, notifier: deps.notifier });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  // Stateless server: no standalone SSE stream (GET) and no sessions to delete (DELETE).
  const methodNotAllowed = (_req: Request, res: Response): void => {
    res.set("Allow", "POST");
    jsonRpcError(res, 405, -32000, "Method not allowed; this server is stateless and only accepts POST /mcp");
  };
  app.get("/mcp", requireBot, methodNotAllowed);
  app.delete("/mcp", requireBot, methodNotAllowed);

  app.use((_req, res) => {
    res.status(404).type("text/plain").send("Not found");
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status = (err as { status?: number }).status;
    if (res.headersSent) return;
    if (status === 413) return jsonRpcError(res, 413, -32600, "Request body too large");
    if (status === 400) return jsonRpcError(res, 400, -32700, "Parse error");
    console.error("unhandled error:", err instanceof Error ? err.message : err);
    jsonRpcError(res, 500, -32603, "Internal error");
  });

  return app;
}
