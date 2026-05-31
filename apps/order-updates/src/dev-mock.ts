/** DEV-ONLY preview harness — tree-shaken from prod. */
import type { BvSession } from "./bv-init";

const EVENTS = ["paid", "confirmed", "prepared", "shipped", "delivered", "completed", "refunded", "cancelled"];
const CHANNELS = ["email", "sms", "whatsapp"];
const ORDERS = [
  { id: 2371, ref: "ORD-2371", status: "paid", total: 7500, currency: "JMD", customer: { name: "Maria Brown", email: "maria@example.com", phone: "8765550133" }, created_at: new Date(Date.now() - 36e5).toISOString() },
  { id: 2370, ref: "ORD-2370", status: "shipped", total: 3500, currency: "JMD", customer: { name: "Devon Clarke", email: "devon@example.com", phone: null }, created_at: new Date(Date.now() - 72e5).toISOString() },
  { id: 2369, ref: "ORD-2369", status: "completed", total: 24000, currency: "JMD", customer: { name: "Aaliyah Wright", email: null, phone: "8765550121" }, created_at: new Date(Date.now() - 9e6).toISOString() },
  { id: 2368, ref: "ORD-2368", status: "refunded", total: 1800, currency: "JMD", customer: { name: "Kemar Lewis", email: "kemar@example.com", phone: "8765550177" }, created_at: new Date(Date.now() - 1.2e7).toISOString() },
];
const defTmpl = (enabled: boolean, channels: string[], subject: string, body: string) => ({ enabled, channels, subject, body });
let TEMPLATES: Record<string, any> = {
  paid: defTmpl(true, ["email"], "We got your payment — {{shop}}", "Thanks {{name}}! Order {{ref}} for {{total}} is confirmed."),
  confirmed: defTmpl(false, ["email"], "Order confirmed — {{shop}}", "Hi {{name}}, order {{ref}} is confirmed."),
  prepared: defTmpl(false, ["email"], "Ready — {{shop}}", "Hi {{name}}, order {{ref}} is prepared."),
  shipped: defTmpl(true, ["email", "sms"], "On the way — {{shop}}", "Good news {{name}} — order {{ref}} has shipped."),
  delivered: defTmpl(false, ["email"], "Delivered — {{shop}}", "Hi {{name}}, order {{ref}} was delivered."),
  completed: defTmpl(false, ["email"], "All done — {{shop}}", "Hi {{name}}, order {{ref}} is complete."),
  refunded: defTmpl(false, ["email"], "Refund processed — {{shop}}", "Hi {{name}}, we refunded {{ref}} ({{total}})."),
  cancelled: defTmpl(false, ["email"], "Order cancelled — {{shop}}", "Hi {{name}}, order {{ref}} was cancelled."),
};
let QUIET = { enabled: false, start: 21, end: 8, tz_offset: -5 };
let SENDER = { from_name: null as string | null, accent: "#3b5bff" };
const LOG: any[] = [
  { id: 2, order_ref: "ORD-2362", event: "shipped", channel: "sms", to_addr: "+18765550133", status: "sent", error: null, sent_by_name: "Auto", created_at: new Date(Date.now() - 5e6).toISOString() },
  { id: 1, order_ref: "ORD-2360", event: "paid", channel: "email", to_addr: "x@example.com", status: "sent", error: null, sent_by_name: "Front Desk", created_at: new Date(Date.now() - 9e7).toISOString() },
];

let WA = { state: "idle", qr: null as string | null, phone: null as string | null, available: true };
const SAMPLE_QR = "data:image/svg+xml;utf8," + encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' width='200' height='200'><rect width='200' height='200' fill='#fff'/><rect x='20' y='20' width='60' height='60' fill='#111'/><rect x='120' y='20' width='60' height='60' fill='#111'/><rect x='20' y='120' width='60' height='60' fill='#111'/><rect x='110' y='110' width='20' height='20' fill='#111'/><rect x='150' y='150' width='30' height='30' fill='#111'/></svg>`);
function config() {
  return { templates: TEMPLATES, quiet: QUIET, sender: SENDER, merchant: { name: "Jack Jack Barbershop", logo: null, currency: "JMD" }, events: EVENTS, channels: CHANNELS, ses_configured: true, sms_configured: true, wa_connected: WA.state === "connected" };
}

