import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import express from "express";
import { mountAppCore, inkressApi, orderStatusName } from "@inkress/apps-core";
import { openPg } from "@inkress/apps-core/pgdb";
import { openMerchantTokens } from "@inkress/apps-core/merchant-tokens";
import { sendEmail, sesConfigured } from "@inkress/apps-core/ses";
import { sendSms, snsConfigured, toE164 } from "@inkress/apps-core/sns";
import * as wa from "./whatsapp.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? "0.0.0.0";
for (const k of ["OAUTH_CLIENT_ID", "OAUTH_CLIENT_SECRET", "INKRESS_API_BASE"]) {
  if (!process.env[k]) { console.error(`[order-updates] Missing env: ${k}`); process.exit(1); }
}

const db = await openPg("order_updates", `
  CREATE TABLE IF NOT EXISTS settings (
    merchant_id BIGINT PRIMARY KEY, data JSONB NOT NULL DEFAULT '{}', updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS sends (
    id BIGSERIAL PRIMARY KEY, merchant_id BIGINT NOT NULL, order_ref TEXT, event TEXT,
    channel TEXT NOT NULL DEFAULT 'email', to_addr TEXT, status TEXT NOT NULL DEFAULT 'sent',
    message_id TEXT, error TEXT, sent_by_name TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  ALTER TABLE sends ADD COLUMN IF NOT EXISTS channel TEXT NOT NULL DEFAULT 'email';
  ALTER TABLE sends ADD COLUMN IF NOT EXISTS to_addr TEXT;
  ALTER TABLE sends ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'sent';
  ALTER TABLE sends ADD COLUMN IF NOT EXISTS error TEXT;
  CREATE INDEX IF NOT EXISTS idx_ou_sends ON sends (merchant_id, created_at DESC);

  CREATE TABLE IF NOT EXISTS queue (
    id BIGSERIAL PRIMARY KEY, merchant_id BIGINT NOT NULL, order_ref TEXT, event TEXT,
    channel TEXT NOT NULL, to_addr TEXT NOT NULL, subject TEXT, body TEXT, html TEXT,
    send_after TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS idx_ou_queue ON queue (send_after);

  CREATE TABLE IF NOT EXISTS webhook_subs (
    merchant_id BIGINT PRIMARY KEY, url TEXT NOT NULL, registered_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS webhook_seen (
    webhook_id TEXT PRIMARY KEY, seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS wa_sessions (
    merchant_id BIGINT PRIMARY KEY, phone TEXT, paired_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
`);

const app = express();
app.use("/webhooks/inkress", express.raw({ type: () => true, limit: "1mb" }));

let tokens;
const core = mountAppCore(app, {
  clientId: process.env.OAUTH_CLIENT_ID, clientSecret: process.env.OAUTH_CLIENT_SECRET,
  apiBaseUrl: process.env.INKRESS_API_BASE, frameAncestors: process.env.FRAME_ANCESTORS,
  staticDir: path.join(__dirname, "dist"),
  onBootstrap: (entry) => {
    if (tokens && entry?.merchantId && entry.refreshToken) tokens.save(entry.merchantId, entry.refreshToken).catch(() => {});
    // Cache merchant branding so webhook-time sends can brand without a session.
    const m = entry?.data?.merchant;
    if (entry?.merchantId && m) {
      const snap = { name: m.name || m.username || null, logo: m.logo || null, currency: m.currency_code || "JMD" };
      db.run(`INSERT INTO settings (merchant_id, data, updated_at) VALUES ($1, jsonb_build_object('merchant', $2::jsonb), now())
              ON CONFLICT (merchant_id) DO UPDATE SET data = settings.data || jsonb_build_object('merchant', $2::jsonb), updated_at=now()`,
        [entry.merchantId, JSON.stringify(snap)]).catch(() => {});
    }
  },
});
tokens = await openMerchantTokens("order_updates", core.cfg);

const WEBHOOK_SECRET = process.env.INKRESS_WEBHOOK_SECRET || "";
export const EVENTS = ["paid", "confirmed", "prepared", "shipped", "delivered", "completed", "refunded", "cancelled"];
const CHANNELS = ["email", "sms", "whatsapp"];
const ACCENT_DEFAULT = "#3b5bff";

