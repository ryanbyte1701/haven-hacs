// Haven dashboard, part 2 of 11: How a device is shown: icons, status, cards, chart styles, layout, Group by.
// The parts are plain scripts that index.html loads in order; they share one scope (no build step).
// A part can use anything earlier parts declare. Code that runs while the page loads (not inside a
// function called later) must not use a later part.
  // ---------- per-device presentation ----------
  function deviceIcon(d) {
    const k = kindOf(d);
    if (k === "pool") return ["pool", /low|high|out|alert/i.test(val(d, "status_text") || "") ? "warn" : ""];
    if (k === "thermostat") return ["thermostat", ["heating", "cooling"].includes(val(d, "hvac_action")) ? "active" : ""];
    if (k === "air_monitor") { const sc = val(d, "air_score"); return ["aq_indoor", sc != null && sc < 60 ? "warn" : ""]; }
    if (k === "smart_plug") return ["outlet", val(d, "switch") ? "active" : ""];
    if (k === "vehicle") return ["directions_car", val(d, "lock") === "unlocked" ? "warn" : ""];
    if (k === "network") return ["router", d.online ? "" : "warn"];
    if (k === "air_purifier") return ["air_purifier", val(d, "switch") ? "active" : ""];
    if (k === "ev_charger") { const c = val(d, "charger_status"); return ["ev_station", c === "charging" ? "active" : c === "fault" ? "bad" : ""]; }
    if (k === "vacuum") { const v = val(d, "vacuum_state"); return ["vacuum", v === "cleaning" || v === "returning" ? "active" : v === "error" ? "bad" : ""]; }
    if (k === "irrigation_zone") return ["sprinkler", val(d, "watering") ? "active" : ""];
    if (k === "irrigation_controller") return ["sprinkler", val(d, "standby") ? "warn" : ""];
    if (k === "water_monitor" && !val(d, "leak")) return ["waves", (val(d, "flow_rate") || 0) > 0 ? "active" : ""];
    if (isUps(d)) { const s = val(d, "ups_status"); return [s === "online" ? "battery_charging_full" : "battery_alert", s === "low_battery" ? "bad" : s === "on_battery" ? "warn" : ""]; }
    if (isLight(d)) return [isGroup(d) ? "home_iot_device" : "lightbulb", ""];
    if (has(d, "alarm_panel")) { const s = val(d, "alarm_panel"); return ["shield", s === "triggered" ? "bad" : s && s !== "disarmed" ? "active" : ""]; }
    if (k === "aqi_station") { const a = val(d, "aqi"); return ["aq", a > 150 ? "bad" : a > 100 ? "warn" : ""]; }
    if (has(d, "smoke") || coAlarm(d) || has(d, "heat") || has(d, "gas")) return ["detector_smoke", isAlarm(d) ? "bad" : ""];
    if (has(d, "leak")) return val(d, "leak") ? ["water_damage", "bad"] : ["water_drop", ""];
    if (has(d, "valve")) return ["valve", val(d, "valve") === "open" ? "active" : ""];
    if (has(d, "lock")) return val(d, "lock") === "unlocked" ? ["lock_open", "warn"] : ["lock", ""];
    if (has(d, "ding")) return ["doorbell", val(d, "ding") ? "warn" : val(d, "motion") ? "active" : ""];
    if (d.source === "ring" || d.attributes?.has_snapshot) return [has(d, "light") ? "lightbulb" : "videocam", val(d, "motion") ? "active" : ""];
    if (isShade(d)) return ["blinds", val(d, "shade") === "open" ? "active" : ""];
    if (has(d, "contact")) return val(d, "contact") === "open" ? ["door_open", "warn"] : ["door_front", ""];
    if (has(d, "presence")) return ["sensor_occupied", val(d, "presence") ? "active" : ""];
    if (has(d, "occupancy") && typeof val(d, "occupancy") !== "number") return ["sensor_occupied", val(d, "occupancy") ? "active" : ""];
    if (has(d, "motion")) return ["directions_run", val(d, "motion") ? "active" : ""];
    if (has(d, "switch")) return ["power_settings_new", val(d, "switch") ? "active" : ""];
    if (has(d, "wind_speed") || has(d, "rain_daily")) return ["partly_cloudy_day", ""];
    if (has(d, "moisture") && !has(d, "temperature")) return ["grass", ""];
    if (has(d, "temperature")) return ["device_thermostat", ""];
    return ["sensors", ""];
  }

  /** Main state as [text, tone] — used by cards (status line) and the table. */
  const VAC = { docked: "Docked", cleaning: "Cleaning", returning: "Returning to dock", paused: "Paused", charging: "Charging", idle: "Idle", error: "Error" };
  const EV = { available: "Not plugged in", plugged_in: "Plugged in", charging: "Charging", done: "Charged", fault: "Fault", offline: "Offline" };
  function statusOf(d) {
    const k = kindOf(d);
    if (k === "vehicle" && has(d, "lock")) return val(d, "lock") === "unlocked" ? ["Unlocked", "warn"] : [pretty(val(d, "lock") || "unknown"), ""];
    if (has(d, "vacuum_state")) { const v = val(d, "vacuum_state"); return [VAC[v] || pretty(v || "unknown"), v === "error" ? "bad" : ""]; }
    if (has(d, "charger_status")) { const v = val(d, "charger_status"); return [EV[v] || pretty(v || "unknown"), v === "fault" ? "bad" : ""]; }
    if (k === "irrigation_zone") return val(d, "watering") ? ["Watering", ""] : ["Idle", ""];
    if (k === "thermostat") return [val(d, "status_text") || "Unknown", ""];
    if (k === "smart_plug") return val(d, "switch") ? [`On${val(d, "power") != null ? " · " + fmt(val(d, "power")) + " W" : ""}`, ""] : ["Off", ""];
    if (k === "air_purifier") return val(d, "switch") ? [`On${val(d, "mode") ? " · " + pretty(val(d, "mode")) : ""}`, ""] : ["Off", ""];
    if (k === "irrigation_controller" && val(d, "standby")) return ["Standby", "warn"];
    if (isUps(d)) return { online: ["Online", ""], on_battery: ["On battery", "warn"], low_battery: ["Battery low", "bad"], offline: ["Off", "warn"] }[val(d, "ups_status")] || ["Unknown", ""];
    if (has(d, "alarm_panel")) { const s = val(d, "alarm_panel"); return [ALARM_LABEL[s] || s || "Unknown", s === "triggered" ? "bad" : ""]; }
    if (has(d, "smoke") || coAlarm(d)) return val(d, "smoke") ? ["Smoke detected", "bad"] : val(d, "co") ? ["Carbon monoxide", "bad"] : ["All clear", ""];
    if (has(d, "gas")) return val(d, "gas") ? ["Gas detected", "bad"] : ["All clear", ""];
    if (has(d, "heat")) return val(d, "heat") ? ["High heat", "bad"] : ["Normal", ""];
    if (has(d, "leak")) return val(d, "leak") ? ["Leak detected", "bad"] : ["Dry", ""];
    if (has(d, "lock")) return val(d, "lock") === "locked" ? ["Locked", ""] : val(d, "lock") ? ["Unlocked", "warn"] : ["Unknown", ""];
    if (has(d, "valve")) return val(d, "valve") === "open" ? ["Open", ""] : val(d, "valve") ? ["Closed", ""] : ["Unknown", ""];
    if (has(d, "ding")) return val(d, "ding") ? ["Doorbell!", "warn"] : val(d, "motion") ? ["Motion", ""] : ["Quiet", ""];
    if (isShade(d)) { const p = val(d, "position"); return [typeof p === "number" ? (p <= 0 ? "Closed" : p >= 100 ? "Open" : `${Math.round(p)}% open`) : val(d, "shade") === "open" ? "Open" : val(d, "shade") ? "Closed" : "Unknown", ""]; }
    if (has(d, "contact")) return val(d, "contact") === "open" ? ["Open", "warn"] : ["Closed", ""];
    if (has(d, "presence")) return val(d, "presence") ? ["Occupied", ""] : ["Clear", ""];
    if (has(d, "occupancy") && typeof val(d, "occupancy") === "boolean") return val(d, "occupancy") ? ["Occupied", ""] : ["Clear", ""];
    if (has(d, "motion")) return val(d, "motion") ? ["Motion", ""] : ["No motion", ""];
    if (isLight(d)) {
      if (isGroup(d)) { const m = (d.attributes.members || []).map(id => devices.get(id)).filter(Boolean);
        const on = m.filter(x => val(x, "light")).length; return [val(d, "light") ? `${on || "Some"} of ${m.length || "?"} on` : "All off", ""]; }
      return val(d, "light") ? [has(d, "brightness") ? `On · ${val(d, "brightness") ?? "–"}%` : "On", ""] : ["Off", ""]; }
    if (has(d, "light")) return val(d, "light") ? ["Light on", ""] : ["Light off", ""];
    if (has(d, "switch")) return val(d, "switch") ? ["On", ""] : ["Off", ""];
    if (val(d, "status_text")) return [val(d, "status_text"), /low|high|alert|fault|error|problem|leak/i.test(val(d, "status_text")) ? "warn" : ""];
    return null;
  }
  function readingText(d) {
    if (kindOf(d) === "vehicle") {           // cars: charge or fuel, then range
      const parts = [];
      if (val(d, "battery") != null) parts.push(`${Math.round(val(d, "battery"))}%`);
      else if (val(d, "fuel_level") != null) parts.push(`${Math.round(val(d, "fuel_level"))}% fuel`);
      if (val(d, "range") != null) parts.push(`${n(Math.round(val(d, "range")))} ${d.capabilities.range.unit || ""} range`.trim());
      if (parts.length) return parts.join(" · ");
    }
    if (has(d, "temperature")) return `${temp(val(d, "temperature"))}°${unit}`;
    if (has(d, "moisture")) return `${val(d, "moisture") == null ? "–" : Math.round(val(d, "moisture"))}% soil`;
    if (isUps(d)) return `${n(val(d, "battery"))}% · ${runtimeText(val(d, "runtime"))}`;
    if (kindOf(d) === "aqi_station") return `AQI ${n(val(d, "aqi"))}`;
    if (has(d, "air_score")) return `Score ${n(val(d, "air_score"))}`;
    if (has(d, "ph")) return `pH ${n(val(d, "ph"))}`;
    if (val(d, "charger_status") === "charging" && val(d, "power") != null) return `${(val(d, "power") / 1000).toFixed(1)} kW`;
    return "";
  }
  function detailText(d) {
    const parts = [];
    if (has(d, "temperature") && val(d, "humidity") != null) parts.push(`${Math.round(val(d, "humidity"))}% RH`);
    if (has(d, "temperature") && has(d, "moisture")) parts.push(`soil ${Math.round(val(d, "moisture"))}%`);
    if (isUps(d)) parts.push(`load ${n(val(d, "load"))}%`, `${val(d, "input_voltage") ?? "–"} V in`);
    for (const k of ["wind_speed", "rain_daily", "co2", "pm25", "co_ppm", "illuminance", "pressure"])
      if (val(d, k) != null) parts.push(`${LABEL[k]} ${fmt(val(d, k))}${d.capabilities[k].unit ? " " + d.capabilities[k].unit : ""}`);
    if (has(d, "contact") && has(d, "lock")) parts.push(`door ${val(d, "contact") || "–"}`);
    const lm = d.attributes?.last_motion, ld = d.attributes?.last_ding;
    if (ld) parts.push(`ding ${ago(ld).toLowerCase()}`);
    if (lm) parts.push(`motion ${ago(lm).toLowerCase()}`);
    return parts.join(" · ");
  }

  function readingBlock(d) {
    const k = kindOf(d);
    if (k === "aqi_station") return `<div class="reading"><span class="v aqv" style="--aq:${aqiColor(val(d, "aqi"))}">${n(val(d, "aqi"))}<small> AQI</small></span>${
      d.attributes?.dominant ? `<span class="sub">${icon("aq")}${esc(d.attributes.dominant)}</span>` : ""}</div>`;
    if (has(d, "air_score")) return `<div class="reading"><span class="v">${n(val(d, "air_score"))}<small>/100</small></span>${
      val(d, "co2") != null ? `<span class="sub">${icon("co2")}${n(Math.round(val(d, "co2")))}</span>` : ""}</div>`;
    if (has(d, "ph")) return `<div class="reading"><span class="v"><small>pH </small>${n(val(d, "ph"))}</span>${
      val(d, "free_chlorine") != null ? `<span class="sub">${icon("science")}${n(val(d, "free_chlorine"))} ppm</span>` : ""}</div>`;
    if (k === "air_purifier" && val(d, "pm25") != null) return `<div class="reading"><span class="v">${Math.round(val(d, "pm25"))}<small> PM2.5</small></span></div>`;
    if (k === "ev_charger" && val(d, "charger_status") === "charging" && val(d, "power") != null)
      return `<div class="reading"><span class="v">${(val(d, "power") / 1000).toFixed(1)}<small> kW</small></span>${val(d, "energy_session") != null ? `<span class="sub">${icon("bolt")}${n(val(d, "energy_session"))} kWh</span>` : ""}</div>`;
    if (k === "water_monitor" && val(d, "flow_rate") != null) return `<div class="reading"><span class="v">${(+val(d, "flow_rate")).toFixed(1)}<small> gpm</small></span>${
      val(d, "water_pressure") != null ? `<span class="sub">${icon("speed")}${Math.round(val(d, "water_pressure"))} psi</span>` : ""}</div>`;
    if (has(d, "temperature")) {
      return `<div class="reading"><span class="v">${temp(val(d, "temperature"))}<small>°${unit}</small></span>${
        has(d, "humidity") ? `<span class="sub">${icon("water_drop")}${val(d, "humidity") == null ? "–" : Math.round(val(d, "humidity"))}%</span>` : ""}</div>`;
    }
    if (has(d, "moisture")) return `<div class="reading"><span class="v">${val(d, "moisture") == null ? "–" : Math.round(val(d, "moisture"))}<small>% soil</small></span></div>`;
    if (isUps(d)) return `<div class="reading"><span class="v">${n(val(d, "battery"))}<small>%</small></span><span class="sub">${icon("timer")}${runtimeText(val(d, "runtime"))}</span></div>`;
    return "";
  }
  function statusBlock(d) {
    const s = statusOf(d);
    if (!s) return "";
    const extra = has(d, "contact") && has(d, "lock") ? `Door ${val(d, "contact") || "–"}` :
      d.attributes?.last_ding ? `Last ring ${ago(d.attributes.last_ding).toLowerCase()}` :
      d.attributes?.last_motion ? `Last motion ${ago(d.attributes.last_motion).toLowerCase()}` : "";
    return `<div class="status ${esc(s[1])}">${esc(s[0])}${extra ? `<span class="s2">${esc(extra)}</span>` : ""}</div>`;
  }
  function metaBlock(d) {
    const skip = new Set(["temperature", "humidity", "battery", "battery_low", "leak", "smoke", "co", "heat", "contact", "shade", "lock", "valve",
      "switch", "motion", "presence", "vibration", "action", "tamper", "ups_status", "charging", "replace_battery", "overload",
      "output_voltage", "runtime", "alarm_panel", "ding", "light", "wind_dir", "brightness", "color_temp", "color",
      "status_text", "vacuum_state", "charger_status", "charging", "watering", "air_score", "ph", "mode", "fan_speed", "oscillation",
      "standby", "rain_delay", "amperage_limit", "hvac_action", "hvac_mode", "fan_mode", "heat_setpoint", "cool_setpoint"]);
    const k = kindOf(d);
    if (k === "pool") skip.add("free_chlorine");
    if (k === "water_monitor") { skip.add("flow_rate"); skip.add("water_pressure"); }
    if (has(d, "air_score")) skip.add("co2");
    if (k === "aqi_station") skip.add("aqi");
    if (k === "air_purifier") skip.add("pm25");
    if (k === "ev_charger" && val(d, "charger_status") === "charging") { skip.add("power"); skip.add("energy_session"); }
    if (!has(d, "temperature")) skip.add("moisture");
    const chips = [];
    if (isUps(d) && val(d, "charging")) chips.push(`<span>${icon("bolt")}Charging</span>`);
    if (val(d, "replace_battery")) chips.push(`<span class="low">${icon("battery_alert")}Replace battery</span>`);
    for (const [k, c] of Object.entries(d.capabilities)) {
      if (skip.has(k) || c.value == null) continue;
      if (typeof c.value === "boolean") continue;
      chips.push(`<span>${META_ICON[k] ? icon(META_ICON[k]) : ""}${esc(c.label || pretty(k))} ${capText(k, c)}</span>`);
    }
    const b = val(d, "battery");
    if (!isUps(d)) {
      if (b != null) chips.push(`<span class="${b <= 25 ? "low" : ""}">${icon(batteryIcon(b))}${n(b)}%</span>`);
      else if (val(d, "battery_low")) chips.push(`<span class="low">${icon("battery_alert")}Low</span>`);
    }
    if (!chips.length) return "";
    // at most two chips (one on phones) plus "+N": warnings first, the rest is in the device panel
    chips.sort((x, y) => y.includes('class="low"') - x.includes('class="low"'));
    // estimate each chip's width (12 px text, 14 px icon, padding) and keep what fits beside a "+N" chip
    const room = innerWidth < 600 ? (innerWidth - 32 - 8) / 2 - 28 : 220, w = c => c.replace(/<[^>]+>/g, "").length * 7 + 36;
    let used = 0, cap = 0;
    for (const c of chips) { const need = used + w(c) + (cap ? 6 : 0) + (cap + 1 < chips.length ? 40 : 0); if (need > room && cap >= 1) break; used += w(c) + (cap ? 6 : 0); cap++; if (cap >= 3) break; }
    const extra = chips.length - cap;
    return `<div class="meta">${chips.slice(0, cap).join("")}${extra > 0 ? `<span class="more-n" data-open-device role="button" tabindex="0" aria-label="${extra} more readings">+${extra}</span>` : ""}</div>`;
  }
  // a reading with its unit; temperatures (stored in °C) follow the °F/°C setting
  const capText = (k, c) => k === "temperature" || c.unit === "°C" ? `${temp(c.value)}°${unit}` : `${fmt(c.value)}${c.unit ? " " + esc(c.unit) : ""}`;
  const batteryIcon = b => b == null ? "battery_full" : b <= 10 ? "battery_alert" : b <= 25 ? "battery_1_bar" : b <= 60 ? "battery_3_bar" : b <= 90 ? "battery_5_bar" : "battery_full";

  // Estimated row heights (px) so cards can fit content into a fixed height.
  const rowH = html => html.startsWith('<div class="slider-row') ? 28 : html.startsWith('<div class="colors') ? 26 :
    html.startsWith('<div class="tonal-row') && innerWidth < 600 && (html.match(/class="tonal-btn"/g) || []).length > 2 ? 88 : 40;   // wraps to two lines
  const controlsBlock = d => controlRows(d).join("");
  function controlRows(d) {
    const c = d.capabilities, out = [];
    const seg = (capName, items) => `<div class="segmented">${items.map(([v, label, ic, on]) =>
      `<button data-cmd="${esc(capName)}" data-val="${esc(JSON.stringify(v))}" class="${on ? "on" : ""}" aria-pressed="${!!on}">${on ? icon("check_circle", true) : icon(ic)}${esc(label)}</button>`).join("")}</div>`;
    const sw = (capName, on, label) => `<div class="switch-row"><span>${esc(label)}</span>
      <button class="m3-switch ${on ? "on" : ""}" role="switch" aria-checked="${!!on}" data-cmd="${esc(capName)}" data-val="${esc(JSON.stringify(!on))}" aria-label="${esc(label)} ${esc(d.name)}"></button></div>`;
    if (c.lock?.writable) out.push(seg("lock", [["lock", "Lock", "lock", val(d, "lock") === "locked"], ["unlock", "Unlock", "lock_open", val(d, "lock") === "unlocked"]]));
    if (c.valve?.writable) out.push(seg("valve", [["open", "Open", "water", val(d, "valve") === "open"], ["close", "Close", "valve", val(d, "valve") === "closed"]]));
    if (c.alarm_panel?.writable) { const s = val(d, "alarm_panel");
      out.push(seg("alarm_panel", [["disarm", "Off", "shield", s === "disarmed"], ["arm_home", "Home", "bedtime", s === "armed_home"], ["arm_away", "Away", "directions_walk", s === "armed_away"]])); }
    if (c.switch?.writable) out.push(sw("switch", val(d, "switch"), c.switch.label || "Power"));
    // generic controls for any other writable capability (purifier modes, fan speed, charge limit, standby…)
    const HANDLED = new Set(["lock", "valve", "alarm_panel", "switch", "light", "brightness", "color_temp", "color", "action"]);
    for (const [k, cp] of Object.entries(c)) {
      if (!cp.writable || HANDLED.has(k)) continue;
      if (SETPOINTS.includes(k) && isThermostat(d) && !shownSetpoints(d).includes(k)) continue;
      const off = (has(d, "switch") && !val(d, "switch")) || (has(d, "light") && !val(d, "light"));
      if (cp.options?.length) {
        const opts = cp.options;
        out.push(opts.length <= 3 ? seg(k, opts.map(o => [o, k === "fan_mode" ? `Fan ${pretty(o).toLowerCase()}` : pretty(o), k === "fan_mode" ? "mode_fan" : "tune", String(cp.value) === String(o)]))
          : `<label class="selrow"><span>${esc(cp.label || pretty(k))}</span><select data-cmdsel="${esc(k)}">${opts.map(o => `<option value="${esc(o)}" ${String(cp.value) === String(o) ? "selected" : ""}>${esc(pretty(o))}</option>`).join("")}</select></label>`);
      } else if (cp.min != null && cp.max != null && cp.unit === "°C") {   // setpoints: shown and set in °F or °C
        const f = unit === "F", r = x => f ? Math.round(toUnit(x)) : Math.round(x * 2) / 2;
        out.push(slider(k, cp.value == null ? null : r(cp.value), Math.ceil(f ? toUnit(cp.min) : cp.min * 2) / (f ? 1 : 2), Math.floor(f ? toUnit(cp.max) : cp.max * 2) / (f ? 1 : 2),
          k === "cool_setpoint" ? "ac_unit" : k === "heat_setpoint" ? "local_fire_department" : "thermostat", "temp-set", false, v => `${v}°${unit}`, f ? 1 : 0.5, `${d.name} ${cp.label || pretty(k)}`));
      } else if (cp.min != null && cp.max != null) {
        out.push(slider(k, cp.value, cp.min, cp.max, META_ICON[k] || (k === "fan_speed" ? "mode_fan" : "tune"), "", off, v => `${v}${cp.unit ? " " + cp.unit : ""}`, cp.step, `${d.name} ${cp.label || pretty(k)}`));
      } else if (typeof cp.value === "boolean" || cp.value == null) {
        out.push(sw(k, !!cp.value, cp.label || pretty(k)));
      }
    }
    if (c.light?.writable && isLight(d)) out.push(lightControls(d, view === "lights" || panelFull));
    else if (c.light?.writable) out.push(sw("light", val(d, "light"), "Light"));
    const btns = [];
    if (d.attributes?.has_snapshot) btns.push(`<button class="tonal-btn" data-snapshot>${icon("photo_camera")}Snapshot</button>`);
    if (c.action?.writable) btns.push(...(c.action.options || []).map(o =>
      `<button class="tonal-btn" data-cmd="action" data-val="${esc(JSON.stringify(o))}">${icon({ mute: "notifications", siren: "campaign", open: "arrow_upward", close: "arrow_downward", start: "power_settings_new", stop: "power_off", pause: "timer", dock: "home", locate: "notifications_active", resume_schedule: "schedule" }[o] || (/^run/.test(o) ? "sprinkler" : "science"))}${esc(pretty(o))}</button>`));
    if (btns.length) out.push(`<div class="tonal-row">${btns.join("")}</div>`);
    return out.flatMap(x => Array.isArray(x) ? x : [x]).filter(Boolean);
  }

  function slider(capName, value, min, max, ic, cls = "", disabled = false, label = v => `${v}%`, step = 1, ariaName = "") {
    const num = (x, dflt) => Number.isFinite(Number(x)) && x !== null && x !== "" ? Number(x) : dflt;
    min = num(min, 0); max = num(max, 100); if (max <= min) max = min + 1; step = num(step, 1) || 1;
    const v = Math.min(max, Math.max(min, num(value, min))), pct = ((v - min) / (max - min) * 100).toFixed(1);
    const suffix = label(0).replace(/^0/, "");
    return `<div class="slider-row">${icon(ic)}<input type="range" class="m3-slider ${cls}" min="${min}" max="${max}" step="${step || 1}" value="${v}" data-slider="${esc(capName)}" data-suffix="${esc(suffix)}"
      style="--pct:${pct}%" ${disabled ? "disabled" : ""} aria-label="${esc(ariaName || pretty(capName))}"><output>${esc(label(v))}</output></div>`;
  }
  const phone = () => innerWidth < 840;
  const headSwitch = d => !phone() && isLight(d) && d.capabilities.light?.writable ? `<button class="m3-switch ${val(d, "light") ? "on" : ""}" role="switch"
    aria-checked="${!!val(d, "light")}" data-cmd="light" data-val="${esc(JSON.stringify(!val(d, "light")))}" aria-label="Toggle ${esc(d.name)}"></button>` : "";
  function lightControls(d, full) {
    const on = !!val(d, "light"), c = d.capabilities, a = d.attributes || {};
    const parts = [];   // the on/off switch lives in the card header (see headSwitch), or a row on phones
    if (phone() && c.light?.writable) parts.push(`<div class="switch-row"><span>Light</span><button class="m3-switch ${on ? "on" : ""}" role="switch" aria-checked="${on}" data-cmd="light" data-val="${esc(JSON.stringify(!on))}" aria-label="Toggle ${esc(d.name)}"></button></div>`);
    if (c.brightness) parts.push(slider("brightness", val(d, "brightness"), 1, 100, "light_mode", "", !on, undefined, 1, `${d.name} brightness`));
    if (full && c.color_temp) parts.push(slider("color_temp", val(d, "color_temp"), a.ct_min || 2200, a.ct_max || 6500, "thermostat", "ct", !on, v => `${v}K`, 1, `${d.name} color temperature`));
    if (full && c.color) parts.push(`<div class="colors">${PRESETS.map(h => `<button data-color="${h}" style="background:${h}" class="${(val(d, "color") || "").toLowerCase() === h ? "on" : ""}" aria-label="Color ${h}"></button>`).join("")}
      <label title="Custom color"><input type="color" data-colorpick value="${safeColor(val(d, "color")) || "#ffffff"}" aria-label="Custom color for ${esc(d.name)}"></label></div>`);
    return parts;
  }

  const sparkCap = d => !hasControls(d) && !isUps(d) && ["temperature", "moisture", "humidity"].find(k => has(d, k) && typeof val(d, k) === "number");
  const hasControls = d => Object.values(d.capabilities).some(c => c.writable) || d.attributes?.has_snapshot;
  // ---------- chart styles (Settings → Appearance → Charts), shared by sparklines and History ----------
  const CHART_STYLES = [["area", "Area", "show_chart"], ["line", "Line", "timeline"], ["smooth", "Smooth", "waves"], ["steps", "Steps", "stairs"], ["bars", "Bars", "bar_chart"]];
  let chartStyle = load("chartStyle", "area");
  // history charts: draw the line straight across a stretch without readings (devices that only report on a
  // change, or now and then) instead of breaking it; Settings → Appearance can turn this off
  let joinGaps = load("joinGaps", "true") !== "false";
  if (!CHART_STYLES.some(c => c[0] === chartStyle)) chartStyle = "area";
  const f1x = v => v.toFixed(1);
  function segPath(seg, style) {
    if (!seg.length) return "";
    if (style === "steps") return seg.map(([x, y], i) => i ? `H${f1x(x)}V${f1x(y)}` : `M${f1x(x)},${f1x(y)}`).join("");
    if (style === "smooth" && seg.length > 2) {         // Catmull-Rom through every point, as cubic Béziers
      let d = `M${f1x(seg[0][0])},${f1x(seg[0][1])}`;
      for (let i = 0; i < seg.length - 1; i++) {
        const p0 = seg[i - 1] || seg[i], p1 = seg[i], p2 = seg[i + 1], p3 = seg[i + 2] || p2;
        const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6], c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
        d += `C${f1x(c1[0])},${f1x(c1[1])} ${f1x(c2[0])},${f1x(c2[1])} ${f1x(p2[0])},${f1x(p2[1])}`;
      }
      return d;
    }
    return seg.map(([x, y], i) => `${i ? "L" : "M"}${f1x(x)},${f1x(y)}`).join("");
  }
  // segs: arrays of [x, y] points (gaps between arrays); base: y of the chart bottom
  function plotSvg(segs, base, style = chartStyle, barW = 4) {
    if (style === "bars") {
      const all = segs.flat(); if (!all.length) return "";
      const w = Math.max(1.5, Math.min(barW, 24));
      return `<g class="bars">${all.map(([x, y]) => `<rect x="${f1x(x - w / 2)}" y="${f1x(Math.min(y, base - 1))}" width="${f1x(w)}" height="${f1x(Math.max(1, base - y))}" rx="${w > 4 ? 1.5 : 0}"/>`).join("")}</g>`;
    }
    const lines = segs.filter(s => s.length > 1).map(sg => segPath(sg, style));
    const areas = style === "line" ? [] : segs.filter(s => s.length > 1).map((sg, i) => `${lines[i]}L${f1x(sg[sg.length - 1][0])},${base}L${f1x(sg[0][0])},${base}Z`);
    return `${areas.length ? `<path class="area" d="${areas.join("")}"/>` : ""}<path class="line s-${style}" d="${lines.join("")}"/>`;
  }
  function bucketize(xy, n) {          // bars: at most n bars, each the average of its slice
    if (xy.length <= n) return xy;
    const out = [], size = xy.length / n;
    for (let i = 0; i < n; i++) { const sl = xy.slice(Math.floor(i * size), Math.floor((i + 1) * size)); if (sl.length) out.push([sl.reduce((a, p) => a + p[0], 0) / sl.length, sl.reduce((a, p) => a + p[1], 0) / sl.length]); }
    return out;
  }
  function sparkSvg(points, capName, H = 40) {
    if (!points || points.length < 2) return "";
    const vs = points.map(p => capName === "temperature" ? toUnit(p.v) : p.v);
    const min = Math.min(...vs), max = Math.max(...vs), span = max - min || 1, W = 220, flat = max - min < 1e-9;
    let xy = vs.map((v, i) => [i / (vs.length - 1) * W, flat ? H / 2 : H - 2 - (v - min) / span * (H - 4)]);   // steady: a line through the middle
    if (chartStyle === "bars") xy = bucketize(xy, 36).map(([x, y]) => [x, Math.min(y, H - 3)]);
    const st = flat ? "line" : chartStyle;
    return `<svg class="spark c-${st}" style="height:${H}px" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${plotSvg([xy], H, st, W / 36 * 0.7)}</svg>`;
  }

  // ---------- layout: room order, device order, favorites ----------
  const roomRank = r => { const i = layout.rooms.indexOf(r); return i < 0 ? 1e6 : i; };
  const devRank = (room, id) => { const o = layout.order[room] || []; const i = o.indexOf(id); return i < 0 ? 1e6 : i; };
  const editing = () => document.body.classList.contains("editing");
  function orderRooms(byRoom, floatAlarms = true) {
    const alarmed = r => byRoom[r].some(isAlarm);
    return Object.keys(byRoom).sort((a, b) =>
      (floatAlarms && !editing() ? alarmed(b) - alarmed(a) : 0) ||          // safety first, except while arranging
      roomRank(a) - roomRank(b) || (a === "Other") - (b === "Other") || a.localeCompare(b));
  }
  function orderDevices(room, items, fallback) {
    return items.sort((a, b) => devRank(room, a.id) - devRank(room, b.id) || fallback(a, b));
  }
  function roomSections(shown, { favorites = false, fallback = (a, b) => a.name.localeCompare(b.name), extraFirst = "" } = {}) {
    const pinned = favorites ? layout.pinned.map(id => shown.find(d => d.id === id)).filter(Boolean) : [];
    const pinnedIds = new Set(pinned.map(d => d.id));
    const byRoom = {};
    for (const d of shown) if (!pinnedIds.has(d.id)) (byRoom[d.room || "Other"] ||= []).push(d);
    const render1 = (name, items, isFav = false) => `<section class="room ${isFav ? "fav" : ""}" data-room="${esc(name)}">
      <h2>${editing() && !isFav ? `<span class="grip">${icon("drag_indicator")}</span>` : ""}${esc(name)}</h2>
      <div class="grid" data-room="${esc(name)}">${items.map(card).join("") || (isFav ? `<p class="drop-hint">Drag cards here to pin them to the top of Home</p>` : "")}</div></section>`;
    const fav = favorites && (pinned.length || editing()) ? render1(FAV, pinned, true) : "";
    if (gbNow === "type") return extraFirst + fav + typeSections(shown.filter(d => !pinnedIds.has(d.id)), fallback);
    return extraFirst + fav + orderRooms(byRoom).map(r => render1(r, orderDevices(r, byRoom[r], fallback))).join("");
  }
  // ---------- Group by: Room | Type (chosen per page, saved on this device) ----------
  const groupable = () => view !== "settings" && !pluginPages[view] && (!PAGES.has(view) || view === "lights" || view === "battery");
  const groupBy = () => groupable() && load("groupBy:" + view, load("groupByDefault", "room")) === "type" ? "type" : "room";
  let gbNow = "room";                     // groupBy() of the page being drawn
  const roomOf = d => d.room || "Other";
  // inside a type section: by room (in the user's room order), then the user's card order, then the page's own order
  const byRoomThen = fallback => (a, b) => roomRank(roomOf(a)) - roomRank(roomOf(b)) || (roomOf(a) === "Other") - (roomOf(b) === "Other")
    || roomOf(a).localeCompare(roomOf(b)) || devRank(roomOf(a), a.id) - devRank(roomOf(b), b.id) || fallback(a, b);
  function typeGroups(list, fallback = (a, b) => a.name.localeCompare(b.name)) {      // -> [[typeId, devices]] in display order
    const by = {};
    for (const d of list) (by[deviceType(d)] ||= []).push(d);
    return Object.keys(by).sort((a, b) => (!editing() && by[b].some(isAlarm) - by[a].some(isAlarm)) || TYPE_RANK[a] - TYPE_RANK[b])
      .map(t => [t, by[t].sort(byRoomThen(fallback))]);
  }
  const typeHead = (t, count) => { const [, label, ic] = TYPE_INFO[t] || TYPE_INFO.other;
    return `<span class="tsec-ic">${icon(ic)}</span><span>${esc(label)}</span><small class="tsec-n">${count}</small>`; };
  // data-fixed: type sections can't be dragged, and cards can't be dropped into them (moving = changing rooms)
  const typeSections = (list, fallback) => typeGroups(list, fallback).map(([t, items]) => `<section class="room tsec" data-type="${t}" data-fixed>
      <h2>${typeHead(t, items.length)}</h2><div class="grid">${items.map(card).join("")}</div></section>`).join("");

  function card(d) {
    if (cardStyle === "minimal") return miniCard(d);
    const [ic, tone] = deviceIcon(d);
    const sc = sparkCap(d);
    const updated = lastUpdated(d);
    const lit = isLight(d) && val(d, "light");
    return `<article class="card ${isAlarm(d) ? "alarm" : ""} ${d.online ? "" : "offline"} ${lit ? "lit" : ""} ${isGroup(d) ? "group" : ""}" data-id="${esc(d.id)}" ${lit ? `style="--lit:${glow(d)}"` : ""}>
      <div class="card-head"><div class="avatar ${tone}">${icon(ic, !!tone)}</div>
        <div class="titles"><div class="name" role="button" tabindex="0" title="${esc(d.name)} — details">${esc(d.name)}</div><div class="src">${gbNow === "type" ? `<span class="croom">${esc(d.room || "No room")}</span> · ` : ""}${esc(srcLabel(d))}${d.online ? "" : " · Offline"}</div></div>
        <button class="card-edit" data-edit aria-label="Edit">${icon("edit")}</button>${headSwitch(d)}</div>
      ${fitCard(d, sc)}
      <div class="updated">${updated ? ago(updated) : ""}</div></article>`;
  }

  // Fill the fixed-height card in priority order; whatever doesn't fit goes behind "More".
  let panelFull = false;
  function fitCard(d, sc) {
    const phone = innerWidth < 840;
    const budget = (phone ? 272 : 276) - (phone ? 28 : 32) - (d.name.length > (phone ? 13 : 20) ? 60 : 44) - 16 - 10;
    const reading = readingBlock(d), status = statusBlock(d), meta = metaBlock(d), rows = controlRows(d);
    const spark = sc ? `<button class="spark-btn" data-hist="${esc(sc)}" aria-label="Show history">${sparkSvg(sparks.get(d.id + "|" + sc), sc)}</button>` : "";
    const items = [];
    if (reading) items.push(["r", reading, phone ? 40 : 52]);
    if (status) items.push(["s", status, status.includes('class="s2"') ? 52 : 32]);
    if (rows[0]) items.push(["c", rows[0], rowH(rows[0])]);
    if (meta) items.push(["m", meta, 24]);
    rows.slice(1).forEach(r => items.push(["c", r, rowH(r)]));
    if (spark) items.push(["p", spark, 40]);
    const fit = room => { let used = 0; const keep = new Set();
      items.forEach((it, i) => { if (used + it[2] + 10 <= room) { used += it[2] + 10; keep.add(i); } }); return keep; };
    let keep = fit(budget);
    if (keep.size < items.length) keep = fit(budget - 50);          // leave room for the More/Details button
    const hiddenCtl = items.some((it, i) => it[0] === "c" && !keep.has(i));
    // keep document order: reading, status, spark, meta, controls
    const order = { r: 0, s: 1, p: 2, m: 3, c: 4 };
    const kept = items.map((it, i) => [it, i]).filter(([, i]) => keep.has(i)).sort((a, b) => order[a[0][0]] - order[b[0][0]] || a[1] - b[1]).map(([it]) => it[1]);
    const anyHidden = hiddenCtl || keep.size < items.length;
    return kept.join("") + (anyHidden ? `<button class="more-ctl" data-open-device>${icon("tune")}${hiddenCtl ? "More controls" : "Details"}</button>` : "");
  }

  // Device panel: everything about one device, all controls, tappable history.
  let panelId = null, panelTab = "now";
  const dh = { id: null, range: load("devHistRange", "24h"), data: null, loading: false, error: null, focus: null, custom: null, cdraft: null, req: 0 };
  if (dh.range === "1h") dh.range = "4h";                       // 1h is no longer offered in the panel
  try { const c = JSON.parse(load("devHistCustom", "null")); if (c && c.end > c.start) dh.custom = { start: +c.start, end: +c.end }; } catch {}
  if (dh.range === "custom" && !dh.custom) dh.range = "24h";
  // Controls inside dialogs are plain buttons: only "Close" may submit (and close) the panel.
  document.addEventListener("submit", e => {
    if (e.target.closest("#devpanel") && e.submitter?.value !== "close") e.preventDefault();
  }, true);
  function openDevicePanel(id, tab = "now", focusCap = null) {
    if (panelId !== id) dh.data = null;
    panelId = id; panelTab = tab; dh.focus = focusCap;
    if (tab === "history" && (!dh.data || dh.id !== id)) loadDevHistory(id, dh.range);
    if (tab === "now" && (live.id !== id || !$("#devpanel").open)) loadLive(id);
    wirePanelClose();
    renderDevicePanel(); if (!$("#devpanel").open) $("#devpanel").showModal();
  }
  // Closing: the X (top right), a click/tap on the backdrop, or Escape (the dialog's own cancel). A press that starts
  // inside the panel and ends outside (selecting text, dragging across a chart) never closes it.
  function wirePanelClose() {
    if (wirePanelClose.done) return; wirePanelClose.done = true;
    const dlg = $("#devpanel");
    const outside = e => { const r = dlg.getBoundingClientRect();
      return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom; };
    let downOutside = false;
    dlg.addEventListener("pointerdown", e => { downOutside = e.target === dlg && outside(e); });
    dlg.addEventListener("click", e => {
      const was = downOutside; downOutside = false;
      if (e.target.closest("[data-close-panel]")) { e.preventDefault(); dlg.close("close"); return; }
      if (was && e.target === dlg && outside(e)) dlg.close("close");
    });
    dlg.addEventListener("close", stopLive);
  }
  function renderDevicePanel() {
    const d = devices.get(panelId); if (!d || !$("#devpanel").open && panelId == null) return;
    const [ic, tone] = deviceIcon(d);
    // re-rendering (every live update) must not drop keyboard focus: put it back on the same control
    const ae = document.activeElement, pb = $("#devpanel-body");
    const refocus = ae?.classList?.contains("panel-inner") ? ".panel-inner" : ae && ae !== pb && pb.contains(ae) ? ["data-ptab", "data-dhrange", "data-hist", "data-edit", "data-cmd", "id"]
      .filter(a => ae.hasAttribute(a)).concat(ae.hasAttribute("data-val") ? ["data-val"] : []).map(a => `[${a}="${CSS.escape(ae.getAttribute(a))}"]`).join("") : "";
    const restoreFocus = () => { if (refocus && !pb.contains(document.activeElement)) pb.querySelector(refocus)?.focus({ preventScroll: true }); };
    $("#devpanel").classList.toggle("hist", panelTab === "history");
    const tabs = `<div class="segmented ptabs" role="tablist">${[["now", "Now", "sensors"], ["history", "History", "timeline"]].map(([k, l, i]) =>
      `<button type="button" role="tab" aria-selected="${panelTab === k}" data-ptab="${k}" class="${panelTab === k ? "on" : ""}">${icon(i)}${l}</button>`).join("")}</div>`;
    const head = `<div class="card-head"><div class="avatar ${tone}">${icon(ic, !!tone)}</div><div class="titles"><div class="name" id="devpanel-title">${esc(d.name)}</div>
        <div class="src">${esc([d.room, srcLabel(d), d.model].filter(Boolean).join(" · "))}${d.online ? "" : " · Offline"}</div></div>${panelTab === "now" ? headSwitch(d) : ""}</div>`;
    if (panelTab === "history") {
      $("#devpanel-body").innerHTML = `<div data-id="${esc(d.id)}" class="panel-inner" tabindex="-1" autofocus>${head}${tabs}${devHistoryHtml(d)}</div>`;
      wireDevHistory(); restoreFocus();
      return;
    }
    panelFull = true;
    const rows = controlRows(d).join("");
    panelFull = false;
    const nums = Object.entries(d.capabilities).filter(([, c]) => typeof c.value === "number" && !c.writable);
    // the live charts keep their element (and any hover read-out) across re-renders; drawLive() fills it
    const keepLive = live.id === d.id ? $("#dp-live") : null;
    $("#devpanel-body").innerHTML = `<div data-id="${esc(d.id)}" class="panel-inner" tabindex="-1" autofocus>
      ${head}${tabs}
      ${readingBlock(d)}${statusBlock(d)}
      ${nums.length ? `<div class="panel-grid">${nums.map(([k, c]) => `<button class="pstat" data-hist="${esc(k)}">${icon(META_ICON[k] || (k === "temperature" ? "thermostat" : k === "humidity" ? "water_drop" : k === "battery" ? "battery_full" : "sensors"))}<div><small>${esc(c.label || pretty(k))}</small><b>${capText(k, c)}</b></div></button>`).join("")}</div>` : ""}
      ${rows ? `<div class="panel-ctl">${rows}</div>` : ""}
      <section class="plive" id="dp-live" aria-label="Live readings, last 5 minutes"></section>
      <div class="panel-foot"><span class="muted small">Updated ${ago(lastUpdated(d)).toLowerCase()}</span><button class="text-btn" data-edit>${icon("edit")}Edit</button></div></div>`;
    if (keepLive) $("#dp-live").replaceWith(keepLive); else drawLive();
    restoreFocus();
  }

