import "./index.css";
import {
  initBv, bvApi, makeToast, type BvToastFn,
  mountShell, statRow, dataTable, card, openModal, flash,
  fmtMoney, relTime, pill, emptyState, h, iconEl,
} from "./bv-init";

interface Order { id: number; ref: string; status: string; total: number; currency: string; customer: { name: string; email: string | null; phone: string | null } | null; created_at: string | null; }
interface Tmpl { enabled: boolean; channels: string[]; subject: string; body: string; }
interface Quiet { enabled: boolean; start: number; end: number; tz_offset: number; }
interface Sender { from_name: string | null; accent: string; }
interface Config { templates: Record<string, Tmpl>; quiet: Quiet; sender: Sender; merchant: any; events: string[]; channels: string[]; ses_configured: boolean; sms_configured: boolean; wa_connected: boolean; }
interface WaState { state: string; qr: string | null; phone: string | null; error?: string | null; available: boolean; }
interface LogRow { id: number; order_ref: string; event: string; channel: string; to_addr: string; status: string; error: string | null; sent_by_name: string | null; created_at: string; }
interface Stats { sent_today: number; total: number; queued: number; by_event: Record<string, number>; by_channel: Record<string, number>; }
interface StatusInfo { auto_send: boolean; webhook_registered: boolean; can_register: boolean; background_ready: boolean; webhook_secret_configured: boolean; ses_configured: boolean; sms_configured: boolean; wa_connected: boolean; }

const CHANNEL_LABEL: Record<string, string> = { email: "Email", sms: "SMS", whatsapp: "WhatsApp" };
const CHANNEL_ICON: Record<string, string> = { email: "send", sms: "message", whatsapp: "phone" };
function chanAvail(ch: string): boolean {
  if (ch === "email") return !!cfg?.ses_configured;
  if (ch === "sms") return !!cfg?.sms_configured;
  if (ch === "whatsapp") return !!cfg?.wa_connected;
  return false;
}
const MERGE = ["name", "ref", "total", "status", "items", "shop", "pay_link"];

const root = document.getElementById("root")!;
let toast: BvToastFn;
let merchantName = "Merchant";
let cfg: Config | null = null;
let shell: ReturnType<typeof mountShell>;
let lastField: HTMLInputElement | HTMLTextAreaElement | null = null;

(async () => {
  let session;
  if (import.meta.env.DEV && !new URLSearchParams(location.search).has("inkress_session")) {
    const m = await import("./dev-mock"); m.installMockFetch(); session = m.mockSession();
  } else {
    try { session = await initBv(); }
    catch (err: any) { root.innerHTML = ""; root.append(fatal(err?.message)); return; }
  }
  toast = makeToast(session.inkress);
  merchantName = session.merchant.name || session.merchant.username || "Merchant";

  shell = mountShell({
    brandIcon: "message",
    title: "Order Updates",
    subtitle: `${merchantName} · keep customers in the loop, automatically`,
    poweredBy: "Marketplace",
    tabs: [
      { id: "orders", label: "Orders", icon: "receipt", render: renderOrders },
      { id: "messages", label: "Messages", icon: "message", render: renderMessages },
      { id: "settings", label: "Settings", icon: "settings", render: renderSettings },
      { id: "sent", label: "Activity", icon: "inbox", render: renderActivity },
    ],
  });
})();

async function loadConfig(): Promise<Config> { cfg = await bvApi<Config>("/api/settings"); return cfg; }
function sampleCtx(status: string) {
  return { shop: cfg?.sender?.from_name || merchantName, name: "Maria Brown", ref: "ORD-2371", total: "JMD 12,500.00", status, items: "1× Afro Fade, 1× Beard Shaping", pay_link: "https://pay.inkress.com/abc" };
}
function fillMerge(str: string, status: string): string {
  const c = sampleCtx(status) as Record<string, string>;
  return String(str || "").replace(/\{\{(\w+)\}\}/g, (_, k) => ((k === "customer" ? c.name : c[k]) ?? `{{${k}}}`));
}

