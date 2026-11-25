import { isIP } from "node:net";

export type WebhookHttpPolicy = "private" | "always" | "never";

export interface WebhookPolicy {
  allowHttp: WebhookHttpPolicy;
  allowLoopback: boolean;
}

export const DEFAULT_WEBHOOK_POLICY: WebhookPolicy = {
  allowHttp: "private",
  allowLoopback: false,
};

export class WebhookUrlError extends Error {}

const BLOCKED_METADATA_HOSTS = new Set(["metadata.google.internal", "metadata.goog", "instance-data"]);
const PRIVATE_HOST_SUFFIXES = [".ts.net", ".local", ".lan", ".home.arpa", ".internal", ".localdomain"];
const PRIVATE_EXACT_HOSTS = new Set(["host.docker.internal", "host.containers.internal"]);
const SINGLE_LABEL_HOST = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function parseIPv4Octets(ip: string): [number, number, number, number] | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const nums = parts.map((p) => Number(p));
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return nums as [number, number, number, number];
}

function extractMappedIPv4(ipv6: string): [number, number, number, number] | null {
  const lower = ipv6.toLowerCase();
  const dotted = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted?.[1]) return parseIPv4Octets(dotted[1]);
  const hex = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex?.[1] && hex[2]) {
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    return [(hi >> 8) & 0xff, hi & 0xff, (lo >> 8) & 0xff, lo & 0xff];
  }
  return null;
}

function classifyIPv4(o: [number, number, number, number]): "blocked" | "loopback" | "private" | "public" {
  const [a, b] = o;
  if (a === 0) return "blocked"; // 0.0.0.0/8 unspecified
  if (a === 169 && b === 254) return "blocked"; // link-local & cloud metadata
  if (a === 127) return "loopback";
  if (a === 10) return "private"; // RFC 1918
  if (a === 172 && b >= 16 && b <= 31) return "private"; // RFC 1918
  if (a === 192 && b === 168) return "private"; // RFC 1918
  if (a === 100 && b >= 64 && b <= 127) return "private"; // CGNAT / Tailscale
  return "public";
}

function classifyIPv6(ip: string): "blocked" | "loopback" | "private" | "public" {
  const lower = ip.toLowerCase();
  const mapped = extractMappedIPv4(lower);
  if (mapped) return classifyIPv4(mapped);
  if (lower === "::" || lower === "0:0:0:0:0:0:0:0") return "blocked";
  if (lower === "::1" || lower === "0:0:0:0:0:0:0:1") return "loopback";
  if (lower === "fd00:ec2::254") return "blocked"; // AWS IPv6 IMDS
  // fe80::/10 link-local
  if (/^fe[89ab][0-9a-f]:/.test(lower)) return "blocked";
  // fc00::/7 Unique Local Address (LAN / Tailscale IPv6)
  if (/^f[cd][0-9a-f]{2}:/.test(lower)) return "private";
  return "public";
}

function classifyHost(rawHostname: string): "blocked" | "loopback" | "private" | "public" {
  const stripped = rawHostname.startsWith("[") && rawHostname.endsWith("]") ? rawHostname.slice(1, -1) : rawHostname;
  const host = stripped.toLowerCase().replace(/\.$/, "");
  if (!host) return "blocked";
  if (BLOCKED_METADATA_HOSTS.has(host)) return "blocked";
  if (host === "localhost" || host.endsWith(".localhost")) return "loopback";

  const ipVersion = isIP(host);
  if (ipVersion === 4) {
    const octets = parseIPv4Octets(host);
    return octets ? classifyIPv4(octets) : "blocked";
  }
  if (ipVersion === 6) {
    return classifyIPv6(host);
  }

  if (PRIVATE_EXACT_HOSTS.has(host)) return "private";
  if (PRIVATE_HOST_SUFFIXES.some((s) => host.endsWith(s))) return "private";
  // Single-label container/LAN hostname (e.g. `my-bot` on a compose network)
  if (!host.includes(".") && SINGLE_LABEL_HOST.test(host)) return "private";

  return "public";
}

/**
 * Validates and normalizes an outbound webhook URL.
 * Blocks cloud metadata endpoints always, blocks loopback unless allowed, and
 * enforces the configured HTTP vs HTTPS policy.
 */
export function validateWebhookUrl(rawUrl: string, policy: WebhookPolicy = DEFAULT_WEBHOOK_POLICY): string {
  const trimmed = rawUrl.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new WebhookUrlError("must be a valid http:// or https:// URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new WebhookUrlError("must use http:// or https://");
  }
  if (url.username || url.password) {
    throw new WebhookUrlError("must not contain embedded credentials");
  }

  const hostClass = classifyHost(url.hostname);
  if (hostClass === "blocked") {
    throw new WebhookUrlError("target host is not allowed");
  }
  if (hostClass === "loopback" && !policy.allowLoopback) {
    throw new WebhookUrlError("loopback webhook targets are disabled");
  }

  if (url.protocol === "http:") {
    if (policy.allowHttp === "never") {
      throw new WebhookUrlError("must be an https:// URL");
    }
    if (policy.allowHttp === "private" && hostClass === "public") {
      throw new WebhookUrlError("public webhooks must use https:// (http:// is allowed for LAN/Tailnet hosts)");
    }
  }

  return url.href;
}

export const WEBHOOK_SECRET_PATTERN = /^[\x21-\x7e]{1,512}$/;

export function validateWebhookSecret(secret: string): string {
  const trimmed = secret.trim();
  if (!WEBHOOK_SECRET_PATTERN.test(trimmed)) {
    throw new WebhookUrlError("webhook secret must be 1-512 printable ASCII characters without spaces");
  }
  return trimmed;
}