export function installMockFetch() {
  window.fetch = async (input: any, init: any = {}) => {
    const url = typeof input === "string" ? input : input.url;
    const method = (init.method || "GET").toUpperCase();
    const u = new URL(url, location.origin);
    const body = init.body ? JSON.parse(init.body) : {};
    const json = (d: any, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { "Content-Type": "application/json" } });
    await new Promise((r) => setTimeout(r, 80));
    const sm = u.pathname.match(/\/api\/orders\/(\d+)\/send/);

    if (u.pathname === "/api/orders") return json({ orders: ORDERS, ses_configured: true, sms_configured: true, wa_connected: WA.state === "connected" });
    if (u.pathname === "/api/status") return json({ auto_send: true, webhook_registered: true, can_register: true, background_ready: true, webhook_secret_configured: true, ses_configured: true, sms_configured: true, wa_connected: WA.state === "connected" });
    if (u.pathname === "/api/whatsapp" && method === "GET") { if (WA.state === "qr") { WA.state = "connected"; WA.phone = "18765550100"; WA.qr = null; } return json(WA); }
    if (u.pathname === "/api/whatsapp/connect" && method === "POST") { WA = { state: "qr", qr: SAMPLE_QR, phone: null, available: true }; return json(WA); }
    if (u.pathname === "/api/whatsapp/logout" && method === "POST") { WA = { state: "idle", qr: null, phone: null, available: true }; return json({ ok: true }); }
    if (u.pathname === "/api/settings" && method === "GET") return json(config());
    if (u.pathname === "/api/settings" && method === "POST") {
      if (body.templates) TEMPLATES = { ...TEMPLATES, ...body.templates };
      if (body.quiet) QUIET = body.quiet;
      if (body.sender) SENDER = body.sender;
      return json(config());
    }
    if (sm) {
      const o = ORDERS.find((x) => x.id === Number(sm[1]));
      const channels = body.channels || ["email"];
      const results = channels.map((ch: string) => { const to = ch === "email" ? o?.customer?.email : o?.customer?.phone; LOG.unshift({ id: LOG.length + 1, order_ref: o?.ref, event: body.event, channel: ch, to_addr: to, status: to ? "sent" : "failed", error: to ? null : "no recipient", sent_by_name: "Front Desk", created_at: new Date().toISOString() }); return { channel: ch, status: to ? "sent" : "failed", error: to ? undefined : "no recipient" }; });
      return json({ ok: results.some((r: any) => r.status === "sent"), results });
    }
    if (u.pathname === "/api/log") {
      const today = new Date().toISOString().slice(0, 10);
      const byEvent: any = {}, byChannel: any = {};
      for (const r of LOG) if (r.status === "sent") { byEvent[r.event] = (byEvent[r.event] || 0) + 1; byChannel[r.channel] = (byChannel[r.channel] || 0) + 1; }
      return json({ log: LOG, stats: { sent_today: LOG.filter((r) => r.status === "sent" && String(r.created_at).slice(0, 10) === today).length, total: LOG.filter((r) => r.status === "sent").length, queued: 0, by_event: byEvent, by_channel: byChannel } });
    }
    return new Response("{}", { status: 404 });
  };
}

export function mockSession(): BvSession {
  return {
    inkress: { notify: ({ message }: any) => console.log("[toast]", message) } as any,
    merchant: { id: 183, username: "bookerva-jackjack", name: "Jack Jack Barbershop", currency_code: "JMD", email: "jack@example.com", logo: null },
    user: { id: 90, name: "Front Desk", email: "desk@jackjack.com" },
    scopes: ["orders:read", "webhooks:manage"],
  };
}