/* -------------------------------------------------------------------- Orders */
async function renderOrders(host: HTMLElement) {
  host.append(h("div", { class: "bv-muted", style: { padding: "12px 2px" } }, "Loading…"));
  let data: { orders: Order[]; ses_configured: boolean; sms_configured: boolean };
  try { data = await bvApi("/api/orders"); if (!cfg) await loadConfig(); }
  catch (err: any) { host.innerHTML = ""; host.append(emptyState({ icon: "alert", title: "Couldn't load orders", text: err?.message })); return; }
  host.innerHTML = "";
  if (!data.ses_configured && !data.sms_configured) host.append(h("div", { class: "ou-warn" }, iconEl("alert", 15), "No channels configured yet — updates are disabled until email or SMS is set up."));

  host.append(card({ title: "Recent orders", body: data.orders.length ? dataTable<Order>({
    columns: [
      { head: "Order", cell: (o) => h("div", null, h("strong", null, `#${o.ref}`), o.customer ? h("div", { class: "bv-muted" }, o.customer.name) : null) },
      { head: "Total", num: true, cell: (o) => fmtMoney(o.total, o.currency) },
      { head: "Status", cell: (o) => pill(o.status, o.status === "paid" || o.status === "completed" ? "ok" : o.status === "refunded" || o.status === "cancelled" ? "bad" : undefined) },
      { head: "Reach", cell: (o) => h("span", { class: "bv-muted" }, [o.customer?.email && "email", o.customer?.phone && "SMS"].filter(Boolean).join(" · ") || "no contact") },
    ],
    rows: data.orders,
    rowActions: (o) => (o.customer?.email || o.customer?.phone) ? h("button", { class: "ghost sm", onClick: () => openSend(o) }, iconEl("send", 14), "Update") : null,
  }) : emptyState({ icon: "receipt", title: "No orders yet", text: "Orders from Inkress show up here." }) }));
}

function openSend(o: Order) {
  const t = cfg?.templates;
  const sel = h("select", null, ...(cfg?.events || []).map((e) => h("option", { value: e, selected: e === o.status }, e))) as HTMLSelectElement;
  const chanWrap = h("div", { class: "ou-chan-row" });
  const chanInputs: Record<string, HTMLInputElement> = {};
  const paintChannels = () => {
    chanWrap.innerHTML = "";
    const tmpl = t?.[sel.value];
    for (const ch of cfg?.channels || []) {
      const avail = chanAvail(ch);
      const reach = ch === "email" ? o.customer?.email : o.customer?.phone;
      const on = (tmpl?.channels || ["email"]).includes(ch);
      const cb = h("input", { type: "checkbox", checked: on && !!avail && !!reach, disabled: !avail || !reach }) as HTMLInputElement;
      chanInputs[ch] = cb;
      chanWrap.append(h("label", { class: "ou-chan" }, cb, iconEl(CHANNEL_ICON[ch] || "send", 14), (CHANNEL_LABEL[ch] || ch),
        !reach ? h("span", { class: "bv-muted" }, " (no contact)") : !avail ? h("span", { class: "bv-muted" }, " (off)") : null));
    }
  };
  const note = h("div", { class: "ou-preview-mini" });
  const updateNote = () => { const tmpl = t?.[sel.value]; note.innerHTML = ""; note.append(h("strong", null, fillMerge(tmpl?.subject || "", sel.value)), h("div", { class: "bv-muted" }, fillMerge(tmpl?.body || "", sel.value))); paintChannels(); };
  sel.addEventListener("change", updateNote); updateNote();

  const body = h("div", null,
    h("p", null, "Send ", h("strong", null, o.customer?.name || "the customer"), " an update for order ", h("strong", null, `#${o.ref}`), "."),
    h("label", { class: "ou-field" }, h("span", { class: "bv-label" }, "Update type"), sel),
    h("div", { class: "ou-field" }, h("span", { class: "bv-label" }, "Channels"), chanWrap),
    note);
  openModal({ title: "Send order update", body, actions: [{ label: "Send update", primary: true, onClick: () => { void (async () => {
    const channels = Object.entries(chanInputs).filter(([, cb]) => cb.checked).map(([ch]) => ch);
    if (!channels.length) { toast("Pick at least one channel", "warning"); return; }
    try { const r = await bvApi<{ results: any[] }>(`/api/orders/${o.id}/send`, { method: "POST", body: JSON.stringify({ event: sel.value, channels }) });
      const sent = r.results.filter((x) => x.status === "sent").map((x) => CHANNEL_LABEL[x.channel]);
      const failed = r.results.filter((x) => x.status === "failed");
      if (sent.length) flash(`Sent via ${sent.join(", ")}`, "success");
      if (failed.length) toast(`${failed.map((f) => CHANNEL_LABEL[f.channel] + ": " + f.error).join("; ")}`, "error");
      shell.select("sent"); }
    catch (err: any) { toast(err?.message || "Couldn't send", "error"); }
  })(); } }] });
}