const DEFAULTS = {
  paid: { enabled: true, channels: ["email"], subject: "We got your payment — {{shop}}", body: "Thanks {{name}}! Your order {{ref}} for {{total}} is confirmed. We'll keep you posted." },
  confirmed: { enabled: false, channels: ["email"], subject: "Order confirmed — {{shop}}", body: "Hi {{name}}, your order {{ref}} is confirmed." },
  prepared: { enabled: false, channels: ["email"], subject: "Your order is ready — {{shop}}", body: "Hi {{name}}, order {{ref}} is prepared and ready." },
  shipped: { enabled: true, channels: ["email"], subject: "Your order is on the way — {{shop}}", body: "Good news {{name}} — order {{ref}} has shipped." },
  delivered: { enabled: false, channels: ["email"], subject: "Delivered — {{shop}}", body: "Hi {{name}}, order {{ref}} has been delivered. Enjoy!" },
  completed: { enabled: false, channels: ["email"], subject: "All done — {{shop}}", body: "Hi {{name}}, order {{ref}} is complete. Thank you!" },
  refunded: { enabled: false, channels: ["email"], subject: "Your refund is processed — {{shop}}", body: "Hi {{name}}, we've refunded order {{ref}} ({{total}})." },
  cancelled: { enabled: false, channels: ["email"], subject: "Order cancelled — {{shop}}", body: "Hi {{name}}, order {{ref}} has been cancelled." },
};
const QUIET_DEFAULT = { enabled: false, start: 21, end: 8, tz_offset: -5 };

async function getData(mid) { const r = await db.one(`SELECT data FROM settings WHERE merchant_id=$1`, [mid]); return r?.data || {}; }
function mergeTemplates(saved) {
  const out = {};
  for (const e of EVENTS) out[e] = { ...DEFAULTS[e], ...(saved?.[e] || {}), channels: (saved?.[e]?.channels || DEFAULTS[e].channels).filter((c) => CHANNELS.includes(c)) };
  return out;
}
async function getConfig(mid) {
  const d = await getData(mid);
  return { templates: mergeTemplates(d.templates), quiet: { ...QUIET_DEFAULT, ...(d.quiet || {}) }, sender: { from_name: null, accent: ACCENT_DEFAULT, ...(d.sender || {}) }, merchant: d.merchant || null };
}

const curOf = (o) => o.currency?.code || o.currency_code || o.currency || "JMD";
function fmtMoney(n, c) { try { return new Intl.NumberFormat("en-JM", { style: "currency", currency: c }).format(n || 0); } catch { return `${c} ${n}`; } }

// ---- merge-field rendering -------------------------------------------------
function renderFields(str, ctx) {
  return String(str || "")
    .replace(/\{\{shop\}\}/g, ctx.shop || "")
    .replace(/\{\{name\}\}/g, ctx.name || "there")
    .replace(/\{\{customer\}\}/g, ctx.name || "there")
    .replace(/\{\{ref\}\}/g, ctx.ref || "")
    .replace(/\{\{total\}\}/g, ctx.total || "")
    .replace(/\{\{status\}\}/g, ctx.status || "")
    .replace(/\{\{items\}\}/g, ctx.items || "")
    .replace(/\{\{pay_link\}\}/g, ctx.pay_link || "");
}
function ctxFromOrder(o, cfg) {
  const shop = cfg.sender?.from_name || cfg.merchant?.name || "your shop";
  const currency = curOf(o) || cfg.merchant?.currency || "JMD";
  const name = o.customer?.name || [o.customer?.first_name, o.customer?.last_name].filter(Boolean).join(" ") || "there";
  const items = (o.lines || o.order_lines || []).map((l) => `${l.quantity || l.qty || 1}× ${l.product_name || l.title || l.product_variant_name_frozen || "item"}`).join(", ");
  return { shop, name, ref: o.reference || o.reference_id || String(o.id), total: fmtMoney(Number(o.total || 0), currency), status: o.status || "", items, pay_link: o.payment_url || o.payment_link?.url || "" };
}

