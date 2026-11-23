#!/usr/bin/env node
// Container healthcheck: exits 0 when GET /healthz on the local listener returns 2xx.
const port = process.env.PORT || "8080";
try {
  const res = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(4000) });
  process.exit(res.ok ? 0 : 1);
} catch {
  process.exit(1);
}
