// Haven's sidebar panel in Home Assistant (GENERATED from ryanbyte1701/haven tools/hacs: edit it there).
// Home Assistant creates <haven-panel> and keeps setting .hass (the signed-in user, their token, the theme),
// .narrow (phone layout: HA's sidebar is hidden) and .panel (its config). The dashboard itself is Haven's own
// page in a same-origin frame; its hacs-shim.js reads the user's token and the theme from window.__havenPanel.
class HavenPanel extends HTMLElement {
  constructor() {
    super();
    this._themeFns = new Set();
    this._dark = null;
    this._refreshing = null;
    const self = this;
    window.__havenPanel = {
      get hass() { return self._hass; },
      // a fresh Home Assistant access token (they last 30 minutes; refreshed here when needed)
      async token(force = false) {
        const auth = self._hass && self._hass.auth;
        if (!auth) throw new Error("Home Assistant isn't ready");
        if (force || auth.expired) {
          self._refreshing = self._refreshing || auth.refreshAccessToken().finally(() => { self._refreshing = null; });
          await self._refreshing;
        }
        return auth.accessToken;
      },
      currentToken() { return self._hass && self._hass.auth ? self._hass.auth.accessToken : ""; },
      onThemeChange(fn) { self._themeFns.add(fn); return () => self._themeFns.delete(fn); },
    };
  }

  set hass(hass) {
    this._hass = hass;
    const dark = !!(hass && hass.themes && hass.themes.darkMode);
    if (this._dark !== null && dark !== this._dark) this._themeFns.forEach(fn => { try { fn(dark); } catch (e) { /* frame gone */ } });
    this._dark = dark;
    if (hass && hass.auth && hass.auth.expired) window.__havenPanel.token().catch(() => {});
    this._render();
  }
  set narrow(v) { this._narrow = !!v; this._render(); }
  set panel(p) { this._panel = p; this._render(); }
  connectedCallback() { this._render(); }

  _render() {
    if (!this.isConnected || !this._panel) return;
    if (!this._root) {
      this._root = this.attachShadow({ mode: "open" });
      this._root.innerHTML = `<style>
          :host { display: flex; flex-direction: column; height: 100vh; height: 100dvh; background: var(--primary-background-color); }
          header { display: none; align-items: center; gap: 4px; height: 56px; padding: 0 4px; flex: none;
            background: var(--app-header-background-color, var(--primary-color)); color: var(--app-header-text-color, #fff);
            font: 400 20px/1 var(--ha-font-family-body, Roboto, sans-serif); }
          :host([narrow]) header { display: flex; }
          button { all: unset; width: 48px; height: 48px; display: grid; place-items: center; border-radius: 50%; cursor: pointer; }
          button:focus-visible { outline: 2px solid currentColor; }
          svg { width: 24px; height: 24px; fill: currentColor; }
          iframe { flex: 1; width: 100%; border: 0; display: block; }
        </style>
        <header><button type="button" aria-label="Open the Home Assistant menu" title="Menu">
          <svg viewBox="0 0 24 24"><path d="M3,6H21V8H3V6M3,11H21V13H3V11M3,16H21V18H3V16Z"/></svg></button><span>Haven</span></header>
        <iframe title="Haven" allow="fullscreen; clipboard-write"></iframe>`;
      this._root.querySelector("button").addEventListener("click", () =>
        this.dispatchEvent(new Event("hass-toggle-menu", { bubbles: true, composed: true })));
      const cfg = (this._panel && this._panel.config) || {};
      this._root.querySelector("iframe").src = cfg.index || "/haven_panel/index.html";
    }
    this.toggleAttribute("narrow", !!this._narrow);
  }
}
if (!customElements.get("haven-panel")) customElements.define("haven-panel", HavenPanel);