// ---- channel send ----------------------------------------------------------
function emailHtml(cfg, ctx, bodyText) {
  const accent = cfg.sender?.accent || ACCENT_DEFAULT;
  const logo = cfg.merchant?.logo;
  const shop = ctx.shop;
  return `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:520px;margin:0 auto;background:#fff;border:1px solid #eee;border-radius:14px;overflow:hidden;">
    <div style="height:6px;background:${esc(accent)};"></div>
    <div style="padding:26px 28px;">
      ${logo ? `<img src="${esc(logo)}" alt="${esc(shop)}" style="height:40px;margin-bottom:14px;border-radius:8px;">` : `<h2 style="margin:0 0 14px;color:#1a1a1a;">${esc(shop)}</h2>`}
      <p style="color:#444;font-size:15px;line-height:1.55;margin:0 0 18px;white-space:pre-line;">${esc(bodyText)}</p>
      <table style="width:100%;border-collapse:collapse;font-size:14px;border-top:1px solid #eee;">
        <tr><td style="padding:10px 0 4px;color:#888;">Order</td><td align="right" style="padding:10px 0 4px;">${esc(ctx.ref)}</td></tr>
        <tr><td style="padding:4px 0;color:#888;">Total</td><td align="right" style="padding:4px 0;font-weight:700;color:${esc(accent)};">${esc(ctx.total)}</td></tr>
        ${ctx.items ? `<tr><td style="padding:4px 0;color:#888;vertical-align:top;">Items</td><td align="right" style="padding:4px 0;">${esc(ctx.items)}</td></tr>` : ""}
      </table>
      ${ctx.pay_link ? `<a href="${esc(ctx.pay_link)}" style="display:inline-block;margin-top:18px;background:${esc(accent)};color:#fff;text-decoration:none;padding:11px 20px;border-radius:9px;font-weight:600;font-size:14px;">View order</a>` : ""}
    </div>
    <div style="padding:14px 28px;background:#fafafa;color:#aaa;font-size:12px;">${esc(shop)} · via Marketplace</div>
  </div>`;
}

async function deliver(channel, { to, subject, body, html, merchantId }) {
  if (channel === "email") return sendEmail({ to, subject, html, text: body });
  if (channel === "sms") return sendSms({ to, message: body });
  if (channel === "whatsapp") return wa.send(merchantId, to, body);
  throw new Error(`unsupported channel ${channel}`);
}

// Quiet-hours check: is `now` within [start,end) in the merchant's offset tz?
function inQuiet(quiet, now = new Date()) {
  if (!quiet?.enabled) return null;
  const local = new Date(now.getTime() + (Number(quiet.tz_offset) || 0) * 3600000);
  const h = local.getUTCHours();
  const { start, end } = quiet;
  const within = start <= end ? (h >= start && h < end) : (h >= start || h < end);
  if (!within) return null;
  // Compute the next local `end` hour as a UTC instant.
  const next = new Date(local); next.setUTCMinutes(0, 0, 0);
  if (start <= end) next.setUTCHours(end);
  else { if (h >= start) next.setUTCDate(local.getUTCDate() + 1); next.setUTCHours(end); }
  return new Date(next.getTime() - (Number(quiet.tz_offset) || 0) * 3600000);
}

async function logSend(mid, { ref, event, channel, to, status, messageId, error, by }) {
  await db.run(`INSERT INTO sends (merchant_id, order_ref, event, channel, to_addr, status, message_id, error, sent_by_name) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [mid, ref, event, channel, to, status, messageId || null, error || null, by || null]);
}

// Send (or queue if quiet hours) one channel for one order. Returns a result row.
async function sendOrQueue(mid, cfg, event, channel, ctx, opts = {}) {
  const subject = renderFields((cfg.templates[event] || {}).subject, ctx);
  const bodyText = renderFields((cfg.templates[event] || {}).body, ctx);
  const to = channel === "email" ? opts.email : opts.phone;
  if (!to) { await logSend(mid, { ref: ctx.ref, event, channel, to: null, status: "failed", error: "no recipient", by: opts.by }); return { channel, status: "failed", error: "no recipient" }; }

  const defer = opts.allowQuiet === false ? null : inQuiet(cfg.quiet);
  if (defer) {
    const html = channel === "email" ? emailHtml(cfg, ctx, bodyText) : null;
    await db.run(`INSERT INTO queue (merchant_id, order_ref, event, channel, to_addr, subject, body, html, send_after) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [mid, ctx.ref, event, channel, to, subject, bodyText, html, defer.toISOString()]);
    return { channel, status: "queued", send_after: defer.toISOString() };
  }
  try {
    const html = channel === "email" ? emailHtml(cfg, ctx, bodyText) : null;
    const out = await deliver(channel, { to, subject, body: bodyText, html, merchantId: mid });
    await logSend(mid, { ref: ctx.ref, event, channel, to, status: "sent", messageId: out.messageId, by: opts.by });
    return { channel, status: "sent" };
  } catch (err) {
    await logSend(mid, { ref: ctx.ref, event, channel, to, status: "failed", error: err?.message, by: opts.by });
    return { channel, status: "failed", error: err?.message };
  }
}

