// Haven dashboard, part 11 of 11: window.Haven (the API page plugins use) and start-up.
// The parts are plain scripts that index.html loads in order; they share one scope (no build step).
// A part can use anything earlier parts declare. Code that runs while the page loads (not inside a
// function called later) must not use a later part.
  // ---------- small API for page plugins (e.g. /static/automations.js) ----------
  window.Haven = {
    api, icon, esc, snack, confirmAction, hydrateIcons, val, has, srcLabel, deviceIcon, statusOf, ago,
    get devices() { return devices; }, get role() { return me.role; }, get me() { return { ...me }; },
    setToken: t => { token = t; store("token", t); }, go: id => go(id), openDevice: (id, tab) => openDevicePanel(id, tab || "now"), onMessage: fn => msgHooks.push(fn), timeOpts, rerender: () => { const el = $("#rooms"); delete el.dataset.plugin; schedule(); },
    registerPage(id, page) {
      pluginPages[id] = page; PAGES.add(id); TITLES[id] = page.title || page.label;
      const btn = `<button data-f="${id}"><span class="ind">${icon(page.icon)}</span><span class="lbl">${esc(page.label)}</span></button>`;
      $('#nav [data-f="devices"]').insertAdjacentHTML("afterend", btn);
      $('#more [data-f="devices"]').insertAdjacentHTML("afterend", `<button value="${id}" data-f="${id}">${icon(page.icon)}${esc(page.label)}</button>`);
      if (view === id) schedule();
    },
  };
  document.dispatchEvent(new Event("haven:ready"));

  hydrateIcons();
  document.body.dataset.cardStyle = cardStyle;
  applyMode(load("mode", "auto"));
  function start() {
    loadHistInfo();      // after /api/me: a session that must change its password first can't read it yet
    fetch("/api/config", { headers: authHdr() }).then(r => r.json()).then(c => {
      if (c.ui?.title) { appTitle = c.ui.title; document.title = appTitle; }
      if (c.edition && c.edition !== edition) { edition = c.edition; applyNavPrefs(); }
      const tf = c.time_format || c.time?.time_format, tz = c.timezone || c.time?.timezone;
      timeCfg = { hour12: tf === "12h" ? true : tf === "24h" ? false : undefined, timeZone: tz || undefined };
      try { new Intl.DateTimeFormat([], timeOpts()); } catch { timeCfg.timeZone = undefined; }   // ignore an invalid zone
      storageBanner(c.storage_problem);
      renderHeader(); }).catch(() => {});
    if (view === "settings") loadSettings();
    if (view === "power") loadPower();
    renderHeader();
    setInterval(renderHeader, 15000);
    setInterval(() => !PAGES.has(view) && scheduleQuiet(), 30000);
    // background tabs and phones with the screen off don't poll: everything refreshes when the page is seen again
    const shown = () => !document.hidden;
    setInterval(() => shown() && loadSparks(), 300000);
    setInterval(() => shown() && view === "power" && loadPower(), 10000);
    setInterval(() => shown() && loadStatus(), 15000);
    document.addEventListener("visibilitychange", () => { if (shown()) { loadStatus(); if (view === "power") loadPower(); } });
    loadStatus();
    setInterval(loadHa, 15000);   // standby / fault banner
    loadHa();
    connect();
  }
  function applyRole() {
    document.body.dataset.role = me.role;
    const ab = $("#account-btn"), vo = $("#viewonly");
    if (ab) ab.title = ab.ariaLabel = me.guest ? "Viewing without signing in" : `${me.user} · ${{ admin: "Admin", user: "Regular", monitor: "Monitor" }[me.role]}`;
    if (vo) { vo.hidden = me.role !== "monitor"; $("#viewonly-signin").onclick = () => window.HavenAccounts?.showLogin({ keepSession: true, cancelable: true }); }
    if (!isAdmin() && editing()) setEditing(false);
  }
  async function boot() {
    document.body.dataset.role = "monitor";
    if (!token) return askToken();
    let r;
    try { r = await fetch("/api/me", { headers: authHdr() }); } catch { return setTimeout(boot, 3000); }   // server restarting
    if (r.status === 429 || r.status >= 500) return setTimeout(boot, 5000);
    if (!r.ok) return askToken();
    me = await r.json();
    if (me.must_change) return window.HavenAccounts?.showMustChange(me, token);   // first sign-in: own password first
    applyRole(); start();
  }
  boot();
