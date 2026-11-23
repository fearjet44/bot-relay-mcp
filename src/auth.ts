import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import type { BotEntry } from "./config.ts";

const MAX_TOKEN_LENGTH = 512;

export function sha256(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
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
