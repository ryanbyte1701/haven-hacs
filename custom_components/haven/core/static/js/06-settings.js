// Haven dashboard, part 6 of 11: Settings: lists, sections, Smart assignment, Ecowitt, Home page & menu, high availability.
// The parts are plain scripts that index.html loads in order; they share one scope (no build step).
// A part can use anything earlier parts declare. Code that runs while the page loads (not inside a
// function called later) must not use a later part.
  // ---------- settings page ----------
  let settingsData = null;
  async function loadSettings() {
    TITLES.settings = isAdmin() ? "Settings" : "Account";
    if (!isAdmin()) { settingsData = { sections: [], file: "" }; settingsSub = "account"; if (view === "settings") renderSettings(); return; }
    try { settingsData = await api("/api/settings"); } catch (e) { settingsData = { error: e.message }; }
    if (view === "settings") renderSettings();
  }
  // friendlier words for a few values and hints the server sends
  const OPTION_LABEL = { sqlite: "SQLite (built in, recommended)", memory: "Memory (last 24 h only)", prometheus: "Prometheus (separate server)", "12h": "12-hour (1:42 PM)", "24h": "24-hour (13:42)",
    sftp: "SFTP (recommended)", scp: "SCP", ftps: "FTPS (FTP with TLS)", ftp: "FTP (not encrypted)",
    manual: "Off (only when I click Back up now)", every_6h: "Every 6 hours", daily: "Daily", weekly: "Weekly (Sundays)",
    nextTransition: "Until the next schedule change", indefinite: "Until I resume the schedule" };
  const STORE_LABEL = { sqlite: "saved on the NAS", memory: "last 24 h only", prometheus: "Prometheus" };
  const plainHelp = t => String(t || "").replace(/^IANA name like /, "Time zone, e.g. ").replace(/use an IANA name such as/, "use a time zone such as");
  function fieldHtml(sec, f) {
    const v = sec.values[f.key];
    const id = `${sec.id}--${f.key}`;
    const help = f.help ? `<small class="fhelp">${esc(plainHelp(f.help))}</small>` : "";
    if (f.type === "bool") return `<label class="check field"><input type="checkbox" data-key="${f.key}" ${v ? "checked" : ""}><span>${esc(f.label)}</span></label>${help}`;
    if (f.type === "select") return `<label class="textfield"><select data-key="${f.key}" id="${id}">${f.options.map(o => `<option value="${esc(o)}" ${o === v ? "selected" : ""}>${esc(OPTION_LABEL[o] || o)}</option>`).join("")}</select><span>${esc(f.label)}</span></label>${help}`;
    if (f.type === "servers") return `<div class="servers" data-key="${f.key}"><div class="field-label">${esc(f.label)}</div>${(v || []).map(serverRow).join("")}
      <button type="button" class="text-btn" data-add-server>${icon("add")} Add UPS</button></div>`;
    if (f.type === "toggles") {       // one switch per choice; the value lists the ids that are on (mode on) or off (mode off)
      const cur = new Set(Array.isArray(v) ? v : []), offMode = f.mode === "off";
      const opts = [...(sec.choices?.[f.key] || (f.options || []).map(o => ({ id: o, label: o })))];
      for (const id of cur) if (offMode && !opts.some(o => o.id === id)) opts.push({ id, label: id, count: 0 });
      const rows = opts.map(o => { const on = o.locked ? false : offMode ? !cur.has(o.id) : cur.has(o.id);
        return `<div class="tg-row ${o.locked ? "locked" : ""}"><span><b>${esc(o.label)}</b>${o.count != null || o.locked ? `<small class="muted">${o.locked ? esc(o.locked) : `${o.count} device${o.count === 1 ? "" : "s"}`}</small>` : ""}</span>
          <button type="button" class="m3-switch ${on ? "on" : ""}" role="switch" aria-checked="${on}" data-tg="${esc(o.id)}" aria-label="${esc(o.label)}" ${o.locked ? "disabled" : ""}></button></div>`; }).join("");
      return `<div class="toggles" data-key="${f.key}" data-mode="${offMode ? "off" : "on"}"><div class="field-label">${esc(f.label)}</div>
        ${rows || `<p class="muted small">${sec.enabled ? "Nothing found yet: press Refresh now, then reopen this page." : "Turn this integration on to see what Home Assistant has."}</p>`}${help}</div>`;
    }
    if (f.type === "hostlist") {
      const items = Array.isArray(v) ? v : String(v || "").split(/[\s,;]+/).filter(Boolean);
      return `<div class="hostlist" data-key="${f.key}" data-item-label="${esc(f.item_label || "IP address")}"><div class="field-label">${esc(f.label)}</div>
        ${(items.length ? items : [""]).map(h => hostRow(h, f.item_label)).join("")}
        <button type="button" class="text-btn" data-add-host>${icon("add")} ${esc(f.add_label || "Add")}</button>${help}</div>`;
    }
    if (f.multiline) return `<label class="textfield"><textarea data-key="${f.key}" id="${id}" rows="4" spellcheck="false" autocomplete="off" style="width:100%;min-height:96px;padding:16px;border-radius:var(--shape-xs);border:1px solid var(--md-outline);background:transparent;color:var(--md-on-surface);font:13px/1.4 ui-monospace,monospace;resize:vertical;outline:none">${esc(v ?? "")}</textarea><span style="top:-9px;font-size:12px">${esc(f.label)}</span></label>${help}`;
    const type = f.type === "password" ? "password" : f.type === "number" ? "number" : "text";
    const value = f.type === "list" ? (v || []).join(", ") : v ?? "";
    return `<label class="textfield"><input type="${type}" data-key="${f.key}" id="${id}" value="${esc(value)}" placeholder=" " autocomplete="${type === "password" ? "new-password" : "off"}"><span>${esc(f.label)}</span></label>${help}`;
  }
  const hostRow = (h = "", label = "IP address") => `<div class="host-row"><label class="textfield"><input type="text" data-hkey value="${esc(h)}"
      placeholder=" " autocomplete="off" autocapitalize="none" spellcheck="false" inputmode="url"><span>${esc(label)}</span></label>
    <button type="button" class="icon-btn" data-del-host aria-label="Remove ${esc(h || label)}">${icon("delete")}</button></div>`;
  const serverRow = (s = {}) => `<div class="server-row">
    ${[["name", "Name", "text"], ["host", "IP address", "text"], ["port", "Port", "number"], ["ups", "UPS name (optional)", "text"],
       ["username", "Username (optional)", "text"], ["password", "Password (optional)", "password"], ["room", "Room", "text"]].map(([k, l, t]) =>
      `<label class="textfield"><input type="${t}" data-skey="${k}" value="${esc(s[k] ?? (k === "port" ? 3493 : ""))}" placeholder=" " autocomplete="off"><span>${l}</span></label>`).join("")}
    <button type="button" class="icon-btn" data-del-server aria-label="Remove">${icon("delete")}</button></div>`;
  // Settings: a calm list of rows; each opens its own detail page.
  let settingsSub = null;   // null = list, "appearance", "security" or a section id
  const ADVANCED = new Set(["poll_seconds", "discovery", "discovery_prefix", "passkeys",
    "sample_seconds", "prometheus_url", "metrics_enabled", "metrics_token", "region", "session_token", "access_token"]);
  const DASH_GROUP = new Set(["history", "demo", "time", "ha", "backup"]);
  const isAdv = f => f.advanced || ADVANCED.has(f.key);
  function humanErr(st) {
    if (/errno 98|address already in use/i.test(st)) return "Port already in use";
    if (/name resolution|nodename|getaddrinfo|name or service not known/i.test(st)) return "Can't find that host";
    if (/refused/i.test(st)) return "Connection refused – is the device on?";
    if (/timed? ?out/i.test(st)) return "Timed out – check the address";
    if (/errno 13\]|permission denied|read-?only/i.test(st)) return "Can't write its files – see the details";
    if (/401|403|denied|unauthori[sz]ed|invalid (password|credentials)/i.test(st)) return "Sign-in rejected – check the password";
    const m = st.replace(/^error:\s*/i, "").replace(/\[errno -?\d+\]\s*/i, "");
    return "Problem: " + (m.length > 80 ? m.slice(0, 77) + "…" : m);
  }
  function secStatus(sec) {
    const st = sec.status || "";
    if (!sec.enabled) return ["Off", "off"];
    if (sec.id === "ha") {   // "active: holds 192.168.1.50", "standby: 192.168.1.20 is active", "fault: …"
      const [k, ...rest] = st.split(": "), more = rest.join(": ");
      const lbl = { active: "Active", standby: "Standby", starting: "Starting", fault: "Fault" }[k];
      return lbl ? [lbl + (more ? ` · ${more}` : ""), HA_TONE[k]] : ["Starting…", "info"];
    }
    if (sec.id === "history" && /^error: can't reach Prometheus/i.test(st)) return ["Prometheus unreachable · last 24 h from memory", "bad"];
    if (/needs|sign-in|pairing/i.test(st)) return [st.replace(/\s*\(.*\)$/, "").replace(/^needs/, "Needs"), "warn"];
    if (/error|refused|failed|denied|timed out/i.test(st)) return [humanErr(st), "bad"];
    if (sec.id === "backup" && /^ok/.test(st)) { const m = st.replace(/^ok:?\s*/, ""); return [m ? m[0].toUpperCase() + m.slice(1) : "On", "good"]; }
    if (/^ok/.test(st)) { const b = st.replace(/^ok:?\s*/, ""); return [sec.id === "history" ? `On · ${STORE_LABEL[b] || b || "saving"}` : sec.id === "demo" ? "On" : "Connected", "good"]; }
    return [st ? st[0].toUpperCase() + st.slice(1) : "Starting…", "info"];
  }
  // ---------- Appearance preview: sample devices drawn by the real card and chart code, so it always matches ----------
  function previewDevices() {
    const now = Date.now() / 1000, c = (name, value, extra = {}) => [name, { name, value, writable: false, updated: now - 120, ...extra }];
    const dev = (id, name, room, caps, attributes = {}) => ({ id: "preview:" + id, name, room, source: "homeassistant", model: "", online: true, hidden: false,
      attributes, card_style: null, capabilities: Object.fromEntries(caps) });
    return [
      dev("lamp", "Living Room Lamp", "Living Room", [c("light", true, { writable: true }), c("brightness", 70, { writable: true, unit: "%", min: 0, max: 100 }),
        c("color_temp", 2900, { writable: true, unit: "K", min: 2000, max: 6500 })]),
      dev("climate", "Bedroom", "Bedroom", [c("temperature", 21.4, { unit: "°C" }), c("humidity", 44, { unit: "%" }), c("battery", 86, { unit: "%" })]),
      dev("lock", "Front Door", "Entry", [c("lock", "locked", { writable: true, options: ["locked", "unlocked"] }), c("battery", 64, { unit: "%" })]),
      dev("door", "Back Door", "Kitchen", [c("contact", "open")], { kind: "door" }),
      dev("plug", "Coffee Maker", "Kitchen", [c("switch", true, { writable: true }), c("power", 845, { unit: "W" })], { kind: "smart_plug" }),
      dev("leak", "Sink Leak", "Kitchen", [c("leak", false), c("battery", 92, { unit: "%" })]),
    ];
  }
  function previewHtml() {
    const list = previewDevices(), now = Date.now() / 1000;
    // a day of bedroom readings, with a three-hour gap (a sensor that reports now and then)
    const pts = []; for (let i = 0; i <= 96; i++) { const t = now - 86400 + i * 900; if (i > 40 && i < 52) continue;
      pts.push({ t, v: 20.5 + Math.sin(i / 9) * 1.2 + (i % 7) * 0.05 }); }
    sparks.set("preview:climate|temperature", pts.map(p => ({ t: p.t, v: p.v })));
    let chart = ""; try { chart = numChart(list[1], "temperature", pts, now - 86400, now); } catch { chart = ""; }
    const cards = mode === "table" ? tableView(list) : `<div class="grid prev-grid">${list.map(card).join("")}</div>`;
    return `<aside class="set-card appear-prev" aria-label="Preview">
      <div class="prev-head"><h3>Preview</h3><small class="muted">Sample devices · ${esc((CARD_STYLES.find(s => s[0] === cardStyle) || CARD_STYLES[0])[1])} cards · ${mode === "table" ? "Table" : "Cards"}</small></div>
      <div class="prev-body" inert>
        <section class="room"><h2>Kitchen &amp; more</h2>${cards}</section>
        <div class="prev-chart"><div class="prev-label">History · Bedroom temperature</div>${chart}</div>
        <div class="prev-controls"><button type="button" class="filled-btn">${icon("check")}Save</button><button type="button" class="tonal-btn">Cancel</button>
          <button type="button" class="fchip on">${icon("check")}Selected</button><button type="button" class="fchip">Filter</button>
          <span class="m3-switch on" role="switch" aria-checked="true"></span><span class="m3-switch" role="switch" aria-checked="false"></span></div>
      </div></aside>`;
  }

  function appearanceSummary() {
    return [{ light: "Light", dark: "Dark", auto: "Auto" }[load("mode", "auto")], root.dataset.seed[0].toUpperCase() + root.dataset.seed.slice(1),
      `°${unit}`, `${(CARD_STYLES.find(s => s[0] === cardStyle) || CARD_STYLES[0])[1]} cards`, mode === "table" ? "Table" : "Cards",
      `${(CHART_STYLES.find(c => c[0] === chartStyle) || CHART_STYLES[0])[1]} charts`, load("groupByDefault", "room") === "type" ? "By type" : ""].filter(Boolean).join(" · ");
  }
  // ---------- Settings → Smart assignment: suggested page and room changes, applied only once approved ----------
  const SA_WINDOW = /\b(blinds?|shades?|curtains?|drapes?|shutters?|awnings?|windows?|skylights?)\b/i;
  const SA_DOOR = /\b(doors?|gates?|garage)\b/i;
  const SA_APPLIANCE = /\b(washer|washing machine|dryer|fridge|refrigerator|freezer|dishwasher|oven|range|microwave|water heater|hood)\b/i;
  const SA_LAMP = /\b(lamps?|lights?|sconces?|chandelier|pendant|bulbs?|led strip)\b/i;
  let saOff = new Set();                 // suggestions the user unticked
  const tabName = t => (TABS.find(x => x[0] === t) || [, t])[1];
  function smartSuggestions() {
    const out = [], all = [...devices.values()].filter(d => !d.hidden);
    const rooms = [...new Set(all.map(d => d.room).filter(r => r && r !== "Other"))].sort((a, b) => b.length - a.length);
    const reEsc = x => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const roomRe = new Map(rooms.map(r => [r, [new RegExp(`(^|\\b)${reEsc(r)}\\b`, "i"), new RegExp(`^${reEsc(r)}\\b`, "i"), new RegExp(reEsc(r), "i")]]));
    for (const d of all) {
      const text = `${d.name} ${(d.attributes?.ha_entities || []).join(" ").replace(/[._]/g, " ")}`;
      const cur = tabsOf(d), auto = autoTabs(d), custom = Array.isArray(d.categories);
      let next = [...cur]; const why = [];
      const add = t => { if (!next.includes(t)) next.push(t); }, drop = t => { next = next.filter(x => x !== t); };
      const same = (a, b) => a.length === b.length && a.every(x => b.includes(x));
      if (cur.some(t => !TAB_IDS.includes(t))) { next = next.filter(t => TAB_IDS.includes(t)); why.push("the Controls page was removed"); }
      if (isPool(d)) {            // pool devices live on Pool alone
        if (!same(next, ["pool"])) { next = ["pool"]; why.push(srcLabel(d) === "WaterGuru" ? "it's a WaterGuru pool device" : `the name mentions "pool"`); }
      } else {
      if (next.includes("climate") && ["leak", "water", "valve"].includes(deviceType(d))) { drop("climate"); why.push("water temperature isn't room climate"); }
      if (next.includes("switches") && !typeMatch(d, "switches")) { drop("switches");
        why.push(has(d, "light") ? "it's a light, not a light switch or plug" : "Switches is only for smart plugs and light switches"); }
      if (!next.includes("switches") && typeMatch(d, "switches") && has(d, "light")) { add("switches"); why.push("its name says it's a light switch"); }
      if (cur.includes("doors") && !isWindow(d) && SA_WINDOW.test(d.name) && !SA_DOOR.test(d.name)) {
        drop("doors"); add("windows"); why.push(`the name mentions "${(d.name.match(SA_WINDOW) || ["window"])[0].toLowerCase()}"`); }
      else if (cur.includes("windows") && !isShade(d) && SA_DOOR.test(d.name) && !SA_WINDOW.test(d.name)) {
        drop("windows"); add("doors"); why.push("the name says it's a door"); }
      if (edition === "hacs" && SA_APPLIANCE.test(text) && !["vehicle", "network"].includes(kindOf(d)) && !cur.includes("appliances")) {
        add("appliances"); if (has(d, "contact")) { drop("doors"); drop("windows"); drop("security"); }
        why.push(`it looks like an appliance (${(text.match(SA_APPLIANCE) || [""])[0].toLowerCase()})`); }
      if (!isLight(d) && d.capabilities.switch?.writable && SA_LAMP.test(d.name) && !cur.includes("lights")) { add("lights"); why.push("it switches a lamp"); }
      // every recognised type has a home page: smoke alarms and locks in Security, leak sensors in Water…
      const ty = deviceType(d), home = { smoke: "security", alarm: "security", lock: "security", motion: "security", camera: "security",
        leak: "water", valve: "water", water: "water", thermostat: "climate", climate: "climate", light: "lights", shade: "windows",
        door: isWindow(d) ? "windows" : "doors", plug: typeMatch(d, "switches") ? "switches" : "", vacuum: edition === "hacs" ? "appliances" : "", purifier: "climate" }[ty];
      if (home && !next.includes(home) && !(home === "lights" && why.length)) {
        add(home); if (home === "windows") drop("doors");
        why.push(`Haven recognises it as ${(TYPE_INFO[ty] || TYPE_INFO.other)[1].toLowerCase()}${["smoke", "lock"].includes(ty) ? ", which belong in Security" : ""}`); }
      }
      if (why.length && !same(next, cur)) {
        const gone = cur.filter(t => !next.includes(t)).map(tabName), added = next.filter(t => !cur.includes(t)).map(tabName);
        out.push({ key: `tabs:${d.id}`, id: d.id, body: same(next, auto) ? { auto_categories: true } : { categories: TAB_IDS.filter(t => next.includes(t)) },
          title: d.name, change: [added.length ? `Add to ${added.join(", ")}` : "", gone.length ? `remove from ${gone.join(", ")}` : ""].filter(Boolean).join(", "),
          why: why.join("; "), on: true });
      } else if (custom && same(cur, auto)) {
        out.push({ key: `auto:${d.id}`, id: d.id, body: { auto_categories: true }, title: d.name, change: "Back to automatic pages",
          why: "your manual pages are the same as what Haven picks, so it can keep up by itself", on: true });
      }
      // rooms: a device without one whose name starts with (or contains) a room's name
      const hit = rooms.find(r => roomRe.get(r)[0].test(d.name));
      if ((!d.room || d.room === "Other") && hit) out.push({ key: `room:${d.id}`, id: d.id, body: { room: hit }, title: d.name,
        change: `Put in ${hit}`, why: "it has no room and its name mentions this one", on: true });
      else if (d.room && hit && hit !== d.room && roomRe.get(hit)[1].test(d.name) && !(roomRe.get(d.room)?.[2] || new RegExp(reEsc(d.room), "i")).test(d.name))
        out.push({ key: `room:${d.id}`, id: d.id, body: { room: hit }, title: d.name, change: `Move from ${d.room} to ${hit}`,
          why: "its name starts with another room (off until you tick it: it may be on purpose)", on: false });
    }
    return out.sort((a, b) => a.title.localeCompare(b.title));
  }
  const saOn = sg => saOff.has(sg.key) ? false : sg.on || saOff.has("+" + sg.key);
  function smartHtml() {
    const sg = smartSuggestions(), picked = sg.filter(saOn);
    const rows = sg.map(x => { const on = saOn(x), [ic, tone] = devices.get(x.id) ? deviceIcon(devices.get(x.id)) : ["sensors", ""];
      return `<label class="sa-row ${on ? "on" : ""}"><input type="checkbox" data-sa="${esc(x.key)}" ${on ? "checked" : ""}>
        <span class="avatar ${tone}">${icon(ic, !!tone)}</span><span class="ltext"><b>${esc(x.title)}</b><span class="sa-change">${esc(x.change)}</span><small>Because ${esc(x.why)}</small></span></label>`; }).join("");
    return `<div class="dhead"><span class="avatar big">${icon("wand_stars")}</span><div><h2>Smart assignment</h2><small>Suggested pages and rooms · nothing changes until you approve</small></div></div>
      <section class="set-card">
        <p class="muted small">Haven looks at every device's name and what it reports and suggests where it belongs: blinds and windows on Windows instead of Doors, appliances on Appliances, lamps on smart plugs on Lights, a room for devices without one. Tick the ones you want and press Apply. You can undo any of them later from the device's edit menu.</p>
        ${sg.length ? `<div class="sa-bar"><button type="button" class="text-btn" data-sa-all="1">Select all</button><button type="button" class="text-btn" data-sa-all="0">Select none</button>
          <span style="flex:1"></span><button type="button" class="text-btn" data-sa-rescan>${icon("sync")}Check again</button></div>
          <div class="sa-list">${rows}</div>
          <div class="set-actions"><span class="muted small">${picked.length} of ${sg.length} selected</span><span style="flex:1"></span>
            <button type="button" class="filled-btn" data-sa-apply ${picked.length ? "" : "disabled"}>${icon("check")}Apply ${picked.length || ""}</button></div>`
        : `<div class="sa-empty">${icon("check_circle", true)}<span>Everything looks assigned. Check again after adding devices.</span></div>`}
      </section>`;
  }
  async function smartApply(btn) {
    const sg = smartSuggestions().filter(saOn); if (!sg.length) return;
    btn.disabled = true;
    const by = {};
    for (const x of sg) { const b = by[x.id] ||= {}; Object.assign(b, x.body); if (b.categories && b.auto_categories) delete b.auto_categories; }
    let ok = 0, fail = 0;
    for (const [id, body] of Object.entries(by)) {
      try { devices.set(id, await api(`/api/devices/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(body) })); ok++; }
      catch { fail++; }
    }
    saOff = new Set();
    snack(fail ? `Applied ${ok} change${ok === 1 ? "" : "s"}; ${fail} failed` : `Applied ${ok} change${ok === 1 ? "" : "s"}`);
    renderBadges(); renderSettings();
  }

  function renderSettings() {
    $("#summary").innerHTML = ""; $("#alerts").innerHTML = "";
    if (!settingsData) { $("#rooms").innerHTML = `<p class="empty">Loading…</p>`; return; }
    if (settingsData.error) { $("#rooms").innerHTML = `<p class="empty">${esc(settingsData.error)}</p>`; return; }
    if (!isAdmin()) settingsSub = "account";
    if (settingsSub) return renderSettingsDetail();
    const row = (key, ic, title, sub, tone = "", extra = "") => `<button type="button" class="lrow" data-open-setting="${key}">
        <span class="avatar ${tone === "off" ? "dim" : ""}">${icon(ic)}</span>
        <span class="ltext"><b>${esc(title)}</b><small class="lstat ${tone}">${tone && tone !== "off" ? "<i></i>" : ""}<span>${esc(sub)}</span></small></span>${extra}${icon("chevron_right")}</button>`;
    const accounts = settingsData.sections.filter(s => !DASH_GROUP.has(s.id));
    const on = accounts.filter(s => s.enabled), off = accounts.filter(s => !s.enabled);
    const issues = on.filter(s => ["bad", "warn"].includes(secStatus(s)[1])).length;
    const group = (title, note, rows) => rows ? `<section class="lgroup"><div class="lgroup-head"><h3>${title}</h3>${note ? `<small>${note}</small>` : ""}</div><div class="lcard">${rows}</div></section>` : "";
    const hist = settingsData.sections.find(s => s.id === "history"), demo = settingsData.sections.find(s => s.id === "demo");
    $("#rooms").innerHTML = `<div class="settings-wrap list">
      ${group("Your accounts", `${on.length} on${issues ? ` · ${issues} need${issues === 1 ? "s" : ""} attention` : ""}`, on.map(s => { const [t, tone] = secStatus(s); return row(s.id, s.icon, s.label, t, tone); }).join(""))}
      ${group("Add an account", "", off.map(s => row(s.id, s.icon, s.label, "Off", "off")).join(""))}
      ${group("Dashboard", "", row("home", "dashboard_customize", "Home page & menu", homeSummary()) +
        (() => { const n = smartSuggestions().length; return row("smart", "wand_stars", "Smart assignment", n ? `${n} suggestion${n === 1 ? "" : "s"} to review` : "Everything looks assigned", n ? "warn" : ""); })() + row("appearance", "palette", "Appearance", appearanceSummary()) +
        (() => { const t = settingsData.sections.find(s => s.id === "time"); return t ? row("time", t.icon, t.label, ...secStatus(t)) : ""; })() +
        (hist ? row("history", hist.icon, hist.label, ...secStatus(hist)) : "") + (demo ? row("demo", demo.icon, demo.label, ...secStatus(demo)) : ""))}
      ${(() => { const sys = ["backup", "ha"].map(id => settingsData.sections.find(s => s.id === id)).filter(Boolean);
        return group("System", "", sys.map(h => row(h.id, h.icon, h.label, ...secStatus(h))).join("") + row("diagnostics", "bug_report", "Diagnostics", "Anonymous tech dump for troubleshooting")); })()}
      ${group("Security", "", row("users", "manage_accounts", "Users & access", "Accounts, roles, viewing without signing in") +
        row("account", "person", "Your account", `${me.user || "admin"} · Admin`))}
      <p class="muted small lfoot">Accounts are saved on the server in <code>${esc(settingsData.file)}</code>. Passwords are never sent back to the browser.</p>
    </div>`;
  }
  // ---- Ecowitt gateways: only trusted gateways are listened to ----
  const ecoGw = { data: null, at: 0, loading: false };
  async function loadEcoGateways() {
    ecoGw.loading = true;
    try { ecoGw.data = await api("/api/ecowitt/gateways"); } catch { ecoGw.data = null; }
    ecoGw.loading = false; ecoGw.at = Date.now();
    if (view === "settings" && settingsSub === "ecowitt") renderSettings();
  }
  function ecoGatewaysHtml(g) {
    const ago = t => t ? `${Math.max(0, Math.round((Date.now() / 1000 - t) / 60))} min ago` : "";
    const row = (x, pending) => `<div class="gw-row ${pending ? "pending" : ""}"><span class="avatar ${pending ? "warn" : ""}">${icon(pending ? "help" : "check_circle", !pending)}</span>
      <div class="gw-txt"><b>${x.model ? `${esc(x.model)} <small>PASSKEY ${esc(x.passkey)}</small>` : `Gateway ${esc(String(x.passkey || x.id || "").replace(/^[.…]+/, "…"))}`}</b>
      <small>${pending ? `Sending from ${esc(x.ip || "?")} · ${esc(ago(x.last_seen))} · ${esc(x.count)} report${x.count === 1 ? "" : "s"}` : x.from_config ? "Trusted in config.yaml" : "Trusted"}</small></div>
      ${pending ? `<button type="button" class="tonal-btn" data-eco-approve="${esc(x.id)}">${icon("check")}Trust</button>` : ""}
      ${x.from_config ? "" : `<button type="button" class="icon-btn" data-eco-forget="${esc(x.id)}" aria-label="${pending ? "Ignore" : "Stop trusting"} this gateway">${icon("delete")}</button>`}</div>`;
    return `<div class="gw-list"><h3>Gateways</h3>
      ${g.pending.length ? `<p class="hint warn">${icon("info")}<span>A gateway Haven doesn't know yet is sending data. Its readings are ignored until you trust it. Trust it only if the address matches your gateway's IP (shown in the WS View Plus app).</span></p>` : ""}
      ${g.pending.map(x => row(x, true)).join("")}${g.approved.map(x => row(x, false)).join("")}
      ${!g.pending.length && !g.approved.length ? `<p class="muted small">No gateway has sent data yet.</p>` : ""}</div>`;
  }

  // ---- Home page & menu customization (saved on the server, same on every screen) ----
  let homeDraft = null;
  const PAGE_LIST = [["climate", "Climate"], ["air", "Air quality"], ["lights", "Lights"], ["water", "Water"], ["pool", "Pool"], ["doors", "Doors"], ["windows", "Windows"],
    ["security", "Security"], ["switches", "Switches"], ...(edition === "hacs" ? [["appliances", "Appliances"]] : []), ["battery", "Batteries"], ["power", "Power"], ["devices", "Devices"], ["automations", "Automations"]];
  function homeSummary() {
    const c = homeCfg(), on = ["weather", "climate", "thermostat", "aqi_outdoor", "aqi_indoor"].filter(k => c[k]).length;
    const hidden = (c.hidden_pages || []).length;
    return `${on} cards · ${(c.tiles || []).length} status tiles${hidden ? ` · ${hidden} page${hidden > 1 ? "s" : ""} hidden` : ""}`;
  }
  function homeSettingsHtml() {
    if (!homeDraft) homeDraft = JSON.parse(JSON.stringify(homeCfg()));
    const h = homeDraft, tiles = h.tiles || [];
    const sw = (k, label, sub = "") => `<div class="hrow"><span>${esc(label)}${sub ? `<small class="muted">${esc(sub)}</small>` : ""}</span>
      <button type="button" class="m3-switch ${h[k] !== false ? "on" : ""}" role="switch" aria-checked="${h[k] !== false}" data-hflag="${k}" aria-label="${esc(label)}"></button></div>`;
    const ordered = [...tiles.map(id => HOME_TILES.find(t => t[0] === id)).filter(Boolean), ...HOME_TILES.filter(t => !tiles.includes(t[0]))];
    const tileRows = ordered.map(([id, label, ic]) => { const on = tiles.includes(id), i = tiles.indexOf(id);
      return `<div class="trow ${on ? "" : "off"}">${icon(ic)}<span>${esc(label)}</span>
        ${on ? `<button type="button" class="icon-btn sm" data-hmove="${id}:-1" ${i === 0 ? "disabled" : ""} aria-label="Move ${esc(label)} up">${icon("arrow_upward")}</button>
        <button type="button" class="icon-btn sm" data-hmove="${id}:1" ${i === tiles.length - 1 ? "disabled" : ""} aria-label="Move ${esc(label)} down">${icon("arrow_downward")}</button>` : `<span class="tspace"></span>`}
        <button type="button" class="m3-switch ${on ? "on" : ""}" role="switch" aria-checked="${on}" data-htile="${id}" aria-label="Show ${esc(label)}"></button></div>`; }).join("");
    const hidden = new Set(h.hidden_pages || []);
    const pages = PAGE_LIST.map(([id, label]) => `<label class="pchip ${hidden.has(id) ? "" : "on"}"><input type="checkbox" data-hpage="${id}" ${hidden.has(id) ? "" : "checked"}>${esc(label)}</label>`).join("");
    const startOpts = [["all", "Home"], ...PAGE_LIST.filter(([id]) => !hidden.has(id))].map(([id, l]) => `<option value="${id}" ${(h.start || "all") === id ? "selected" : ""}>${esc(l)}</option>`).join("");
    return `<div class="dhead"><span class="avatar big">${icon("dashboard_customize")}</span><div><h2>Home page & menu</h2><small>Saved on Haven, the same on every screen</small></div></div>
      <section class="set-card"><h3 class="set-h">Top of the Home page</h3>
        ${sw("weather", "Weather", "needs Weather forecast or a weather station")}${sw("forecast", "Forecast for the next days")}
        ${sw("station", "Use my weather station for the current reading", "Ecowitt / outdoor sensor")}
        ${sw("climate", "Inside temperature & humidity")}${sw("thermostat", "Thermostat controls", "mode and temperature for each thermostat")}${sw("aqi_outdoor", "Outdoor air quality")}${sw("aqi_indoor", "Indoor air quality")}</section>
      <section class="set-card"><h3 class="set-h">Status tiles</h3><p class="muted small">Tiles only appear when you have devices for them. Use the arrows to change the order.</p>
        <div class="tlist">${tileRows}</div></section>
      <section class="set-card"><h3 class="set-h">Below the tiles</h3>${sw("favorites", "Favorites", "cards you pinned")}${sw("rooms", "All rooms and devices")}</section>
      <section class="set-card"><h3 class="set-h">Header</h3>${sw("greeting", "Greeting (Good morning…)")}
        <label class="textfield"><input id="htitle" type="text" maxlength="40" value="${esc(h.title || "")}" placeholder=" " autocomplete="off"><span>Dashboard name (default: ${esc(appTitle)})</span></label></section>
      <section class="set-card"><h3 class="set-h">Menu</h3><p class="muted small">Pages you don't use can be hidden from the side menu and the phone's More menu. Home and Settings always stay.</p>
        <div class="pchips">${pages}</div>
        <label class="selrow"><span>Open Haven on</span><select id="hstart">${startOpts}</select></label></section>
      <div class="set-actions"><button type="button" class="text-btn" data-hreset>${icon("restart_alt")}Reset to defaults</button><span style="flex:1"></span>
        <button type="button" class="filled-btn" data-hsave>${icon("save")}Save</button></div>`;
  }
  // Home page & menu: every change is saved right away (no Save needed), so it applies at once on every screen
  function homeSave(note) {
    if (!homeDraft) return;
    homeDraft.title = ($("#htitle")?.value ?? homeDraft.title ?? "").trim(); homeDraft.start = $("#hstart")?.value || homeDraft.start || "all";
    clearTimeout(homeSave.t);
    homeSave.t = setTimeout(() => api("/api/layout", { method: "PUT", body: JSON.stringify({ home: homeDraft }) })
      .then(l => { layout = l; applyNavPrefs(); if (note) snack(note); }).catch(e => snack(`Couldn't save: ${e.message}`)), 250);
  }
  function homeSettingsClick(t) {
    if (!homeDraft) return false;
    const f = t.closest("[data-hflag]"); if (f) { const k = f.dataset.hflag; homeDraft[k] = homeDraft[k] === false; renderSettings(); homeSave(); return true; }
    const tl = t.closest("[data-htile]"); if (tl) { const id = tl.dataset.htile; const a = homeDraft.tiles = [...(homeDraft.tiles || [])];
      a.includes(id) ? a.splice(a.indexOf(id), 1) : a.push(id); renderSettings(); homeSave(); return true; }
    const mv = t.closest("[data-hmove]"); if (mv) { const [id, d] = mv.dataset.hmove.split(":"); const a = homeDraft.tiles = [...homeDraft.tiles];
      const i = a.indexOf(id), j = i + Number(d); if (i >= 0 && j >= 0 && j < a.length) { [a[i], a[j]] = [a[j], a[i]]; } renderSettings();
      $(`[data-hmove="${id}:${d}"]`)?.focus(); homeSave(); return true; }
    if (t.closest("[data-hreset]")) { homeDraft = JSON.parse(JSON.stringify(HOME_DEFAULT)); renderSettings(); homeSave("Defaults restored"); return true; }
    if (t.closest("[data-hsave]")) { homeSave("Home page saved"); return true; }
    return false;
  }
  document.addEventListener("change", e => { if (homeDraft && (e.target.id === "htitle" || e.target.id === "hstart")) homeSave("Saved"); });

  // ---- High availability (beta, app/ha.py): live status card, "Fail over now", banner on a standby ----
  const ha = { data: null, timer: null };
  const HA_TONE = { active: "good", standby: "info", starting: "info", fault: "bad", disabled: "off" };
  const haLabel = s => ({ active: "Active", standby: "Standby", starting: "Starting", fault: "Fault", disabled: "Off", stopping: "Stopping" }[s] || s || "Unknown");
  async function loadHa() {
    try { const r = await fetch("/api/ha/status", { headers: authHdr() }); ha.data = r.ok ? await r.json() : null; } catch { ha.data = null; }
    haBanner();
    const card = $("#ha-card");
    if (card && view === "settings" && settingsSub === "ha") {
      const open = card.querySelector("details")?.open;
      card.outerHTML = haCardHtml();
      if (open) $("#ha-card details").open = true;
    }
  }
  function haWatch() {     // refresh the card every 2 s while its page is open
    if (!ha.data) loadHa();
    if (ha.timer) return;
    ha.timer = setInterval(() => { if (view === "settings" && settingsSub === "ha") loadHa(); else { clearInterval(ha.timer); ha.timer = null; } }, 2000);
  }
  const haVipUrl = d => `${location.protocol}//${d.vip}${location.port ? ":" + location.port : ""}/`;
  function haBanner() {
    const d = ha.data, show = d?.enabled && ["standby", "fault"].includes(d.state);
    let el = $("#ha-banner");
    if (!show) { el?.remove(); return; }
    const html = d.state === "standby"
      ? `${icon("sync")}<span><b>Standby</b> — the active Haven is ${esc(d.peer?.address || "the other NAS")}. Devices and automations run there.</span>
         ${location.hostname === d.vip ? "" : `<a class="text-btn" href="${esc(haVipUrl(d))}">Open ${esc(d.vip)}</a>`}`
      : `${icon("warning")}<span><b>High availability fault.</b> ${esc(d.message || "")}</span>
         ${isAdmin() ? `<button type="button" class="text-btn" data-goto-setting="ha">Details</button>` : ""}`;
    if (!el) { $(".page").insertAdjacentHTML("afterbegin", `<div id="ha-banner" role="status"></div>`); el = $("#ha-banner"); }
    el.className = `ha-banner ${d.state}`;
    if (el._h !== html) { el.innerHTML = html; el._h = html; }
  }
  // Haven can't write its folders on the NAS (admins only): nothing will be saved until that's fixed
  function storageBanner(msg) {
    let el = $("#storage-banner");
    if (!msg) { el?.remove(); return; }
    if (!el) { $(".page").insertAdjacentHTML("afterbegin", `<div id="storage-banner" class="ha-banner fault" role="alert"></div>`); el = $("#storage-banner"); }
    el.innerHTML = `${icon("warning")}<span><b>Settings can't be saved.</b> ${esc(msg)}</span>`;
  }
  function haCardHtml() {
    const d = ha.data;
    if (!d) return `<div class="ha-card" id="ha-card"><p class="muted small">Loading status…</p></div>`;
    if (!d.enabled && d.state !== "fault") return `<div class="ha-card" id="ha-card"><p class="muted small">Off. Fill in the fields below on both NASes (primary first), turn it on and save.</p></div>`;
    const p = d.peer || {}, t = ts => ts ? new Date(ts * 1000).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit", ...timeOpts() }) : "";
    const kv = (label, value, sub = "") => `<div class="ha-kv"><small>${label}</small><b>${value}</b>${sub ? `<span>${sub}</span>` : ""}</div>`;
    const age = p.last_heartbeat_age == null ? "Never" : p.last_heartbeat_age < 1.5 ? "Just now" : `${Math.round(p.last_heartbeat_age)} s ago`;
    const lf = d.last_failover;
    const evs = (d.events || []).map(e => `<li><time>${esc(t(e.ts))}</time><span><b>${esc(haLabel(e.from))} → ${esc(haLabel(e.to))}</b> ${esc(e.reason)}</span></li>`).join("");
    const active = d.state === "active", canFail = active ? p.reachable && p.state === "standby" : d.enabled;
    const hint = (cls, ic, text) => `<p class="hint ${cls}">${icon(ic)}<span>${esc(text)}</span></p>`;
    return `<div class="ha-card ${d.state}" id="ha-card">
      <div class="ha-top"><span class="ha-pill ${d.state}"><i></i>${esc(d.state_label || haLabel(d.state))}</span>
        <small class="muted">since ${esc(t(d.since))}</small>${d.dry_run ? `<span class="ha-pill test">Test mode: no real IP changes</span>` : ""}</div>
      ${d.message ? hint(d.state === "fault" ? "bad" : "", d.state === "fault" ? "error" : "info", d.message) : ""}
      ${d.warning ? hint("warn", "warning", d.warning) : ""}
      ${d.yielding ? hint("", "info", "Handed over: this Haven won't take the virtual IP back until the other one fails or you choose Fail over now.") : ""}
      <div class="ha-grid">
        ${kv("Virtual IP", d.vip ? `${esc(d.vip)}/${esc(d.prefix)}` : "–", d.has_vip ? `Held here${d.interface ? ` on ${esc(d.interface)}` : ""}` : `Not held here${d.interface ? ` · ${esc(d.interface)}` : ""}`)}
        ${kv("Other Haven", esc(p.address || "–"), p.reachable ? `${esc(haLabel(p.state))} · priority ${esc(p.priority)}` : esc(p.problem || "Not answering"))}
        ${kv("Last heartbeat", age, p.rtt_ms != null && p.reachable ? `${esc(p.rtt_ms)} ms round trip` : "")}
        ${kv("This Haven", `${esc(d.role === "standby" ? "Standby" : "Primary")} · priority ${esc(d.priority)}`, d.preempt ? "Preempt on" : "Preempt off")}
        ${kv("Last failover", lf ? esc(t(lf.ts)) : "None yet", lf ? esc(lf.to === "this" ? "To this Haven" : "To the other Haven") : "")}
        ${kv("Settings copy", !d.sync?.enabled ? "Off" : active ? "Source" : d.sync.error ? "Failed" : d.sync.last ? esc(t(d.sync.last)) : "Waiting",
          !d.sync?.enabled ? "" : active ? "The standby copies from here" : esc(d.sync.error || "From the active Haven"))}
      </div>
      <details class="ha-events"><summary>${icon("schedule")}Recent changes (${(d.events || []).length})</summary><ol>${evs || `<li class="muted">None yet</li>`}</ol></details>
      <div class="set-actions"><small class="muted">${active ? "Hands the virtual IP to the other Haven." : "Takes the virtual IP from the other Haven."}</small><span style="flex:1"></span>
        <button type="button" class="tonal-btn" data-ha-failover ${canFail ? "" : "disabled"}>${icon("sync")}Fail over now</button></div>
    </div>`;
  }
  // "Pair automatically (from the primary)": sign in to a freshly installed backup and make it the standby
  const haPair = { backup: "", username: "admin", password: "haven-admin", my: "", vip: "", prefix: "", msg: "", tone: "", busy: false, myEdited: false };
  function haPairHtml(sec) {
    const v = sec.values || {}, p = haPair;
    if (!p.vip && v.vip) p.vip = v.vip;
    const standbyHere = sec.enabled && v.role === "standby";
    const tf = (k, label, type = "text", ac = "off", extra = "") => `<label class="textfield"><input type="${type}" data-pk="${k}" value="${esc(p[k])}" placeholder=" " autocomplete="${ac}" autocapitalize="none" spellcheck="false" ${extra}><span>${label}</span></label>`;
    return `<section class="ha-pair" id="ha-pair">
      <h3 class="ha-h">${icon("sync")}Pair automatically (from the primary)</h3>
      <p class="muted small ha-hp">${standbyHere ? "This Haven is set up as a standby. Run this on the primary instead." :
        "Do this on the Haven that should be the primary. The backup only needs to be installed with the high-availability compose file: Haven signs in to it, gives it the shared secret and virtual IP, makes it the standby, and copies your accounts and settings to it."}</p>
      <div class="set-fields">
        ${tf("backup", "Backup Haven's address (its own IP)", "text", "off", 'inputmode="url"')}
        ${tf("username", "Backup's admin username", "text", "off")}
        ${tf("password", "Backup's admin password", "password", "new-password")}
        <small class="fhelp">A fresh install uses admin / haven-admin unless HAVEN_ADMIN_USER / HAVEN_ADMIN_PASSWORD are set in its compose file.</small>
        ${tf("vip", "Virtual IP address", "text", "off", 'inputmode="decimal"')}
      </div>
      <details class="adv"><summary>Advanced</summary><div class="set-fields">
        ${tf("my", "This Haven's address, as the backup reaches it")}
        <small class="fhelp">Filled in automatically from the route to the backup. Change it if the backup must use another IP or port.</small>
        ${tf("prefix", "Prefix length (empty = 24 or the current one)", "number")}
      </div></details>
      ${p.msg ? `<p class="hint ${p.tone}">${icon(p.tone === "bad" ? "error" : p.tone === "good" ? "check_circle" : "info")}<span>${esc(p.msg)}</span></p>` : ""}
      <div class="set-actions"><span style="flex:1"></span><button type="button" class="tonal-btn" data-ha-adopt ${p.busy ? "disabled" : ""}>${icon("sync")}${p.busy ? "Pairing…" : "Make it my standby"}</button></div>
    </section>`;
  }
  function haPairRedraw() { const el = $("#ha-pair"), sec = settingsData?.sections.find(x => x.id === "ha"); if (el && sec) { const open = el.querySelector("details")?.open; el.outerHTML = haPairHtml(sec); if (open) $("#ha-pair details").open = true; } }
  document.addEventListener("input", e => { if (e.target.id === "pagesearch-input") { pageQuery = e.target.value; clearTimeout(renderSearch.t); renderSearch.t = setTimeout(schedule, 120); } });
  document.addEventListener("input", e => { const i = e.target.closest?.("[data-pk]"); if (!i) return; haPair[i.dataset.pk] = i.value; if (i.dataset.pk === "my") haPair.myEdited = true; });
  document.addEventListener("change", async e => {
    const i = e.target.closest?.('[data-pk="backup"]'); if (!i || !i.value.trim() || haPair.myEdited) return;
    try { const d = await api(`/api/ha/adopt_defaults?backup=${encodeURIComponent(i.value.trim())}`);
      if (d.my_address && !haPair.myEdited) { haPair.my = d.my_address; const m = $('[data-pk="my"]'); if (m) m.value = d.my_address; } } catch {}
  });
  async function haAdopt(force = false) {
    const p = haPair;
    if (!p.backup.trim()) { p.msg = "Enter the backup Haven's address."; p.tone = "bad"; return haPairRedraw(); }
    if (!p.vip.trim()) { p.msg = "Enter the virtual IP both Havens will share."; p.tone = "bad"; return haPairRedraw(); }
    p.busy = true; p.msg = `Signing in to ${p.backup.trim()} and setting it up…`; p.tone = ""; haPairRedraw();
    let r, d;
    try {
      r = await fetch("/api/ha/adopt_backup", { method: "POST", headers: { "Content-Type": "application/json", ...authHdr() },
        body: JSON.stringify({ backup: p.backup.trim(), username: p.username.trim(), password: p.password, my_address: p.my.trim(),
          vip: p.vip.trim(), prefix: p.prefix ? Number(p.prefix) : null, force }) });
      d = await r.json().catch(() => ({}));
    } catch { r = null; d = { detail: "Can't reach this Haven." }; }
    p.busy = false;
    if (r?.status === 409 && d.needs_confirm) {
      haPairRedraw();
      if (await confirmAction("Replace the backup's pairing?", `${d.detail} It will become this Haven's standby instead.`, "sync")) return haAdopt(true);
      p.msg = "Not paired: the backup keeps its current pairing."; p.tone = ""; return haPairRedraw();
    }
    if (!r?.ok) { p.msg = typeof d.detail === "string" ? d.detail : "Pairing failed."; p.tone = "bad"; return haPairRedraw(); }
    p.msg = `Paired. ${p.backup.trim()} is now this Haven's standby` + (d.backup_state ? ` (it reports: ${haLabel(d.backup_state)})` : "") + "." +
      (d.secret_generated ? " A new shared secret was created and saved on both." : "") +
      (d.backup_fault ? ` The backup can't hold the virtual IP yet: ${d.backup_fault}` : " Your accounts and settings are copied to it within a few seconds.");
    p.tone = d.backup_fault ? "warn" : "good"; p.password = "";
    snack("Backup paired"); ha.data = d.status || ha.data; await loadSettings(); loadHa();
  }

  async function haFailover() {
    const d = ha.data; if (!d) return;
    const active = d.state === "active";
    if (!(await confirmAction(active ? "Hand over to the other Haven?" : "Take over now?",
      active ? `${d.peer?.address || "The other Haven"} becomes active and takes ${d.vip}. This Haven goes on standby and stops its integrations and automations.`
        : `This Haven becomes active and takes ${d.vip}. The other Haven goes on standby.`, "sync", active ? "Hand over" : "Take over"))) return;
    try { await api("/api/ha/failover", { method: "POST", body: JSON.stringify({ action: active ? "handover" : "takeover" }) });
      snack(active ? "Handing over…" : "Taking over…"); } catch (e) { snack(e.message); }
    setTimeout(loadHa, 700); setTimeout(loadHa, 3000);
  }

  function renderSettingsDetail() {
    const back = `<button type="button" class="backbtn" data-settings-back>${icon("arrow_back")}Settings</button>`;
    let body = "";
    if (settingsSub === "home") {
      body = homeSettingsHtml();
    } else if (settingsSub === "appearance") {
      const pref = load("mode", "auto");
      const seg = (id, items, cur, attr) => `<div class="segmented" id="${id}">${items.map(([v, l, ic]) => `<button type="button" data-${attr}="${v}" class="${cur === v ? "on" : ""}">${ic ? icon(ic) : ""}${l}</button>`).join("")}</div>`;
      body = `<div class="dhead"><span class="avatar big">${icon("palette")}</span><div><h2>Appearance</h2><small>Saved on this device only</small></div></div>
        <div class="appear-wrap">${previewHtml()}
        <section class="set-card" id="appearance">
          <div class="frow"><span>Theme</span>${seg("mode-seg", [["light", "Light", "light_mode"], ["dark", "Dark", "dark_mode"], ["auto", "Auto", "brightness_auto"]], pref, "mode")}</div>
          <div class="frow"><span>Color</span><div class="swatches" id="swatches">${Object.entries(SEEDS).map(([n, c]) =>
            `<button type="button" class="swatch ${root.dataset.seed === n ? "on" : ""}" data-seed="${n}" style="background:${c}" title="${n}">${root.dataset.seed === n ? icon("check_circle", true) : ""}</button>`).join("")}</div></div>
          <div class="frow"><span>Temperature</span>${seg("unit-seg", [["F", "°F"], ["C", "°C"]], unit, "unit")}</div>
          <div class="frow frow-wrap"><span>Card style</span><div id="style-seg" class="style-pick" role="radiogroup" aria-label="Card style">${CARD_STYLES.map(([v, l, ic]) =>
            `<button type="button" role="radio" aria-checked="${cardStyle === v}" class="fchip ${cardStyle === v ? "on" : ""}" data-cstyle="${v}">${icon(ic)}${l}</button>`).join("")}</div></div>
          <p class="muted small">A single device can have its own style: tap Edit on its card.</p>
          <div class="frow chartrow"><span>Charts</span><div class="chart-picks" id="chart-seg">${CHART_STYLES.map(([k, l]) => `<button type="button" class="chart-pick ${chartStyle === k ? "on" : ""}" data-chart="${k}" aria-pressed="${chartStyle === k}">
            <svg viewBox="0 0 72 28" class="spark c-${k}" preserveAspectRatio="none">${plotSvg([[[0, 20], [9, 14], [18, 17], [27, 8], [36, 11], [45, 5], [54, 13], [63, 9], [72, 12]]], 28, k, 5)}</svg><small>${l}</small></button>`).join("")}</div></div>
          <div class="frow"><span>Connect readings<small class="muted">draw a line across gaps between readings (devices that report now and then)</small></span>
            <button type="button" class="m3-switch ${joinGaps ? "on" : ""}" role="switch" aria-checked="${joinGaps}" data-joingaps aria-label="Connect readings across gaps"></button></div>
          <div class="frow"><span>Layout</span>${seg("layout-seg", [["cards", "Cards", "grid_view"], ["table", "Table", "table_rows"]], mode, "layout")}</div>
          <div class="frow"><span>Group by<small class="muted">for pages you haven't set yet</small></span>${seg("groupby-seg", [["room", "Room", "door_front"], ["type", "Type", "category"]], load("groupByDefault", "room"), "gbdefault")}</div>
        </section></div>`;
    } else if (settingsSub === "smart") {
      body = smartHtml();
    } else if (settingsSub === "diagnostics") {
      $("#rooms").innerHTML = `<div class="settings-wrap detail">${back}
        <div class="dhead"><span class="avatar big">${icon("bug_report")}</span><div><h2>Diagnostics</h2><small class="lstat info"><i></i><span>Anonymous tech dump</span></small></div></div>
        <section class="set-card diag-card">
          <p>A file to send when something doesn't work right. It has every device's type, make and model, integration,
            what it reports (readings, states, units, ranges, which ones you can control, how long ago each was updated),
            online and battery state, each integration's status, which settings are filled in, the history storage and
            recent warnings. It also describes the dashboard as this screen shows it, to help design it: the screen size,
            your appearance choices, what is on each page, and for each device its type, pages, card style and whether
            its card has to hide controls.</p>
          <p class="muted small">Anonymous: device and room names become "Thermostat 1", "Room A"…; ids are scrambled; IP and MAC
            addresses, e-mail addresses, host names, tokens and passwords are removed; settings values are never included.
            Open the file to check before you share it.</p>
          <div id="diag-sum" class="muted small"></div><div id="diag-link" class="diag-link" hidden></div>
          <div class="set-actions diag-actions"><button type="button" class="tonal-btn" data-diag-copy>${icon("content_copy")}Copy summary</button>
            <button type="button" class="tonal-btn" data-diag-gh>${icon("bug_report")}Report on GitHub</button>
            <button type="button" class="filled-btn" data-diag-dl>${icon("download")}Download</button></div>
          <p class="muted small"><b>Report on GitHub</b> opens a new issue on Haven's GitHub with the summary filled in. Download the
            file too and drag it into the issue before you submit it, so it can be reviewed in full.</p>
        </section></div>`;
      return;
    } else if (["account", "users", "security"].includes(settingsSub)) {   // accounts.js draws these
      const pg = settingsSub === "account" || !isAdmin() ? "account" : "users";
      $("#rooms").innerHTML = `<div class="settings-wrap detail acc-page" data-acc="${pg}">${isAdmin() ? back : ""}<div class="acc-body"></div></div>`;
      window.HavenAccounts?.render(pg, $("#rooms .acc-body"));
      return;
    } else {
      const sec = settingsData.sections.find(x => x.id === settingsSub);
      if (!sec) { settingsSub = null; return renderSettings(); }
      const [st, tone] = secStatus(sec);
      const basic = sec.fields.filter(f => !isAdv(f)), adv = sec.fields.filter(isAdv);
      if (sec.id === "ha") haWatch();
      if (sec.id === "ecowitt" && sec.enabled && !ecoGw.loading && Date.now() - ecoGw.at > 5000) loadEcoGateways();
      const push = sec.push_info ? `<p class="hint">${icon("info")}<span>On the gateway: Server <b>${esc(location.hostname)}</b> · Port <b>${esc(location.protocol === "https:" ? (sec.push_info.http_port || 1701) : (location.port || 80))}</b> · Path <b class="secret-path">${esc(ecoGw.data?.push_path || "/data/report")}</b><button type="button" class="icon-btn sm copy-btn" data-copy="${esc(ecoGw.data?.push_path || "/data/report")}" aria-label="Copy the path" title="Copy the path">${icon("content_copy")}</button> · Protocol <b>Ecowitt</b>
        ${ecoGw.data?.push_path ? "<br>Using this exact path (it's a secret) trusts the gateway automatically. With plain /data/report you approve it below." : ""}</span></p>` : "";
      const gws = sec.id === "ecowitt" && sec.enabled && ecoGw.data ? ecoGatewaysHtml(ecoGw.data) : "";
      const loginBtn = sec.login ? `<button type="button" class="tonal-btn" data-login="${sec.login === true ? sec.id : sec.login}">${icon("login")}${sec.login === "hue" ? "Pair bridge" : "Sign in"}</button>` : "";
      const actBtns = sec.enabled ? (sec.actions || []).map(x => `<button type="button" class="tonal-btn" data-sec-action="${esc(x.id)}">${icon(x.icon || "sync")}${esc(x.label)}</button>`).join("") : "";
      body = `<section class="set-card detail" data-section="${sec.id}">
          <div class="dhead"><span class="avatar big">${icon(sec.icon)}</span><div><h2>${esc(sec.label)}</h2><small class="lstat ${tone}">${tone !== "off" ? "<i></i>" : ""}<span>${esc(st)}</span></small></div>
            <label class="enable-lbl">${sec.enabled ? "On" : "Off"}<button type="button" class="m3-switch ${sec.enabled ? "on" : ""}" data-enable role="switch" aria-checked="${sec.enabled}" aria-label="Turn ${esc(sec.label)} on or off"></button></label></div>
          ${tone === "bad" && sec.status ? `<p class="hint bad">${icon("error")}<span>${esc(sec.status.replace(/^error:\s*/i, "").replace(/^./, c => c.toUpperCase()))}</span></p>` : ""}
          <details class="howto" ${sec.enabled && tone === "good" ? "" : "open"}><summary>${icon("help")}How to set up</summary><p>${esc(plainHelp(sec.help))}</p>${push}</details>
          ${sec.id === "ha" ? haCardHtml() + haPairHtml(sec) : ""}${gws}
          ${sec.id === "ha" ? `<h3 class="ha-h">${icon("tune")}Pair manually</h3><p class="muted small ha-hp">Set the same shared secret and virtual IP on both Havens: <b>primary</b> on one, <b>standby</b> on the other, each with the other's own IP. Then turn it on and save on both.</p>` : ""}
          ${basic.length ? `<div class="set-fields">${basic.map(f => fieldHtml(sec, f)).join("")}</div>` : ""}
          ${adv.length ? `<details class="adv"><summary>Advanced</summary><div class="set-fields">${adv.map(f => fieldHtml(sec, f)).join("")}</div></details>` : ""}
          <div class="set-actions">${loginBtn}${actBtns}<span style="flex:1"></span><button type="button" class="filled-btn" data-save>${icon("save")}Save</button></div>
        </section>`;
    }
    $("#rooms").innerHTML = `<div class="settings-wrap detail ${settingsSub === "appearance" ? "appear-page" : ""}">${back}${body}</div>`;
  }

  function collectSection(el) {
    const values = {};
    $$("[data-key]", el).forEach(i => {
      if (i.classList.contains("toggles")) {
        const off = i.dataset.mode === "off";
        values[i.dataset.key] = $$("[data-tg]", i).filter(b => !b.disabled && b.classList.contains("on") !== off).map(b => b.dataset.tg);
        if (!off && !values[i.dataset.key].length) delete values[i.dataset.key];   // all off: keep what was saved
      } else if (i.classList.contains("hostlist")) {
        values[i.dataset.key] = $$("[data-hkey]", i).map(x => x.value.trim()).filter(Boolean);
      } else if (i.classList.contains("servers")) {
        values[i.dataset.key] = $$(".server-row", i).map(r => Object.fromEntries($$("[data-skey]", r).map(x => [x.dataset.skey, x.value.trim()])));
      } else values[i.dataset.key] = i.type === "checkbox" ? i.checked : i.value;
    });
    return { enabled: $("[data-enable]", el).classList.contains("on"), values };
  }