/* ----------------------------------------------------------------- Messages */
async function renderMessages(host: HTMLElement) {
  try { await loadConfig(); }
  catch (err: any) { host.append(emptyState({ icon: "alert", title: "Couldn't load", text: err?.message })); return; }
  const c = cfg!;

  const editors: Record<string, { enabled: HTMLInputElement; channels: Record<string, HTMLInputElement>; subject: HTMLInputElement; body: HTMLTextAreaElement; preview: HTMLElement }> = {};
  const list = h("div", { class: "ou-templates" });
  for (const e of c.events) {
    const t = c.templates[e]; if (!t) continue;
    const enabled = h("input", { type: "checkbox", checked: t.enabled }) as HTMLInputElement;
    const subject = h("input", { value: t.subject, placeholder: "Subject (email)" }) as HTMLInputElement;
    const bodyEl = h("textarea", { rows: "3", placeholder: "Message" }, t.body) as HTMLTextAreaElement;
    subject.addEventListener("focus", () => { lastField = subject; });
    bodyEl.addEventListener("focus", () => { lastField = bodyEl; });
    const channels: Record<string, HTMLInputElement> = {};
    const chanRow = h("div", { class: "ou-chan-row" });
    for (const ch of c.channels) {
      const avail = chanAvail(ch);
      const cb = h("input", { type: "checkbox", checked: t.channels.includes(ch), disabled: !avail }) as HTMLInputElement;
      channels[ch] = cb;
      chanRow.append(h("label", { class: "ou-chan" }, cb, iconEl(CHANNEL_ICON[ch] || "send", 14), (CHANNEL_LABEL[ch] || ch), !avail ? h("span", { class: "bv-muted" }, " (off)") : null));
    }
    const preview = h("div", { class: "ou-preview" });
    const repaint = () => { preview.innerHTML = ""; preview.append(
      h("div", { class: "ou-preview-subject" }, fillMerge(subject.value, e)),
      h("div", { class: "ou-preview-body" }, fillMerge(bodyEl.value, e))); };
    subject.addEventListener("input", repaint); bodyEl.addEventListener("input", repaint); repaint();
    editors[e] = { enabled, channels, subject, body: bodyEl, preview };

    list.append(h("div", { class: "ou-tmpl" + (t.enabled ? " is-on" : "") },
      h("div", { class: "ou-tmpl-head" },
        pill(e, e === "paid" || e === "completed" ? "ok" : e === "refunded" || e === "cancelled" ? "bad" : undefined),
        h("label", { class: "ou-toggle" }, enabled, " Auto-send")),
      chanRow, subject, bodyEl,
      h("div", { class: "ou-preview-wrap" }, h("span", { class: "ou-preview-tag" }, "Preview"), preview)));
  }

  const palette = h("div", { class: "ou-merge" }, h("span", { class: "bv-muted" }, "Insert:"),
    ...MERGE.map((m) => h("button", { class: "ou-mergebtn", onClick: () => insertMerge(`{{${m}}}`) }, `{{${m}}}`)));

  const save = h("button", { class: "primary", onClick: async () => {
    const payload: any = { templates: {} };
    for (const e of c.events) { const ed = editors[e]!; payload.templates[e] = { enabled: ed.enabled.checked, channels: Object.entries(ed.channels).filter(([, cb]) => cb.checked).map(([ch]) => ch), subject: ed.subject.value, body: ed.body.value }; }
    try { cfg = await bvApi<Config>("/api/settings", { method: "POST", body: JSON.stringify(payload) }); flash("Messages saved", "success"); }
    catch (err: any) { toast(err?.message || "error", "error"); }
  } }, "Save messages");

  host.append(card({ title: "Per-event messages", action: save, body: h("div", null,
    h("div", { class: "ou-hint bv-muted" }, "Toggle ", h("b", null, "Auto-send"), " to message customers automatically when an order reaches that status. Pick channels per event."),
    palette, list) }));
}
function insertMerge(token: string) {
  const f = lastField; if (!f) { toast("Click a subject or message field first", "info"); return; }
  const s = f.selectionStart ?? f.value.length, e = f.selectionEnd ?? f.value.length;
  f.value = f.value.slice(0, s) + token + f.value.slice(e);
  f.focus(); f.selectionStart = f.selectionEnd = s + token.length;
  f.dispatchEvent(new Event("input"));
}

