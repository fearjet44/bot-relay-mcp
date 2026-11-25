import { escapeHtml } from "../viewer.ts";

export const ADMIN_CSS = `:root {
  --bg: #f6f7f9;
  --card: #ffffff;
  --text: #16181d;
  --muted: #5d6472;
  --border: #dfe3ea;
  --accent: #2563eb;
  --accent-hover: #1d4ed8;
  --ok-bg: #e7f6ec;
  --ok-fg: #146c2e;
  --bad-bg: #fdecec;
  --bad-fg: #b42318;
  --warn-bg: #fef4e6;
  --warn-fg: #9a5504;
  --code-bg: #f0f2f6;
  --shadow: 0 1px 2px rgba(0, 0, 0, 0.05);
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0f1115;
    --card: #171a21;
    --text: #eceef2;
    --muted: #9aa3b2;
    --border: #2a303c;
    --accent: #3b82f6;
    --accent-hover: #60a5fa;
    --ok-bg: #102b19;
    --ok-fg: #4ade80;
    --bad-bg: #321315;
    --bad-fg: #f87171;
    --warn-bg: #31230c;
    --warn-fg: #fbbf24;
    --code-bg: #1f2430;
    --shadow: 0 1px 3px rgba(0, 0, 0, 0.4);
  }
}
* { box-sizing: border-box; }
body {
  margin: 0;
  font: 14px/1.45 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  background: var(--bg);
  color: var(--text);
}
.container { max-width: 1120px; margin: 0 auto; padding: 1.25rem; }
header.topbar {
  display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between;
  gap: 0.75rem; margin-bottom: 1.25rem;
}
.brand { display: flex; align-items: center; gap: 0.65rem; }
.brand h1 { margin: 0; font-size: 1.35rem; letter-spacing: -0.02em; }
.version { font-size: 12px; color: var(--muted); background: var(--code-bg); padding: 2px 7px; border-radius: 999px; }
.actions { display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap; }
.card {
  background: var(--card); border: 1px solid var(--border); border-radius: 10px;
  padding: 1rem 1.15rem; margin-bottom: 1rem; box-shadow: var(--shadow);
}
.endpoints {
  display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 0.75rem;
}
.endpoint-item { display: flex; flex-direction: column; gap: 0.25rem; }
.endpoint-label { font-size: 12px; color: var(--muted); font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; }
.endpoint-row { display: flex; gap: 0.4rem; align-items: center; }
.endpoint-row code {
  flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  background: var(--code-bg); padding: 5px 8px; border-radius: 6px; font-size: 12.5px;
}
nav.tabs {
  display: flex; gap: 0.35rem; border-bottom: 1px solid var(--border); margin-bottom: 1rem; overflow-x: auto;
}
nav.tabs button {
  background: transparent; border: none; border-bottom: 2px solid transparent; color: var(--muted);
  padding: 0.6rem 0.9rem; font-weight: 600; cursor: pointer; white-space: nowrap; border-radius: 0;
}
nav.tabs button.active { color: var(--accent); border-bottom-color: var(--accent); }
.panel { display: none; }
.panel.active { display: block; }
button, .btn {
  font: inherit; font-weight: 500; padding: 0.42rem 0.75rem; border-radius: 7px;
  border: 1px solid var(--border); background: var(--card); color: var(--text); cursor: pointer;
}
button:hover { border-color: var(--accent); }
button.primary { background: var(--accent); color: #fff; border-color: var(--accent); }
button.primary:hover { background: var(--accent-hover); }
button.danger { color: var(--bad-fg); border-color: var(--border); }
button.danger:hover { border-color: var(--bad-fg); background: var(--bad-bg); }
button.small { padding: 0.25rem 0.55rem; font-size: 12.5px; }
input, select {
  font: inherit; padding: 0.45rem 0.65rem; border-radius: 7px;
  border: 1px solid var(--border); background: var(--bg); color: var(--text);
}
.form-grid {
  display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 0.65rem; align-items: end;
}
.field { display: flex; flex-direction: column; gap: 0.25rem; }
.field label { font-size: 12px; color: var(--muted); font-weight: 600; }
.table-wrap { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; font-size: 13.5px; }
th, td { text-align: left; padding: 0.55rem 0.6rem; border-bottom: 1px solid var(--border); vertical-align: top; }
th { font-size: 12px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.03em; }
.pill {
  display: inline-block; font-size: 11.5px; font-weight: 600; padding: 2px 8px;
  border-radius: 999px; background: var(--code-bg); color: var(--muted);
}
.pill.ok { background: var(--ok-bg); color: var(--ok-fg); }
.pill.bad { background: var(--bad-bg); color: var(--bad-fg); }
.pill.warn { background: var(--warn-bg); color: var(--warn-fg); }
.muted { color: var(--muted); font-size: 12.5px; }
pre.codebox {
  background: var(--code-bg); padding: 0.75rem; border-radius: 8px;
  overflow-x: auto; white-space: pre-wrap; word-break: break-all; font-size: 12.5px; margin: 0.4rem 0 0.75rem;
}
.msg-body { white-space: pre-wrap; word-break: break-word; margin: 0; font-family: inherit; max-width: 520px; }
.row-actions { display: flex; gap: 0.35rem; flex-wrap: wrap; }
.section-head { display: flex; justify-content: space-between; align-items: center; gap: 0.75rem; margin-bottom: 0.75rem; flex-wrap: wrap; }
.section-head h2 { margin: 0; font-size: 1.05rem; }
.modal-backdrop {
  position: fixed; inset: 0; background: rgba(0, 0, 0, 0.55); display: none;
  align-items: center; justify-content: center; padding: 1rem; z-index: 50;
}
.modal-backdrop.open { display: flex; }
.modal {
  background: var(--card); border: 1px solid var(--border); border-radius: 12px;
  max-width: 640px; width: 100%; max-height: 90vh; overflow-y: auto; padding: 1.25rem;
}
.modal h3 { margin: 0 0 0.5rem; }
.toast {
  position: fixed; bottom: 1rem; right: 1rem; background: var(--text); color: var(--bg);
  padding: 0.6rem 0.9rem; border-radius: 8px; font-size: 13px; display: none; z-index: 100;
}
.toast.show { display: block; }
.login-box { max-width: 380px; margin: 12vh auto; }
.err { color: var(--bad-fg); font-size: 13px; margin: 0.5rem 0; }
`;

