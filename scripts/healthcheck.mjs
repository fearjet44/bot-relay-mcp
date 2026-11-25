#!/usr/bin/env node
// Container healthcheck: exits 0 when GET /healthz returns 2xx on PORT (and ADMIN_PORT if set).
const ports = [process.env.PORT || "8080"];
if (process.env.ADMIN_PORT) ports.push(process.env.ADMIN_PORT);

try {
  for (const port of ports) {
    const res = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) process.exit(1);
  }
  process.exit(0);
} catch {
  process.exit(1);
}