// Drain due queued messages (quiet hours elapsed).
async function drainQueue() {
  const due = await db.q(`DELETE FROM queue WHERE send_after <= now() RETURNING *`);
  for (const q of due) {
    try {
      const out = await deliver(q.channel, { to: q.to_addr, subject: q.subject, body: q.body, html: q.html, merchantId: q.merchant_id });
      await logSend(q.merchant_id, { ref: q.order_ref, event: q.event, channel: q.channel, to: q.to_addr, status: "sent", messageId: out.messageId });
    } catch (err) {
      await logSend(q.merchant_id, { ref: q.order_ref, event: q.event, channel: q.channel, to: q.to_addr, status: "failed", error: err?.message });
    }
  }
}
setInterval(() => { drainQueue().catch(() => {}); }, 60000);

// ---- Orders (manual send) --------------------------------------------------
app.get("/api/orders", core.requireSession, async (req, res) => {
  try {
    const r = await inkressApi(core.cfg, req.session.accessToken, `orders?limit=60&order=id desc`);
    const orders = (r?.result?.entries || []).map((o) => ({
      id: o.id, ref: o.reference_id || String(o.id), status: orderStatusName(o),
      total: Number(o.total || 0), currency: curOf(o),
      customer: o.customer ? { name: [o.customer.first_name, o.customer.last_name].filter(Boolean).join(" ") || o.customer.email, email: o.customer.email || null, phone: o.customer.phone || null } : null,
      created_at: o.inserted_at || o.created_at || null,
    }));
    res.json({ orders, ses_configured: sesConfigured(), sms_configured: snsConfigured(), wa_connected: wa.isConnected(req.session.merchantId) });
  } catch (err) { res.status(502).json({ error: "orders_failed", message: err?.message }); }
});

app.post("/api/orders/:id/send", core.requireSession, async (req, res) => {
  const event = EVENTS.includes(req.body?.event) ? req.body.event : "paid";
  const channelsReq = Array.isArray(req.body?.channels) ? req.body.channels.filter((c) => CHANNELS.includes(c)) : null;
  try {
    const r = await inkressApi(core.cfg, req.session.accessToken, `orders/${encodeURIComponent(req.params.id)}`);
    const o = r?.result; if (!o) return res.status(404).json({ error: "not_found" });
    const cfg = await getConfig(req.session.merchantId);
    const ctx = ctxFromOrder({ ...o, status: event, lines: o.order_lines || o.lines }, cfg);
    const channels = channelsReq || (cfg.templates[event]?.channels || ["email"]);
    const email = o.customer?.email; const phone = o.customer?.phone;
    const results = [];
    for (const ch of channels) {
      if (ch === "email" && !sesConfigured()) { results.push({ channel: ch, status: "failed", error: "email not configured" }); continue; }
      if (ch === "sms" && !snsConfigured()) { results.push({ channel: ch, status: "failed", error: "sms not configured" }); continue; }
      // Manual sends ignore quiet hours (staff is choosing to send now).
      results.push(await sendOrQueue(req.session.merchantId, cfg, event, ch, ctx, { email, phone: toE164(phone), by: req.actor?.name, allowQuiet: false }));
    }
    res.json({ ok: results.some((r) => r.status === "sent"), results });
  } catch (err) { res.status(502).json({ error: "send_failed", message: err?.message }); }
});