export const ADMIN_JS = `(() => {
  const $ = (id) => document.getElementById(id);
  let state = null;
  let activeTab = "bots";

  function toast(msg) {
    const el = $("toast");
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.remove("show"), 2600);
  }

  async function copyText(text, label) {
    try {
      await navigator.clipboard.writeText(text);
      toast((label || "Copied") + " copied");
    } catch {
      toast("Copy failed — select and copy manually");
    }
  }

  async function api(path, opts = {}) {
    const headers = Object.assign({ "X-Requested-With": "bot-relay-ui" }, opts.headers || {});
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";
    const res = await fetch(path, Object.assign({}, opts, { headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined }));
    if (res.status === 401) {
      window.location.href = "/login";
      throw new Error("Unauthorized");
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.message || data.error || "Request failed (" + res.status + ")");
    return data;
  }

  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (k === "class") node.className = v;
        else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
        else if (v !== null && v !== undefined) node.setAttribute(k, String(v));
      }
    }
    for (const c of children) {
      if (c === null || c === undefined) continue;
      node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    }
    return node;
  }

  function fmtTime(iso) {
    if (!iso) return "—";
    try {
      return new Date(iso).toLocaleString();
    } catch {
      return iso;
    }
  }

  function openModal(title, contentNodes) {
    $("modal-title").textContent = title;
    const body = $("modal-body");
    body.replaceChildren(...contentNodes);
    $("modal-backdrop").classList.add("open");
  }

  function closeModal() {
    $("modal-backdrop").classList.remove("open");
  }

  $("modal-close").addEventListener("click", closeModal);
  $("modal-backdrop").addEventListener("click", (e) => {
    if (e.target === $("modal-backdrop")) closeModal();
  });

  function showSecretModal(title, intro, blocks) {
    const nodes = [el("p", { class: "muted" }, intro)];
    for (const b of blocks) {
      nodes.push(
        el(
          "div",
          { class: "section-head" },
          el("strong", null, b.label),
          el("button", { class: "small", type: "button", onclick: () => copyText(b.value, b.label) }, "Copy"),
        ),
        el("pre", { class: "codebox" }, b.value),
      );
    }
    openModal(title, nodes);
  }

  function openWebhookModal(bot) {
    const urlInput = el("input", { type: "url", placeholder: "http://my-bot.tailnet.ts.net:9090/hook", value: bot.webhook.url || "", style: "width:100%" });
    const secretInput = el("input", { type: "text", placeholder: bot.webhook.has_secret ? "Leave blank to keep existing secret" : "Optional shared secret", style: "width:100%" });
    const enabledCheck = el("input", { type: "checkbox" });
    enabledCheck.checked = bot.webhook.url ? bot.webhook.enabled : true;
    const clearSecretCheck = el("input", { type: "checkbox" });
    const errEl = el("div", { class: "err" });

    const form = el(
      "form",
      {
        onsubmit: async (e) => {
          e.preventDefault();
          errEl.textContent = "";
          const rawUrl = urlInput.value.trim();
          const body = { url: rawUrl || null, enabled: enabledCheck.checked };
          if (clearSecretCheck.checked) body.secret = null;
          else if (secretInput.value.trim()) body.secret = secretInput.value.trim();
          try {
            await api("/api/admin/bots/" + encodeURIComponent(bot.id) + "/webhook", { method: "PUT", body });
            closeModal();
            toast("Webhook updated for " + bot.id);
            await refresh();
          } catch (err) {
            errEl.textContent = err.message;
          }
        },
      },
      el("div", { class: "field", style: "margin-bottom:0.75rem" }, el("label", null, "Webhook URL (leave empty to remove)"), urlInput),
      el("div", { class: "field", style: "margin-bottom:0.75rem" }, el("label", null, "Webhook Secret (HMAC-SHA256 + Bearer)"), secretInput),
      el("label", { style: "display:flex;gap:0.4rem;align-items:center;margin-bottom:0.5rem" }, enabledCheck, "Enabled"),
      bot.webhook.has_secret
        ? el("label", { style: "display:flex;gap:0.4rem;align-items:center;margin-bottom:0.75rem" }, clearSecretCheck, "Clear existing secret")
        : null,
      errEl,
      el("div", { class: "row-actions" }, el("button", { class: "primary", type: "submit" }, "Save Webhook")),
    );
    openModal("Webhook for " + bot.id, [form]);
  }

  function openAddBotModal() {
    const idInput = el("input", { type: "text", required: "true", placeholder: "e.g. mac-mini-bot", pattern: "[a-z0-9][a-z0-9-]{0,62}", style: "width:100%" });
    const nameInput = el("input", { type: "text", placeholder: "Optional friendly name", style: "width:100%" });
    const urlInput = el("input", { type: "url", placeholder: "Optional webhook URL (http:// LAN/Tailnet or https://)", style: "width:100%" });
    const errEl = el("div", { class: "err" });
    const form = el(
      "form",
      {
        onsubmit: async (e) => {
          e.preventDefault();
          errEl.textContent = "";
          try {
            const res = await api("/api/admin/bots", {
              method: "POST",
              body: {
                id: idInput.value.trim(),
                display_name: nameInput.value.trim() || undefined,
                webhook_url: urlInput.value.trim() || undefined,
              },
            });
            const blocks = [
              { label: "Bearer Token (shown once)", value: res.token },
              {
                label: "MCP Connector JSON",
                value: JSON.stringify({ url: state.server.mcp_url, headers: { Authorization: "Bearer " + res.token } }, null, 2),
              },
            ];
            if (res.webhook && res.webhook.secret) {
              blocks.push({ label: "Webhook Secret", value: res.webhook.secret });
            }
            showSecretModal("Bot created: " + res.bot_id, "Copy this bearer token now. It is stored only as a SHA-256 hash and cannot be shown again.", blocks);
            await refresh();
          } catch (err) {
            errEl.textContent = err.message;
          }
        },
      },
      el("div", { class: "field", style: "margin-bottom:0.75rem" }, el("label", null, "Bot ID (lowercase, digits, dashes)"), idInput),
      el("div", { class: "field", style: "margin-bottom:0.75rem" }, el("label", null, "Display Name (optional)"), nameInput),
      el("div", { class: "field", style: "margin-bottom:0.75rem" }, el("label", null, "Webhook URL (optional)"), urlInput),
      errEl,
      el("div", { class: "row-actions" }, el("button", { class: "primary", type: "submit" }, "Create Bot")),
    );
    openModal("Add Bot Manually", [form]);
  }

  function renderEndpoints(srv) {
    $("version-badge").textContent = "v" + srv.version;
    $("logout-btn").style.display = srv.auth_method === "gateway" ? "none" : "";
    const wrap = $("endpoints");
    const items = [
      ["MCP Endpoint", srv.mcp_url],
      ["SSE Push Stream", srv.events_url],
      ["Self-Register Endpoint", srv.register_url],
    ];
    wrap.replaceChildren(
      ...items.map(([label, url]) =>
        el(
          "div",
          { class: "endpoint-item" },
          el("span", { class: "endpoint-label" }, label),
          el(
            "div",
            { class: "endpoint-row" },
            el("code", { title: url }, url),
            el("button", { class: "small", type: "button", onclick: () => copyText(url, label) }, "Copy"),
          ),
        ),
      ),
    );
  }

  function renderBots() {
    const tbody = $("bots-body");
    if (!state.bots.length) {
      tbody.replaceChildren(el("tr", null, el("td", { colspan: "6", class: "muted" }, "No bots registered yet. Create an invite code or add a bot manually.")));
      return;
    }
    tbody.replaceChildren(
      ...state.bots.map((b) => {
        const sseCount = state.sse_connections[b.id] || 0;
        const statusPill = el("span", { class: "pill " + (b.status === "active" ? "ok" : "bad") }, b.status);
        const ssePill = sseCount > 0 ? el("span", { class: "pill ok" }, "SSE live (" + sseCount + ")") : el("span", { class: "muted" }, "—");
        const whParts = [];
        if (b.webhook.url) {
          whParts.push(el("div", null, el("code", null, b.webhook.url)));
          const meta = [b.webhook.enabled ? "enabled" : "paused", b.webhook.source];
          if (b.webhook.last_status) meta.push("last: " + b.webhook.last_status);
          whParts.push(el("div", { class: "muted" }, meta.join(" · ")));
        } else {
          whParts.push(el("span", { class: "muted" }, "None"));
        }

        const actions = [];
        if (b.status === "active") {
          actions.push(el("button", { class: "small", type: "button", onclick: () => openWebhookModal(b) }, "Webhook"));
          if (b.webhook.url && b.webhook.enabled) {
            actions.push(
              el("button", {
                class: "small",
                type: "button",
                onclick: async () => {
                  try {
                    const res = await api("/api/admin/bots/" + encodeURIComponent(b.id) + "/webhook/test", { method: "POST" });
                    toast((res.ok ? "Test OK: " : "Test failed: ") + res.detail + " (" + res.durationMs + "ms)");
                    await refresh();
                  } catch (err) {
                    toast(err.message);
                  }
                },
              }, "Test"),
            );
          }
        }
        if (b.source === "db") {
          if (b.status === "active") {
            actions.push(
              el("button", {
                class: "small",
                type: "button",
                onclick: async () => {
                  if (!confirm("Generate a new bearer token for " + b.id + " and revoke previous tokens?")) return;
                  try {
                    const res = await api("/api/admin/bots/" + encodeURIComponent(b.id) + "/rotate-token", { method: "POST", body: { revoke_others: true } });
                    showSecretModal("Rotated token: " + b.id, "Previous tokens were revoked. Update the bot with this new token:", [{ label: "New Bearer Token", value: res.token }]);
                    await refresh();
                  } catch (err) {
                    toast(err.message);
                  }
                },
              }, "Rotate"),
            );
            actions.push(
              el("button", {
                class: "small danger",
                type: "button",
                onclick: async () => {
                  if (!confirm("Revoke " + b.id + "? All its tokens and SSE streams will be terminated.")) return;
                  try {
                    await api("/api/admin/bots/" + encodeURIComponent(b.id) + "/revoke", { method: "POST" });
                    toast("Revoked " + b.id);
                    await refresh();
                  } catch (err) {
                    toast(err.message);
                  }
                },
              }, "Revoke"),
            );
          } else {
            actions.push(
              el("button", {
                class: "small primary",
                type: "button",
                onclick: async () => {
                  try {
                    const res = await api("/api/admin/bots/" + encodeURIComponent(b.id) + "/restore", { method: "POST" });
                    showSecretModal("Restored bot: " + b.id, "Bot is active again with a fresh bearer token:", [{ label: "New Bearer Token", value: res.token }]);
                    await refresh();
                  } catch (err) {
                    toast(err.message);
                  }
                },
              }, "Restore"),
            );
          }
        }

        return el(
          "tr",
          null,
          el(
            "td",
            null,
            el("strong", null, b.id),
            b.display_name ? el("div", { class: "muted" }, b.display_name) : null,
            el("div", { class: "muted" }, b.source + " · " + b.active_tokens + " token(s)"),
          ),
          el("td", null, statusPill, el("div", { class: "muted" }, "Seen: " + fmtTime(b.last_seen_at))),
          el("td", null, ssePill),
          el("td", null, ...whParts),
          el("td", null, String(b.unread_count)),
          el("td", null, el("div", { class: "row-actions" }, ...actions)),
        );
      }),
    );
  }

  function renderInvites() {
    const tbody = $("invites-body");
    if (!state.invites.length) {
      tbody.replaceChildren(el("tr", null, el("td", { colspan: "6", class: "muted" }, "No invite codes created yet.")));
      return;
    }
    tbody.replaceChildren(
      ...state.invites.map((inv) => {
        const cls = inv.status === "active" ? "ok" : inv.status === "exhausted" ? "warn" : "bad";
        return el(
          "tr",
          null,
          el("td", null, el("code", null, inv.code_prefix + "…"), inv.label ? el("div", { class: "muted" }, inv.label) : null),
          el("td", null, inv.bot_id ? el("code", null, inv.bot_id) : el("span", { class: "muted" }, "Any bot ID")),
          el("td", null, inv.uses + " / " + inv.max_uses),
          el("td", null, inv.expires_at ? fmtTime(inv.expires_at) : "Never"),
          el("td", null, el("span", { class: "pill " + cls }, inv.status)),
          el(
            "td",
            null,
            inv.status === "active"
              ? el("button", {
                  class: "small danger",
                  type: "button",
                  onclick: async () => {
                    try {
                      await api("/api/admin/invites/" + encodeURIComponent(inv.id), { method: "DELETE" });
                      toast("Invite revoked");
                      await refresh();
                    } catch (err) {
                      toast(err.message);
                    }
                  },
                }, "Revoke")
              : el("span", { class: "muted" }, "—"),
          ),
        );
      }),
    );
  }

  function renderMessages() {
    const tbody = $("messages-body");
    if (!state.messages.length) {
      tbody.replaceChildren(el("tr", null, el("td", { colspan: "5", class: "muted" }, "No messages yet.")));
      return;
    }
    tbody.replaceChildren(
      ...state.messages.map((m) =>
        el(
          "tr",
          null,
          el("td", null, el("code", null, fmtTime(m.created_at))),
          el("td", null, m.from + " → " + m.to),
          el("td", null, el("code", null, m.thread_id), el("div", { class: "muted" }, m.message_id)),
          el(
            "td",
            null,
            m.subject ? el("div", null, el("strong", null, m.subject)) : null,
            el("pre", { class: "msg-body" }, m.body.length > 1000 ? m.body.slice(0, 1000) + "… [truncated]" : m.body),
          ),
          el("td", null, el("span", { class: "pill " + (m.acked_at ? "ok" : m.read_at ? "warn" : "") }, m.acked_at ? "acked" : m.read_at ? "read" : "unread")),
        ),
      ),
    );
  }

  function renderAudit() {
    const tbody = $("audit-body");
    if (!state.audit.length) {
      tbody.replaceChildren(el("tr", null, el("td", { colspan: "6", class: "muted" }, "No audit entries yet.")));
      return;
    }
    tbody.replaceChildren(
      ...state.audit.map((a) => {
        const good = a.status === "ok" || a.status === "delivered";
        return el(
          "tr",
          null,
          el("td", null, String(a.id)),
          el("td", null, el("code", null, fmtTime(a.ts))),
          el("td", null, a.bot_id || "—"),
          el("td", null, a.tool),
          el("td", null, el("span", { class: "pill " + (good ? "ok" : "bad") }, a.status + (a.detail ? " (" + a.detail + ")" : ""))),
          el("td", null, el("code", null, a.message_ids.join(", "))),
        );
      }),
    );
  }

  async function refresh() {
    state = await api("/api/admin/overview");
    renderEndpoints(state.server);
    renderBots();
    renderInvites();
    renderMessages();
    renderAudit();
  }

  $("invite-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const botId = $("inv-bot").value.trim() || undefined;
    const label = $("inv-label").value.trim() || undefined;
    const maxUses = Number($("inv-uses").value) || 1;
    const ttlRaw = $("inv-ttl").value;
    const expiresInSeconds = ttlRaw === "never" ? null : Number(ttlRaw);
    try {
      const res = await api("/api/admin/invites", {
        method: "POST",
        body: { bot_id: botId, label, max_uses: maxUses, expires_in_seconds: expiresInSeconds },
      });
      $("invite-form").reset();
      showSecretModal(
        "Approval Code Created",
        "Give this code to the bot to self-register. Shown once (stored only as a SHA-256 hash).",
        [
          { label: "Approval Code", value: res.code },
          { label: "curl Command", value: res.curl_example },
          { label: "Bot Setup Prompt", value: res.bot_prompt },
        ],
      );
      await refresh();
    } catch (err) {
      toast(err.message);
    }
  });

  $("add-bot-btn").addEventListener("click", openAddBotModal);
  $("refresh-btn").addEventListener("click", () => refresh().then(() => toast("Refreshed")).catch((e) => toast(e.message)));
  $("logout-btn").addEventListener("click", async () => {
    await fetch("/logout", { method: "POST", headers: { "X-Requested-With": "bot-relay-ui" } });
    window.location.href = "/login";
  });

  document.querySelectorAll("nav.tabs button").forEach((btn) => {
    btn.addEventListener("click", () => {
      activeTab = btn.dataset.tab;
      document.querySelectorAll("nav.tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === activeTab));
      document.querySelectorAll(".panel").forEach((p) => p.classList.toggle("active", p.id === "panel-" + activeTab));
    });
  });

  refresh().catch((err) => toast(err.message));
})();
`;