/* ----------------------------------------------------------------- Settings */
async function renderSettings(host: HTMLElement) {
  let status: StatusInfo | null = null;
  try { [, status] = await Promise.all([loadConfig(), bvApi<StatusInfo>("/api/status").catch(() => null as any)]); }
  catch (err: any) { host.append(emptyState({ icon: "alert", title: "Couldn't load", text: err?.message })); return; }
  const c = cfg!;

  if (status) {
    const on = status.auto_send;
    host.append(h("div", { class: "ou-realtime" + (on ? " is-on" : "") },
      iconEl(on ? "bell" : "clock", 15),
      h("span", null, on ? "Auto-send is on — customers are notified automatically on status changes." : "Auto-send activates once this app is reconnected with webhook access."),
      h("div", { class: "ou-chips" },
        channelChip("Email", status.ses_configured),
        channelChip("SMS", status.sms_configured),
        channelChip("WhatsApp", status.wa_connected))));
  }

  host.append(whatsAppCard());

  // Quiet hours
  const q = c.quiet;
  const qEnabled = h("input", { type: "checkbox", checked: q.enabled }) as HTMLInputElement;
  const qStart = hourSelect(q.start), qEnd = hourSelect(q.end);
  const qTz = h("input", { type: "number", value: String(q.tz_offset), step: "1", min: "-12", max: "14", style: { width: "70px" } }) as HTMLInputElement;
  const quietCard = card({ title: "Quiet hours", body: h("div", null,
    h("label", { class: "ou-toggle" }, qEnabled, " Hold messages overnight and send when quiet hours end"),
    h("div", { class: "ou-quiet-row" },
      h("label", { class: "ou-field" }, h("span", { class: "bv-label" }, "From"), qStart),
      h("label", { class: "ou-field" }, h("span", { class: "bv-label" }, "Until"), qEnd),
      h("label", { class: "ou-field" }, h("span", { class: "bv-label" }, "UTC offset"), qTz)),
    h("div", { class: "bv-muted", style: { fontSize: "0.8125rem" } }, "Messages that would land during quiet hours are queued and sent automatically when the window ends.")) });

  // Branding
  const s = c.sender;
  const fromName = h("input", { value: s.from_name || "", placeholder: merchantName }) as HTMLInputElement;
  const accent = h("input", { type: "color", value: s.accent || "#3b5bff" }) as HTMLInputElement;
  const brandCard = card({ title: "Branding", body: h("div", null,
    h("label", { class: "ou-field" }, h("span", { class: "bv-label" }, "Sender name (shown as the shop)"), fromName),
    h("label", { class: "ou-field" }, h("span", { class: "bv-label" }, "Accent colour"), h("div", { class: "ou-accent" }, accent, c.merchant?.logo ? h("img", { src: c.merchant.logo, class: "ou-logo" }) : h("span", { class: "bv-muted" }, "Your Inkress logo appears in emails when set"))) ) });

  const save = h("button", { class: "primary", onClick: async () => {
    try { cfg = await bvApi<Config>("/api/settings", { method: "POST", body: JSON.stringify({
      quiet: { enabled: qEnabled.checked, start: Number(qStart.value), end: Number(qEnd.value), tz_offset: Number(qTz.value) },
      sender: { from_name: fromName.value, accent: accent.value },
    }) }); flash("Settings saved", "success"); }
    catch (err: any) { toast(err?.message || "error", "error"); }
  } }, "Save settings");

  host.append(quietCard, brandCard, h("div", { style: { marginTop: "4px" } }, save));
}
let waPoll: any = null;
function whatsAppCard(): HTMLElement {
  const bodyHost = h("div", { class: "ou-wa" });
  const paint = (st: WaState | null) => {
    bodyHost.innerHTML = "";
    if (!st || st.available === false) {
      bodyHost.append(h("div", { class: "bv-muted" }, "WhatsApp isn't available on this server."));
      return;
    }
    if (st.state === "connected") {
      bodyHost.append(
        h("div", { class: "ou-wa-status is-on" }, iconEl("check", 16), h("span", null, "Connected", st.phone ? ` · +${st.phone}` : "")),
        h("button", { class: "ghost sm", onClick: async () => { stopPoll(); await bvApi("/api/whatsapp/logout", { method: "POST" }); load(); } }, "Disconnect"));
      return;
    }
    if (st.state === "qr" && st.qr) {
      bodyHost.append(
        h("p", { class: "bv-muted" }, "On your phone, open WhatsApp → Settings → Linked devices → Link a device, then scan:"),
        h("img", { src: st.qr, class: "ou-wa-qr", alt: "WhatsApp QR" }));
      return;
    }
    if (st.state === "connecting") { bodyHost.append(h("div", { class: "ou-wa-status" }, iconEl("clock", 16), "Connecting… preparing the QR code.")); return; }
    if (st.state === "error") { bodyHost.append(h("div", { class: "ou-warn" }, iconEl("alert", 14), st.error || "Couldn't start WhatsApp."), connectBtn()); return; }
    bodyHost.append(h("p", { class: "bv-muted" }, "Link your WhatsApp to send order updates over WhatsApp."), connectBtn());
  };
  const connectBtn = () => h("button", { class: "primary", onClick: async () => {
    try { paint(await bvApi<WaState>("/api/whatsapp/connect", { method: "POST" })); startPoll(); }
    catch (err: any) { toast(err?.message || "WhatsApp unavailable", "error"); }
  } }, iconEl("phone", 15), "Connect WhatsApp");
  const startPoll = () => { stopPoll(); waPoll = setInterval(load, 2500); };
  const stopPoll = () => { if (waPoll) { clearInterval(waPoll); waPoll = null; } };
  const load = async () => {
    try { const st = await bvApi<WaState>("/api/whatsapp"); paint(st); if (st.state === "connected" || st.state === "idle" || st.state === "error") stopPoll(); }
    catch { stopPoll(); }
  };
  load();
  return card({ title: "WhatsApp", body: bodyHost });
}

