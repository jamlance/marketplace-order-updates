// WhatsApp channel via whatsapp-web.js — isolated + lazy-loaded so the rest of
// the app (email/SMS) never depends on Chromium being present. Each merchant
// gets their own LocalAuth session persisted under WWEBJS_DATA_PATH (a Coolify
// volume), so a paired session survives restarts.
//
// State machine per merchant: idle → connecting → qr → connected (or error /
// disconnected). The frontend polls /api/whatsapp; on `qr` it renders the data
// URL for the merchant to scan.

let mod = null;            // { Client, LocalAuth } once dynamically imported
let qrcodeMod = null;      // qrcode lib
let loadError = null;
const clients = new Map(); // merchantId -> { client, state, qrDataUrl, phone, error }

const DATA_PATH = process.env.WWEBJS_DATA_PATH || "/tmp/wwebjs";

async function load() {
  if (mod) return mod;
  if (loadError) throw loadError;
  try {
    const wweb = await import("whatsapp-web.js");
    qrcodeMod = (await import("qrcode")).default;
    mod = { Client: wweb.default.Client, LocalAuth: wweb.default.LocalAuth };
    return mod;
  } catch (err) {
    loadError = err;
    throw err;
  }
}

export function isAvailable() { return !loadError; }

export function stateFor(merchantId) {
  const e = clients.get(Number(merchantId));
  if (!e) return { state: "idle", qr: null, phone: null, available: isAvailable() };
  return { state: e.state, qr: e.qrDataUrl, phone: e.phone, error: e.error || null, available: true };
}

export async function connect(merchantId) {
  merchantId = Number(merchantId);
  const existing = clients.get(merchantId);
  if (existing && ["connecting", "qr", "connected"].includes(existing.state)) return stateFor(merchantId);

  const { Client, LocalAuth } = await load();
  const entry = { client: null, state: "connecting", qrDataUrl: null, phone: null, error: null };
  clients.set(merchantId, entry);

  const client = new Client({
    authStrategy: new LocalAuth({ clientId: `m${merchantId}`, dataPath: DATA_PATH }),
    puppeteer: {
      headless: true,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--single-process"],
    },
  });
  entry.client = client;

  client.on("qr", async (qr) => { entry.state = "qr"; try { entry.qrDataUrl = await qrcodeMod.toDataURL(qr, { margin: 1, width: 280 }); } catch { entry.qrDataUrl = null; } });
  client.on("authenticated", () => { entry.state = "connecting"; entry.qrDataUrl = null; });
  client.on("ready", () => { entry.state = "connected"; entry.qrDataUrl = null; entry.phone = client.info?.wid?.user || null; });
  client.on("auth_failure", (m) => { entry.state = "error"; entry.error = String(m || "auth failure"); });
  client.on("disconnected", () => { entry.state = "disconnected"; entry.qrDataUrl = null; });

  client.initialize().catch((err) => { entry.state = "error"; entry.error = err?.message || "init failed"; });
  return stateFor(merchantId);
}

// Best-effort resume: if a session folder exists for this merchant, bring the
// client back up (called on boot for known merchants, and before auto-send).
export async function ensure(merchantId) {
  const e = clients.get(Number(merchantId));
  if (e && e.state === "connected") return e;
  if (e && ["connecting", "qr"].includes(e.state)) return e;
  return connect(merchantId);
}

export async function disconnect(merchantId) {
  merchantId = Number(merchantId);
  const e = clients.get(merchantId);
  if (!e?.client) { clients.delete(merchantId); return; }
  try { await e.client.logout(); } catch { /* ignore */ }
  try { await e.client.destroy(); } catch { /* ignore */ }
  clients.delete(merchantId);
}

export function isConnected(merchantId) {
  const e = clients.get(Number(merchantId));
  return Boolean(e && e.state === "connected");
}

export async function send(merchantId, phone, message) {
  const e = clients.get(Number(merchantId));
  if (!e || e.state !== "connected" || !e.client) throw new Error("whatsapp not connected");
  const digits = String(phone || "").replace(/\D/g, "");
  if (!digits) throw new Error("no phone number");
  const sent = await e.client.sendMessage(`${digits}@c.us`, message);
  return { messageId: sent?.id?._serialized || sent?.id?.id || "wa" };
}