// ---- Settings / templates --------------------------------------------------
app.get("/api/settings", core.requireSession, async (req, res) => {
  const cfg = await getConfig(req.session.merchantId);
  res.json({ ...cfg, events: EVENTS, channels: CHANNELS, ses_configured: sesConfigured(), sms_configured: snsConfigured(), wa_connected: wa.isConnected(req.session.merchantId) });
});
app.post("/api/settings", core.requireSession, async (req, res) => {
  const b = req.body || {};
  const t = b.templates || {};
  const templates = {};
  for (const e of EVENTS) if (t[e]) templates[e] = {
    enabled: !!t[e].enabled,
    channels: (Array.isArray(t[e].channels) ? t[e].channels : ["email"]).filter((c) => CHANNELS.includes(c)),
    subject: String(t[e].subject || "").slice(0, 160), body: String(t[e].body || "").slice(0, 1000),
  };
  const quiet = b.quiet ? { enabled: !!b.quiet.enabled, start: clampHour(b.quiet.start, 21), end: clampHour(b.quiet.end, 8), tz_offset: Number(b.quiet.tz_offset ?? -5) } : undefined;
  const sender = b.sender ? { from_name: String(b.sender.from_name || "").slice(0, 60) || null, accent: /^#[0-9a-f]{6}$/i.test(b.sender.accent) ? b.sender.accent : ACCENT_DEFAULT } : undefined;
  const patch = {};
  if (Object.keys(templates).length) patch.templates = templates;
  if (quiet) patch.quiet = quiet;
  if (sender) patch.sender = sender;
  await db.run(`INSERT INTO settings (merchant_id, data, updated_at) VALUES ($1, $2::jsonb, now())
                ON CONFLICT (merchant_id) DO UPDATE SET data = settings.data || $2::jsonb, updated_at=now()`,
    [req.session.merchantId, JSON.stringify(patch)]);
  res.json(await getConfig(req.session.merchantId));
});
const clampHour = (v, d) => { const n = Number(v); return Number.isFinite(n) ? Math.max(0, Math.min(23, Math.floor(n))) : d; };

// ---- Log + stats -----------------------------------------------------------
app.get("/api/log", core.requireSession, async (req, res) => {
  const log = await db.q(`SELECT * FROM sends WHERE merchant_id=$1 ORDER BY created_at DESC LIMIT 100`, [req.session.merchantId]);
  const today = new Date().toISOString().slice(0, 10);
  const all = await db.q(`SELECT event, channel, status, created_at FROM sends WHERE merchant_id=$1`, [req.session.merchantId]);
  const sentToday = all.filter((r) => r.status === "sent" && String(r.created_at).slice(0, 10) === today).length;
  const byEvent = {}; const byChannel = {};
  for (const r of all) if (r.status === "sent") { byEvent[r.event] = (byEvent[r.event] || 0) + 1; byChannel[r.channel] = (byChannel[r.channel] || 0) + 1; }
  const queued = await db.one(`SELECT count(*)::int AS n FROM queue WHERE merchant_id=$1`, [req.session.merchantId]);
  res.json({ log, stats: { sent_today: sentToday, total: all.filter((r) => r.status === "sent").length, queued: queued?.n || 0, by_event: byEvent, by_channel: byChannel } });
});

// ---- Real-time status + webhook self-registration --------------------------
app.get("/api/status", core.requireSession, async (req, res) => {
  const mid = req.session.merchantId;
  let sub = await db.one(`SELECT * FROM webhook_subs WHERE merchant_id=$1`, [mid]);
  const canRegister = WEBHOOK_SECRET && (req.session.scope || []).includes("webhooks:manage");
  if (!sub && canRegister) {
    const base = process.env.PUBLIC_BASE_URL || `https://${req.get("host")}`;
    const url = `${base}/webhooks/inkress/${mid}`;
    try {
      await inkressApi(core.cfg, req.session.accessToken, `webhook_urls`, { method: "POST", body: JSON.stringify({ url, event: "orders" }) });
      await db.run(`INSERT INTO webhook_subs (merchant_id, url) VALUES ($1,$2) ON CONFLICT (merchant_id) DO UPDATE SET url=$2, registered_at=now()`, [mid, url]);
      sub = { merchant_id: mid, url };
    } catch (err) {
      if (String(err?.message || "").match(/already|unique|exist|422/i)) { await db.run(`INSERT INTO webhook_subs (merchant_id, url) VALUES ($1,$2) ON CONFLICT (merchant_id) DO NOTHING`, [mid, url]); sub = { merchant_id: mid, url }; }
    }
  }
  res.json({
    auto_send: Boolean(sub), webhook_registered: Boolean(sub), can_register: Boolean(canRegister),
    background_ready: await tokens.hasToken(mid), webhook_secret_configured: Boolean(WEBHOOK_SECRET),
    ses_configured: sesConfigured(), sms_configured: snsConfigured(), wa_connected: wa.isConnected(mid),
  });
});

// ---- WhatsApp pairing ------------------------------------------------------
app.get("/api/whatsapp", core.requireSession, async (req, res) => {
  const mid = req.session.merchantId;
  const st = wa.stateFor(mid);
  if (st.state === "connected") await db.run(`INSERT INTO wa_sessions (merchant_id, phone) VALUES ($1,$2) ON CONFLICT (merchant_id) DO UPDATE SET phone=$2`, [mid, st.phone]).catch(() => {});
  res.json(st);
});
app.post("/api/whatsapp/connect", core.requireSession, async (req, res) => {
  try { res.json(await wa.connect(req.session.merchantId)); }
  catch (err) { res.status(500).json({ state: "error", available: false, error: err?.message || "WhatsApp is unavailable on this server." }); }
});
app.post("/api/whatsapp/logout", core.requireSession, async (req, res) => {
  await wa.disconnect(req.session.merchantId).catch(() => {});
  await db.run(`DELETE FROM wa_sessions WHERE merchant_id=$1`, [req.session.merchantId]).catch(() => {});
  res.json({ ok: true });
});

// ---- Webhook receiver (auto-send on status change) -------------------------
app.post("/webhooks/inkress/:merchantId", async (req, res) => {
  const merchantId = Number(req.params.merchantId);
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body || {}));
  if (WEBHOOK_SECRET) {
    const expected = crypto.createHmac("sha256", WEBHOOK_SECRET).update(raw).digest("base64");
    const got = String(req.get("x-inkress-webhook-signature") || "");
    const a = Buffer.from(expected), b = Buffer.from(got);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).json({ error: "bad_signature" });
  }
  res.json({ received: true });

  try {
    const evt = JSON.parse(raw.toString("utf8"));
    const o = evt?.order || evt?.data?.order;
    if (!o || !merchantId) return;
    const status = String(o.status || "").toLowerCase();
    if (!EVENTS.includes(status)) return;

    const wid = String(req.get("x-inkress-webhook-id") || `${o.id}.${status}`);
    if (await db.one(`SELECT 1 FROM webhook_seen WHERE webhook_id=$1`, [wid])) return;
    await db.run(`INSERT INTO webhook_seen (webhook_id) VALUES ($1) ON CONFLICT DO NOTHING`, [wid]);

    const cfg = await getConfig(merchantId);
    const tmpl = cfg.templates[status];
    if (!tmpl?.enabled) return;
    const channels = (tmpl.channels || ["email"]).filter((c) => CHANNELS.includes(c));
    if (!channels.length) return;

    const ctx = ctxFromOrder(o, cfg);
    let email = o.customer?.email || null;
    let phone = null;

    // SMS/WhatsApp need a phone, which the webhook payload omits — re-fetch via
    // the merchant's background token (offline_access) when a phone channel is on.
    if (channels.includes("sms") || channels.includes("whatsapp")) {
      try {
        const at = await tokens.accessTokenFor(merchantId);
        const r = await inkressApi(core.cfg, at, `orders/${encodeURIComponent(o.id)}`);
        const full = r?.result;
        phone = toE164(full?.customer?.phone);
        if (!email) email = full?.customer?.email || null;
      } catch { /* no background token → phone channels skipped */ }
      if (channels.includes("whatsapp")) wa.ensure(merchantId).catch(() => {});
    }

    for (const ch of channels) {
      if (ch === "email" && !sesConfigured()) continue;
      if (ch === "sms" && !snsConfigured()) continue;
      if (ch === "whatsapp" && !wa.isConnected(merchantId)) continue;
      await sendOrQueue(merchantId, cfg, status, ch, ctx, { email, phone, by: "Auto" });
    }
    console.log(`[order-updates] auto-sent ${status} for order ${o.id} (merchant ${merchantId}) via ${channels.join(",")}`);
  } catch (err) {
    console.error(`[order-updates] webhook failed: ${err?.message}`);
  }
});

core.mountSpaFallback();
app.listen(PORT, HOST, () => console.log(`[order-updates] listening on ${HOST}:${PORT}`));

// Resume previously-paired WhatsApp sessions from the persistent volume so
// auto-send keeps working after a restart (best-effort; never blocks boot).
setTimeout(async () => {
  if (!wa.isAvailable()) return;
  try { const rows = await db.q(`SELECT merchant_id FROM wa_sessions`); for (const r of rows) wa.ensure(r.merchant_id).catch(() => {}); }
  catch { /* ignore */ }
}, 4000);

function esc(s) { return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
