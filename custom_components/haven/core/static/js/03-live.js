// Haven dashboard, part 3 of 11: Now tab (live charts), the table view and summary chips.
// The parts are plain scripts that index.html loads in order; they share one scope (no build step).
// A part can use anything earlier parts declare. Code that runs while the page loads (not inside a
// function called later) must not use a later part.
  // ---------- Now tab: live charts of the last 5 minutes ----------
  // Seeded from /history?range=5m (every reading the hub kept in memory), then fed by the websocket's device updates;
  // redrawn at most once a second (and every 5 s so the window slides). Only #dp-live is redrawn, never focused.
  const LIVE_SECS = 300;
  const live = { id: null, series: {}, kinds: {}, last: {}, states: {}, skew: 0, loading: false, error: null, dirty: false, timer: null, drawn: 0, hover: null, req: 0 };
  const liveNow = () => Date.now() / 1000 + live.skew;
  async function loadLive(id) {
    const req = ++live.req;
    Object.assign(live, { id, series: {}, kinds: {}, last: {}, states: {}, loading: true, error: null, hover: null });
    startLive(); drawLive();
    let data = null, err = null;
    try { data = await api(`/api/devices/${encodeURIComponent(id)}/history?range=5m`); } catch (e) { err = e.message; }
    if (live.req !== req) return;                       // another device / tab since
    live.loading = false; live.error = err;
    if (data) {
      live.skew = (Number(data.end) || Date.now() / 1000) - Date.now() / 1000;      // chart in the hub's clock
      live.series = {}; for (const [k, pts] of Object.entries(data.series || {})) live.series[k] = pts.map(p => ({ t: Number(p.t), v: Number(p.v) }));
      Object.assign(live, { kinds: data.kinds || {}, last: data.last || {}, states: data.states || {} });
    }
    drawLive();
  }
  function startLive() { if (!live.timer) live.timer = setInterval(liveTick, 1000); }
  function stopLive() { clearInterval(live.timer); live.timer = null; live.hover = null; }
  function liveTick() {
    if (!$("#devpanel").open || panelTab !== "now") return stopLive();
    if (live.dirty || liveNow() - live.drawn >= 5) drawLive();
  }
  const liveStateNum = (k, v) => typeof v === "boolean" ? (v ? 1 : 0) : typeof v === "number" ? v
    : typeof v === "string" ? (live.states[k]?.[v.toLowerCase()] ?? null) : null;
  function liveIngest(d) {
    if (live.id !== d.id || live.loading || !live.timer) return;
    const now = liveNow();
    for (const k of Object.keys(live.kinds)) {
      const c = d.capabilities[k]; if (!c || c.value == null) continue;
      const t = Number(c.updated) || now, pts = live.series[k] ||= [], prev = pts[pts.length - 1];
      if (prev && t <= prev.t) continue;
      if (live.kinds[k] === "state") {
        const v = liveStateNum(k, c.value); if (v == null || (prev && prev.v === v)) continue;
        pts.push({ t, v });
      } else if (typeof c.value === "number") pts.push({ t, v: c.value });
      else continue;
      live.last[k] = { t, v: pts[pts.length - 1].v }; live.dirty = true;
    }
  }
  function drawLive() {
    const host = $("#dp-live"); if (!host || panelTab !== "now") return;
    const d = devices.get(live.id); if (!d || d.id !== panelId) return;
    live.dirty = false; live.drawn = liveNow();
    const t1 = live.drawn, t0 = t1 - LIVE_SECS;
    for (const [k, pts] of Object.entries(live.series)) {      // forget what slid out (keep the state in force at t0)
      let i = 0; while (i < pts.length && pts[i].t < t0) i++;
      if (live.kinds[k] === "state" && i > 0) i--;
      if (i) pts.splice(0, i);
    }
    const head = `<div class="live-head"><span class="live-dot" aria-hidden="true"></span><b>Live</b><span>· last 5 min</span></div>`;
    if (live.loading) { host.innerHTML = head + `<div class="live-wait muted small">Loading the last 5 minutes…</div>`; return; }
    if (live.error) { host.innerHTML = head + `<p class="muted small">${esc(live.error)}</p>`; return; }
    const known = k => d.capabilities[k] && ((live.series[k] || []).length || live.last[k]);
    const keys = Object.keys(live.kinds).filter(known).sort((a, b) => {
      const ia = CHART_ORDER.indexOf(a), ib = CHART_ORDER.indexOf(b);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
    });
    const states = keys.filter(k => live.kinds[k] === "state"), nums = keys.filter(k => live.kinds[k] !== "state" && !d.capabilities[k].writable);
    const main = states.filter(k => MAIN_STATES.has(k)), minor = states.filter(k => !MAIN_STATES.has(k));
    const n = main.length + nums.length + minor.length;
    if (!n) { host.innerHTML = ""; host.hidden = true; return; }
    host.hidden = false;
    const inner = host.clientWidth || (innerWidth < 840 ? innerWidth - 32 : Math.min(920, innerWidth - 32) - 48);
    const cols = n > 1 && inner >= 2 * 300 + 12 ? 2 : 1;
    const W = Math.max(240, Math.round((inner - (cols - 1) * 12) / cols - 24));
    liveInfo.clear();
    host.innerHTML = head + `<div class="live-cards ${cols === 1 ? "one" : ""}">${[...main.map(k => liveState(d, k, t0, t1)),
      ...nums.map(k => liveNum(d, k, t0, t1, W)), ...minor.map(k => liveState(d, k, t0, t1))].join("")}</div>`;
    host.querySelectorAll("svg.hchart[data-lcap]").forEach(svg => {
      const info = liveInfo.get(svg.dataset.lcap); if (!info) return;
      chartHover(svg, info, x => { live.hover = x == null ? null : { k: svg.dataset.lcap, x }; }, true);
      if (live.hover?.k === svg.dataset.lcap) svg._showAt?.(live.hover.x);
    });
    wireTipDismiss();
  }
  const liveInfo = new Map();
  const sinceText = sec => sec < 60 ? "just now" : sec < 3600 ? `${Math.floor(sec / 60)} min ago` : sec < 86400 ? `${Math.floor(sec / 3600)} h ago` : `${Math.floor(sec / 86400)} d ago`;
  function liveNum(d, k, t0, t1, W) {
    const temperature = k === "temperature", conv = v => temperature ? toUnit(v) : v;
    const u = temperature ? `°${unit}` : (d.capabilities[k]?.unit || "");
    const f1 = v => `${+v.toFixed(Math.abs(v) < 10 ? 2 : 1)}${u && !u.startsWith("°") ? " " : ""}${u}`;
    const pts = (live.series[k] || []).filter(p => p.t >= t0 - 1 && p.t <= t1 + 5);
    const lastP = live.last[k], lastT = Math.max(Number(lastP?.t) || 0, Number(d.capabilities[k]?.updated) || 0);
    const quiet = !pts.length;
    const cur = quiet ? Number(lastP?.v ?? d.capabilities[k]?.value) : pts[pts.length - 1].v;
    const vs = quiet ? [conv(cur)] : pts.map(p => conv(p.v));
    const rawLo = Math.min(...vs), rawHi = Math.max(...vs), flat = rawHi - rawLo < 1e-6 * Math.max(1, Math.abs(rawHi));
    let lo, hi;
    if (flat) { const st = Math.abs(rawLo) >= 10 ? 1 : 0.1; lo = rawLo - st; hi = rawHi + st; }
    else { const st = niceStep(rawHi - rawLo, 2); lo = Math.floor(rawLo / st) * st; hi = Math.ceil(rawHi / st) * st; if (rawLo >= 0 && lo < 0) lo = 0; if (hi - lo < st) hi = lo + st; }
    const small = innerWidth < 600, H = small ? 92 : 100;
    const dec = flat ? (Number.isInteger(rawLo) ? 0 : 1) : Math.max(0, Math.min(2, stepDecimals((hi - lo) / 2)));
    const ticksY = flat ? [rawLo] : [lo, hi];
    const labelW = Math.max(...ticksY.map(v => v.toFixed(dec).length)) * 6.5 + 10;
    const P = { l: Math.max(28, Math.round(labelW)), r: 8, t: 8, b: 20 };
    const X = t => P.l + (t - t0) / ((t1 - t0) || 1) * (W - P.l - P.r), Y = v => P.t + (1 - (v - lo) / (hi - lo)) * (H - P.t - P.b);
    const base = H - P.b;
    let plot = "", tail = "", dot = "";
    if (quiet) tail = `<path class="ext" d="M${f1x(X(t0))},${f1x(Y(conv(cur)))}H${f1x(X(t1))}"/>`;
    else {
      let xy = pts.map(p => [X(p.t), Y(conv(p.v))]);
      const style = flat ? "line" : chartStyle;
      if (style === "bars") { const nb = Math.max(20, Math.round((W - P.l - P.r) / 8)); xy = bucketize(xy, nb); plot = plotSvg([xy], base, "bars", (W - P.l - P.r) / nb * 0.7); }
      else plot = xy.length > 1 ? plotSvg([xy], base, style) : "";
      const [lx, ly] = [X(pts[pts.length - 1].t), Y(conv(cur))];
      if (X(t1) - lx > 1) tail = `<path class="ext" d="M${f1x(lx)},${f1x(ly)}H${f1x(X(t1))}"/>`;   // still that value until now
      dot = `<circle class="live-now" cx="${f1x(lx)}" cy="${f1x(ly)}" r="3.5"/>`;
    }
    const grid = ticksY.map(v => { const y = Y(v);
      return `<line x1="${P.l}" x2="${W - P.r}" y1="${f1x(y)}" y2="${f1x(y)}" class="g"/><text x="${P.l - 6}" y="${f1x(y + 4)}" text-anchor="end">${v.toFixed(dec)}</text>`; }).join("");
    const ticks = axisTicks(t0, t1, 3).map((t, i) => `<text x="${f1x(X(t))}" y="${H - 5}" text-anchor="${["start", "middle", "end"][i]}">${esc(i === 2 ? "now" : fmtTime(t, LIVE_SECS))}</text>`).join("");
    const note = quiet ? `No readings in the last 5 minutes${lastT ? ` · last reading ${sinceText(t1 - lastT)}` : ""}`
      : flat ? `No change in the last 5 minutes · ${pts.length} reading${pts.length === 1 ? "" : "s"}`
      : `Low <b>${esc(f1(rawLo))}</b> · High <b>${esc(f1(rawHi))}</b> · ${pts.length} readings`;
    if (!quiet) liveInfo.set(k, { pts, t0, t1, conv, u, W, H, P, lo, hi });
    const label = capLabel(d, k);
    return `<section class="hcard lcard ${quiet ? "quiet" : ""}" data-lcap="${esc(k)}">
      <div class="hcard-head">${icon(META_ICON[k] || (temperature ? "thermostat" : k === "humidity" ? "water_drop" : k === "battery" ? "battery_full" : "sensors"))}
        <b>${esc(label)}</b><span class="hnow">${Number.isFinite(cur) ? esc(f1(conv(cur))) : ""}</span></div>
      <div class="hplot"><svg viewBox="0 0 ${W} ${H}" class="hchart lchart c-${flat || quiet ? "line" : chartStyle}" data-lcap="${esc(k)}" role="img" aria-label="${esc(`${label}, last 5 minutes: ${quiet ? "no readings" : flat ? `steady at ${f1(rawLo)}` : `${f1(rawLo)} to ${f1(rawHi)}`}`)}">${grid}${ticks}
        ${plot}${tail}${dot}<line class="cross" x1="0" x2="0" y1="${P.t}" y2="${base}" visibility="hidden"/><circle class="dot" r="4" visibility="hidden"/></svg>
        <div class="htip" hidden></div></div>
      <div class="hstats"><span>${note}</span></div>
    </section>`;
  }
  function liveState(d, k, t0, t1) {
    const raw = live.series[k] || [], lastP = live.last[k];
    const pts = raw.length ? raw : lastP ? [{ t: Math.min(Number(lastP.t), t0), v: Number(lastP.v) }] : [];
    const segs = [];
    pts.forEach((p, i) => { const a = Math.max(p.t, t0), b = Math.min(i + 1 < pts.length ? pts[i + 1].t : t1, t1); if (b > a) segs.push({ a, b, v: Math.round(Number(p.v)) }); });
    const merged = segs.reduce((m, x) => { const l = m[m.length - 1]; if (l && l.v === x.v) l.b = Math.max(l.b, x.b); else m.push({ ...x }); return m; }, []);
    const span = t1 - t0, bad = BAD_STATES.has(k);
    const tone = v => v === 0 ? "off" : (bad || (k === "ups_status" && v >= 1) || (k === "alarm_panel" && v === 6) || (k === "lock" && v === 2)) ? "bad" : "on";
    const bars = merged.map(x => `<i class="${tone(x.v)}" style="left:${((x.a - t0) / span * 100).toFixed(3)}%;width:${Math.max(0.3, (x.b - x.a) / span * 100).toFixed(3)}%"
      title="${esc(stateWord(k, x.v))} · ${esc(whenText(x.a, span))} – ${esc(whenText(x.b, span))} (${esc(durText(x.b - x.a))})"></i>`).join("");
    const changes = raw.filter((p, i) => i > 0 && p.t > t0 + 0.5 && p.v !== raw[i - 1].v).length;   // the first reading isn't a change
    const cur = merged.length ? merged[merged.length - 1].v : null;
    const lastT = Number(lastP?.t) || 0;
    const note = changes ? `${changes} change${changes === 1 ? "" : "s"} · last ${sinceText(t1 - lastT)}`
      : `No change in the last 5 minutes${lastT && cur != null ? ` · ${stateWord(k, cur).toLowerCase()} for ${durText(t1 - lastT)}` : ""}`;
    return `<section class="hcard state lcard" data-lcap="${esc(k)}">
      <div class="hcard-head">${icon(STATE_ICON[k] || META_ICON[k] || "toggle_on")}<b>${esc(capLabel(d, k))}</b><span class="hnow">${cur == null ? "" : esc(stateWord(k, cur))}</span></div>
      <div class="tline" role="img" aria-label="${esc(`${capLabel(d, k)}, last 5 minutes: ${note}`)}">${bars}</div>
      <div class="tticks">${axisTicks(t0, t1, 3).map((t, i) => `<span>${esc(i === 2 ? "now" : fmtTime(t, LIVE_SECS))}</span>`).join("")}</div>
      <div class="hstats"><span>${esc(note)}</span></div>
    </section>`;
  }

  function quickAction(d) {
    const c = d.capabilities;
    const btn = (capName, value, ic, label, on) => `<button class="quick ${on ? "on" : ""}" data-cmd="${esc(capName)}" data-val="${esc(JSON.stringify(value))}" aria-label="${esc(label)}" title="${esc(label)}">${icon(ic, on)}</button>`;
    if (c.light?.writable || c.switch?.writable) { const k = c.light?.writable ? "light" : "switch", on = !!val(d, k);
      return `<button class="m3-switch sm ${on ? "on" : ""}" role="switch" aria-checked="${on}" data-cmd="${k}" data-val="${esc(JSON.stringify(!on))}" aria-label="Toggle ${esc(d.name)}"></button>`; }
    if (c.lock?.writable) { const locked = val(d, "lock") === "locked";
      return btn("lock", locked ? "unlock" : "lock", locked ? "lock" : "lock_open", locked ? "Unlock" : "Lock", !locked); }
    if (c.valve?.writable) { const open = val(d, "valve") === "open";
      return btn("valve", open ? "close" : "open", "valve", open ? "Close valve" : "Open valve", open); }
    return "";
  }
  // the headline and second line the compact cards (Minimal, Tile, Bubble, Glance) show
  function cardBits(d) {
    const st = statusOf(d);
    let big = "", small = "";
    if (has(d, "ph") && typeof val(d, "ph") === "number") { big = `${fmt(val(d, "ph"))}<small> pH</small>`; small = [has(d, "temperature") ? `${temp(val(d, "temperature"))}°` : "", st ? st[0] : ""].filter(Boolean).join(" · "); }
    else if (has(d, "temperature")) { big = `${temp(val(d, "temperature"))}<small>°</small>`; small = [val(d, "humidity") != null ? `${Math.round(val(d, "humidity"))}% RH` : "", st ? st[0] : ""].filter(Boolean).join(" · "); }
    else if (has(d, "moisture")) { big = `${val(d, "moisture") == null ? "–" : Math.round(val(d, "moisture"))}<small>%</small>`; small = "Soil moisture"; }
    else if (isUps(d)) { big = `${n(val(d, "battery"))}<small>%</small>`; small = `${st[0]} · ${runtimeText(val(d, "runtime"))}`; }
    else if (st) { big = `<span class="word">${esc(st[0])}</span>`; small = detailText(d); }
    return { big, small, st };
  }
  function miniCard(d) {
    const [ic, tone] = deviceIcon(d);
    const { big, small, st } = cardBits(d);
    const b = val(d, "battery");
    const lowBat = batteryLow(d) && !isUps(d) ? `<span class="mini-bat">${icon("battery_alert", true)}${b != null ? n(b) + "%" : "Low"}</span>` : "";
    const lit = isLight(d) && val(d, "light");
    return `<article class="card mini ${isAlarm(d) ? "alarm" : ""} ${d.online ? "" : "offline"} ${lit ? "lit" : ""} ${st && st[1] ? "tone-" + st[1] : ""}" data-id="${esc(d.id)}" ${lit ? `style="--lit:${glow(d)}"` : ""}>
      <div class="mini-head"><span class="mini-ic ${tone}">${icon(ic, !!tone)}</span><span class="name" title="${esc(d.name)}">${esc(d.name)}</span>
        <button class="card-edit" data-edit aria-label="Edit">${icon("edit")}</button>${quickAction(d)}</div>
      <div class="mini-big">${big}</div>
      <div class="mini-small">${gbNow === "type" ? `<span class="croom">${esc(d.room || "No room")}</span>${small ? " · " : ""}` : ""}${esc(small) || (gbNow === "type" ? "" : "&nbsp;")}${lowBat}${d.online ? "" : `<span class="mini-bat">${icon("wifi_off")}Offline</span>`}</div>
    </article>`;
  }

  // ---------- more card styles: Tile, Bubble, Glance ----------
  const CARD_STYLES = [["standard", "Standard", "dashboard"], ["minimal", "Minimal", "view_agenda"], ["tile", "Tile", "grid_view"],
    ["bubble", "Bubble", "radio_button_checked"], ["glance", "Glance", "apps"]];
  const styleOf = d => d.card_style || cardStyle;
  const mainSwitch = d => d.capabilities.light?.writable ? "light" : d.capabilities.switch?.writable ? "switch" : null;
  // the round icon: for a light or switch it is the on/off button
  function iconBubble(d, cls) {
    const [ic, tone] = deviceIcon(d), k = mainSwitch(d);
    if (k && !editing()) { const on = !!val(d, k);
      return `<button type="button" class="${cls} ${tone} ${on ? "on" : ""}" data-cmd="${k}" data-val="${esc(JSON.stringify(!on))}" aria-pressed="${on}" aria-label="Turn ${esc(d.name)} ${on ? "off" : "on"}">${icon(ic, on || !!tone)}</button>`; }
    return `<span class="${cls} ${tone}">${icon(ic, !!tone)}</span>`;
  }
  const stripTags = h => { const t = document.createElement("template"); t.innerHTML = h; return t.content.textContent.trim(); };
  function stateText(d) {               // one plain line: "62%", "Off", "21° · 40% RH", "Locked"
    const k = mainSwitch(d);
    if (k === "light" || (isLight(d) && has(d, "light"))) { const on = !!val(d, "light"), b = val(d, "brightness");
      return on ? (b != null ? `${n(b)}%` : "On") : "Off"; }
    const { big, small } = cardBits(d);
    return [stripTags(big), small].filter(Boolean).join(" · ") || (k ? (val(d, k) ? "On" : "Off") : "");
  }
  const cardClasses = d => { const lit = isLight(d) && val(d, "light");
    return [`${isAlarm(d) ? "alarm" : ""} ${d.online ? "" : "offline"} ${lit ? "lit" : ""} ${mainSwitch(d) && val(d, mainSwitch(d)) ? "is-on" : ""}`, lit ? `style="--lit:${glow(d)}"` : ""]; };
  const roomLine = d => gbNow === "type" ? `<span class="croom">${esc(d.room || "No room")}</span>` : "";
  const openArea = () => editing() ? "" : "data-open-device";
  const editBtn = `<button class="card-edit" data-edit aria-label="Edit">${icon("edit")}</button>`;
  function tileCard(d) {                // a square: icon button on top, name and state below
    const [cls, sty] = cardClasses(d), { big, small } = cardBits(d), k = mainSwitch(d);
    return `<article class="card dtile ${cls}" data-id="${esc(d.id)}" ${sty}>
      <div class="dtile-top">${k ? iconBubble(d, "bub-ic") : quickAction(d) || iconBubble(d, "bub-ic")}${editBtn}</div>
      <div class="dtile-body" ${openArea()}><div class="name" title="${esc(d.name)}">${esc(d.name)}</div>
        <div class="dtile-state">${k ? esc(stateText(d)) : big ? `<b>${big}</b>${small ? ` <span>${esc(small)}</span>` : ""}` : esc(small)}</div>
        ${roomLine(d) ? `<div class="dtile-room">${roomLine(d)}</div>` : ""}</div></article>`;
  }
  function bubbleCard(d) {              // a pill: a light fills up to its brightness
    const [cls, sty] = cardClasses(d), k = mainSwitch(d);
    const fill = k === "light" && val(d, "light") ? (val(d, "brightness") ?? 100) : k && val(d, k) ? 100 : 0;
    return `<article class="card bub ${cls}" data-id="${esc(d.id)}" ${sty}><span class="bub-fill" style="width:${Math.max(0, Math.min(100, +fill || 0))}%"></span>
      ${iconBubble(d, "bub-ic")}
      <div class="bub-body" ${openArea()}><div class="name" title="${esc(d.name)}">${esc(d.name)}</div>
        <div class="bub-state">${roomLine(d)}${roomLine(d) ? " · " : ""}${esc(stateText(d))}${d.online ? "" : " · Offline"}</div></div>
      ${editBtn}${k ? "" : quickAction(d)}</article>`;
  }
  function glanceCard(d) {              // small and round: icon, the one number or word, name
    const [cls, sty] = cardClasses(d), k = mainSwitch(d), { big } = cardBits(d);
    return `<article class="card glance ${cls}" data-id="${esc(d.id)}" ${sty}>${editBtn}
      ${iconBubble(d, "bub-ic")}
      <div class="glance-val" ${openArea()}>${k ? esc(stateText(d)) : big || esc(stateText(d)) || "&nbsp;"}</div>
      <div class="name" title="${esc(d.name)}">${esc(d.name)}</div></article>`;
  }

  function typeMatch(d, t) {
    if (t === "battery") return val(d, "battery") != null || val(d, "battery_low") != null;
    if (t === "power") return isUps(d) || isPlug(d) || (has(d, "power") && deviceType(d) === "other");   // a metered socket (HS300 outlet)
    if (t === "lights") return isLight(d);
    if (t === "pool") return isPool(d);
    if (t === "water" && deviceType(d) === "valve") return true;
    if (t === "climate" && ["leak", "water", "valve"].includes(deviceType(d))) return false;   // water temperature (leak sensor, water line) isn't room climate
    if (t === "security" && ["smoke", "alarm"].includes(deviceType(d))) return true;   // smoke/CO alarms always count as security
    if (t === "doors") return has(d, "contact") && !isWindow(d);
    if (t === "windows") return (has(d, "contact") && isWindow(d)) || isShade(d);
    // Switches: smart plugs and light switches only. Bulbs and the extra switches of a camera, vacuum… don't count
    if (t === "switches") {
      const txt = `${d.name} ${d.model || ""}`;
      return has(d, "light") ? !isGroup(d) && (WALL_SWITCH.test(txt) || PLUG_NAME.test(txt))
        : isPlug(d) || (writableSwitch(d) && (["plug", "other"].includes(deviceType(d)) || PLUG_NAME.test(txt)));
    }
    if (t === "appliances") return ["appliance", "vacuum", "air_purifier"].includes(kindOf(d)) || has(d, "vacuum_state");
    const g = GROUPS[t]; return !!g && g.some(k => has(d, k) && !(k === "co" && !coAlarm(d))
      && !(k === "occupancy" && isThermostat(d)));   // a thermostat's built-in occupancy sensor doesn't make it a security device
  }
  const autoTabs = d => isPool(d) ? ["pool"] : TAB_IDS.filter(t => typeMatch(d, t));   // pool devices live on Pool alone
  const tabsOf = d => Array.isArray(d.categories) ? d.categories : autoTabs(d);
  function viewMatch(v, d) {
    if ((v.devices || []).includes(d.id)) return true;
    const rules = [v.rooms?.length && (() => v.rooms.includes(d.room || "Other")), v.types?.length && (() => v.types.some(t => TAB_IDS.includes(t) ? tabsOf(d).includes(t) : typeMatch(d, t))),
      v.sources?.length && (() => v.sources.includes(d.source)),
      v.keywords?.length && (() => { const nm = `${d.name} ${d.room || ""}`.toLowerCase(); return v.keywords.some(k => nm.includes(k.toLowerCase())); })].filter(Boolean);
    return rules.length > 0 && rules.every(f => f());
  }
  function matches(d) {
    if (view === "all") return true;
    const cv = customView(); if (cv) return viewMatch(cv, d);
    if (TAB_IDS.includes(view)) return tabsOf(d).includes(view);
    const g = GROUPS[view];
    return g && g.some(k => has(d, k));
  }

  // ---------- table ----------
  const SORTERS = {
    name: d => d.name.toLowerCase(),
    room: d => `${String(roomRank(d.room || "Other")).padStart(7, "0")}|${(d.room || "~").toLowerCase()}|${String(devRank(d.room || "Other", d.id)).padStart(7, "0")}|${d.name.toLowerCase()}`,
    status: d => `${isAlarm(d) ? 0 : needsAttention(d) ? 1 : 2}|${(statusOf(d) || [readingText(d)])[0]}`,
    battery: d => val(d, "battery") ?? (val(d, "battery_low") === true ? 5 : val(d, "battery_low") === false ? 100 : 999),
    updated: d => -lastUpdated(d),
    source: d => srcLabel(d),
  };
  function tableView(list) {
    const s = SORTERS[sort.key] || SORTERS.room;
    list.sort((a, b) => { const x = s(a), y = s(b); return (x < y ? -1 : x > y ? 1 : 0) * sort.dir; });
    const th = (key, label, cls = "") => `<th class="${cls} ${sort.key === key ? "sorted" : ""}" ${key ? `data-sort="${key}"` : ""}>${label}${
      sort.key === key ? `<span class="arrow">${icon(sort.dir > 0 ? "arrow_upward" : "arrow_downward")}</span>` : ""}</th>`;
    let groups = [[null, list]];
    if (gbNow === "type") { const by = {}; list.forEach(d => (by[deviceType(d)] ||= []).push(d));
      groups = Object.keys(by).sort((a, b) => TYPE_RANK[a] - TYPE_RANK[b]).map(t => [t, by[t]]); }
    const rows = groups.map(([t, items]) => (t ? `<tr class="tgroup" data-type="${t}"><th colspan="8" scope="colgroup"><span class="tg">${typeHead(t, items.length)}</span></th></tr>` : "") + items.map(d => {
      const [ic, tone] = deviceIcon(d);
      const st = statusOf(d), rd = readingText(d);
      const b = val(d, "battery"), bl = val(d, "battery_low");
      return `<tr data-id="${esc(d.id)}" class="${isAlarm(d) ? "alarm" : ""} ${d.online ? "" : "offline"}">
        <td class="c-name"><div class="dev"><span class="avatar ${tone}">${icon(ic, !!tone)}</span><div><b>${esc(d.name)}</b><small>${esc(srcLabel(d))}${d.room ? `<span class="rm-inline"> · ${esc(d.room)}</span>` : ""}${d.online ? "" : " · Offline"}</small></div>
          <button class="card-edit" data-edit aria-label="Edit">${icon("edit")}</button></div></td>
        <td class="c-room">${esc(d.room || "—")}</td>
        <td class="muted c-src">${esc(srcLabel(d))}</td>
        <td class="c-status"><span class="val ${st ? st[1] : ""}">${rd ? esc(rd) : ""}${rd && st ? " · " : ""}${st ? esc(st[0]) : ""}</span></td>
        <td class="muted c-det">${esc(detailText(d))}</td>
        <td class="c-bat">${b != null ? levelBar(b) : bl != null ? `<span class="val ${bl ? "bad" : ""}">${bl ? "Low" : "OK"}</span>` : `<span class="muted">—</span>`}</td>
        <td class="muted c-upd">${ago(lastUpdated(d))}</td>
        <td class="c-ctl">${controlsBlock(d)}</td></tr>`;
    }).join("")).join("");
    return `<div class="table-wrap"><table class="dtable devtable"><thead><tr>${th("name", "Device", "c-name")}${th("room", "Room", "c-room")}${th("source", "Integration", "c-src")}${th("status", "Status", "c-status")}${th("", "Details", "c-det")}${th("battery", "Battery", "c-bat")}${th("updated", "Updated", "c-upd")}${th("", "Controls", "c-ctl")}</tr></thead><tbody>${rows}</tbody></table></div>`;
  }
  const levelBar = raw => { const b = Math.max(0, Math.min(100, Number(raw) || 0));
    return `<span class="level ${b <= 25 ? "low" : b <= 50 ? "mid" : ""}"><span class="bar"><i style="width:${Math.max(3, b)}%"></i></span><span>${Math.round(b)}%</span></span>`; };

  // ---------- summary tiles + chips ----------
  const tile = (cls, ic, value, label, fill) => `<div class="tile ${cls}"><div class="ti">${icon(ic, fill)}</div><div class="tv">${value}</div><div class="tl">${esc(label)}</div></div>`;
