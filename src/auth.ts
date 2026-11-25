import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import type { BotEntry } from "./config.ts";

const MAX_TOKEN_LENGTH = 512;
export const ADMIN_COOKIE_NAME = "bot_relay_admin";

export function sha256(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

export function generateToken(prefix = "relay_"): string {
  return `${prefix}${randomBytes(32).toString("base64url")}`;
}

export function generateInviteCode(): string {
  return `join_${randomBytes(18).toString("base64url")}`;
}

export function generateAdminPassword(): string {
  return randomBytes(18).toString("base64url");
}

function headerValue(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Reads the bot token from `X-Relay-Token` (preferred when present, so that
 * `Authorization` can be left to Cloudflare Access's single-header mode) or
 * from `Authorization: Bearer <token>`.
 */
export function extractBotToken(headers: IncomingHttpHeaders): string | undefined {
  const relayToken = headerValue(headers, "x-relay-token")?.trim();
  if (relayToken) return relayToken;
  const auth = headerValue(headers, "authorization");
  const match = auth?.match(/^Bearer\s+(\S+)\s*$/i);
  return match?.[1];
}

/** Accepts `Authorization: Bearer <token>` or HTTP Basic with the token as password. */
export function extractViewerToken(headers: IncomingHttpHeaders): string | undefined {
  const auth = headerValue(headers, "authorization");
  if (!auth) return undefined;
  const bearer = auth.match(/^Bearer\s+(\S+)\s*$/i);
  if (bearer) return bearer[1];
  const basic = auth.match(/^Basic\s+([A-Za-z0-9+/=]+)\s*$/i);
  if (!basic?.[1]) return undefined;
  const decoded = Buffer.from(basic[1], "base64").toString("utf8");
  const sep = decoded.indexOf(":");
  return sep >= 0 ? decoded.slice(sep + 1) : undefined;
}

/**
 * Compares the presented token's digest against every configured digest with
 * `timingSafeEqual`, without short-circuiting, so timing does not reveal which
 * (or whether any) bot matched.
 */
export function authenticateBot(bots: readonly BotEntry[], token: string | undefined): string | undefined {
  if (!token || token.length > MAX_TOKEN_LENGTH) return undefined;
  const digest = sha256(token);
  let matched: string | undefined;
  for (const bot of bots) {
    if (timingSafeEqual(digest, bot.tokenHash) && matched === undefined) {
      matched = bot.id;
    }
  }
  return matched;
}

export function tokenMatchesHash(token: string | undefined, hash: Buffer | undefined): boolean {
  if (!token || !hash || token.length > MAX_TOKEN_LENGTH) return false;
  return timingSafeEqual(sha256(token), hash);
}

export function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  if (!cookieHeader) return {};
  const out: Record<string, string> = {};
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k) out[k] = v;
  }
  return out;
}

export function signAdminSession(sessionSecret: Buffer, expiresAtMs: number): string {
  const payload = String(Math.floor(expiresAtMs));
  const sig = createHmac("sha256", sessionSecret).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

export function verifyAdminSession(
  cookieValue: string | undefined,
  sessionSecret: Buffer,
  nowMs: number = Date.now(),
): boolean {
  if (!cookieValue || cookieValue.length > 256) return false;
  const dot = cookieValue.indexOf(".");
  if (dot <= 0) return false;
  const payload = cookieValue.slice(0, dot);
  const sig = cookieValue.slice(dot + 1);
  if (!/^\d+$/.test(payload) || !sig) return false;
  const exp = Number(payload);
  if (!Number.isSafeInteger(exp) || exp <= nowMs) return false;
  const expected = createHmac("sha256", sessionSecret).update(payload).digest();
  let provided: Buffer;
  try {
    provided = Buffer.from(sig, "base64url");
  } catch {
    return false;
  }
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}

export type AdminAuthMethod = "gateway" | "token" | "cookie";

export interface AdminAuthOptions {
  gatewayKey?: string | undefined;
  allowGateway?: boolean | undefined;
  adminTokenHash?: Buffer | undefined;
  sessionSecret: Buffer;
  nowMs?: number | undefined;
}

export function authenticateAdmin(headers: IncomingHttpHeaders, opts: AdminAuthOptions): AdminAuthMethod | null {
  if (opts.allowGateway && opts.gatewayKey) {
    const presented = headerValue(headers, "x-omarchy-gateway")?.trim();
    if (presented && presented.length <= MAX_TOKEN_LENGTH) {
      if (timingSafeEqual(sha256(presented), sha256(opts.gatewayKey))) {
        return "gateway";
      }
    }
  }

  if (opts.adminTokenHash) {
    const presented = extractViewerToken(headers);
    if (tokenMatchesHash(presented, opts.adminTokenHash)) {
      return "token";
    }
  }

  const cookies = parseCookies(headerValue(headers, "cookie"));
  if (verifyAdminSession(cookies[ADMIN_COOKIE_NAME], opts.sessionSecret, opts.nowMs)) {
    return "cookie";
  }

  return null;
}
