// Haven for Home Assistant: loaded first by the dashboard page (GENERATED from ryanbyte1701/haven tools/hacs).
// Haven's own scripts are unchanged; this adapts them to running inside Home Assistant's "Haven" panel:
// - API calls (/api/...) go to /api/haven/... with the signed-in Home Assistant user's token;
// - live updates (/ws) go to /api/haven/websocket and sign in with that token;
// - no Haven sign-in page or password pages: Home Assistant's accounts are used;
// - "Auto" light/dark follows Home Assistant's theme;
// - Haven's saved preferences are kept apart from Home Assistant's own (key prefix "haven:").
(() => {
  "use strict";
  let P = null;
  try { P = window.parent !== window ? window.parent.__havenPanel : null; } catch (e) { P = null; }
  window.HAVEN_EDITION = "hacs";
  document.documentElement.classList.add("haven-hacs");
  if (!P) {      // opened on its own (not in the sidebar): there is no Home Assistant session to use
    location.replace("/haven");
    return;
  }

  // ---- preferences: own namespace in this origin's localStorage ----
  try {
    const real = window.localStorage, NS = "haven:";
    const ns = {
      getItem: k => real.getItem(NS + k),
      setItem: (k, v) => real.setItem(NS + k, String(v)),
      removeItem: k => real.removeItem(NS + k),
      clear: () => Object.keys(real).filter(k => k.startsWith(NS)).forEach(k => real.removeItem(k)),
      key: i => Object.keys(real).filter(k => k.startsWith(NS)).map(k => k.slice(NS.length))[i] ?? null,
      get length() { return Object.keys(real).filter(k => k.startsWith(NS)).length; },
    };
    Object.defineProperty(window, "localStorage", { configurable: true, get: () => ns });
    ns.setItem("token", "home-assistant");     // Haven's pages only check that a sign-in exists
  } catch (e) { /* storage blocked: Haven falls back to defaults */ }

  // ---- API calls ----
  const realFetch = window.fetch.bind(window);
  const toHaven = u => "/api/haven/" + u.pathname.slice("/api/".length) + u.search;
  // polled by the dashboard but not part of this edition (high availability): answer here, no 404s in the console
  const LOCAL = { "/api/ha/status": "null" };
  window.fetch = async (input, init = {}) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const u = new URL(raw, location.href);
    if (u.origin !== location.origin || !u.pathname.startsWith("/api/") || u.pathname.startsWith("/api/haven/")) {
      return realFetch(input, init);
    }
    if (u.pathname in LOCAL) return new Response(LOCAL[u.pathname], { status: 200, headers: { "Content-Type": "application/json" } });
    const call = async force => {
      const headers = new Headers(init.headers || (input instanceof Request ? input.headers : undefined));
      headers.set("Authorization", `Bearer ${await P.token(force)}`);
      return realFetch(toHaven(u), { ...init, headers });
    };
    let r = await call(false);
    if (r.status === 401) r = await call(true);
    if (r.ok) sessionStorage.removeItem("haven:relogin");
    return r;
  };

  // ---- live updates ----
  const RealWS = window.WebSocket;
  class HavenSocket extends RealWS {
    constructor(url, protocols) {
      const u = new URL(url, location.href);
      const ours = u.host === location.host && u.pathname === "/ws";
      if (ours) u.pathname = "/api/haven/websocket";
      super(u.href, protocols);
      this._ours = ours;
      if (ours) P.token().catch(() => {});        // refresh an expired token before the first message
    }
    send(data) {
      if (this._ours && !this._signedIn) {
        this._signedIn = true;
        try {
          const m = JSON.parse(data);
          if (m && m.type === "auth") { m.token = P.currentToken(); data = JSON.stringify(m); }
        } catch (e) { /* not JSON: send as is */ }
      }
      return super.send(data);
    }
  }
  window.WebSocket = HavenSocket;

  // ---- light/dark: "Auto" follows Home Assistant's theme ----
  const realMM = window.matchMedia.bind(window);
  const DARK = "(prefers-color-scheme: dark)";
  const fns = new Set();
  const haDark = () => { const h = P.hass; return h && h.themes ? !!h.themes.darkMode : null; };
  window.matchMedia = q => {
    if (String(q).replace(/\s+/g, " ").trim() !== DARK || haDark() === null) return realMM(q);
    return {
      media: DARK, onchange: null, get matches() { return !!haDark(); },
      addEventListener: (t, f) => { if (t === "change") fns.add(f); }, removeEventListener: (t, f) => fns.delete(f),
      addListener: f => fns.add(f), removeListener: f => fns.delete(f), dispatchEvent: () => true,
    };
  };
  const off = P.onThemeChange(dark => fns.forEach(f => { try { f({ matches: dark, media: DARK }); } catch (e) { /* ignore */ } }));
  window.addEventListener("pagehide", () => off());

  // ---- accounts: Home Assistant's, not Haven's ----
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  let accounts;
  const patch = a => a && Object.assign(a, {
    // a 401 even with a fresh token: the Home Assistant session ended. Reload once; Home Assistant asks to sign in.
    async showLogin() {
      try { await P.token(true); } catch (e) { /* signed out of Home Assistant */ }
      const n = +(sessionStorage.getItem("haven:relogin") || 0);
      if (n < 2) { sessionStorage.setItem("haven:relogin", String(n + 1)); location.reload(); }
      else window.parent.location.reload();
    },
    showMustChange() {},
    hideLogin() {},
    signOut() {},
    render(page, el) {
      const me = (window.Haven && window.Haven.me) || {};
      const role = me.role === "admin" ? "Admin" : "Regular";
      el.innerHTML = `<section class="acc-card haven-hacs-account">
        <h3>${esc(me.user || "You")} · ${role}</h3>
        <p>Haven uses your Home Assistant account. Home Assistant administrators are Haven admins (devices,
        settings, automations); everyone else is a Regular user (sees and controls devices).</p>
        <p>To add people or change who is an administrator, use Home Assistant: Settings → People.</p></section>`;
    },
  });
  try {
    Object.defineProperty(window, "HavenAccounts", { configurable: true, get: () => accounts, set: v => { accounts = patch(v); } });
  } catch (e) { /* keep Haven's own */ }
})();
