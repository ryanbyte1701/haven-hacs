// Haven dashboard, part 5 of 11: Battery, Lights, Devices, Air quality and Power pages.
// The parts are plain scripts that index.html loads in order; they share one scope (no build step).
// A part can use anything earlier parts declare. Code that runs while the page loads (not inside a
// function called later) must not use a later part.
  // ---------- battery page ----------
  function batteryPage(list) {
    const bat = list.filter(d => val(d, "battery") != null || val(d, "battery_low") != null);
    const lvl = d => val(d, "battery") ?? (val(d, "battery_low") ? 10 : 100);
    bat.sort((a, b) => lvl(a) - lvl(b) || a.name.localeCompare(b.name));
    const groups = gbNow === "type" ? typeGroups(bat).map(([t, items]) => [typeHead(t, items.length), d => items.includes(d), true])
      : [["Replace soon", d => lvl(d) <= 25], ["Getting low", d => lvl(d) > 25 && lvl(d) <= 50], ["Good", d => lvl(d) > 50]];
    if (gbNow === "type") bat.sort((a, b) => lvl(a) - lvl(b) || byRoomThen((x, y) => x.name.localeCompare(y.name))(a, b));
    const withPct = bat.filter(d => val(d, "battery") != null);
    const avg = withPct.length ? Math.round(withPct.reduce((a, d) => a + val(d, "battery"), 0) / withPct.length) : null;
    const low = bat.filter(d => lvl(d) <= 25);
    $("#summary").innerHTML = tile(low.length ? "warn" : "good", low.length ? "battery_alert" : "battery_full", `${low.length}`,
      low.length ? "need new batteries" : "All batteries healthy", true) +
      tile("", "battery_5_bar", avg != null ? `${avg}<small>%</small>` : "–", "Average level") +
      tile("", "sensors", `${bat.length}`, "battery-powered devices");
    $("#alerts").innerHTML = "";
    const row = d => {
      const b = val(d, "battery");
      return `<div class="batt-row" data-id="${esc(d.id)}"><span class="avatar ${lvl(d) <= 25 ? "warn" : ""}">${icon(batteryIcon(lvl(d)), lvl(d) <= 25)}</span>
        <div><b>${esc(d.name)}</b><small>${esc([d.room, srcLabel(d), d.model].filter(Boolean).join(" · "))}</small></div>
        ${b != null ? levelBar(b) : `<span class="level ${val(d, "battery_low") ? "low" : ""}"><span class="bar"><i style="width:${val(d, "battery_low") ? 10 : 100}%"></i></span><span>${val(d, "battery_low") ? "Low" : "OK"}</span></span>`}
        <span class="when">${ago(lastUpdated(d))}</span></div>`;
    };
    $("#rooms").innerHTML = bat.length ? `<div class="batt-list">${groups.map(([label, fn, isType]) => {
      const g = bat.filter(fn); return g.length ? `<div class="batt-group ${isType ? "tgroup" : ""}">${isType ? label : `${label} · ${g.length}`}</div>${g.map(row).join("")}` : ""; }).join("")}</div>`
      : `<p class="empty">No battery-powered devices yet.</p>`;
  }

  // ---------- lights page ----------
  function lightsPage(list) {
    const lights = list.filter(d => tabsOf(d).includes("lights") && !isGroup(d)), groups = list.filter(d => isGroup(d) && tabsOf(d).includes("lights"));
    const on = lights.filter(d => val(d, "light"));
    $("#summary").innerHTML = tile(on.length ? "primary" : "", "lightbulb", `${on.length}<small> on</small>`,
      on.length ? on.map(d => d.name).slice(0, 3).join(", ") + (on.length > 3 ? ` +${on.length - 3}` : "") : "Everything is off", !!on.length) +
      tile("", "home_iot_device", `${lights.length}`, `lights · ${groups.length} room${groups.length === 1 ? "" : "s"} & zones`);
    $("#alerts").innerHTML = "";
    if (!lights.length && !groups.length) {
      $("#rooms").innerHTML = `<div class="empty-state">${icon("lightbulb")}<h3>No lights yet</h3><p>Pair your Philips Hue bridge under Settings → Philips Hue. Zigbee2MQTT bulbs show up automatically through MQTT.</p>
        <button class="tonal-btn" data-goto="settings">${icon("settings")}Open Settings</button></div>`; return;
    }
    if (gbNow === "type") { $("#rooms").innerHTML = typeSections([...groups, ...lights], (a, b) => a.name.localeCompare(b.name)); initSortables(); return; }
    const groupSec = groups.length ? `<section class="room" data-fixed><h2>Rooms &amp; zones</h2><div class="grid">${groups.sort((a, b) => a.name.localeCompare(b.name)).map(card).join("")}</div></section>` : "";
    $("#rooms").innerHTML = roomSections(lights, { extraFirst: groupSec });
    initSortables();
  }

  // ---------- devices page: every device, its tabs, room, visibility ----------
  let devQuery = "", devFilter = "all";
  let devSort = JSON.parse(load("devSort", '{"key":"room","dir":1}'));
  let devSel = { source: "", type: "", room: "" };
  const TYPE_NAMES = { ...Object.fromEntries(TABS.map(([t, l]) => [t, l])), battery: "Batteries", power: "UPS", none: "In no tab" };
  const primaryType = d => (TYPE_INFO[deviceType(d)] || TYPE_INFO.other)[1];
  const DEV_SORTS = {
    name: ["Name", d => d.name.toLowerCase(), null],
    room: ["Room", d => `${d.room ? 0 : 1}|${(d.room || "").toLowerCase()}|${d.name.toLowerCase()}`, d => d.room || "No room"],
    type: ["Type", d => `${primaryType(d)}|${d.name.toLowerCase()}`, primaryType],
    source: ["Integration", d => `${srcLabel(d)}|${d.name.toLowerCase()}`, srcLabel],
    updated: ["Last update", d => -lastUpdated(d), null],
    battery: ["Battery", d => val(d, "battery") ?? (val(d, "battery_low") === true ? 5 : 999), null],
    status: ["Offline first", d => `${d.online ? 1 : 0}|${d.online ? "" : String(1e12 - lastUpdated(d)).padStart(14, "0")}|${d.name.toLowerCase()}`,
      d => d.online ? "Online" : "Offline"],
  };
  function devicesPage() {
    $("#summary").innerHTML = "";
    $("#alerts").innerHTML = `<div class="devtools">
      <label class="search">${icon("search")}<input id="devsearch" type="search" placeholder="Search devices, rooms, brands" value="${esc(devQuery)}" autocomplete="off"><small id="devcount"></small></label>
      <div class="devfilters" id="devfilters">
        ${devSelect("source", "Integration", [...new Set([...devices.values()].map(srcLabel))].sort().map(x => [x, x]))}
        ${devSelect("type", "Type", Object.entries(TYPE_NAMES))}
        ${devSelect("room", "Room", [...new Set([...devices.values()].map(d => d.room || "No room"))].sort().map(x => [x, x]))}
        ${[["offline", `Offline (${[...devices.values()].filter(d => !d.online).length})`], ["changed", "Tabs changed"], ["hidden", "Hidden"]].map(([k, l]) =>
          `<button type="button" class="fchip ${devFilter === k ? "on" : ""}" data-devfilter="${k}">${devFilter === k ? icon("check") : ""}${l}</button>`).join("")}
        <span class="devsort"><label class="selchip">${icon("swap_vert")}<span>Sort: ${(DEV_SORTS[devSort.key] || DEV_SORTS.room)[0]}</span><select id="devsort">${Object.entries(DEV_SORTS).map(([k, [l]]) =>
          `<option value="${k}" ${devSort.key === k ? "selected" : ""}>${l}</option>`).join("")}</select></label>
          <button type="button" class="icon-btn" id="devsortdir" title="${devSort.dir > 0 ? "Ascending" : "Descending"}">${icon(devSort.dir > 0 ? "arrow_upward" : "arrow_downward")}</button></span>
      </div></div>`;
    $("#rooms").innerHTML = `<div class="devlist"></div>`;
    renderDeviceList();
  }
  function devSelect(key, label, options) {
    const cur = devSel[key];
    return `<label class="selchip ${cur ? "on" : ""}">${cur ? icon("check") : ""}<span>${esc(cur ? (options.find(o => o[0] === cur) || [0, cur])[1] : label)}</span>
      <select data-devsel="${key}" aria-label="${label}"><option value="">All ${label === "Type" ? "types" : label === "Room" ? "rooms" : "integrations"}</option>${options.map(([v, l]) =>
        `<option value="${esc(v)}" ${cur === v ? "selected" : ""}>${esc(l)}</option>`).join("")}</select></label>`;
  }
  function renderDeviceList() {
    const box = $(".devlist"); if (!box) return;
    const q = devQuery.trim().toLowerCase();
    const all = [...devices.values()].filter(d => !q || `${d.name} ${d.room} ${srcLabel(d)} ${d.model}`.toLowerCase().includes(q))
      .filter(d => devFilter === "changed" ? Array.isArray(d.categories) : devFilter === "hidden" ? d.hidden : devFilter === "offline" ? !d.online : true)
      .filter(d => !devSel.source || srcLabel(d) === devSel.source)
      .filter(d => !devSel.room || (d.room || "No room") === devSel.room)
      .filter(d => !devSel.type || (devSel.type === "none" ? !tabsOf(d).length : devSel.type === "battery" ? typeMatch(d, "battery")
        : devSel.type === "power" ? isUps(d) || isPlug(d) : tabsOf(d).includes(devSel.type)));
    const [, keyFn, groupFn] = DEV_SORTS[devSort.key] || DEV_SORTS.room;
    all.sort((a, b) => { const x = keyFn(a), y = keyFn(b); return (x < y ? -1 : x > y ? 1 : 0) * devSort.dir; });
    const counts = { all: devices.size, changed: [...devices.values()].filter(d => Array.isArray(d.categories)).length,
      hidden: [...devices.values()].filter(d => d.hidden).length };
    box.innerHTML = `<details class="devnote" ${load("devNoteClosed", "") ? "" : "open"}><summary>${icon("info")}<span>How tabs work${counts.changed || counts.hidden ? ` · ${[counts.changed ? `${counts.changed} changed` : "", counts.hidden ? `${counts.hidden} hidden` : ""].filter(Boolean).join(" · ")}` : ""}</span>${icon("keyboard_arrow_down")}</summary>
      <p>Tabs are picked automatically from what each device reports. Security includes locks, door and window sensors, alarm panels, cameras, smoke, CO and gas alarms, and motion and presence sensors. Tap a tab to add or remove a device; changed devices are marked <b>Custom</b> and can be reset to automatic. Every device always appears on Home unless it's hidden.</p></details>
      <div class="devhead"><span>Device</span><span>Room</span><span>Shows in tabs</span><span>Visible</span></div>` +
      (all.map((d, i) => {
        const [ic, tone] = deviceIcon(d), tabs = tabsOf(d), custom = Array.isArray(d.categories), auto = autoTabs(d);
        const g = groupFn ? groupFn(d) : null, prevG = i && groupFn ? groupFn(all[i - 1]) : null;
        const header = g != null && g !== prevG ? `<div class="devgroup">${esc(g)}<small>${all.filter(x => groupFn(x) === g).length}</small></div>` : "";
        return header + `<div class="devrow ${d.hidden ? "is-hidden" : ""}" data-id="${esc(d.id)}">
          <div class="dcell dname"><span class="avatar ${tone}">${icon(ic, !!tone)}</span><div><b>${esc(d.name)}</b><small>${esc([srcLabel(d), d.model].filter(Boolean).join(" · "))}</small></div>
            <button class="icon-btn" data-edit title="Rename, move or pin" aria-label="Edit ${esc(d.name)}">${icon("edit")}</button></div>
          <div class="dcell droom ${d.room ? "" : "muted"}">${esc(d.room || "No room")}</div>
          <div class="dcell dtabs">${TABS.filter(([t]) => t !== "appliances" || edition === "hacs").map(([t, l, ti]) => `<button type="button" class="tabchip ${tabs.includes(t) ? "on" : ""} ${!custom ? "auto" : auto.includes(t) !== tabs.includes(t) ? "changed" : ""}"
              data-tab="${t}" aria-pressed="${tabs.includes(t)}" title="${tabs.includes(t) ? "Remove from" : "Add to"} ${l}">${icon(ti, tabs.includes(t))}${l}</button>`).join("")}
            ${custom ? `<button type="button" class="text-btn reset-tabs" data-reset-tabs title="Back to automatic: ${esc(auto.map(t => TABS.find(x => x[0] === t)[1]).join(", ") || "no tabs")}">${icon("restart_alt")}Custom · reset</button>`
              : `<span class="autotag">Auto</span>`}</div>
          <div class="dcell dvis"><button class="m3-switch sm ${d.hidden ? "" : "on"}" role="switch" aria-checked="${!d.hidden}" data-visible aria-label="Show ${esc(d.name)}"></button></div>
        </div>`; }).join("") || `<div class="empty-state">${icon("filter_alt_off")}<h3>No devices match</h3><p>Nothing fits ${devQuery ? `“${esc(devQuery)}” and ` : ""}these filters.</p>
          <button type="button" class="tonal-btn" data-clear-devfilters>${icon("close")}Clear filters</button></div>`);
    const n = $("#devcount"); if (n) n.textContent = `${all.length} of ${devices.size}`;
  }
  async function patchDevice(id, body, msg) {
    try { const d = await api(`/api/devices/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(body) });
      devices.set(id, d); renderDeviceList(); renderBadges(); if (msg) snack(msg); }
    catch (err) { snack(err.message); }
  }

  // ---------- air quality page ----------
  const AQI_BANDS = [[50, "Good", "#00b050"], [100, "Moderate", "#e6b800"], [150, "Unhealthy for sensitive groups", "#ff7e00"],
    [200, "Unhealthy", "#e53935"], [300, "Very unhealthy", "#8f3f97"], [1e9, "Hazardous", "#7e0023"]];
  const aqiBand = a => AQI_BANDS.find(b => (Number.isFinite(Number(a)) ? Number(a) : 0) <= b[0]) || AQI_BANDS[AQI_BANDS.length - 1];
  const aqiColor = a => a == null || !isFinite(a) ? "inherit" : aqiBand(Number(a))[2];
  // [capability, label, unit, good-max, moderate-max, higherIsBetter]
  const AIR_METRICS = [["aqi", "AQI", "", 50, 100], ["air_score", "Air score", "/100", 80, 60, true], ["pm25", "PM2.5", "µg/m³", 12, 35.4],
    ["pm10", "PM10", "µg/m³", 54, 154], ["co2", "CO₂", "ppm", 800, 1200], ["voc", "VOC", "ppb", 333, 1000], ["ozone", "Ozone", "µg/m³", 100, 160],
    ["no2", "NO₂", "µg/m³", 40, 100], ["so2", "SO₂", "µg/m³", 40, 125], ["co", "CO", "µg/m³", 4000, 10000], ["co_ppm", "CO", "ppm", 9, 35],
    ["dust", "Dust", "µg/m³", 50, 150], ["uv", "UV", "", 2, 7], ["humidity", "Humidity", "%", null, null], ["filter_life", "Filter", "%", null, null]];
  const AIR_KEYS = new Set(["aqi", "air_score", "pm25", "pm10", "co2", "voc", "ozone", "no2", "so2", "dust", "co_ppm"]);
  function airTone(m, v) {
    const [k, , , good, mod, hib] = m;
    if (v == null || typeof v !== "number") return "";
    if (k === "humidity") return v < 25 || v > 65 ? "mod" : "good";
    if (k === "filter_life") return v < 10 ? "bad" : v < 25 ? "mod" : "good";
    if (good == null) return "";
    return hib ? (v >= good ? "good" : v >= mod ? "mod" : "bad") : (v <= good ? "good" : v <= mod ? "mod" : "bad");
  }
  function airPage(list) {
    const stations = list.filter(d => kindOf(d) === "aqi_station");
    const airDevs = list.filter(d => kindOf(d) !== "aqi_station" && Object.keys(d.capabilities).some(k => AIR_KEYS.has(k) && typeof val(d, k) === "number"));
    $("#summary").innerHTML = ""; $("#alerts").innerHTML = "";
    const outdoor = stations.map(d => {
      const a = val(d, "aqi"), [, cat, col] = aqiBand(a), at = d.attributes || {};
      const fc = (at.forecast || []).slice(0, 25), maxA = Math.max(100, ...fc.map(x => x.aqi || 0));
      const bars = fc.length ? `<div class="aqfc">${fc.map(x => `<i title="${esc(new Date(Number(x.t) * 1000).toLocaleString([], { weekday: "short", hour: "numeric", ...timeOpts() }))}: AQI ${Number(x.aqi) || 0}" style="height:${Math.max(4, (Number(x.aqi) || 0) / maxA * 100)}%;background:${aqiColor(Number(x.aqi))}"></i>`).join("")}</div>
        <div class="aqfc-axis"><span>Now</span><span>+12 h</span><span>+24 h</span></div>` : "";
      return `<section class="aqhero" data-id="${esc(d.id)}" style="--aq:${col}">
        <div class="aqmain"><div class="aqring"><b>${n(a)}</b><small>AQI</small></div>
          <div class="aqinfo"><h3>${esc(cat)}</h3><p>${esc([at.place, at.dominant ? `mostly ${at.dominant}` : "", at.provider].filter(Boolean).join(" · "))}</p>
          <small class="muted">${at.observed ? `Observed ${ago(at.observed).toLowerCase()}` : ""} · updates hourly</small></div></div>
        <div class="aqtiles">${[["pm25", "PM2.5", "µg/m³"], ["pm10", "PM10", "µg/m³"], ["ozone", "Ozone", "µg/m³"], ["no2", "NO₂", "µg/m³"], ["so2", "SO₂", "µg/m³"],
          ["co", "CO", "µg/m³"], ["dust", "Dust", "µg/m³"], ["uv", "UV index", ""], ["pm25_aqi", "PM2.5 AQI", ""], ["pm10_aqi", "PM10 AQI", ""], ["ozone_aqi", "Ozone AQI", ""]]
          .map(([k, l, u]) => val(d, k) == null ? "" : `<button class="aqtile" data-hist="${esc(k)}"><small>${l}</small><b>${fmt(val(d, k))}</b><span>${u}</span></button>`).join("")}</div>
        ${bars ? `<div class="aqfc-wrap"><small>Next 24 hours</small>${bars}</div>` : ""}
      </section>`;
    }).join("") || `<section class="aqhero empty"><div class="empty-state">${icon("aq")}<h3>Add your outdoor air quality</h3>
      <p>Enter your ZIP code and Haven checks the AQI every hour (Open-Meteo, no key needed; EPA AirNow optional).</p>
      <button class="tonal-btn" data-goto-setting="airquality">${icon("settings")}Set up</button></div></section>`;
    const cols = AIR_METRICS.filter(m => airDevs.some(d => typeof val(d, m[0]) === "number"));
    const table = airDevs.length ? `<div class="table-wrap"><table class="dtable airtable"><thead><tr><th class="c-name">Device</th><th>Room</th>${cols.map(m => `<th>${m[1]}</th>`).join("")}<th>Updated</th></tr></thead><tbody>${
      airDevs.sort((a, b) => (a.room || "~").localeCompare(b.room || "~") || a.name.localeCompare(b.name)).map(d => {
        const [ic, tone] = deviceIcon(d);
        return `<tr data-id="${esc(d.id)}"><td class="c-name"><div class="dev"><span class="avatar ${tone}">${icon(ic, !!tone)}</span><div><b>${esc(d.name)}</b><small>${esc(srcLabel(d))}</small></div></div></td>
          <td>${esc(d.room || "—")}</td>${cols.map(m => { const v = val(d, m[0]); return `<td>${typeof v === "number" ? `<button class="aqcell ${airTone(m, v)}" data-hist="${m[0]}">${m[0] === "temperature" ? temp(v) : fmt(v)}<small>${m[2]}</small></button>` : `<span class="muted">—</span>`}</td>`; }).join("")}
          <td class="muted">${ago(lastUpdated(d))}</td></tr>`; }).join("")}</tbody></table></div>` : `<p class="empty">No indoor air sensors yet. Awair monitors, purifiers (Dyson, Levoit) and Ecowitt PM2.5/CO₂ sensors appear here.</p>`;
    const purifiers = list.filter(d => kindOf(d) === "air_purifier");
    $("#rooms").innerHTML = `<div class="airpage">${outdoor}
      <h2 class="sec-title">Indoor air <small>${airDevs.length} device${airDevs.length === 1 ? "" : "s"} · tap a value for its history</small></h2>${table}
      <div class="aqlegend"><span><i class="good"></i>Good</span><span><i class="mod"></i>Moderate</span><span><i class="bad"></i>Poor</span></div>
      ${purifiers.length ? `<h2 class="sec-title">Purifiers</h2><div class="grid">${purifiers.map(card).join("")}</div>` : ""}</div>`;
  }

  // ---------- power page ----------
  let nutHist = {}, powerRange = load("powerRange", "24h");
  let powerTrend = null;
  async function loadPower() {
    const pt = api(`/api/power/history?range=${powerRange}`).then(r => { powerTrend = r; }).catch(() => {});
    await Promise.all([pt, ...visible().filter(isUps).map(async d => {
      for (const k of ["battery", "load"]) try { nutHist[d.id + "|" + k] = await api(`/api/devices/${encodeURIComponent(d.id)}/history/${k}?range=${powerRange}`); } catch {}
    })]);
    if (view === "power") scheduleQuiet();
  }
  function gauge(pct, tone) {
    const r = 54, c = 2 * Math.PI * r, p = Math.max(0, Math.min(100, pct ?? 0));
    return `<svg class="gauge ${tone}" viewBox="0 0 128 128"><circle cx="64" cy="64" r="${r}" class="track"/>
      <circle cx="64" cy="64" r="${r}" class="fill" stroke-dasharray="${c}" stroke-dashoffset="${c * (1 - p / 100)}"/></svg>`;
  }
  function plugPanel(plugs) {
    if (!plugs.length) return "";
    const total = plugs.reduce((a, d) => a + (Number(val(d, "power")) || 0), 0);
    const today = plugs.reduce((a, d) => a + (Number(val(d, "energy_today")) || 0), 0);
    const metered = plugs.some(d => has(d, "power"));
    const rows = plugs.slice().sort((a, b) => (Number(val(b, "power")) || 0) - (Number(val(a, "power")) || 0) || a.name.localeCompare(b.name)).map(d => {
      const on = !!val(d, "switch");
      return `<tr data-id="${esc(d.id)}" class="${d.online ? "" : "offline"}">
        <td class="c-name"><div class="dev"><span class="avatar ${on ? "active" : ""}">${icon("outlet", on)}</span><div><b>${esc(d.name)}</b><small>${esc([d.room, d.model].filter(Boolean).join(" · "))}${d.online ? "" : " · Offline"}</small></div></div></td>
        <td class="num">${has(d, "power") ? `${n(val(d, "power"))} W` : "–"}</td>
        <td class="num">${has(d, "energy_today") ? `${n(val(d, "energy_today"))} kWh` : "–"}</td>
        <td class="num">${has(d, "energy_month") ? `${n(val(d, "energy_month"))} kWh` : "–"}</td>
        <td class="c-act"><button class="m3-switch ${on ? "on" : ""}" role="switch" aria-checked="${on}" data-cmd="switch" data-val="${esc(JSON.stringify(!on))}" aria-label="Toggle ${esc(d.name)}" ${d.online ? "" : "disabled"}></button></td></tr>`;
    }).join("");
    return `<section class="ups-panel plugs" data-id="plugs">
      <div class="ups-head"><div><h3>${icon("outlet")} Smart plugs</h3><small>${plugs.filter(d => val(d, "switch")).length} of ${plugs.length} on</small></div>
        ${metered ? `<span class="pill">${icon("bolt", true)}${n(Math.round(total))} W now · ${n(Math.round(today * 100) / 100)} kWh today</span>` : ""}</div>
      <div class="table-wrap"><table class="plug-table"><thead><tr><th>Plug</th><th class="num">Using</th><th class="num">Today</th><th class="num">This month</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>
    </section>`;
  }
  // ---------- power trend: total and per device ----------
  const PCOLORS = ["#4e79a7", "#f28e2b", "#59a14f", "#e15759", "#76b7b2", "#b07aa1", "#9c9c9c"];
  const watts = w => w == null ? "–" : w >= 1000 ? `${fmt(Math.round(w / 100) / 10)} kW` : `${fmt(Math.round(w))} W`;
  const kwhText = k => k == null ? "–" : k >= 100 ? `${fmt(Math.round(k))} kWh` : k >= 1 ? `${fmt(Math.round(k * 10) / 10)} kWh` : `${fmt(Math.round(k * 1000))} Wh`;
  function powerStack(pt) {              // the biggest users get their own band; the rest share "Everything else"
    const top = pt.devices.filter(d => d.kwh > 0 || d.points.some(v => v)).slice(0, 6);
    const rest = pt.devices.filter(d => !top.includes(d));
    const bands = top.map((d, i) => ({ id: d.id, name: d.name, color: PCOLORS[i], points: d.points }));
    if (rest.length) bands.push({ id: "", name: `Everything else (${rest.length})`, color: PCOLORS[6],
      points: pt.t.map((_, i) => rest.reduce((a, d) => a + (d.points[i] || 0), 0)) });
    return bands;
  }
  function powerChart(pt, bands) {
    const W = 800, H = 220, L = 0, B = H - 2, N = pt.t.length;
    const tot = pt.t.map((_, i) => bands.reduce((a, b) => a + (b.points[i] || 0), 0));
    const max = Math.max(1, ...tot) * 1.08;
    const x = i => L + i / Math.max(1, N - 1) * (W - L), y = v => B - v / max * (B - 6);
    let under = pt.t.map(() => 0);
    const paths = bands.map(b => {
      const top = under.map((u, i) => u + (b.points[i] || 0));
      const d = `M${top.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("L")}L${under.map((v, i) => [i, v]).reverse().map(([i, v]) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("L")}Z`;
      under = top;
      return `<path d="${d}" fill="${b.color}" fill-opacity=".78" stroke="${b.color}" stroke-width="1"/>`;
    }).join("");
    const grid = [0.25, 0.5, 0.75, 1].map(f => `<line x1="0" x2="${W}" y1="${y(max / 1.08 * f).toFixed(1)}" y2="${y(max / 1.08 * f).toFixed(1)}"/>`).join("");
    const labels = [0.5, 1].map(f => `<span style="top:${(y(max / 1.08 * f) / H * 100).toFixed(1)}%">${watts(max / 1.08 * f)}</span>`).join("");
    const span = pt.end - pt.start;
    return `<div class="ptrend-chart" data-n="${N}"><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"><g class="grid">${grid}</g>${paths}
        <path class="ptotal" d="M${tot.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("L")}"/><line class="pcursor" x1="0" x2="0" y1="0" y2="${H}" hidden/></svg>
      <div class="ylabels">${labels}</div><div class="ptip" hidden></div>
      <div class="xlabels"><span>${esc(fmtTime(pt.start, span))}</span><span>${esc(fmtTime(pt.start + span / 2, span))}</span><span>Now</span></div></div>`;
  }
  function powerTrendPanel(list) {
    const pt = powerTrend;
    if (!pt?.devices?.length) return "";
    const metered = list.filter(d => has(d, "power"));
    const nowW = metered.reduce((a, d) => a + (d.online ? Number(val(d, "power")) || 0 : 0), 0);
    const bands = powerStack(pt);
    const color = Object.fromEntries(bands.filter(b => b.id).map(b => [b.id, b.color]));
    const total = pt.total_kwh || 0;
    const rows = pt.devices.map(d => {
      const dev = devices.get(d.id), share = total > 0 ? d.kwh / total * 100 : 0;
      const sp = d.points.filter(v => v != null).length > 1 ? sparkSvg(d.points.map((v, i) => ({ t: pt.t[i], v: v ?? 0 })), "power", 32) : "";
      return `<tr data-id="${esc(d.id)}" class="${d.online ? "" : "offline"}">
        <td class="c-name"><div class="dev"><span class="pdot" style="background:${color[d.id] || PCOLORS[6]}"></span><div><b>${esc(d.name)}</b><small>${esc([d.room, dev && isUps(dev) ? "UPS" : ""].filter(Boolean).join(" · "))}${d.online ? "" : " · Offline"}</small></div></div></td>
        <td class="c-spark">${sp}</td>
        <td class="num">${watts(dev?.online && typeof val(dev, "power") === "number" ? val(dev, "power") : null)}</td><td class="num">${watts(d.average)}</td><td class="num">${watts(d.peak)}</td>
        <td class="num"><b>${kwhText(d.kwh)}</b><div class="pshare"><i style="width:${share.toFixed(1)}%;background:${color[d.id] || PCOLORS[6]}"></i></div></td></tr>`;
    }).join("");
    const stat = (label, value) => `<div class="pstat"><div><small>${esc(label)}</small><b>${esc(value)}</b></div></div>`;
    return `<section class="ups-panel ptrend" data-id="ptrend">
      <div class="ups-head"><div><h3>${icon("bolt")} Power use</h3><small>${pt.devices.length} metered device${pt.devices.length === 1 ? "" : "s"} · last ${esc(powerRange)}</small></div></div>
      <div class="pstats ptstats">${stat("Using now", watts(nowW))}${stat(`Average · ${powerRange}`, watts(pt.average))}${stat(`Peak · ${powerRange}`, watts(pt.peak))}${stat(`Energy · ${powerRange}`, kwhText(total))}</div>
      ${powerChart(pt, bands)}
      <div class="plegend">${bands.map(b => `<span><i style="background:${b.color}"></i>${esc(b.name)}</span>`).join("")}</div>
      <div class="table-wrap"><table class="plug-table ptrend-table"><thead><tr><th>Device</th><th>Trend</th><th class="num">Now</th><th class="num">Average</th><th class="num">Peak</th><th class="num">Energy</th></tr></thead><tbody>${rows}</tbody></table></div>
    </section>`;
  }
  function powerTip(e) {                 // hover/touch the trend chart: time, total and the top bands at that moment
    const box = e.target.closest?.(".ptrend-chart"); if (!box || !powerTrend) return;
    const r = box.querySelector("svg").getBoundingClientRect(), pt = powerTrend, N = pt.t.length;
    const i = Math.max(0, Math.min(N - 1, Math.round((e.clientX - r.left) / r.width * (N - 1))));
    const bands = powerStack(pt), tip = box.querySelector(".ptip"), cur = box.querySelector(".pcursor");
    const xv = (i / Math.max(1, N - 1) * 800).toFixed(1); cur.setAttribute("x1", xv); cur.setAttribute("x2", xv); cur.hidden = false;
    const tot = bands.reduce((a, b) => a + (b.points[i] || 0), 0);
    tip.innerHTML = `<b>${esc(fmtTime(pt.t[i], pt.end - pt.start > 2 * 86400 ? 3 * 86400 : 3600))}</b><div>Total <b>${watts(tot)}</b></div>` +
      bands.filter(b => b.points[i]).map(b => `<div><i style="background:${b.color}"></i>${esc(b.name)} <b>${watts(b.points[i])}</b></div>`).join("");
    tip.hidden = false;
    const left = e.clientX - r.left; tip.style.left = `${Math.min(Math.max(0, left + 12), r.width - tip.offsetWidth)}px`;
  }
  document.addEventListener("pointermove", powerTip);
  document.addEventListener("pointerleave", e => { const b = e.target.closest?.(".ptrend-chart"); if (b) { b.querySelector(".ptip").hidden = true; b.querySelector(".pcursor").hidden = true; } }, true);

  function powerPage(list) {
    // several UPSes: the ones on battery (or low) first, then by name
    const upsRank = d => ({ low_battery: 0, on_battery: 1 }[val(d, "ups_status")] ?? (d.online ? 3 : 2));
    const ups = list.filter(isUps).sort((a, b) => upsRank(a) - upsRank(b) || a.name.localeCompare(b.name)), plugs = list.filter(isPlug);
    $("#summary").innerHTML = "";
    const metered = list.some(d => has(d, "power"));
    $("#alerts").innerHTML = ups.length || metered ? `<div class="segmented ranges" id="power-ranges">${histRanges.filter(r => r !== "1h").map(r =>
      `<button type="button" data-prange="${r}" class="${r === powerRange ? "on" : ""}">${r}</button>`).join("")}</div>` : "";
    const steady = (pts, u) => pts?.length > 1 && pts.every(p => p.v === pts[0].v) ? ` · steady at ${esc(fmt(pts[0].v))}${u}` : "";
    const stat = (ic, label, value) => `<div class="pstat">${icon(ic)}<div><small>${esc(label)}</small><b>${esc(value)}</b></div></div>`;
    const panels = ups.map(d => {
      const v = d.attributes?.nut_vars || {}, s = val(d, "ups_status");
      const tone = s === "low_battery" ? "bad" : s === "on_battery" ? "warn" : "";
      const [st] = statusOf(d);
      const hb = nutHist[d.id + "|battery"], hl = nutHist[d.id + "|load"];
      return `<section class="ups-panel ${tone}" data-id="${esc(d.id)}">
        <div class="ups-head"><div><h3>${esc(d.name)}</h3><small>${esc([d.model, d.room, d.attributes?.nut_host].filter(Boolean).join(" · "))}</small></div>
          <span class="pill ${tone}">${icon(s === "online" ? "power" : "power_off", true)}${esc(st)}${val(d, "charging") ? " · charging" : ""}</span></div>
        <div class="ups-body">
          <div class="gauge-wrap">${gauge(val(d, "battery"), tone)}<div class="gauge-label"><b>${n(val(d, "battery"))}<small>%</small></b><span>${runtimeText(val(d, "runtime"))}</span></div></div>
          <div class="pstats">
            ${stat("speed", "Load", `${n(val(d, "load"))}%`)}
            ${stat("bolt", "Power", val(d, "power") != null ? `${val(d, "power")} W` : "–")}
            ${stat("electrical_services", "Input", val(d, "input_voltage") != null ? `${val(d, "input_voltage")} V` : "–")}
            ${stat("power", "Output", val(d, "output_voltage") != null ? `${val(d, "output_voltage")} V` : "–")}
            ${stat("battery_full", "Battery", v["battery.voltage"] ? `${v["battery.voltage"]} V` : v["battery.type"] || "–")}
            ${stat("timer", "Runtime", runtimeText(val(d, "runtime")))}
          </div>
        </div>
        ${hb || hl ? `<div class="ups-charts"><button class="spark-btn" data-hist="battery"><small>Charge · ${powerRange}${steady(hb, "%")}</small>${sparkSvg(hb, "battery", 56)}</button><button class="spark-btn" data-hist="load"><small>Load · ${powerRange}${steady(hl, "%")}</small>${sparkSvg(hl, "load", 56)}</button></div>` : ""}
        ${val(d, "replace_battery") ? `<div class="chip bad">${icon("battery_alert", true)}UPS reports the battery needs replacing</div>` : ""}
        <details class="raw"><summary>All UPS values (${Object.keys(v).length})</summary>
          <table>${Object.entries(v).sort().map(([k, x]) => `<tr><td>${esc(k)}</td><td>${esc(x)}</td></tr>`).join("")}</table></details>
      </section>`;
    }).join("");
    $("#rooms").innerHTML = ups.length || plugs.length || powerTrend?.devices?.length ? `<div class="power-wrap">${powerTrendPanel(list)}${panels}${plugPanel(plugs)}</div>`
      : `<div class="empty-state">${icon("power")}<h3>No UPS or smart plugs yet</h3><p>Add your UniFi UPS under Settings → UPS (NUT), or Tapo plugs under Settings → TP-Link Tapo plugs.</p>
         <button class="tonal-btn" data-goto="settings">${icon("settings")}Open Settings</button></div>`;
  }