function hourSelect(v: number) {
  return h("select", null, ...Array.from({ length: 24 }, (_, i) => h("option", { value: String(i), selected: i === v }, `${String(i).padStart(2, "0")}:00`))) as HTMLSelectElement;
}
function channelChip(label: string, on: boolean | undefined) {
  return h("span", { class: "ou-chip" + (on ? " is-on" : "") }, iconEl(on ? "check" : "x", 12), label);
}

/* ----------------------------------------------------------------- Activity */
async function renderActivity(host: HTMLElement) {
  let data: { log: LogRow[]; stats: Stats };
  try { data = await bvApi("/api/log"); }
  catch (err: any) { host.append(emptyState({ icon: "alert", title: "Couldn't load", text: err?.message })); return; }

  host.append(statRow([
    { k: "Sent today", v: String(data.stats.sent_today), tone: "ok", icon: "send" },
    { k: "Total sent", v: String(data.stats.total), icon: "inbox" },
    { k: "Queued", v: String(data.stats.queued), tone: data.stats.queued ? "accent" : undefined, icon: "clock" },
  ]));

  host.append(card({ title: "Sent updates", body: data.log.length ? dataTable<LogRow>({
    columns: [
      { head: "When", cell: (r) => h("span", { class: "bv-muted" }, relTime(r.created_at)) },
      { head: "Order", cell: (r) => h("strong", null, `#${r.order_ref}`) },
      { head: "Event", cell: (r) => pill(r.event) },
      { head: "Channel", cell: (r) => h("span", { class: "ou-chan-pill" }, iconEl(CHANNEL_ICON[r.channel] || "send", 12), CHANNEL_LABEL[r.channel] || r.channel) },
      { head: "To", cell: (r) => h("span", { class: "bv-muted" }, r.to_addr || "—") },
      { head: "Status", cell: (r) => r.status === "sent" ? pill("sent", "ok") : r.status === "queued" ? pill("queued", "warn") : pill(r.error || "failed", "bad") },
    ], rows: data.log,
  }) : emptyState({ icon: "inbox", title: "No updates sent yet", text: "Enable auto-send in Messages, or send one from the Orders tab." }) }));
}

function fatal(msg?: string) { return h("div", { class: "bv-empty", style: { margin: "40px auto" } }, h("h3", null, "Order Updates couldn't load"), h("p", null, msg || "Open this app from the Inkress dashboard.")); }
