// Haven dashboard, part 9 of 11: History dialog and device history charts, snapshot.
// The parts are plain scripts that index.html loads in order; they share one scope (no build step).
// A part can use anything earlier parts declare. Code that runs while the page loads (not inside a
// function called later) must not use a later part.
  // ---------- history dialog ----------
  let histRanges = ["1h", "4h", "24h", "7d", "30d", "1y"], histBackend = "memory", histMaxSpan = 86400;
  const loadHistInfo = () => api("/api/history/info").then(i => { if (i.ranges?.length) histRanges = i.ranges; histBackend = i.backend;
    if (Number(i.max_span) > 0) histMaxSpan = Number(i.max_span); }).catch(() => {});
  const fmtTime = (t, span) => new Date(t * 1000).toLocaleString([], { ...(span > 2 * 86400 ? { month: "short", day: "numeric" } : { hour: "numeric", minute: "2-digit" }), ...timeOpts() });
  // ---------- device history: every reading and state of one device, charted ----------
  const RANGE_SECS = { "5m": 300, "1h": 3600, "4h": 14400, "24h": 86400, "7d": 604800, "30d": 2592000, "1y": 31536000 };
  const PANEL_RANGES = ["4h", "24h", "7d", "30d", "1y"];   // History tab buttons (those the backend can serve), then Custom
  const rangeName = () => dh.range === "custom" ? "this range" : dh.range;
  const CHART_ORDER = ["temperature", "humidity", "battery", "power", "energy_today", "pm25", "co2", "voc", "aqi", "air_score",
    "ph", "free_chlorine", "flow_rate", "water_pressure", "load", "runtime", "input_voltage", "output_voltage", "voltage", "current"];
  const STATE_WORDS = {
    contact: ["Closed", "Open"], lock: ["Locked", "Unlocked", "Jammed"], valve: ["Closed", "Open"], leak: ["Dry", "Leak"],
    motion: ["Clear", "Motion"], occupancy: ["Clear", "Occupied"], presence: ["Away", "Present"], smoke: ["Clear", "Smoke"],
    co: ["Clear", "CO"], light: ["Off", "On"], switch: ["Off", "On"], watering: ["Idle", "Watering"], charging: ["No", "Charging"],
    ups_status: ["Online", "On battery", "Low battery", "Offline"],
    alarm_panel: ["Disarmed", "Armed home", "Armed away", "Armed night", "Arming", "Entry delay", "Triggered"] };
  const BAD_STATES = new Set(["leak", "smoke", "co", "heat", "tamper", "alarm"]);
  const MAIN_STATES = new Set(["contact", "lock", "valve", "leak", "motion", "occupancy", "presence", "smoke", "co", "light", "switch",
    "ups_status", "alarm_panel", "watering"]);
  const STATE_ICON = { contact: "sensor_door", lock: "lock", valve: "valve", leak: "water_damage", motion: "directions_run",
    occupancy: "sensor_occupied", presence: "sensor_occupied", smoke: "detector_smoke", co: "detector_smoke", light: "lightbulb",
    switch: "power", ups_status: "battery_charging_full", alarm_panel: "shield", watering: "sprinkler", charging: "battery_charging_full" };
  const dhPts = new Map();   // cap -> {pts, t0, t1, lo, hi, conv, unit} for hover read-out

  async function loadDevHistory(id, range) {
    if (range === "custom" && !dh.custom) dh.custom = { start: Math.floor(Date.now() / 1000) - 86400, end: Math.floor(Date.now() / 1000) };
    if (range !== "custom" && !PANEL_RANGES.includes(range)) range = "24h";
    const req = ++dh.req;
    Object.assign(dh, { id, range, loading: true, error: null });
    if (panelTab === "history") renderDevicePanel();
    let data = null, err = null;
    const q = range === "custom" ? `start=${Math.floor(dh.custom.start)}&end=${Math.ceil(dh.custom.end)}` : `range=${encodeURIComponent(range)}`;
    try { data = await api(`/api/devices/${encodeURIComponent(id)}/history?${q}`); } catch (e) { err = e.message; }
    if (dh.req !== req) return;                                 // user moved on
    Object.assign(dh, { data, error: err, loading: false, at: Date.now() });
    if (panelId === id && panelTab === "history") renderDevicePanel();
  }
  function pickDevRange(r) {
    dh.range = r; dh.cdraft = null; store("devHistRange", r);
    loadDevHistory(panelId, r);
  }
  // Custom range: datetime-local inputs, read and written in the user's time zone (Settings → Appearance)
  function tzParts(t) {
    const o = {};
    new Intl.DateTimeFormat("en-US", { timeZone: timeCfg.timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(t * 1000)).forEach(p => { o[p.type] = p.value; });
    return o;
  }
  const toLocalInput = t => { const p = tzParts(t); return `${p.year}-${p.month}-${p.day}T${p.hour === "24" ? "00" : p.hour}:${p.minute}`; };
  function fromLocalInput(v) {
    const m = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d)/.exec(v || ""); if (!m) return NaN;
    const wall = Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5]) / 1000;
    let t = wall;
    for (let i = 0; i < 3; i++) { const p = tzParts(t); t += wall - Date.UTC(+p.year, p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second) / 1000; }
    return t;
  }
  function rangeText(a, b) {
    const yr = t => tzParts(t).year, thisYear = tzParts(Date.now() / 1000).year;
    const f = t => new Date(t * 1000).toLocaleString([], { month: "short", day: "numeric", ...(yr(a) !== thisYear || yr(b) !== thisYear ? { year: "numeric" } : {}),
      hour: "numeric", minute: "2-digit", ...timeOpts() });
    return `${f(a)} – ${f(b)}`;
  }
  const spanText = s => s >= 86400 * 2 ? `${Math.round(s / 86400)} days` : s >= 86400 ? "24 hours" : `${Math.round(s / 3600)} hours`;
  function checkCustom(fromV, toV) {           // -> {start, end} or {error}
    const a = fromLocalInput(fromV), b = fromLocalInput(toV), now = Date.now() / 1000;
    if (!Number.isFinite(a) || !Number.isFinite(b)) return { error: "Choose a start and an end." };
    if (a >= b) return { error: "The start must be before the end." };
    if (b > now + 60) return { error: "The end can't be in the future." };
    if (b - a < 60) return { error: "Choose a range of at least 1 minute." };
    if (a < now - histMaxSpan - 60) return { error: `History only goes back ${spanText(histMaxSpan)}: choose a later start.` };
    return { start: a, end: Math.min(b, now) };
  }
  function customFormHtml() {
    const c = dh.custom || { start: Date.now() / 1000 - 86400, end: Date.now() / 1000 };
    const from = dh.cdraft?.from ?? toLocalInput(c.start), to = dh.cdraft?.to ?? toLocalInput(c.end);
    const now = Date.now() / 1000, min = toLocalInput(now - histMaxSpan), max = toLocalInput(now);
    const chk = checkCustom(from, to);
    return `<div class="dh-custom" role="group" aria-label="Custom range">
      <label class="dtf"><span>From</span><input type="datetime-local" id="dh-from" value="${esc(from)}" min="${esc(min)}" max="${esc(max)}" step="60" aria-describedby="dh-cerr"></label>
      <label class="dtf"><span>To</span><input type="datetime-local" id="dh-to" value="${esc(to)}" min="${esc(min)}" max="${esc(max)}" step="60" aria-describedby="dh-cerr"></label>
      <button type="button" class="tonal-btn" data-dhcustom ${chk.error ? "disabled" : ""}>${icon("check")}Show</button>
      <p class="dh-cerr" id="dh-cerr" role="alert">${esc(chk.error || "")}</p></div>`;
  }
  function wireCustomRange() {
    const f = $("#dh-from"), t = $("#dh-to"); if (!f || !t) return;
    const upd = () => { dh.cdraft = { from: f.value, to: t.value }; const chk = checkCustom(f.value, t.value);
      $("#dh-cerr").textContent = chk.error || ""; $("[data-dhcustom]").disabled = !!chk.error;
      f.toggleAttribute("aria-invalid", !!chk.error); t.toggleAttribute("aria-invalid", !!chk.error); };
    f.addEventListener("input", upd); t.addEventListener("input", upd);
    [f, t].forEach(el => el.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); applyCustomRange(); } }));
  }
  function applyCustomRange() {
    const f = $("#dh-from"), t = $("#dh-to"); if (!f || !t) return;
    const chk = checkCustom(f.value, t.value);
    if (chk.error) { $("#dh-cerr").textContent = chk.error; return; }
    dh.custom = { start: Math.floor(chk.start), end: Math.ceil(chk.end) }; dh.cdraft = null;
    dh.range = "custom"; store("devHistRange", "custom"); store("devHistCustom", JSON.stringify(dh.custom));
    loadDevHistory(panelId, "custom");
  }
  const capLabel = (d, k) => d.capabilities[k]?.label || LABEL[k] || (k === "temperature" ? "Temperature" : k === "battery" ? "Battery" : pretty(k));
  const isStateCap = (d, k) => {
    const kind = dh.data?.kinds?.[k];
    if (kind) return kind === "state";
    const pts = dh.data?.series?.[k] || [];
    return !!(dh.data?.states || {})[k] || typeof d.capabilities[k]?.value === "boolean" || (pts.length > 0 && pts.every(p => p.v === 0 || p.v === 1) && !!STATE_WORDS[k] && typeof d.capabilities[k]?.value !== "number");
  };
  function stateWord(k, v) {
    const words = STATE_WORDS[k];
    const i = Math.round(Number(v));
    return words ? (words[i] ?? String(v)) : (i ? "On" : "Off");
  }
  function durText(sec) {
    if (sec < 60) return `${Math.round(sec)} s`;
    if (sec < 3600) return `${Math.round(sec / 60)} min`;
    if (sec < 86400) { const h = Math.floor(sec / 3600), m = Math.round(sec % 3600 / 60); return m ? `${h} h ${m} min` : `${h} h`; }
    return `${(sec / 86400).toFixed(sec < 864000 ? 1 : 0)} days`;
  }
  const whenText = (t, span) => new Date(t * 1000).toLocaleString([], { ...(span > 86400 ? { month: "short", day: "numeric" } : {}), hour: "numeric", minute: "2-digit", ...timeOpts() });
  function axisTicks(t0, t1, n = 5) { return Array.from({ length: n }, (_, i) => t0 + (t1 - t0) * i / (n - 1)); }

  // "nice" axis steps (1, 2 or 5 × 10^n) so gridlines land on round numbers
  function niceStep(span, n = 4) {
    const raw = Math.max(span, 1e-9) / n, p = Math.pow(10, Math.floor(Math.log10(raw))), m = raw / p;
    return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p;
  }
  const stepDecimals = s => Math.max(0, Math.min(3, -Math.floor(Math.log10(s) + 1e-9)));
  function numChart(d, k, pts, t0, t1) {
    const temperature = k === "temperature";
    const conv = v => temperature ? toUnit(v) : v;
    const u = temperature ? `°${unit}` : (d.capabilities[k]?.unit || "");
    const vs = pts.map(p => conv(p.v));
    const rawLo = Math.min(...vs), rawHi = Math.max(...vs);
    const flat = rawHi - rawLo < 1e-6 * Math.max(1, Math.abs(rawHi));
    let lo, hi, step, ticksY;
    if (flat) {                          // a steady reading: one labelled line at its value, drawn mid-chart
      step = Math.abs(rawLo) >= 10 ? 1 : 0.1; lo = rawLo - step; hi = rawHi + step; ticksY = [rawLo];
    } else {
      step = niceStep(rawHi - rawLo);
      lo = Math.floor(rawLo / step) * step; hi = Math.ceil(rawHi / step) * step;
      if (rawLo >= 0 && lo < 0) lo = 0;  // never a negative axis for a quantity that can't be negative
      if (hi - lo < step) hi = lo + step;
      ticksY = []; for (let v = lo; v <= hi + step / 2; v += step) ticksY.push(+v.toFixed(6));
    }
    const dec = flat ? (Number.isInteger(rawLo) ? 0 : Math.min(2, (String(+rawLo.toFixed(2)).split(".")[1] || "").length)) : stepDecimals(step);
    const small = innerWidth < 600;
    // the chart is drawn at (about) its real width in pixels, so its 11 px labels stay 11 px
    const W = Math.max(280, Math.round(dh.W || (small ? 340 : 420))), H = small ? 150 : 170;
    const labelW = Math.max(...ticksY.map(v => v.toFixed(dec).length)) * 6.5 + 10;
    const P = { l: Math.max(28, Math.round(labelW)), r: 8, t: 10, b: 22 };
    const X = t => P.l + (t - t0) / ((t1 - t0) || 1) * (W - P.l - P.r), Y = v => P.t + (1 - (v - lo) / (hi - lo)) * (H - P.t - P.b);
    // break the line where data is missing for a long time (offline device, restart)
    const steps = pts.slice(1).map((p, i) => p.t - pts[i].t).sort((a, b) => a - b);
    const median = steps.length ? steps[steps.length >> 1] : 0;
    const gap = Math.max(median * 4, ((t1 - t0) / 300) * 6, 900);
    const segs = []; let dots = "";
    pts.forEach((p, i) => {
      const near = i && p.t - pts[i - 1].t <= gap, nearNext = i + 1 < pts.length && pts[i + 1].t - p.t <= gap;
      const joined = i && (joinGaps || near), next = i + 1 < pts.length && (joinGaps || nearNext);
      const xy = [X(p.t), Y(conv(p.v))];
      if (joined) segs[segs.length - 1].push(xy); else segs.push([xy]);
      // a reading next to a gap gets a dot: with the line joined, the dots show where the readings really are
      if ((joinGaps ? (pts.length <= 48 || !(near && nearNext)) && pts.length > 1 : !joined && !next) && chartStyle !== "bars")
        dots += `<circle class="lone" cx="${f1x(xy[0])}" cy="${f1x(xy[1])}" r="2.5"/>`;
    });
    const plotW = W - P.l - P.r, nb = Math.max(20, Math.round(plotW / 8));
    const plot = flat ? plotSvg(segs, H - P.b, "line") : chartStyle === "bars"
      ? plotSvg([bucketize(segs.flat(), nb)], H - P.b, "bars", plotW / nb * 0.7)
      : plotSvg(segs, H - P.b);
    const grid = ticksY.map(v => { const y = Y(v);
      return `<line x1="${P.l}" x2="${W - P.r}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}" class="g"/><text x="${P.l - 6}" y="${(y + 4).toFixed(1)}" text-anchor="end">${v.toFixed(dec)}</text>`; }).join("");
    const nx = W < 380 ? 3 : W < 560 ? 4 : 5;
    const ticks = axisTicks(t0, t1, nx).map((t, i, a) =>
      `<text x="${X(t).toFixed(1)}" y="${H - 6}" text-anchor="${i === 0 ? "start" : i === a.length - 1 ? "end" : "middle"}">${esc(fmtTime(t, t1 - t0))}</text>`).join("");
    const avg = vs.reduce((a, b) => a + b, 0) / vs.length;
    const f1 = v => `${+v.toFixed(Math.abs(v) < 10 ? 2 : 1)}${u && !u.startsWith("°") ? " " : ""}${u}`;
    const cur = d.capabilities[k]?.value;
    dhPts.set(k, { pts, t0, t1, conv, u, W, H, P, lo, hi });
    const label = capLabel(d, k);
    const summary = flat ? `${label} over ${rangeName()}: steady at ${f1(rawLo)}` : `${label} over ${rangeName()}: low ${f1(rawLo)}, average ${f1(avg)}, high ${f1(rawHi)}`;
    return `<section class="hcard ${dh.focus === k ? "focus" : ""}" data-hcap="${esc(k)}">
      <div class="hcard-head">${icon(META_ICON[k] || (temperature ? "thermostat" : k === "humidity" ? "water_drop" : k === "battery" ? "battery_full" : "sensors"))}
        <b>${esc(label)}</b><span class="hnow">${cur == null ? "" : esc(f1(conv(Number(cur))))}</span></div>
      <div class="hstats">${flat ? `<span>Steady at <b>${esc(f1(rawLo))}</b> the whole time</span>`
        : `<span>Low <b>${esc(f1(rawLo))}</b></span><span>Avg <b>${esc(f1(avg))}</b></span><span>High <b>${esc(f1(rawHi))}</b></span>`}</div>
      <div class="hplot"><svg viewBox="0 0 ${W} ${H}" class="hchart c-${chartStyle}" data-hcap="${esc(k)}" role="img" aria-label="${esc(summary)}">${grid}${ticks}
        ${plot}${dots}
        <line class="cross" x1="0" x2="0" y1="${P.t}" y2="${H - P.b}" visibility="hidden"/><circle class="dot" r="4" visibility="hidden"/></svg>
        <div class="htip" hidden></div></div>
    </section>`;
  }

  const NEVER = { contact: "Never opened", lock: "Never unlocked", valve: "Never opened", leak: "No leak", motion: "No motion",
    occupancy: "Nobody detected", presence: "Nobody detected", smoke: "No smoke", co: "No carbon monoxide", light: "Never turned on",
    switch: "Never turned on", watering: "Never watered", charging: "Never charged", ups_status: "Never left mains power", alarm_panel: "Never armed" };
  function stateTimeline(d, k, pts, t0, t1) {
    const now = t1;
    // segments from each change to the next one (the last runs until now)
    const segs = [];
    pts.forEach((p, i) => {
      const a = Math.max(p.t, t0), b = Math.min(i + 1 < pts.length ? pts[i + 1].t : now, t1);
      if (b > a) segs.push({ a, b, v: Math.round(Number(p.v) + (typeof d.capabilities[k]?.value === "boolean" ? 0 : 0)) });
    });
    // repeated samples of the same state are one stretch
    const merged = segs.reduce((m, s) => { const l = m[m.length - 1]; if (l && l.v === s.v) l.b = Math.max(l.b, s.b); else m.push({ ...s }); return m; }, []);
    const span = (t1 - t0) || 1;
    const bad = BAD_STATES.has(k);
    const tone = v => v === 0 ? "off" : (bad || (k === "ups_status" && v >= 1) || (k === "alarm_panel" && v === 6) || (k === "lock" && v === 2)) ? "bad" : "on";
    const active = merged.filter(s => s.v !== 0);
    const activeTime = active.reduce((a, s) => a + (s.b - s.a), 0);
    // how often it went INTO the active state (from the resting state) within the range
    const times = merged.filter((s, i) => i > 0 && s.v !== 0 && merged[i - 1].v === 0).length;
    const bars = merged.map(s => `<i class="${tone(s.v)}" style="left:${((s.a - t0) / span * 100).toFixed(3)}%;width:${Math.max(0.15, (s.b - s.a) / span * 100).toFixed(3)}%"
      title="${esc(stateWord(k, s.v))} · ${esc(whenText(s.a, span))} – ${esc(whenText(s.b, span))} (${esc(durText(s.b - s.a))})"></i>`).join("");
    const changes = merged.slice(-6).reverse().map(s => `<li><span class="sw ${tone(s.v)}"></span><b>${esc(stateWord(k, s.v))}</b>
      <span>${esc(new Date(s.a * 1000).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", ...timeOpts() }))}</span><span class="muted">${esc(durText(s.b - s.a))}</span></li>`).join("");
    const word1 = stateWord(k, 1);
    return `<section class="hcard state ${dh.focus === k ? "focus" : ""}" data-hcap="${esc(k)}">
      <div class="hcard-head">${icon(STATE_ICON[k] || META_ICON[k] || "toggle_on")}<b>${esc(capLabel(d, k))}</b><span class="hnow">${esc(stateWord(k, Number(d.capabilities[k]?.value === true ? 1 : d.capabilities[k]?.value === false ? 0 : (dh.data.states?.[k]?.[String(d.capabilities[k]?.value).toLowerCase()] ?? 0))))}</span></div>
      <div class="hstats">${activeTime < 1 ? `<span>${esc(NEVER[k] || `Never ${word1.toLowerCase()}`)} in this period</span>`
        : activeTime >= span - 1 && !times ? `<span><b>${esc(word1)}</b> the whole time</span>`
        : `<span>${esc(word1)} <b>${times}×</b></span><span>Total <b>${esc(durText(activeTime))}</b></span><span><b>${(activeTime / span * 100).toFixed(activeTime / span < 0.1 ? 1 : 0)}%</b> of the time</span>`}</div>
      <div class="tline">${bars}</div>
      <div class="tticks">${axisTicks(t0, t1).map(t => `<span>${esc(fmtTime(t, t1 - t0))}</span>`).join("")}</div>
      ${dh.data?.truncated?.[k] ? `<p class="muted small">Very many changes in this range: the timeline is simplified.</p>` : ""}
      ${changes ? `<details class="tchanges"><summary>Recent changes</summary><ul>${changes}</ul></details>` : ""}
    </section>`;
  }

  function devHistoryHtml(d) {
    const shown = [...PANEL_RANGES.filter(r => histRanges.includes(r)), "custom"];
    let ranges = `<div class="segmented ranges dh-ranges" role="group" aria-label="Time range">${shown.map(r => `<button type="button" data-dhrange="${r}" class="${r === dh.range ? "on" : ""}" aria-pressed="${r === dh.range}">${r === "custom" ? `${icon("tune")}Custom` : r}</button>`).join("")}</div>`;
    if (dh.range === "custom") ranges += customFormHtml() + (dh.data && !dh.loading && !dh.error
      ? `<p class="dh-span">${icon("schedule")}<span>${esc(rangeText(dh.data.start, dh.data.end))}${dh.data.clamped ? ` <span class="muted">(adjusted to the history kept)</span>` : ""}</span></p>` : "");
    if (dh.loading && (!dh.data || dh.id !== d.id)) return ranges + `<div class="snap-wait">${icon("timer")}<span>Loading history…</span></div>`;
    if (dh.error) return ranges + `<div class="snap-wait">${icon("info")}<span>${esc(dh.error)}</span></div>`;
    const series = dh.data?.series || {};
    const now = Number(dh.data?.end) || Date.now() / 1000, rs = (dh.data ? Number(dh.data.end) - Number(dh.data.start) : 0) || RANGE_SECS[dh.range] || 86400;
    // all charts share one time axis: from the start of the range (or the first data, if later) to now
    const first = Math.min(...Object.values(series).filter(p => p.length).map(p => p[0].t), now);
    const t0 = Math.max(now - rs, first), t1 = now;
    dhPts.clear();
    const keys = Object.keys(series).sort((a, b) => {
      const ia = CHART_ORDER.indexOf(a), ib = CHART_ORDER.indexOf(b);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
    });
    const states = keys.filter(k => isStateCap(d, k) && series[k].length), nums = keys.filter(k => !isStateCap(d, k));
    // the device's main state (door, lock, valve, leak, light, UPS…) first, then readings, then minor flags
    const main = states.filter(k => MAIN_STATES.has(k)), minor = states.filter(k => !MAIN_STATES.has(k));
    // chart width = the card's real width (see #devpanel in style.css), so text in the SVG is drawn at its real size
    const nCards = main.length + minor.length + nums.filter(k => series[k].length >= 2).length;
    const inner = innerWidth < 840 ? innerWidth - 32 : Math.min(920, innerWidth - 32) - 48;
    const cols = nCards > 1 && inner >= 2 * 380 + 12 ? 2 : 1;
    dh.W = (inner - (cols - 1) * 12) / cols - 28;
    const cards = [...main.map(k => stateTimeline(d, k, series[k], t0, t1)),
      ...nums.filter(k => series[k].length >= 2).map(k => numChart(d, k, series[k], t0, t1)),
      ...minor.map(k => stateTimeline(d, k, series[k], t0, t1))].join("");
    const empty = [...nums.filter(k => series[k].length < 2), ...keys.filter(k => isStateCap(d, k) && !series[k].length)].map(k => capLabel(d, k));
    const since = first > now - rs + 60 ? `<p class="muted small">History starts ${esc(new Date(first * 1000).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", ...timeOpts() }))}${histBackend === "memory" ? " · only the last 24 hours are kept (Settings → History & metrics to keep more)" : ""}.</p>` : "";
    return `${ranges}${dh.loading ? `<div class="hloading"></div>` : ""}${since}
      <div class="hcards ${cols === 1 ? "one" : ""}">${cards || `<div class="snap-wait">${icon("info")}<span>${dh.range === "custom" ? "No history in this range." : `No history for ${esc(dh.range)} yet. Readings are recorded from now on.`}</span></div>`}</div>
      ${empty.length && cards ? `<p class="muted small">Not enough data yet for: ${empty.map(esc).join(", ")}.</p>` : ""}`;
  }

  // Hover / tap read-out on a line chart: nearest reading under the pointer. onPos(x | null) remembers the pointer
  // (live charts redraw every second and restore it through svg._showAt); withSeconds for the 5-minute charts.
  function chartHover(svg, info, onPos = null, withSeconds = false) {
    const tip = svg.parentElement.querySelector(".htip"), cross = svg.querySelector(".cross"), dot = svg.querySelector(".dot");
    const { pts, t0, t1, conv, u, W, H, P, lo, hi } = info;
    if (!pts.length) return;
    const showAt = clientX => {
      const r = svg.getBoundingClientRect(); if (!r.width) return;
      const x = (clientX - r.left) / r.width * W;
      const t = t0 + (x - P.l) / (W - P.l - P.r) * (t1 - t0);
      let lo2 = 0, hi2 = pts.length - 1;
      while (hi2 - lo2 > 1) { const m = (lo2 + hi2) >> 1; if (pts[m].t < t) lo2 = m; else hi2 = m; }
      const p = Math.abs(pts[lo2].t - t) < Math.abs(pts[hi2].t - t) ? pts[lo2] : pts[hi2];
      const px = P.l + (p.t - t0) / ((t1 - t0) || 1) * (W - P.l - P.r), py = P.t + (1 - (conv(p.v) - lo) / (hi - lo)) * (H - P.t - P.b);
      cross.setAttribute("x1", px); cross.setAttribute("x2", px); cross.setAttribute("visibility", "visible");
      dot.setAttribute("cx", px); dot.setAttribute("cy", py); dot.setAttribute("visibility", "visible");
      tip.hidden = false;
      tip.textContent = `${+conv(p.v).toFixed(2)}${u && !u.startsWith("°") ? " " : ""}${u} · ${new Date(p.t * 1000).toLocaleString([], withSeconds
        ? { hour: "numeric", minute: "2-digit", second: "2-digit", ...timeOpts() } : { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", ...timeOpts() })}`;
      const left = px / W * r.width; tip.style.left = `${Math.min(Math.max(left, 70), r.width - 70)}px`;
    };
    const move = e => { showAt(e.clientX); onPos?.(e.clientX); };
    const leave = () => { tip.hidden = true; cross.setAttribute("visibility", "hidden"); dot.setAttribute("visibility", "hidden"); onPos?.(null); };
    // a finger lifting fires pointerleave: keep the read-out until the next tap somewhere else
    svg.addEventListener("pointermove", move); svg.addEventListener("pointerdown", move);
    svg.addEventListener("pointerleave", e => { if (e.pointerType !== "touch") leave(); });
    svg._hideTip = leave; svg._showAt = showAt;
  }
  function wireDevHistory() {
    const body = $("#devpanel-body");
    if (dh.focus) body.querySelector(`.hcard[data-hcap="${CSS.escape(dh.focus)}"]`)?.scrollIntoView({ block: "nearest" });
    body.querySelectorAll("svg.hchart[data-hcap]").forEach(svg => {
      const info = dhPts.get(svg.dataset.hcap); if (info) chartHover(svg, info);
    });
    wireTipDismiss();
    wireCustomRange();
  }
  function wireTipDismiss() {
    if (wireTipDismiss.done) return; wireTipDismiss.done = true;
    document.addEventListener("pointerdown", e => {
      $$("#devpanel svg.hchart").forEach(svg => { if (!svg.contains(e.target)) svg._hideTip?.(); });
    }, true);
  }

  // ---------- snapshot ----------
  let snapId = null;
  async function showSnapshot(id) {
    snapId = id; const d = devices.get(id);
    $("#snap-title").textContent = d ? d.name : "Snapshot";
    $("#snap-frame").innerHTML = `<div class="snap-wait">${icon("photo_camera")}<span>Asking the camera for a snapshot…</span></div>`;
    if (!$("#snapshot").open) $("#snapshot").showModal();
    try {
      const r = await fetch(`/api/ring/${encodeURIComponent(id)}/snapshot`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || r.statusText);
      if (showSnapshot.url) URL.revokeObjectURL(showSnapshot.url);
      const url = showSnapshot.url = URL.createObjectURL(await r.blob());
      $("#snap-frame").innerHTML = `<img src="${url}" alt="Snapshot from ${esc(d?.name)}"><small>${new Date().toLocaleTimeString([], timeOpts())}</small>`;
    } catch (e) { $("#snap-frame").innerHTML = `<div class="snap-wait">${icon("wifi_off")}<span>${esc(e.message)}</span></div>`; }
  }
  $("#snap-refresh").onclick = () => snapId && showSnapshot(snapId);

