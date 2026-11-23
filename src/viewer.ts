import type { AuditEntry, ViewerMessage } from "./store.ts";

const BODY_PREVIEW_CHARS = 2000;

export function escapeHtml(value: string | null | undefined): string {
  return (value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function preview(body: string): string {
  return body.length > BODY_PREVIEW_CHARS ? `${body.slice(0, BODY_PREVIEW_CHARS)}… [truncated]` : body;
}

export function renderLogPage(opts: {
  hostname: string | undefined;
  messages: ViewerMessage[];
  audit: AuditEntry[];
  generatedAt: string;
}): string {
  const messageRows = opts.messages
    .map(
      (m) => `<tr>
  <td><code>${escapeHtml(m.created_at)}</code></td>
  <td>${escapeHtml(m.from)} → ${escapeHtml(m.to)}</td>
  <td><code>${escapeHtml(m.thread_id)}</code><br><code>${escapeHtml(m.message_id)}</code></td>
  <td>${m.subject ? `<strong>${escapeHtml(m.subject)}</strong><br>` : ""}<pre>${escapeHtml(preview(m.body))}</pre></td>
  <td>${m.acked_at ? "acked" : m.read_at ? "read" : "unread"}</td>
</tr>`,
    )
    .join("\n");
  const auditRows = opts.audit
    .map(
      (a) => `<tr>
  <td>${a.id}</td>
  <td><code>${escapeHtml(a.ts)}</code></td>
  <td>${escapeHtml(a.bot_id ?? "—")}</td>
  <td>${escapeHtml(a.tool)}</td>
  <td class="${a.status === "ok" ? "ok" : "bad"}">${escapeHtml(a.status)}${a.detail ? ` (${escapeHtml(a.detail)})` : ""}</td>
  <td><code>${escapeHtml(a.message_ids.join(", "))}</code></td>
</tr>`,
    )
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="robots" content="noindex">
<title>bot-relay log${opts.hostname ? ` — ${escapeHtml(opts.hostname)}` : ""}</title>
<style>
body { font: 14px/1.4 system-ui, sans-serif; margin: 1.5rem; color: #222; }
table { border-collapse: collapse; width: 100%; margin-bottom: 2rem; }
th, td { border: 1px solid #ddd; padding: 4px 6px; vertical-align: top; text-align: left; }
th { background: #f4f4f4; }
pre { white-space: pre-wrap; word-break: break-word; margin: 0; font: inherit; }
code { font-size: 12px; }
.ok { color: #176f2c; } .bad { color: #a11; }
</style>
</head>
<body>
<h1>bot-relay log</h1>
<p>Read-only view. Generated <code>${escapeHtml(opts.generatedAt)}</code>.</p>
<h2>Recent messages (${opts.messages.length})</h2>
<table>
<thead><tr><th>Created</th><th>From → To</th><th>Thread / Message</th><th>Content</th><th>State</th></tr></thead>
<tbody>
${messageRows || '<tr><td colspan="5">No messages.</td></tr>'}
</tbody>
</table>
<h2>Audit log (${opts.audit.length} most recent)</h2>
<table>
<thead><tr><th>#</th><th>Time</th><th>Bot</th><th>Tool</th><th>Status</th><th>Message ids</th></tr></thead>
<tbody>
${auditRows || '<tr><td colspan="6">No entries.</td></tr>'}
</tbody>
</table>
</body>
</html>
`;
}
