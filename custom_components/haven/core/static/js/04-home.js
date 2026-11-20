// Haven dashboard, part 4 of 11: Home page, including the thermostat controls.
// The parts are plain scripts that index.html loads in order; they share one scope (no build step).
// A part can use anything earlier parts declare. Code that runs while the page loads (not inside a
// function called later) must not use a later part.
  // ---------- Home page ----------
  const HOME_TILES = [
    ["leaks", "Leaks", "water_drop"], ["security", "Doors & locks", "shield_lock"], ["safety", "Smoke, CO & alarm", "detector_smoke"],
    ["power", "Power use", "bolt"], ["ups", "UPS / mains power", "battery_charging_full"], ["batteries", "Batteries", "battery_full"],
    ["lights", "Lights", "lightbulb"], ["water", "Water", "water"], ["offline", "Offline devices", "wifi_off"],
    ["ev", "EV charger", "ev_station"], ["vacuum", "Vacuum", "vacuum"], ["irrigation", "Irrigation", "sprinkler"], ["pool", "Pool", "pool"]];
  const HOME_DEFAULT = { weather: true, forecast: true, station: true, climate: true, thermostat: true, aqi_outdoor: true, aqi_indoor: true,
    favorites: true, rooms: true, greeting: true, tiles: ["leaks", "security", "safety", "power", "ups", "batteries", "lights", "water", "offline"] };
  const homeCfg = () => ({ ...HOME_DEFAULT, ...(layout.home || {}) });
  const WX_ICON = { clear: ["clear_day", "partly_cloudy_night"], partly: ["partly_cloudy_day", "partly_cloudy_night"], cloudy: ["cloud", "cloud"],
    fog: ["foggy", "foggy"], rain: ["rainy", "rainy"], sleet: ["weather_snowy", "weather_snowy"], snow: ["weather_snowy", "weather_snowy"], storm: ["thunderstorm", "thunderstorm"] };
  const wxIcon = (kind, day = true) => (WX_ICON[kind] || WX_ICON.cloudy)[day ? 0 : 1];
  const tempC = c => c == null ? "–" : `${Math.round(toUnit(c))}°`;
  // ids: the devices behind the tile; tapping it lists them (each opens its pop-up) instead of just changing page
  const goTile = (go, cls, ic, value, label, sub = "", ids = null) => `<button type="button" class="tile htile ${cls}" data-goto="${esc(go)}"${
      ids?.length ? ` data-ids="${esc(ids.join(" "))}" data-list-title="${esc(String(label || "").replace(/<[^>]+>/g, ""))}"` : ""}>
      <div class="ti">${icon(ic, true)}</div><div class="tv">${value}</div><div class="tl">${esc(label)}</div>${sub ? `<div class="ts">${esc(sub)}</div>` : ""}</button>`;

  function showDeviceList(title, ids, page) {
    const devs = ids.map(id => devices.get(id)).filter(Boolean);
    let dlg = $("#devlist");
    if (!dlg) { document.body.insertAdjacentHTML("beforeend", `<dialog id="devlist" class="m3-dialog" aria-labelledby="devlist-title"></dialog>`); dlg = $("#devlist");
      dlg.addEventListener("click", e => { if (e.target === dlg) dlg.close(); }); }
    dlg.innerHTML = `<h2 id="devlist-title">${esc(title)}</h2>
      <div class="devlist">${devs.map(d => { const [ic, tone] = deviceIcon(d), st = statusOf(d), rd = readingText(d);
        return `<button type="button" class="devlist-row" data-id="${esc(d.id)}" data-open-device><span class="avatar ${tone}">${icon(ic, !!tone)}</span>
          <span class="ltext"><b>${esc(d.name)}</b><small>${esc([d.room, [rd, st?.[0]].filter(Boolean).join(" · ")].filter(Boolean).join(" · "))}</small></span>${icon("chevron_right")}</button>`; }).join("")
        || `<p class="muted">Nothing to show.</p>`}</div>
      <div class="dlg-actions">${page && TITLES[page] ? `<button type="button" class="text-btn" data-goto="${esc(page)}" data-close-list>Open ${esc(TITLES[page])}</button>` : ""}
        <button type="button" class="text-btn" data-close-list>Close</button></div>`;
    dlg.showModal();
  }
  function homeTileHtml(id, list) {
    const names = a => a.map(d => d.name).slice(0, 2).join(", ") + (a.length > 2 ? ` +${a.length - 2}` : "");
    switch (id) {
      case "leaks": {
        const sensors = list.filter(d => has(d, "leak")); if (!sensors.length) return "";
        const wet = sensors.filter(d => val(d, "leak") === true);
        return wet.length ? goTile("water", "bad", "water_damage", `${wet.length} leak${wet.length > 1 ? "s" : ""}`, names(wet), "Check now", wet.map(d => d.id))
          : goTile("water", "good", "water_drop", "No leaks", `${sensors.length} sensor${sensors.length > 1 ? "s" : ""} dry`, "", sensors.map(d => d.id));
      }
      case "security": {
        const doors = list.filter(d => has(d, "contact") && !has(d, "lock")), locks = list.filter(d => has(d, "lock"));
        if (!doors.length && !locks.length) return "";
        const open = doors.filter(d => val(d, "contact") === "open"), unlocked = locks.filter(d => val(d, "lock") === "unlocked");
        const bad = [...open, ...unlocked];
        return bad.length ? goTile("security", "warn", unlocked.length ? "lock_open" : "door_open", `${bad.length} not secure`,
            [...open.map(d => d.name + " open"), ...unlocked.map(d => d.name + " unlocked")].slice(0, 2).join(" · "), bad.map(d => d.id))
          : goTile("security", "good", "shield_lock", "Secure", `${doors.length} closed · ${locks.length} locked`, "", [...doors, ...locks].map(d => d.id));
      }
      case "safety": {
        const det = list.filter(d => ["smoke", "heat", "gas"].some(k => has(d, k)) || coAlarm(d)), panel = list.find(d => has(d, "alarm_panel"));
        if (!det.length && !panel) return "";
        const firing = det.filter(d => ["smoke", "co", "gas", "heat"].some(k => val(d, k) === true));
        if (firing.length || (panel && val(panel, "alarm_panel") === "triggered")) return goTile("security", "bad", "local_fire_department", "Alarm!", names(firing.length ? firing : [panel]), "", (firing.length ? firing : [panel]).map(d => d.id));
        const mode = panel ? esc(ALARM_LABEL[val(panel, "alarm_panel")] || val(panel, "alarm_panel")) : null;
        return goTile("security", "good", panel && val(panel, "alarm_panel") !== "disarmed" ? "shield" : "detector_smoke", mode || "All clear",
          det.length ? `${det.length} detector${det.length > 1 ? "s" : ""} OK` : "Alarm system", mode && det.length ? "Detectors OK" : "", [...det, ...(panel ? [panel] : [])].map(d => d.id));
      }
      case "power": {
        const meters = list.filter(d => (isPlug(d) || kindOf(d) === "ev_charger") && typeof val(d, "power") === "number");
        const ups = list.filter(d => isUps(d) && typeof val(d, "power") === "number");
        if (!meters.length && !ups.length) return "";
        const w = [...meters, ...ups].reduce((a, d) => a + (Number(val(d, "power")) || 0), 0);
        const kwh = list.reduce((a, d) => a + (Number(val(d, "energy_today")) || 0), 0);
        const big = [...meters].sort((a, b) => (val(b, "power") || 0) - (val(a, "power") || 0))[0];
        return goTile("power", "primary", "bolt", w >= 1000 ? `${(w / 1000).toFixed(1)}<small> kW</small>` : `${Math.round(w)}<small> W</small>`,
          "Using now", [kwh ? `${kwh.toFixed(1)} kWh today` : "", big && val(big, "power") > 0 ? `most: ${big.name}` : ""].filter(Boolean).join(" · "));
      }
      case "ups": {
        const ups = list.filter(isUps); if (!ups.length) return "";
        const onBatt = ups.filter(d => ["on_battery", "low_battery"].includes(val(d, "ups_status")));
        if (onBatt.length) {
          const worst = onBatt.sort((a, b) => (val(a, "battery") ?? 100) - (val(b, "battery") ?? 100))[0];
          const low = val(worst, "ups_status") === "low_battery" || (val(worst, "battery") ?? 100) <= 25;
          return goTile("power", low ? "bad" : "warn", "power_off", `On battery · ${n(val(worst, "battery"))}%`, worst.name,
            `${runtimeText(val(worst, "runtime"))} left${onBatt.length > 1 ? ` · ${onBatt.length} UPS on battery` : ""}`);
        }
        const off = ups.filter(d => !d.online || val(d, "ups_status") === "offline");
        if (off.length) return goTile("power", "warn", "battery_alert", "UPS offline", names(off));
        const minRun = Math.min(...ups.map(d => Number(val(d, "runtime")) || Infinity));
        return goTile("power", "good", "power", "On mains power", `${ups.length} UPS${ups.length > 1 ? "es" : ""} charged`, isFinite(minRun) ? `${runtimeText(minRun)} backup` : "");
      }
      case "batteries": {
        const b = list.filter(d => !isUps(d) && (typeof val(d, "battery") === "number" || has(d, "battery_low")));
        if (!b.length) return "";
        const low = b.filter(batteryLow), nums = b.filter(d => typeof val(d, "battery") === "number");
        const lowest = nums.sort((a, c) => val(a, "battery") - val(c, "battery"))[0];
        return goTile("battery", low.length ? "warn" : "good", low.length ? "battery_alert" : "battery_full",
          low.length ? `${low.length} low` : "All good", lowest ? `Lowest: ${lowest.name} ${n(val(lowest, "battery"))}%` : `${b.length} devices`, low.length ? names(low) : "");
      }
      case "lights": {
        const l = list.filter(d => isLight(d) && !isGroup(d)); if (!l.length) return "";
        const on = l.filter(d => val(d, "light"));
        return goTile("lights", on.length ? "primary" : "", "lightbulb", `${on.length}<small> of ${l.length} on</small>`, on.length ? names(on) : "All lights off");
      }
      case "water": {
        const valves = list.filter(d => has(d, "valve")), mon = list.find(d => kindOf(d) === "water_monitor");
        if (!valves.length && !mon) return "";
        const main = mon && has(mon, "valve") ? mon : valves[0];
        const closed = main && val(main, "valve") === "closed";
        const flow = mon ? val(mon, "flow_rate") : null, used = mon ? val(mon, "water_usage_today") : null;
        return goTile("water", closed ? "warn" : "", closed ? "valve" : "water", closed ? "Water off" : "Water on",
          main ? main.name : "Water", [flow != null ? `${n(flow)} ${mon.capabilities.flow_rate.unit || ""} now` : "", used != null ? `${n(used)} ${mon.capabilities.water_usage_today.unit || ""} today` : ""].filter(Boolean).join(" · "));
      }
      case "offline": {
        const off = list.filter(d => !d.online);
        return off.length ? goTile("devices", "warn", "wifi_off", `${off.length} offline`, names(off)) : goTile("devices", "good", "devices", "All online", `${list.length} devices`);
      }
      case "ev": {
        const ev = list.find(d => kindOf(d) === "ev_charger"); if (!ev) return "";
        const st = val(ev, "charger_status");
        return goTile("power", st === "charging" ? "primary" : "", "ev_station", st === "charging" ? `${n((val(ev, "power") || 0) / 1000)}<small> kW</small>` : esc(pretty(st || "idle")), ev.name,
          val(ev, "energy_session") != null ? `${n(val(ev, "energy_session"))} kWh this session` : "");
      }
      case "vacuum": {
        const v = list.find(d => kindOf(d) === "vacuum"); if (!v) return "";
        return goTile(edition === "hacs" ? "appliances" : "devices", val(v, "vacuum_state") === "error" ? "bad" : "", "vacuum", esc(pretty(val(v, "vacuum_state") || "—")), v.name, val(v, "battery") != null ? `Battery ${n(val(v, "battery"))}%` : "");
      }
      case "irrigation": {
        const z = list.filter(d => kindOf(d) === "irrigation_zone"); if (!z.length) return "";
        const on = z.filter(d => val(d, "watering"));
        return goTile("water", on.length ? "primary" : "", "sprinkler", on.length ? "Watering" : "Idle", on.length ? names(on) : `${z.length} zone${z.length > 1 ? "s" : ""}`);
      }
      case "pool": {
        const p = list.find(d => kindOf(d) === "pool"); if (!p) return "";
        return goTile("water", /low|high|out|alert/i.test(val(p, "status_text") || "") ? "warn" : "good", "pool", `pH ${fmt(val(p, "ph"))}`, p.name,
          [val(p, "free_chlorine") != null ? `Cl ${fmt(val(p, "free_chlorine"))} ppm` : "", val(p, "temperature") != null ? `${temp(val(p, "temperature"))}°` : ""].filter(Boolean).join(" · "));
      }
    }
    return "";
  }

  function homeWeather(list, cfg) {
    const wx = list.find(d => kindOf(d) === "weather");
    const station = list.find(d => d.source === "ecowitt" && isOutdoor(d) && typeof val(d, "temperature") === "number")
      || list.find(d => d.source !== "weather" && !["aqi_station", "weather"].includes(kindOf(d)) && has(d, "wind_speed")
        && Object.keys(d.capabilities).some(k => k.startsWith("temperature")));
    const useStation = cfg.station && station;
    if (!(cfg.weather && wx) && !useStation) return "";
    const a = wx?.attributes || {}, today = (a.daily || [])[0];
    const outKey = (d, base) => { const ks = Object.keys(d.capabilities).filter(k => k.startsWith(base) && typeof val(d, k) === "number");
      return ks.find(k => /outdoor|outside/i.test(k + " " + (d.capabilities[k].label || ""))) || (ks.includes(base) ? base : ks[0]); };
    const sT = useStation ? outKey(station, "temperature") : null, sH = useStation ? outKey(station, "humidity") : null;
    const curTemp = useStation && sT ? val(station, sT) : val(wx, "temperature");
    const hum = useStation && sH ? val(station, sH) : val(wx, "humidity");
    const wind = useStation && has(station, "wind_speed") ? val(station, "wind_speed") : val(wx, "wind_speed");
    const windU = (useStation && has(station, "wind_speed") ? station.capabilities.wind_speed.unit : wx?.capabilities.wind_speed?.unit) || "";
    const bits = [hum != null ? `${icon("humidity_percentage")}${Math.round(hum)}%` : "", wind != null ? `${icon("air")}${n(wind)} ${esc(windU)}` : "",
      wx && val(wx, "uv") != null ? `${icon("clear_day")}UV ${Math.round(val(wx, "uv"))}` : "",
      useStation && val(station, "rain_daily") != null ? `${icon("rainy")}${n(val(station, "rain_daily"))} ${esc(station.capabilities.rain_daily.unit || "")}` : ""].filter(Boolean);
    const days = cfg.forecast && wx ? (a.daily || []).slice(0, 6).map((d, i) => `<div class="wday"><small>${i === 0 ? "Today" : esc(new Date(d.t * 1000).toLocaleDateString([], { weekday: "short", ...timeOpts() }))}</small>
        ${icon(wxIcon(d.icon), true)}<b>${tempC(d.hi)}</b><span>${tempC(d.lo)}</span>${d.pop ? `<i>${Math.round(d.pop)}%</i>` : ""}</div>`).join("") : "";
    const stationNote = useStation ? `<div class="wstation">${icon("sensors")}<span>Your station <b>${esc(station.name)}</b>${wx ? ` · forecast ${tempC(val(wx, "temperature"))}` : ""}</span></div>` : "";
    return `<section class="hcardx weather ${a.is_day === false ? "night" : ""}" ${wx ? `data-open-device="${esc(wx.id)}" data-id="${esc(wx.id)}" tabindex="0" role="button" aria-label="Weather details"` : ""}>
      <div class="wnow">
        <div class="wicon">${icon(wxIcon(a.icon, a.is_day !== false), true)}</div>
        <div class="wtemp">${curTemp == null ? "–" : `${temp(curTemp)}<small>°${unit}</small>`}</div>
        <div class="wdesc"><b>${esc(wx ? val(wx, "status_text") || "" : "Outside")}</b>
          <span>${wx && val(wx, "feels_like") != null ? `Feels like ${tempC(val(wx, "feels_like"))}` : ""}${today ? `${wx && val(wx, "feels_like") != null ? " · " : ""}<span class="nw">H\u00a0${tempC(today.hi)} L\u00a0${tempC(today.lo)}</span>` : ""}</span>
          <span class="wplace">${esc(a.place || (useStation ? station.room || "" : ""))}</span></div>
      </div>
      ${bits.length ? `<div class="wbits">${bits.map(b => `<span>${b}</span>`).join("")}</div>` : ""}
      ${days ? `<div class="wdays">${days}</div>` : ""}
      ${stationNote}
    </section>`;
  }
  function homeClimate(list) {
    // living-space sensors only: not outdoor/pool/weather/UPS/cars, and not fridges, freezers, ovens or water heaters
    // (anything outside 5–40 °C isn't the temperature of a room)
    const inside = list.filter(d => typeof val(d, "temperature") === "number" && !isOutdoor(d) && !isUps(d)
      && !["weather", "aqi_station", "pool", "vehicle", "network"].includes(kindOf(d))
      && val(d, "temperature") >= 5 && val(d, "temperature") <= 40 && !/fridge|freezer|refrigerator|oven|water heater|attic|pool|spa|hot tub/i.test(`${d.name} ${d.room || ""}`));
    if (!inside.length) return "";
    // Thermostats and their room sensors (ecobee and others) and anything named "indoor"/"inside" are the house's own
    // readings: when there are any, they make the big number and range, and list first
    const isIndoor = d => isThermostat(d) || d.source === "ecobee" || /\b(indoor|inside|thermostat)\b/i.test(`${d.name} ${(d.attributes?.ha_entities || []).join(" ")}`);
    const pref = inside.filter(isIndoor), base = pref.length ? pref : inside;
    const ts = base.map(d => val(d, "temperature")), avg = ts.reduce((a, b) => a + b, 0) / ts.length;
    const hums = base.map(d => val(d, "humidity")).filter(v => typeof v === "number");
    const rooms = {}, prefRoom = new Set(pref.map(d => d.room || "Other"));
    inside.forEach(d => { (rooms[d.room || "Other"] ||= []).push(val(d, "temperature")); });
    const rows = Object.entries(rooms).map(([r, v]) => [r, v.reduce((a, b) => a + b, 0) / v.length])
      .sort((a, b) => prefRoom.has(b[0]) - prefRoom.has(a[0]) || b[1] - a[1]).slice(0, 5)
      .map(([r, t]) => `<li><span>${esc(r)}</span><b>${temp(t)}°</b></li>`).join("");
    return `<section class="hcardx climate" data-goto="climate" tabindex="0" role="button" aria-label="Inside: open Climate">
      <div class="hcx-head">${icon("home")}<span>Inside</span></div>
      <div class="hcx-big">${temp(avg)}<small>°${unit}</small></div>
      <div class="hcx-sub">${hums.length ? `${Math.round(hums.reduce((a, b) => a + b, 0) / hums.length)}% humidity · ` : ""}<span class="nw">${temp(Math.min(...ts))}–${temp(Math.max(...ts))}°</span></div>
      <ul class="hcx-list">${rows}</ul></section>`;
  }
  // ---------- Home: thermostat controls ----------
  // −/+ change the shown number at once and send after a short pause (one command for several taps); until the
  // thermostat reports the new setpoint the card keeps showing what was asked for.
  const thermoPend = {};                 // "id|cap" -> {v: °C, until: ms}
  const tStep = () => unit === "F" ? 5 / 9 : 0.5;
  const tRound = c => unit === "F" ? (Math.round(toUnit(c)) - 32) * 5 / 9 : Math.round(c * 2) / 2;
  const tShow = c => c == null ? "–" : unit === "F" ? `${Math.round(toUnit(c))}` : (Math.round(c * 2) / 2).toFixed(1);
  function setpointNow(d, k) {
    const p = thermoPend[d.id + "|" + k];
    if (p && Date.now() < p.until && Math.abs((val(d, k) ?? 1e9) - p.v) > 0.2) return p.v;
    delete thermoPend[d.id + "|" + k];
    return val(d, k);
  }
  const ACTION_WORD = { heating: "Heating", cooling: "Cooling", idle: "Idle", off: "Off", fan: "Fan only", drying: "Drying", preheating: "Preheating", defrosting: "Defrosting" };
  const MODE_LABEL = { heat_cool: "Auto", auto: "Auto", heat: "Heat", cool: "Cool", off: "Off", dry: "Dry", fan_only: "Fan", aux_heat_only: "Aux heat", emergency_heat: "Emergency heat" };
  function thermoCard(d) {
    const act = String(val(d, "hvac_action") || "").toLowerCase(), mode = String(val(d, "hvac_mode") || "");
    const tone = /heat/.test(act) ? "heat" : /cool/.test(act) ? "cool" : "";
    const word = ACTION_WORD[act] || (act ? pretty(act) : mode === "off" ? "Off" : val(d, "status_text") || "");
    const sps = shownSetpoints(d), dis = d.online && canControl() ? "" : "disabled";
    const label = k => d.capabilities[k]?.label || { target_temperature: "Set to", heat_setpoint: "Heat to", cool_setpoint: "Cool to" }[k];
    const sp = sps.map(k => `<div class="tset ${k === "cool_setpoint" ? "cool" : k === "heat_setpoint" ? "heat" : ""}"><small>${esc(label(k))}</small>
        <div class="tset-row"><button type="button" class="icon-btn tbtn" data-tstep="${k}:-1" aria-label="${esc(label(k))} lower" ${dis}>${icon("remove")}</button>
        <b>${tShow(setpointNow(d, k))}<small>°${unit}</small></b>
        <button type="button" class="icon-btn tbtn" data-tstep="${k}:1" aria-label="${esc(label(k))} higher" ${dis}>${icon("add")}</button></div></div>`).join("");
    const modes = d.capabilities.hvac_mode?.writable ? d.capabilities.hvac_mode.options || [] : [];
    const seg = modes.length ? `<div class="segmented tmodes">${modes.map(o => `<button type="button" data-cmd="hvac_mode" data-val="${esc(JSON.stringify(o))}" class="${o === mode ? "on" : ""}" aria-pressed="${o === mode}" ${dis}>${esc(MODE_LABEL[o] || pretty(o))}</button>`).join("")}</div>` : "";
    const resume = (d.capabilities.action?.options || []).includes("resume_schedule") && d.capabilities.action.writable !== false
      ? `<button type="button" class="text-btn" data-cmd="action" data-val='"resume_schedule"' ${dis}>${icon("schedule")}Resume schedule</button>` : "";
    const hum = val(d, "humidity");
    return `<section class="hcardx thermo ${tone} ${d.online ? "" : "offline"}" data-id="${esc(d.id)}">
      <div class="hcx-head">${icon("thermostat")}<span class="tname">${esc(d.name)}${d.room && d.room !== d.name ? `<small> · ${esc(d.room)}</small>` : ""}</span>
        <button type="button" class="icon-btn sm topen" data-open-device aria-label="${esc(d.name)} details">${icon("open_in_full")}</button></div>
      <div class="tbody">
        <div class="tnow"><div class="hcx-big">${val(d, "temperature") == null ? "–" : temp(val(d, "temperature"))}<small>°${unit}</small></div>
          <div class="hcx-sub">${word ? `<span class="tact">${esc(word)}</span>` : ""}${typeof hum === "number" ? `<span>${Math.round(hum)}% humidity</span>` : ""}${d.online ? "" : "<span>Offline</span>"}</div></div>
        ${sp ? `<div class="tsets">${sp}</div>` : mode === "off" ? `<div class="tsets muted">Turned off</div>` : ""}
      </div>
      ${seg || resume ? `<div class="tfoot">${seg}${resume}</div>` : ""}
    </section>`;
  }
  function homeThermostats(list) {
    const ts = list.filter(d => isThermostat(d) && (d.capabilities.hvac_mode?.writable || SETPOINTS.some(k => d.capabilities[k]?.writable)))
      .sort((a, b) => b.online - a.online || a.name.localeCompare(b.name)).slice(0, 6);
    return ts.length ? `<div class="home-thermos n${ts.length}">${ts.map(thermoCard).join("")}</div>` : "";
  }
  function thermoStep(btn) {
    const id = btn.closest("[data-id]").dataset.id, d = devices.get(id); if (!d) return;
    if (!canControl()) return snack("Viewing only: sign in to control devices");
    const [k, dir] = btn.dataset.tstep.split(":"), cp = d.capabilities[k];
    const cur = setpointNow(d, k) ?? val(d, "temperature") ?? 21;
    let v = tRound(cur + Number(dir) * tStep());
    if (cp?.min != null) v = Math.max(v, Number(cp.min)); if (cp?.max != null) v = Math.min(v, Number(cp.max));
    const key = id + "|" + k;
    thermoPend[key] = { v, until: Date.now() + 15000 };
    btn.parentElement.querySelector("b").innerHTML = `${tShow(v)}<small>°${unit}</small>`;
    clearTimeout(thermoStep[key]);
    thermoStep[key] = setTimeout(() => sendCmd(id, k, Math.round(v * 100) / 100, true), 900);
  }

  function homeAirOut(list) {
    const st = list.find(d => kindOf(d) === "aqi_station" && typeof val(d, "aqi") === "number"); if (!st) return "";
    const a = val(st, "aqi"), [, cat, col] = aqiBand(a);
    return `<section class="hcardx aq" data-goto="air" style="--aq:${col}" tabindex="0" role="button" aria-label="Outdoor air: open Air quality">
      <div class="hcx-head">${icon("aq")}<span>Outdoor air</span></div>
      <div class="hcx-big">${Math.round(a)}<small> AQI</small></div>
      <div class="hcx-sub"><i class="aqdot"></i>${esc(cat)}</div>
      <div class="hcx-foot">${esc([st.attributes?.dominant ? `Mostly ${st.attributes.dominant}` : "", st.attributes?.place].filter(Boolean).join(" · "))}</div></section>`;
  }
  function homeAirIn(list) {
    const mons = list.filter(d => kindOf(d) !== "aqi_station" && !isOutdoor(d) && ["air_score", "pm25", "co2", "voc"].some(k => typeof val(d, k) === "number"));
    if (!mons.length) return "";
    const score = mons.filter(d => typeof val(d, "air_score") === "number").sort((a, b) => val(a, "air_score") - val(b, "air_score"))[0];
    const pm = Math.max(...mons.map(d => Number(val(d, "pm25"))).filter(Number.isFinite), -1);
    const co2 = Math.max(...mons.map(d => Number(val(d, "co2"))).filter(Number.isFinite), -1);
    const tone = (score && val(score, "air_score") < 60) || pm > 35 || co2 > 1500 ? "bad" : (score && val(score, "air_score") < 80) || pm > 12 || co2 > 1000 ? "warn" : "good";
    const word = { good: "Good", warn: "Fair", bad: "Poor" }[tone];
    return `<section class="hcardx aqin ${tone}" data-goto="air" tabindex="0" role="button" aria-label="Indoor air: open Air quality">
      <div class="hcx-head">${icon("aq_indoor")}<span>Indoor air</span></div>
      <div class="hcx-big">${score ? `${Math.round(val(score, "air_score"))}<small> score</small>` : word}</div>
      <div class="hcx-sub"><i class="aqdot"></i>${word}${score ? ` · worst: ${esc(score.name)}` : ""}</div>
      <div class="hcx-foot">${[pm >= 0 ? `PM2.5 ${Math.round(pm)}` : "", co2 >= 0 ? `CO₂ ${Math.round(co2)} ppm` : "", `${mons.length} monitor${mons.length > 1 ? "s" : ""}`].filter(Boolean).join(" · ")}</div></section>`;
  }
  // pages hidden from the menu, and the page Haven opens on
  let startApplied = false;
  function applyNavPrefs(initial = false) {
    const cfg = homeCfg(), hidden = new Set(cfg.hidden_pages || []);
    $$("#nav [data-f], #more [data-f]").forEach(b => { if (!["all", "settings"].includes(b.dataset.f)) b.hidden = hidden.has(b.dataset.f); });
    // Appliances: Home Assistant edition only (appliances come from HA's washer/dryer/fridge/oven… integrations)
    $$('#nav [data-f="appliances"], #more [data-f="appliances"]').forEach(b => { b.hidden = b.hidden || edition !== "hacs"; });
    if (initial && !startApplied) {
      startApplied = true;
      if (cfg.start && cfg.start !== view && !hidden.has(cfg.start)) go(cfg.start);
    }
  }
  function homeTiles(list) {
    const cfg = homeCfg();
    const hero = [homeWeather(list, cfg), cfg.climate ? homeClimate(list) : "", cfg.aqi_outdoor ? homeAirOut(list) : "", cfg.aqi_indoor ? homeAirIn(list) : ""].filter(Boolean);
    const tiles = (cfg.tiles || []).map(id => homeTileHtml(id, list)).filter(Boolean);
    const admin = (window.Haven?.role || "admin") === "admin";
    const noWx = !list.some(d => kindOf(d) === "weather") && cfg.weather && admin
      ? `<button type="button" class="hcardx hint" data-goto-setting="weather">${icon("partly_cloudy_day")}<span><b>Add the weather forecast</b><small>Settings → Weather forecast</small></span></button>` : "";
    return `<div class="home-dash">
      ${hero.length || noWx ? `<div class="home-hero n${hero.length} ${(hero.length - (hero[0]?.includes("hcardx weather") ? 1 : 0)) % 2 ? "odd" : ""}">${hero.join("")}${hero.length < 2 ? noWx : ""}</div>` : ""}
      ${cfg.thermostat ? homeThermostats(list) : ""}
      ${tiles.length ? `<div class="home-tiles">${tiles.join("")}</div>` : ""}
      ${admin ? `<button type="button" class="text-btn home-custom" data-goto-setting="home">${icon("dashboard_customize")}Customize</button>` : ""}
    </div>`;
  }
  function doorTiles(list, page = "doors") {
    const c = list.filter(d => has(d, "contact"));
    const open = c.filter(d => val(d, "contact") === "open"), closed = c.length - open.length;
    return goTile(page, open.length ? "warn" : "good", open.length ? "door_open" : "door_front", `${open.length} open`,
      open.length ? open.map(d => d.name).slice(0, 3).join(", ") : "Everything is closed", "", open.map(d => d.id)) +
      tile("", "sensor_door", `${closed} closed`, `${c.length} contact sensor${c.length === 1 ? "" : "s"}`) +
      tile("", "battery_alert", `${c.filter(batteryLow).length}`, "need new batteries");
  }
  // Alerts under the title: one chip per device while there are few, else one chip per kind ("11 offline") that
  // opens the list. Never a row of identical icon-only chips.
  let alertsOpen = null;
  function renderChips(list) {
    const low = view !== "battery" ? list.filter(batteryLow) : [], off = list.filter(d => !d.online);
    const kinds = [["low", "battery_alert", low, n => `${n} low batter${n === 1 ? "y" : "ies"}`, d => `${d.name} battery low`],
                   ["off", "wifi_off", off, n => `${n} offline`, d => `${d.name} offline`]];
    const out = [];
    for (const [k, ic, devs, sum, one] of kinds) {
      if (!devs.length) continue;
      if (devs.length <= 2) { devs.forEach(d => out.push(`<button type="button" class="chip warn" data-id="${esc(d.id)}" data-open-device>${icon(ic, true)}${esc(one(d))}</button>`)); continue; }
      const open = alertsOpen === k;
      out.push(`<button type="button" class="chip warn" data-alerts-toggle="${k}" aria-expanded="${open}">${icon(ic, true)}${esc(sum(devs.length))}<span class="chev ${open ? "up" : ""}">${icon("keyboard_arrow_down")}</span></button>`);
      if (open) out.push(`<div class="alert-list">${devs.map(d => `<button type="button" class="chip" data-id="${esc(d.id)}" data-open-device>${esc(d.name)}${d.room ? ` <small>${esc(d.room)}</small>` : ""}</button>`).join("")}</div>`);
    }
    $("#alerts").innerHTML = out.join("");
  }