export function renderAdminPage(titleSuffix?: string): string {
  const title = titleSuffix ? `Bot Relay — ${escapeHtml(titleSuffix)}` : "Bot Relay";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${title}</title>
<link rel="stylesheet" href="/assets/admin.css">
</head>
<body>
<div class="container">
  <header class="topbar">
    <div class="brand">
      <h1>Bot Relay</h1>
      <span id="version-badge" class="version">v2</span>
    </div>
    <div class="actions">
      <button id="add-bot-btn" class="primary" type="button">+ Add Bot</button>
      <button id="refresh-btn" type="button">Refresh</button>
      <button id="logout-btn" type="button">Sign Out</button>
    </div>
  </header>

  <section class="card">
    <div id="endpoints" class="endpoints"></div>
  </section>

  <nav class="tabs" role="tablist">
    <button type="button" class="active" data-tab="bots">Bots</button>
    <button type="button" data-tab="invites">Invite Codes</button>
    <button type="button" data-tab="messages">Messages</button>
    <button type="button" data-tab="audit">Audit Log</button>
  </nav>

  <section id="panel-bots" class="panel active card">
    <div class="section-head">
      <h2>Registered Bots</h2>
    </div>
    <div class="table-wrap">
      <table>
        <thead>
          <tr><th>Bot</th><th>Status</th><th>SSE Push</th><th>Webhook</th><th>Unread</th><th>Actions</th></tr>
        </thead>
        <tbody id="bots-body"><tr><td colspan="6" class="muted">Loading…</td></tr></tbody>
      </table>
    </div>
  </section>

  <section id="panel-invites" class="panel">
    <div class="card">
      <div class="section-head"><h2>Generate Approval Code</h2></div>
      <form id="invite-form" class="form-grid">
        <div class="field">
          <label for="inv-bot">Lock to Bot ID (optional)</label>
          <input id="inv-bot" type="text" placeholder="any bot id" pattern="[a-z0-9][a-z0-9-]{0,62}">
        </div>
        <div class="field">
          <label for="inv-label">Label (optional)</label>
          <input id="inv-label" type="text" placeholder="e.g. Home Mac Mini">
        </div>
        <div class="field">
          <label for="inv-uses">Max Uses</label>
          <input id="inv-uses" type="number" min="1" max="100" value="1">
        </div>
        <div class="field">
          <label for="inv-ttl">Expires In</label>
          <select id="inv-ttl">
            <option value="900">15 minutes</option>
            <option value="3600" selected>1 hour</option>
            <option value="86400">24 hours</option>
            <option value="604800">7 days</option>
            <option value="never">Never</option>
          </select>
        </div>
        <div class="field">
          <button type="submit" class="primary">Create Code</button>
        </div>
      </form>
    </div>
    <div class="card">
      <div class="section-head"><h2>Invite Codes</h2></div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr><th>Code Prefix</th><th>Locked Bot</th><th>Uses</th><th>Expires</th><th>Status</th><th>Actions</th></tr>
          </thead>
          <tbody id="invites-body"><tr><td colspan="6" class="muted">Loading…</td></tr></tbody>
        </table>
      </div>
    </div>
  </section>

  <section id="panel-messages" class="panel card">
    <div class="section-head"><h2>Recent Messages</h2></div>
    <div class="table-wrap">
      <table>
        <thead>
          <tr><th>Created</th><th>From → To</th><th>Thread / ID</th><th>Content</th><th>State</th></tr>
        </thead>
        <tbody id="messages-body"><tr><td colspan="5" class="muted">Loading…</td></tr></tbody>
      </table>
    </div>
  </section>

  <section id="panel-audit" class="panel card">
    <div class="section-head"><h2>Audit Log (Append-Only)</h2></div>
    <div class="table-wrap">
      <table>
        <thead>
          <tr><th>#</th><th>Time</th><th>Bot</th><th>Tool / Event</th><th>Status</th><th>Message IDs</th></tr>
        </thead>
        <tbody id="audit-body"><tr><td colspan="6" class="muted">Loading…</td></tr></tbody>
      </table>
    </div>
  </section>
</div>

<div id="modal-backdrop" class="modal-backdrop" role="dialog" aria-modal="true">
  <div class="modal">
    <div class="section-head">
      <h3 id="modal-title"></h3>
      <button id="modal-close" class="small" type="button">Close</button>
    </div>
    <div id="modal-body"></div>
  </div>
</div>
<div id="toast" class="toast" role="status"></div>
<script src="/assets/admin.js"></script>
</body>
</html>`;
}

export function renderLoginPage(error?: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Sign in — Bot Relay</title>
<link rel="stylesheet" href="/assets/admin.css">
</head>
<body>
<div class="container">
  <div class="card login-box">
    <h1 style="margin-top:0;font-size:1.3rem">Bot Relay Admin</h1>
    <p class="muted">Enter your admin password or token to manage bots, invite codes, and webhooks.</p>
    ${error ? `<div class="err">${escapeHtml(error)}</div>` : ""}
    <form method="POST" action="/login">
      <div class="field" style="margin-bottom:0.85rem">
        <label for="password">Admin Password / Token</label>
        <input id="password" name="password" type="password" required autofocus autocomplete="current-password" style="width:100%">
      </div>
      <button type="submit" class="primary" style="width:100%">Sign In</button>
    </form>
  </div>
</div>
</body>
</html>`;
}
