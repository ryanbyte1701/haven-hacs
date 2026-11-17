(() => {
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const root = document.documentElement;
  const devices = new Map();
  const sparks = new Map();
  const store = (k, v) => { try { v === undefined ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} };
  const load = (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } };
  let view = load("filter", "all");
  let mode = load("viewmode", "cards");
  let sort; try { sort = JSON.parse(load("sort", "")) || {}; } catch { sort = {}; }
  if (typeof sort.key !== "string") sort = { key: "room", dir: 1 };
  let unit = load("unit", "F");
  let token = load("token", "");
  let appTitle = "Haven";
  let timeCfg = { hour12: undefined, timeZone: undefined };
  const timeOpts = () => ({ ...(timeCfg.hour12 !== undefined ? { hour12: timeCfg.hour12 } : {}), ...(timeCfg.timeZone ? { timeZone: timeCfg.timeZone } : {}) });
  let layout = { rooms: [], order: {}, pinned: [], views: [] };
  const VIEW_TYPES = { climate: "Climate", lights: "Lights", water: "Water", doors: "Doors", security: "Security",
    controls: "Controls", battery: "Batteries", power: "UPS" };
  const VIEW_ICONS = ["dashboard", "home", "bedtime", "lightbulb", "thermostat", "water_drop", "sensor_door", "shield_lock",
    "power", "grass", "partly_cloudy_day", "videocam", "home_work", "tune", "battery_full", "lan", "sprinkler", "detector_smoke"];
  const customView = () => view.startsWith("v:") ? (layout.views || []).find(v => "v:" + v.id === view) : null;
  let cardStyle = load("cardStyle", "standard");
  let dragging = false, sortables = [];
  const FAV = "★ Favorites";

  const SEEDS = { ocean: "#1E88E5", violet: "#6750A4", teal: "#00897B", sage: "#7C9A3D", desert: "#D9772B" };
  const GROUPS = {
    climate: ["temperature", "humidity", "pressure", "co2", "pm25", "pm10", "voc", "aqi", "air_score", "illuminance", "wind_speed", "rain_daily", "moisture"],
    water: ["leak", "valve", "moisture", "rain_daily", "flow_rate", "water_pressure", "water_usage_today", "ph", "orp", "free_chlorine", "watering"],
    doors: ["contact"],
    security: ["contact", "lock", "motion", "presence", "occupancy", "vibration", "tamper", "smoke", "co", "co_ppm", "gas", "heat", "alarm_panel", "ding"],
    controls: ["lock", "valve", "switch", "action", "light", "alarm_panel"],
    lights: ["light"],
  };
  const PAGES = new Set(["battery", "power", "settings", "devices", "air"]);
  const pluginPages = {};   // id -> { label, icon, title, render(el), onDevices?() }
  const TABS = [["climate", "Climate", "thermostat"], ["lights", "Lights", "lightbulb"], ["water", "Water", "water_drop"],
    ["doors", "Doors", "sensor_door"], ["security", "Security", "shield_lock"], ["controls", "Controls", "tune"]];
  const TAB_IDS = TABS.map(t => t[0]);
  const TITLES = { lights: "Lights", climate: "Climate", water: "Water", doors: "Doors", security: "Security", controls: "Controls",
    battery: "Batteries", power: "Power", settings: "Settings", devices: "Devices", air: "Air quality" };
  const LABEL = { humidity: "Humidity", moisture: "Soil", pressure: "Pressure", illuminance: "Light", co2: "CO₂", pm25: "PM2.5",
    wind_speed: "Wind", wind_gust: "Gust", rain_daily: "Rain", rain_rate: "Rate", uv: "UV", solar: "Solar",
    co_ppm: "CO", power: "Power", runtime: "Runtime", load: "Load", input_voltage: "Input", output_voltage: "Output",
    aqi: "AQI", air_score: "Air score", voc: "VOC", pm10: "PM10", ph: "pH", orp: "ORP", free_chlorine: "Chlorine",
    flow_rate: "Flow", water_pressure: "Pressure", water_usage_today: "Used today", cartridge_life: "Cartridge",
    filter_life: "Filter", fan_speed: "Fan", mode: "Mode", oscillation: "Oscillate", energy_session: "Session",
    charge_time: "Charging", amperage_limit: "Limit", clean_area: "Area", clean_time: "Clean time",
    main_brush_life: "Brush", side_brush_life: "Side brush", rain_delay: "Rain delay", standby: "Standby",
    ups_status: "UPS status", replace_battery: "Replace battery", 
    energy_today: "Today", energy_month: "This month", voltage: "Voltage", current: "Current" };
  const pretty = k => LABEL[k] || (/^run_(\d+)m$/.test(k) ? `${k.match(/\d+/)[0]} min` : null) || String(k).replace(/_/g, " ").replace(/^./, c => c.toUpperCase());
  const kindOf = d => d.attributes?.kind || "";
  const META_ICON = { outdoor_temperature: "partly_cloudy_day", wind_speed: "air", wind_gust: "air", rain_daily: "rainy", rain_rate: "rainy", uv: "sunny", solar: "sunny",
    co2: "co2", pm25: "air", pressure: "science", illuminance: "light_mode", co_ppm: "detector_smoke", moisture: "grass",
    runtime: "timer", load: "speed", input_voltage: "electrical_services", power: "bolt", brightness: "light_mode", color_temp: "thermostat", output_voltage: "electrical_services",
    voc: "aq", pm10: "air", aqi: "aq", co: "co2", filter_life: "filter_alt", cartridge_life: "filter_alt", flow_rate: "waves",
    water_pressure: "speed", water_usage_today: "water", free_chlorine: "science", orp: "science", ph: "water_ph",
    energy_session: "bolt", energy_today: "bolt", energy_month: "bolt", voltage: "electrical_services", current: "electrical_services", charge_time: "timer", clean_area: "grid_view", clean_time: "timer", main_brush_life: "cleaning_services", side_brush_life: "cleaning_services" };
  const SRC = { yolink: "YoLink", aqara: "Aqara", ecowitt: "Ecowitt", xsense: "X-Sense", mqtt: "MQTT", demo: "Demo", nut: "UPS", ring: "Ring", hue: "Hue",
    waterguru: "WaterGuru", flo: "Flo by Moen", rachio: "Rachio", awair: "Awair", dyson: "Dyson", vesync: "Levoit (VeSync)",
    chargepoint: "ChargePoint", roborock: "Roborock", airquality: "Outdoor AQI", tapo: "Tapo", ecobee: "ecobee",
    homeassistant: "Home Assistant", hass: "Home Assistant" };
  const ALARM_LABEL = { disarmed: "Disarmed", armed_home: "Armed · Home", armed_away: "Armed · Away", armed_night: "Armed · Night",
    arming: "Arming…", pending: "Entry delay", triggered: "TRIGGERED" };

  // ---------- icons ----------
  const icon = (name, filled = false) => {
    const p = window.MD_ICONS[name] || window.MD_ICONS.sensors;
    return `<svg class="ic" viewBox="0 -960 960 960" aria-hidden="true"><path d="${p[filled ? 1 : 0]}"/></svg>`;
  };
  const hydrateIcons = (el = document) => $$("[data-icon]", el).forEach(n => {
    if (!n.querySelector(":scope > svg.ic")) n.insertAdjacentHTML("afterbegin", icon(n.dataset.icon, n.hasAttribute("data-fill")));
  });

  // ---------- helpers ----------
  // who is signed in (GET /api/me). Roles: admin | user (controls devices) | monitor (view only)
  let me = { user: null, role: "monitor", guest: true };
  const isAdmin = () => me.role === "admin";
  const canControl = () => me.role === "admin" || me.role === "user";
  const authHdr = () => token ? { Authorization: `Bearer ${token}` } : {};
  const api = (path, opts = {}) => fetch(path, { ...opts, headers: { "Content-Type": "application/json", ...authHdr() } })
    .catch(() => { throw new Error("Haven isn't reachable. Check your connection."); })   // not "Failed to fetch"
    .then(async r => { if (r.status === 401) { askToken(); throw new Error("Please sign in again"); }
      if (!r.ok) { const d = (await r.json().catch(() => ({}))).detail; throw new Error(typeof d === "string" ? d : r.statusText); } return r.json(); });
  const msgHooks = [];
  // the sign-in page lives in accounts.js; many 401s at once still show it once
  function askToken(reason) { if (!document.body.classList.contains("auth-open")) window.HavenAccounts?.showLogin({ reason }); }
  const signInBanner = () => askToken("Your session ended. Sign in again.");
  const toUnit = c => unit === "F" ? c * 9 / 5 + 32 : c;
  const temp = c => c == null ? "–" : toUnit(c).toFixed(1);
  const ago = ts => { if (!ts) return ""; const s = Date.now() / 1000 - ts;
    return s < 60 ? "Just now" : s < 3600 ? `${Math.floor(s / 60)} min ago` : s < 86400 ? `${Math.floor(s / 3600)} h ago` : `${Math.floor(s / 86400)} d ago`; };
  const val = (d, k) => d.capabilities[k]?.value;
  const has = (d, k) => k in d.capabilities;
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmt = v => typeof v === "number" ? +v.toFixed(1) : esc(v);
  const n = v => v == null ? "–" : fmt(v);                        // any device value going into HTML
  const safeColor = c => /^#[0-9a-f]{6}$/i.test(String(c || "")) ? c : null;
  const visible = () => [...devices.values()].filter(d => !d.hidden);
  const lastUpdated = d => Math.max(0, ...Object.values(d.capabilities).map(c => c.updated || 0));
  const srcLabel = d => { const s = (d.model || "").startsWith("demo (") ? d.model.slice(6, -1) : d.source; return SRC[s] || s; };
  const runtimeText = m => m == null ? "–" : m >= 90 ? `${Math.floor(m / 60)} h ${Math.round(m % 60)} min` : `${Math.round(m)} min`;

  const isAlarm = d => ["leak", "smoke", "co", "gas", "heat"].some(k => val(d, k) === true) || (val(d, "co_ppm") ?? 0) >= 50 ||
    val(d, "alarm_panel") === "triggered" || val(d, "ups_status") === "low_battery";
  const needsAttention = d => isAlarm(d) || (val(d, "contact") === "open" && !has(d, "lock")) || val(d, "lock") === "unlocked" ||
    val(d, "ups_status") === "on_battery" || batteryLow(d) || !d.online;
  const batteryLow = d => { const b = val(d, "battery"); return (b != null && b <= 25) || val(d, "battery_low") === true; };
  const isOutdoor = d => /outdoor|weather|backyard|patio|garden/i.test(`${d.room} ${d.name}`);
  const isUps = d => has(d, "ups_status");
  const isPlug = d => kindOf(d) === "smart_plug";
  const coAlarm = d => has(d, "co") && typeof val(d, "co") !== "number";   // outdoor AQI services report CO as a number
  const isLight = d => d.attributes?.kind === "light" || d.attributes?.kind === "group" || (has(d, "light") && has(d, "brightness"));
  const isGroup = d => d.attributes?.kind === "group";
  const isThermostat = d => kindOf(d) === "thermostat" || has(d, "hvac_mode") || ["heat_setpoint", "cool_setpoint", "target_temperature"].some(k => has(d, k));

  // ---------- device types (Group by: Type) ----------
  // One human type per device, in the order the sections appear. Edit this list to add or reorder types.
  const DEVICE_TYPES = [
    ["thermostat", "Thermostats", "thermostat"], ["climate", "Temperature & humidity", "device_thermostat"], ["air", "Air quality", "aq_indoor"],
    ["purifier", "Purifiers", "air_purifier"], ["light", "Lights", "lightbulb"], ["light_group", "Light groups", "home_iot_device"],
    ["plug", "Plugs & switches", "outlet"], ["lock", "Locks", "lock"], ["door", "Doors & windows", "door_front"],
    ["motion", "Motion & presence", "sensor_occupied"], ["camera", "Cameras & doorbells", "videocam"], ["alarm", "Alarm panels", "shield"],
    ["smoke", "Smoke & CO alarms", "detector_smoke"], ["leak", "Leak sensors", "water_damage"], ["valve", "Valves", "valve"],
    ["water", "Water", "water"], ["soil", "Soil moisture", "grass"], ["weather", "Weather", "partly_cloudy_day"], ["ups", "UPS", "battery_charging_full"],
    ["ev", "EV chargers", "ev_station"], ["vacuum", "Vacuums", "vacuum"], ["other", "Other", "sensors"]];
  const TYPE_RANK = Object.fromEntries(DEVICE_TYPES.map((t, i) => [t[0], i]));
  const TYPE_INFO = Object.fromEntries(DEVICE_TYPES.map(t => [t[0], t]));
  function deviceType(d) {
    const k = kindOf(d), any = (...ks) => ks.some(x => has(d, x));
    if (isThermostat(d)) return "thermostat";
    if (isUps(d)) return "ups";
    if (k === "ev_charger" || has(d, "charger_status")) return "ev";
    if (k === "vacuum" || has(d, "vacuum_state")) return "vacuum";
    if (k === "air_purifier") return "purifier";
    if (k === "weather") return "weather";
    if (k === "aqi_station" || k === "air_monitor") return "air";
    if (has(d, "alarm_panel")) return "alarm";
    if (has(d, "smoke") || coAlarm(d) || any("heat", "gas")) return "smoke";
    if (has(d, "ding") || d.attributes?.has_snapshot || ["camera", "doorbell"].includes(k) || d.source === "ring") return "camera";
    if (isGroup(d)) return "light_group";
    if (isLight(d)) return "light";
    if (has(d, "lock")) return "lock";
    if (["pool", "water_monitor", "irrigation_zone", "irrigation_controller"].includes(k) || any("ph", "flow_rate", "watering", "water_usage_today")) return "water";
    if (has(d, "leak")) return "leak";
    if (has(d, "valve")) return "valve";
    if (has(d, "contact")) return "door";
    if (any("motion", "presence") || (has(d, "occupancy") && typeof val(d, "occupancy") !== "number")) return "motion";
    if (k === "smart_plug" || has(d, "switch")) return "plug";
    if (any("air_score", "co2", "pm25", "voc", "aqi")) return "air";
    if (any("wind_speed", "rain_daily")) return "weather";
    if (has(d, "moisture") && !has(d, "temperature")) return "soil";
    if (any("temperature", "humidity")) return "climate";
    return "other";
  }
  const PRESETS = ["#ffb46b", "#ffe9c9", "#ff5a4e", "#ff9f1c", "#7bd389", "#4cc2ff", "#8f6bff", "#ff6fb5"];
  function kelvinRgb(k) {   // Tanner Helland approximation, good enough for a glow color
    const t = k / 100; let r, g, b;
    r = t <= 66 ? 255 : 329.7 * Math.pow(t - 60, -0.1332);
    g = t <= 66 ? 99.47 * Math.log(t) - 161.12 : 288.12 * Math.pow(t - 60, -0.0755);
    b = t >= 66 ? 255 : t <= 19 ? 0 : 138.52 * Math.log(t - 10) - 305.04;
    const c = v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0");
    return `#${c(r)}${c(g)}${c(b)}`;
  }
  const glow = d => safeColor(val(d, "color")) || (Number(val(d, "color_temp")) ? kelvinRgb(Number(val(d, "color_temp"))) : "#ffd27a");

  // ---------- per-device presentation ----------
  function deviceIcon(d) {
    const k = kindOf(d);
    if (k === "pool") return ["pool", /low|high|out|alert/i.test(val(d, "status_text") || "") ? "warn" : ""];
    if (k === "thermostat") return ["thermostat", ["heating", "cooling"].includes(val(d, "hvac_action")) ? "active" : ""];
    if (k === "air_monitor") { const sc = val(d, "air_score"); return ["aq_indoor", sc != null && sc < 60 ? "warn" : ""]; }
    if (k === "smart_plug") return ["outlet", val(d, "switch") ? "active" : ""];
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
    const skip = new Set(["temperature", "humidity", "battery", "battery_low", "leak", "smoke", "co", "heat", "contact", "lock", "valve",
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
  const controlsBlock = (d, compact = false) => controlRows(d).join("");
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
    if (c.switch?.writable) out.push(sw("switch", val(d, "switch"), "Power"));
    // generic controls for any other writable capability (purifier modes, fan speed, charge limit, standby…)
    const HANDLED = new Set(["lock", "valve", "alarm_panel", "switch", "light", "brightness", "color_temp", "color", "action"]);
    const tmode = kindOf(d) === "thermostat" ? val(d, "hvac_mode") : null;
    for (const [k, cp] of Object.entries(c)) {
      if (!cp.writable || HANDLED.has(k)) continue;
      if (tmode && ((k === "heat_setpoint" && /^(cool|off)$/.test(tmode)) || (k === "cool_setpoint" && /^(heat|aux_heat_only|off)$/.test(tmode)))) continue;
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
      `<button class="tonal-btn" data-cmd="action" data-val="${esc(JSON.stringify(o))}">${icon({ mute: "notifications", siren: "campaign", start: "power_settings_new", stop: "power_off", pause: "timer", dock: "home", locate: "notifications_active", resume_schedule: "schedule" }[o] || (/^run/.test(o) ? "sprinkler" : "science"))}${esc(pretty(o))}</button>`));
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
  function miniCard(d) {
    const [ic, tone] = deviceIcon(d);
    const st = statusOf(d);
    let big = "", small = "";
    if (has(d, "ph") && typeof val(d, "ph") === "number") { big = `${fmt(val(d, "ph"))}<small> pH</small>`; small = [has(d, "temperature") ? `${temp(val(d, "temperature"))}°` : "", st ? st[0] : ""].filter(Boolean).join(" · "); }
    else if (has(d, "temperature")) { big = `${temp(val(d, "temperature"))}<small>°</small>`; small = [val(d, "humidity") != null ? `${Math.round(val(d, "humidity"))}% RH` : "", st ? st[0] : ""].filter(Boolean).join(" · "); }
    else if (has(d, "moisture")) { big = `${val(d, "moisture") == null ? "–" : Math.round(val(d, "moisture"))}<small>%</small>`; small = "Soil moisture"; }
    else if (isUps(d)) { big = `${n(val(d, "battery"))}<small>%</small>`; small = `${st[0]} · ${runtimeText(val(d, "runtime"))}`; }
    else if (st) { big = `<span class="word">${esc(st[0])}</span>`; small = detailText(d); }
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

  function typeMatch(d, t) {
    if (t === "battery") return val(d, "battery") != null || val(d, "battery_low") != null;
    if (t === "power") return isUps(d) || isPlug(d);
    if (t === "lights") return isLight(d);
    const g = GROUPS[t]; return !!g && g.some(k => has(d, k) && (t !== "controls" || d.capabilities[k].writable) && !(k === "co" && !coAlarm(d))
      && !(k === "occupancy" && isThermostat(d)));   // a thermostat's built-in occupancy sensor doesn't make it a security device
  }
  const autoTabs = d => TAB_IDS.filter(t => typeMatch(d, t));
  const tabsOf = d => Array.isArray(d.categories) ? d.categories : autoTabs(d);
  function viewMatch(v, d) {
    if ((v.devices || []).includes(d.id)) return true;
    const rules = [v.rooms?.length && (() => v.rooms.includes(d.room || "Other")), v.types?.length && (() => v.types.some(t => TAB_IDS.includes(t) ? tabsOf(d).includes(t) : typeMatch(d, t))),
      v.sources?.length && (() => v.sources.includes(d.source))].filter(Boolean);
    return rules.length > 0 && rules.every(f => f());
  }
  function matches(d) {
    if (view === "all") return true;
    const cv = customView(); if (cv) return viewMatch(cv, d);
    if (TAB_IDS.includes(view)) return tabsOf(d).includes(view);
    const g = GROUPS[view];
    return g && g.some(k => has(d, k) && (view !== "controls" || d.capabilities[k].writable));
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
        <td class="c-ctl">${controlsBlock(d, true)}</td></tr>`;
    }).join("")).join("");
    return `<div class="table-wrap"><table class="dtable devtable"><thead><tr>${th("name", "Device", "c-name")}${th("room", "Room", "c-room")}${th("source", "Integration", "c-src")}${th("status", "Status", "c-status")}${th("", "Details", "c-det")}${th("battery", "Battery", "c-bat")}${th("updated", "Updated", "c-upd")}${th("", "Controls", "c-ctl")}</tr></thead><tbody>${rows}</tbody></table></div>`;
  }
  const levelBar = raw => { const b = Math.max(0, Math.min(100, Number(raw) || 0));
    return `<span class="level ${b <= 25 ? "low" : b <= 50 ? "mid" : ""}"><span class="bar"><i style="width:${Math.max(3, b)}%"></i></span><span>${Math.round(b)}%</span></span>`; };

  // ---------- summary tiles + chips ----------
  const tile = (cls, ic, value, label, fill) => `<div class="tile ${cls}"><div class="ti">${icon(ic, fill)}</div><div class="tv">${value}</div><div class="tl">${esc(label)}</div></div>`;
  // ---------- Home page ----------
  const HOME_TILES = [
    ["leaks", "Leaks", "water_drop"], ["security", "Doors & locks", "shield_lock"], ["safety", "Smoke, CO & alarm", "detector_smoke"],
    ["power", "Power use", "bolt"], ["ups", "UPS / mains power", "battery_charging_full"], ["batteries", "Batteries", "battery_full"],
    ["lights", "Lights", "lightbulb"], ["water", "Water", "water"], ["offline", "Offline devices", "wifi_off"],
    ["ev", "EV charger", "ev_station"], ["vacuum", "Vacuum", "vacuum"], ["irrigation", "Irrigation", "sprinkler"], ["pool", "Pool", "pool"]];
  const HOME_DEFAULT = { weather: true, forecast: true, station: true, climate: true, aqi_outdoor: true, aqi_indoor: true,
    favorites: true, rooms: true, greeting: true, tiles: ["leaks", "security", "safety", "power", "ups", "batteries", "lights", "water", "offline"] };
  const homeCfg = () => ({ ...HOME_DEFAULT, ...(layout.home || {}) });
  const WX_ICON = { clear: ["clear_day", "partly_cloudy_night"], partly: ["partly_cloudy_day", "partly_cloudy_night"], cloudy: ["cloud", "cloud"],
    fog: ["foggy", "foggy"], rain: ["rainy", "rainy"], sleet: ["weather_snowy", "weather_snowy"], snow: ["weather_snowy", "weather_snowy"], storm: ["thunderstorm", "thunderstorm"] };
  const wxIcon = (kind, day = true) => (WX_ICON[kind] || WX_ICON.cloudy)[day ? 0 : 1];
  const tempC = c => c == null ? "–" : `${Math.round(toUnit(c))}°`;
  const goTile = (go, cls, ic, value, label, sub = "") => `<button type="button" class="tile htile ${cls}" data-goto="${esc(go)}">
      <div class="ti">${icon(ic, true)}</div><div class="tv">${value}</div><div class="tl">${esc(label)}</div>${sub ? `<div class="ts">${esc(sub)}</div>` : ""}</button>`;

  function homeTileHtml(id, list) {
    const names = a => a.map(d => d.name).slice(0, 2).join(", ") + (a.length > 2 ? ` +${a.length - 2}` : "");
    switch (id) {
      case "leaks": {
        const sensors = list.filter(d => has(d, "leak")); if (!sensors.length) return "";
        const wet = sensors.filter(d => val(d, "leak") === true);
        return wet.length ? goTile("water", "bad", "water_damage", `${wet.length} leak${wet.length > 1 ? "s" : ""}`, names(wet), "Check now")
          : goTile("water", "good", "water_drop", "No leaks", `${sensors.length} sensor${sensors.length > 1 ? "s" : ""} dry`);
      }
      case "security": {
        const doors = list.filter(d => has(d, "contact") && !has(d, "lock")), locks = list.filter(d => has(d, "lock"));
        if (!doors.length && !locks.length) return "";
        const open = doors.filter(d => val(d, "contact") === "open"), unlocked = locks.filter(d => val(d, "lock") === "unlocked");
        const bad = [...open, ...unlocked];
        return bad.length ? goTile("security", "warn", unlocked.length ? "lock_open" : "door_open", `${bad.length} not secure`,
            [...open.map(d => d.name + " open"), ...unlocked.map(d => d.name + " unlocked")].slice(0, 2).join(" · "))
          : goTile("security", "good", "shield_lock", "Secure", `${doors.length} closed · ${locks.length} locked`);
      }
      case "safety": {
        const det = list.filter(d => ["smoke", "heat", "gas"].some(k => has(d, k)) || coAlarm(d)), panel = list.find(d => has(d, "alarm_panel"));
        if (!det.length && !panel) return "";
        const firing = det.filter(d => ["smoke", "co", "gas", "heat"].some(k => val(d, k) === true));
        if (firing.length || (panel && val(panel, "alarm_panel") === "triggered")) return goTile("security", "bad", "local_fire_department", "Alarm!", names(firing.length ? firing : [panel]));
        const mode = panel ? (ALARM_LABEL[val(panel, "alarm_panel")] || val(panel, "alarm_panel")) : null;
        return goTile("security", "good", panel && val(panel, "alarm_panel") !== "disarmed" ? "shield" : "detector_smoke", mode || "All clear",
          det.length ? `${det.length} detector${det.length > 1 ? "s" : ""} OK` : "Alarm system", mode && det.length ? "Detectors OK" : "");
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
        return goTile("controls", st === "charging" ? "primary" : "", "ev_station", st === "charging" ? `${n((val(ev, "power") || 0) / 1000)}<small> kW</small>` : pretty(st || "idle"), ev.name,
          val(ev, "energy_session") != null ? `${n(val(ev, "energy_session"))} kWh this session` : "");
      }
      case "vacuum": {
        const v = list.find(d => kindOf(d) === "vacuum"); if (!v) return "";
        return goTile("controls", val(v, "vacuum_state") === "error" ? "bad" : "", "vacuum", pretty(val(v, "vacuum_state") || "—"), v.name, val(v, "battery") != null ? `Battery ${n(val(v, "battery"))}%` : "");
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
      || list.find(d => d.source !== "weather" && kindOf(d) !== "aqi_station" && has(d, "wind_speed") && typeof val(d, "temperature") === "number");
    const useStation = cfg.station && station;
    if (!(cfg.weather && wx) && !useStation) return "";
    const a = wx?.attributes || {}, today = (a.daily || [])[0];
    const curTemp = useStation ? val(station, "temperature") : val(wx, "temperature");
    const hum = useStation && has(station, "humidity") ? val(station, "humidity") : val(wx, "humidity");
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
          <span>${wx && val(wx, "feels_like") != null ? `Feels like ${tempC(val(wx, "feels_like"))}` : ""}${today ? ` · <span class="nw">H\u00a0${tempC(today.hi)} L\u00a0${tempC(today.lo)}</span>` : ""}</span>
          <span class="wplace">${esc(a.place || (useStation ? station.room || "" : ""))}</span></div>
      </div>
      ${bits.length ? `<div class="wbits">${bits.map(b => `<span>${b}</span>`).join("")}</div>` : ""}
      ${days ? `<div class="wdays">${days}</div>` : ""}
      ${stationNote}
    </section>`;
  }
  function homeClimate(list) {
    const inside = list.filter(d => typeof val(d, "temperature") === "number" && !isOutdoor(d) && !isUps(d) && !["weather", "aqi_station", "pool"].includes(kindOf(d)));
    if (!inside.length) return "";
    const ts = inside.map(d => val(d, "temperature")), avg = ts.reduce((a, b) => a + b, 0) / ts.length;
    const hums = inside.map(d => val(d, "humidity")).filter(v => typeof v === "number");
    const rooms = {}; inside.forEach(d => { (rooms[d.room || "Other"] ||= []).push(val(d, "temperature")); });
    const rows = Object.entries(rooms).map(([r, v]) => [r, v.reduce((a, b) => a + b, 0) / v.length]).sort((a, b) => b[1] - a[1]).slice(0, 5)
      .map(([r, t]) => `<li><span>${esc(r)}</span><b>${temp(t)}°</b></li>`).join("");
    return `<section class="hcardx climate" data-goto="climate" tabindex="0" role="button" aria-label="Inside: open Climate">
      <div class="hcx-head">${icon("home")}<span>Inside</span></div>
      <div class="hcx-big">${temp(avg)}<small>°${unit}</small></div>
      <div class="hcx-sub">${hums.length ? `${Math.round(hums.reduce((a, b) => a + b, 0) / hums.length)}% humidity · ` : ""}<span class="nw">${temp(Math.min(...ts))}–${temp(Math.max(...ts))}°</span></div>
      <ul class="hcx-list">${rows}</ul></section>`;
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
      ${tiles.length ? `<div class="home-tiles">${tiles.join("")}</div>` : ""}
      ${admin ? `<button type="button" class="text-btn home-custom" data-goto-setting="home">${icon("dashboard_customize")}Customize</button>` : ""}
    </div>`;
  }
  function doorTiles(list) {
    const c = list.filter(d => has(d, "contact"));
    const open = c.filter(d => val(d, "contact") === "open"), closed = c.length - open.length;
    return tile(open.length ? "warn" : "good", open.length ? "door_open" : "door_front", `${open.length} open`,
      open.length ? open.map(d => d.name).slice(0, 3).join(", ") : "Everything is closed", true) +
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
    $("#alerts").innerHTML = lights.length ? `<div class="light-tools"><button class="tonal-btn" data-all-lights="false">${icon("power_settings_new")}All off</button>
      <button class="tonal-btn" data-all-lights="true">${icon("lightbulb")}All on</button></div>` : "";
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
  const primaryType = d => { const t = tabsOf(d); return t.length ? TYPE_NAMES[t[0]] : isUps(d) ? "UPS" : "No tab"; };
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
          <div class="dcell dtabs">${TABS.map(([t, l, ti]) => `<button type="button" class="tabchip ${tabs.includes(t) ? "on" : ""} ${!custom ? "auto" : auto.includes(t) !== tabs.includes(t) ? "changed" : ""}"
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
  async function loadPower() {
    await Promise.all(visible().filter(isUps).map(async d => {
      for (const k of ["battery", "load"]) try { nutHist[d.id + "|" + k] = await api(`/api/devices/${encodeURIComponent(d.id)}/history/${k}?range=${powerRange}`); } catch {}
    }));
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
  function powerPage(list) {
    // several UPSes: the ones on battery (or low) first, then by name
    const upsRank = d => ({ low_battery: 0, on_battery: 1 }[val(d, "ups_status")] ?? (d.online ? 3 : 2));
    const ups = list.filter(isUps).sort((a, b) => upsRank(a) - upsRank(b) || a.name.localeCompare(b.name)), plugs = list.filter(isPlug);
    $("#summary").innerHTML = "";
    $("#alerts").innerHTML = ups.length ? `<div class="segmented ranges" id="power-ranges">${histRanges.filter(r => r !== "1h").map(r =>
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
    $("#rooms").innerHTML = ups.length || plugs.length ? `<div class="power-wrap">${panels}${plugPanel(plugs)}</div>`
      : `<div class="empty-state">${icon("power")}<h3>No UPS or smart plugs yet</h3><p>Add your UniFi UPS under Settings → UPS (NUT), or Tapo plugs under Settings → TP-Link Tapo plugs.</p>
         <button class="tonal-btn" data-goto="settings">${icon("settings")}Open Settings</button></div>`;
  }

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
  function appearanceSummary() {
    return [{ light: "Light", dark: "Dark", auto: "Auto" }[load("mode", "auto")], root.dataset.seed[0].toUpperCase() + root.dataset.seed.slice(1),
      `°${unit}`, cardStyle === "minimal" ? "Minimal cards" : "Standard cards", mode === "table" ? "Table" : "Cards",
      `${(CHART_STYLES.find(c => c[0] === chartStyle) || CHART_STYLES[0])[1]} charts`, load("groupByDefault", "room") === "type" ? "By type" : ""].filter(Boolean).join(" · ");
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
      ${group("Dashboard", "", row("home", "dashboard_customize", "Home page & menu", homeSummary()) + row("appearance", "palette", "Appearance", appearanceSummary()) +
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
  const PAGE_LIST = [["climate", "Climate"], ["air", "Air quality"], ["lights", "Lights"], ["water", "Water"], ["doors", "Doors"],
    ["security", "Security"], ["controls", "Controls"], ["battery", "Batteries"], ["power", "Power"], ["devices", "Devices"], ["automations", "Automations"]];
  function homeSummary() {
    const c = homeCfg(), on = ["weather", "climate", "aqi_outdoor", "aqi_indoor"].filter(k => c[k]).length;
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
        ${sw("climate", "Inside temperature & humidity")}${sw("aqi_outdoor", "Outdoor air quality")}${sw("aqi_indoor", "Indoor air quality")}</section>
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
  function homeSettingsClick(t) {
    if (!homeDraft) return false;
    const f = t.closest("[data-hflag]"); if (f) { const k = f.dataset.hflag; homeDraft[k] = homeDraft[k] === false; renderSettings(); return true; }
    const tl = t.closest("[data-htile]"); if (tl) { const id = tl.dataset.htile; const a = homeDraft.tiles = [...(homeDraft.tiles || [])];
      a.includes(id) ? a.splice(a.indexOf(id), 1) : a.push(id); renderSettings(); return true; }
    const mv = t.closest("[data-hmove]"); if (mv) { const [id, d] = mv.dataset.hmove.split(":"); const a = homeDraft.tiles = [...homeDraft.tiles];
      const i = a.indexOf(id), j = i + Number(d); if (i >= 0 && j >= 0 && j < a.length) { [a[i], a[j]] = [a[j], a[i]]; } renderSettings();
      $(`[data-hmove="${id}:${d}"]`)?.focus(); return true; }
    if (t.closest("[data-hreset]")) { homeDraft = JSON.parse(JSON.stringify(HOME_DEFAULT)); renderSettings(); snack("Defaults restored. Save to keep them."); return true; }
    if (t.closest("[data-hsave]")) {
      homeDraft.title = ($("#htitle")?.value || "").trim(); homeDraft.start = $("#hstart")?.value || "all";
      api("/api/layout", { method: "PUT", body: JSON.stringify({ home: homeDraft }) })
        .then(l => { layout = l; applyNavPrefs(); snack("Home page saved"); }).catch(e => snack(e.message));
      return true;
    }
    return false;
  }

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
        <section class="set-card" id="appearance">
          <div class="frow"><span>Theme</span>${seg("mode-seg", [["light", "Light", "light_mode"], ["dark", "Dark", "dark_mode"], ["auto", "Auto", "brightness_auto"]], pref, "mode")}</div>
          <div class="frow"><span>Color</span><div class="swatches" id="swatches">${Object.entries(SEEDS).map(([n, c]) =>
            `<button type="button" class="swatch ${root.dataset.seed === n ? "on" : ""}" data-seed="${n}" style="background:${c}" title="${n}">${root.dataset.seed === n ? icon("check_circle", true) : ""}</button>`).join("")}</div></div>
          <div class="frow"><span>Temperature</span>${seg("unit-seg", [["F", "°F"], ["C", "°C"]], unit, "unit")}</div>
          <div class="frow"><span>Card style</span>${seg("style-seg", [["standard", "Standard", "dashboard"], ["minimal", "Minimal", "view_agenda"]], cardStyle, "cstyle")}</div>
          <div class="frow chartrow"><span>Charts</span><div class="chart-picks" id="chart-seg">${CHART_STYLES.map(([k, l]) => `<button type="button" class="chart-pick ${chartStyle === k ? "on" : ""}" data-chart="${k}" aria-pressed="${chartStyle === k}">
            <svg viewBox="0 0 72 28" class="spark c-${k}" preserveAspectRatio="none">${plotSvg([[[0, 20], [9, 14], [18, 17], [27, 8], [36, 11], [45, 5], [54, 13], [63, 9], [72, 12]]], 28, k, 5)}</svg><small>${l}</small></button>`).join("")}</div></div>
          <div class="frow"><span>Layout</span>${seg("layout-seg", [["cards", "Cards", "grid_view"], ["table", "Table", "table_rows"]], mode, "layout")}</div>
          <div class="frow"><span>Group by<small class="muted">for pages you haven't set yet</small></span>${seg("groupby-seg", [["room", "Room", "door_front"], ["type", "Type", "category"]], load("groupByDefault", "room"), "gbdefault")}</div>
        </section>`;
    } else if (settingsSub === "diagnostics") {
      $("#rooms").innerHTML = `<div class="settings-wrap detail">${back}
        <div class="dhead"><span class="avatar big">${icon("bug_report")}</span><div><h2>Diagnostics</h2><small class="lstat info"><i></i><span>Anonymous tech dump</span></small></div></div>
        <section class="set-card diag-card">
          <p>A file to send when something doesn't work right. It has every device's type, make and model, integration,
            what it reports (readings, states, units, ranges, which ones you can control, how long ago each was updated),
            online and battery state, each integration's status, which settings are filled in, the history storage and
            recent warnings.</p>
          <p class="muted small">Anonymous: device and room names become "Thermostat 1", "Room A"…; ids are scrambled; IP and MAC
            addresses, e-mail addresses, host names, tokens and passwords are removed; settings values are never included.
            Open the file to check before you share it.</p>
          <div id="diag-sum" class="muted small"></div>
          <div class="set-actions"><button type="button" class="tonal-btn" data-diag-copy>${icon("content_copy")}Copy summary</button>
            <span style="flex:1"></span><button type="button" class="filled-btn" data-diag-dl>${icon("download")}Download</button></div>
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
    $("#rooms").innerHTML = `<div class="settings-wrap detail">${back}${body}</div>`;
  }

  function collectSection(el) {
    const values = {};
    $$("[data-key]", el).forEach(i => {
      if (i.classList.contains("hostlist")) {
        values[i.dataset.key] = $$("[data-hkey]", i).map(x => x.value.trim()).filter(Boolean);
      } else if (i.classList.contains("servers")) {
        values[i.dataset.key] = $$(".server-row", i).map(r => Object.fromEntries($$("[data-skey]", r).map(x => [x.dataset.skey, x.value.trim()])));
      } else values[i.dataset.key] = i.type === "checkbox" ? i.checked : i.value;
    });
    return { enabled: $("[data-enable]", el).classList.contains("on"), values };
  }

  // ---------- custom views ----------
  function openViewEditor(existing) {
    const dlg = $("#viewdlg"), f = $("#view-form");
    const v = existing ? JSON.parse(JSON.stringify(existing)) : { id: Math.random().toString(36).slice(2, 9), name: "", icon: "dashboard", rooms: [], types: [], sources: [], devices: [] };
    $("#view-title").textContent = existing ? "Edit view" : "New view";
    $("#view-delete").hidden = !existing;
    f.name.value = v.name;
    const all = [...devices.values()].filter(d => !d.hidden);
    const rooms = [...new Set(all.map(d => d.room || "Other"))].sort();
    const sources = [...new Set(all.map(d => d.source))].sort();
    const chips = (key, items, label = x => x) => items.map(x => `<button type="button" class="fchip ${v[key].includes(x) ? "on" : ""}" data-pick="${key}" data-v="${esc(x)}">${v[key].includes(x) ? icon("check") : ""}${esc(label(x))}</button>`).join("");
    const draw = () => {
      $("#icon-pick").innerHTML = VIEW_ICONS.map(i => `<button type="button" class="${v.icon === i ? "on" : ""}" data-icon-pick="${i}" aria-label="${i}">${icon(i, v.icon === i)}</button>`).join("");
      $("#pick-rooms").innerHTML = chips("rooms", rooms);
      $("#pick-types").innerHTML = chips("types", Object.keys(VIEW_TYPES), t => VIEW_TYPES[t]);
      $("#pick-sources").innerHTML = chips("sources", sources, x => SRC[x] || x);
      $("#pick-devices").innerHTML = all.sort((a, b) => (a.room || "").localeCompare(b.room || "") || a.name.localeCompare(b.name)).map(d =>
        `<label><input type="checkbox" data-pick-dev="${esc(d.id)}" ${v.devices.includes(d.id) ? "checked" : ""}><span>${esc(d.name)}</span><small>${esc(d.room || "Other")} · ${esc(srcLabel(d))}</small></label>`).join("");
      const n = all.filter(d => viewMatch(v, d)).length;
      $("#view-count").innerHTML = `${icon("info")}<span>${n} device${n === 1 ? "" : "s"} match${n === 1 ? "es" : ""} right now</span>`;
    };
    f.onclick = e => {
      const c = e.target.closest("[data-pick]"); if (c) { const k = c.dataset.pick, x = c.dataset.v;
        v[k] = v[k].includes(x) ? v[k].filter(y => y !== x) : [...v[k], x]; draw(); return; }
      const ip = e.target.closest("[data-icon-pick]"); if (ip) { v.icon = ip.dataset.iconPick; draw(); }
    };
    f.onchange = e => { const cb = e.target.closest("[data-pick-dev]"); if (!cb) return;
      v.devices = cb.checked ? [...v.devices, cb.dataset.pickDev] : v.devices.filter(x => x !== cb.dataset.pickDev); draw(); };
    $("#view-delete").onclick = async () => {
      dlg.close("cancel");
      if (!(await confirmAction(`Delete "${existing.name}"?`, "Only the view is removed. Devices and their rooms stay as they are.", "delete"))) return;
      layout.views = layout.views.filter(x => x.id !== existing.id); await saveLayout(); go("all"); snack("View deleted");
    };
    dlg.onclose = async () => {
      if (dlg.returnValue !== "save") return;
      v.name = f.name.value.trim() || "View";
      layout.views = existing ? layout.views.map(x => x.id === v.id ? v : x) : [...(layout.views || []), v];
      await saveLayout(); renderViewNav.key = null; go("v:" + v.id); snack(existing ? "View updated" : `"${v.name}" added to the menu`);
    };
    // an empty name gets an inline M3 error, not the browser's bubble
    const err = $("#view-name-err"), nameBox = f.name.closest(".textfield");
    const setErr = on => { err.hidden = !on; nameBox.classList.toggle("error", on); on ? f.name.setAttribute("aria-invalid", "true") : f.name.removeAttribute("aria-invalid"); };
    f.noValidate = true; setErr(false);
    f.name.oninput = () => f.name.value.trim() && setErr(false);
    f.onsubmit = e => { if (e.submitter?.value === "save" && !f.name.value.trim()) { e.preventDefault(); setErr(true); f.name.focus(); } };
    draw(); dlg.returnValue = ""; dlg.showModal(); setTimeout(() => f.name.focus(), 50);
  }

  // ---------- arranging (edit mode) ----------
  function destroySortables() { sortables.forEach(x => { try { x.destroy(); } catch {} }); sortables = []; }
  function renderEditBar() {
    let bar = $("#editbar");
    if (!editing() || PAGES.has(view) && view !== "lights" || mode === "table") { bar?.remove(); return; }
    const byType = gbNow === "type", key = `${view}|${gbNow}`;
    if (bar && bar.dataset.key === key) return;
    bar?.remove();
    const text = byType
      ? `<span class="short"><b>Arranging.</b> Switch to Group by room to move cards between rooms.</span><span class="long"><b>Arranging.</b> Cards are grouped by type. Switch to Group by room to move cards between rooms or reorder them. Use ✎ on a card to rename, move or hide it${view === "all" ? ", or pin it to Favorites" : ""}.</span>
        <button class="text-btn" data-groupby="room">${icon("door_front")}Group by room</button>`
      : `<span class="short"><b>Arranging.</b> Drag cards and room titles. Drop on ★ Favorites to pin.</span><span class="long"><b>Arranging.</b> Drag cards to reorder or move them between rooms. Drag a room by its title to reorder rooms${view === "all" ? ". Drag cards into Favorites to pin them to the top" : ""}. Use ✎ on a card to rename or hide it.</span>
        <button class="text-btn" data-reset-layout>Reset</button>`;
    $("#rooms").insertAdjacentHTML("beforebegin", `<div id="editbar" class="editbar ${byType ? "bytype" : ""}" data-key="${esc(key)}">${icon(byType ? "category" : "edit")}${text}<button class="filled-btn" data-done-edit>${icon("check")}Done</button></div>`);
  }
  function initSortables() {
    if (!editing() || !window.Sortable || mode === "table") return;
    const common = { animation: 160, delay: 120, delayOnTouchOnly: true, forceFallback: true, fallbackTolerance: 4, ghostClass: "drag-ghost", chosenClass: "drag-chosen",
      filter: ".m3-switch, .segmented, .tonal-btn, .quick, input, .card-edit, .colors", preventOnFilter: false,
      onStart: () => { dragging = true; }, };
    $$("#rooms .grid").forEach(g => {
      if (g.closest("[data-fixed]")) return;
      sortables.push(Sortable.create(g, { ...common, group: "cards", draggable: ".card", onEnd: onCardDrop }));
    });
    sortables.push(Sortable.create($("#rooms"), { ...common, draggable: ".room:not(.fav):not([data-fixed])", handle: "h2", onEnd: onRoomDrop }));
  }
  async function saveLayout() {
    try { layout = await api("/api/layout", { method: "PUT", body: JSON.stringify(layout) }); }
    catch (e) { snack(`Couldn't save layout: ${e.message}`); }
  }
  async function onCardDrop(e) {
    dragging = false;
    const id = e.item.dataset.id, from = e.from.dataset.room, to = e.to.dataset.room;
    // capture the visible order of every room grid
    $$("#rooms .grid[data-room]").forEach(g => {
      const ids = $$(":scope > .card", g).map(c => c.dataset.id);
      if (g.dataset.room === FAV) layout.pinned = ids;
      else {
        // keep positions of devices hidden by the current filter
        const prev = (layout.order[g.dataset.room] || []).filter(x => !ids.includes(x) && devices.get(x)?.room === g.dataset.room);
        layout.order[g.dataset.room] = [...ids, ...prev];
      }
    });
    if (from !== to) {
      if (from === FAV) layout.pinned = layout.pinned.filter(x => x !== id);
      if (to !== FAV) {
        const d = devices.get(id), newRoom = to === "Other" ? "" : to;
        if (d && (d.room || "") !== newRoom) {
          try { await api(`/api/devices/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ room: newRoom }) });
            snack(`${d.name} moved to ${to}`); } catch (err) { snack(err.message); }
        }
      } else snack(`${devices.get(id)?.name} pinned to Favorites`);
    }
    await saveLayout(); schedule();
  }
  async function onRoomDrop() {
    dragging = false;
    const shownRooms = $$("#rooms > .room:not(.fav):not([data-fixed])").map(s => s.dataset.room);
    const rest = layout.rooms.filter(r => !shownRooms.includes(r));
    layout.rooms = [...shownRooms, ...rest];
    await saveLayout(); schedule();
  }

  // ---------- main render ----------
  function render() {
    destroySortables();
    renderViewNav();
    if (view.startsWith("v:") && !customView() && layout.views) { view = "all"; store("filter", view); }
    gbNow = groupBy(); document.body.dataset.groupBy = gbNow;
    renderHeader();
    renderEditBar();
    renderBadges();
    const list = visible();
    $("#viewmode").style.display = PAGES.has(view) ? "none" : "";
    document.body.dataset.view = view;
    // leaving a plugin page (Automations…): clear its flag first, so coming back re-renders it
    if (!pluginPages[view] && $("#rooms").dataset.plugin) { delete $("#rooms").dataset.plugin; $("#rooms")._html = null; }
    if (view === "settings") { if (!$(".settings-wrap")) renderSettings(); return; }
    if (view === "devices") { if (!$(".devlist")) devicesPage(); else renderDeviceList(); return; }
    if (pluginPages[view]) {
      const pg = pluginPages[view], el = $("#rooms");
      if (el.dataset.plugin !== view) { $("#summary").innerHTML = ""; $("#alerts").innerHTML = ""; el.dataset.plugin = view; el._html = null; nativeHTML.set.call(el, ""); pg.render(el); }
      else pg.onDevices?.(el);
      return;
    }
    if (view === "battery") return batteryPage(list);
    if (view === "air") return airPage(list);
    if (view === "power") return powerPage(list);
    if (view === "lights") return lightsPage(list);
    $("#summary").innerHTML = view === "all" && list.length ? homeTiles(list) : view === "doors" ? doorTiles(list) : "";
    renderChips(list);
    const shown = list.filter(matches);
    if (view === "doors") shown.sort((a, b) => (val(b, "contact") === "open") - (val(a, "contact") === "open"));
    if (!shown.length) { $("#rooms").innerHTML = customView() ? `<div class="empty-state">${icon(customView().icon)}<h3>Nothing matches this view yet</h3><p>Pick rooms, types, brands or devices for it.</p><button class="tonal-btn" data-edit-view>${icon("tune")}Edit view</button></div>`
      : `<p class="empty">${list.length ? "Nothing in this view yet." : "No devices yet. Add your accounts in Settings."}</p>`; return; }
    if (mode === "table") { $("#rooms").innerHTML = tableView(shown); return; }
    const fallback = (a, b) => isAlarm(b) - isAlarm(a) || (view === "doors" ? (val(b, "contact") === "open") - (val(a, "contact") === "open") : 0) || a.name.localeCompare(b.name);
    const hc = view === "all" ? homeCfg() : null;
    $("#rooms").innerHTML = hc && !hc.rooms && !editing()
      ? (hc.favorites ? roomSections(shown.filter(d => layout.pinned.includes(d.id)), { favorites: true, fallback }) : "")
      : roomSections(shown, { favorites: view === "all" && (!hc || hc.favorites || editing()), fallback });
    initSortables();
    $("#roomlist").innerHTML = [...new Set(list.map(d => d.room).filter(Boolean))].map(r => `<option value="${esc(r)}">`).join("");
  }
  function renderViewNav() {
    const views = layout.views || [];
    const key = JSON.stringify(views.map(v => [v.id, v.name, v.icon]));
    if (renderViewNav.key === key) return; renderViewNav.key = key;
    $("#custom-views").innerHTML = views.map(v => `<button data-f="v:${esc(v.id)}"><span class="ind">${icon(v.icon)}</span><span class="lbl">${esc(v.name)}</span></button>`).join("");
    $("#more-views").innerHTML = views.map(v => `<button value="v" data-f="v:${esc(v.id)}">${icon(v.icon)}${esc(v.name)}</button>`).join("");
  }
  function renderBadges() {
    const list = visible();
    const low = list.filter(batteryLow).length, open = list.filter(d => val(d, "contact") === "open" && !has(d, "lock")).length;
    const pw = list.filter(d => isUps(d) && val(d, "ups_status") !== "online").length;
    const badAir = list.filter(d => (kindOf(d) === "aqi_station" && val(d, "aqi") > 100) || (val(d, "air_score") != null && val(d, "air_score") < 60)).length;
    $("#badge-air").textContent = badAir || "";
    $("#badge-lights").textContent = list.filter(d => isLight(d) && !isGroup(d) && val(d, "light")).length || "";
    $("#badge-battery").textContent = low || ""; $("#badge-doors").textContent = open || ""; $("#badge-power").textContent = pw || "";
    $("#badge-more").textContent = (pw + low + badAir) || "";
    // the same counts in the phone's More sheet, and in every button's accessible name
    const lit = Number($("#badge-lights").textContent) || 0;
    const counts = { air: [badAir, "with poor air"], lights: [lit, "on"], battery: [low, "low"], doors: [open, "open"], power: [pw, "UPS not on mains"] };
    for (const [f, [c, what]] of Object.entries(counts)) {
      $$(`#nav [data-f="${f}"], #more [data-f="${f}"]`).forEach(b => {
        const name = (b.querySelector(".lbl")?.textContent || b.textContent).trim();
        b.dataset.badge = c || ""; c ? b.setAttribute("aria-label", `${name}, ${c} ${what}`) : b.removeAttribute("aria-label");
      });
    }
    const mb = $(".more-btn"); if (mb) { const m = (pw + low + badAir); m ? mb.setAttribute("aria-label", `More, ${m} need attention`) : mb.setAttribute("aria-label", "More"); }
  }
  let pending = false, sliding = false;
  const schedule = () => { if (!pending) { pending = true; requestAnimationFrame(() => { pending = false; if (sliding || dragging) return setTimeout(schedule, 300); render(); }); } };
  const scheduleQuiet = () => { document.body.classList.add("quiet"); schedule(); };

  function renderHeader() {
    const now = new Date(), h = now.getHours();
    const cv = customView();
    $("#editview").hidden = !cv;
    const hcfg = homeCfg();
    $("#greeting").textContent = cv ? cv.name : TITLES[view] || (hcfg.greeting === false ? (hcfg.title || appTitle) : (h < 5 ? "Good night" : h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening"));
    $("#subtitle").textContent = (view === "all" && hcfg.greeting !== false ? `${hcfg.title || appTitle} · ` : "") + now.toLocaleDateString([], { weekday: innerWidth < 840 ? "short" : "long", month: innerWidth < 840 ? "short" : "long", day: "numeric", ...timeOpts() }) +
      (innerWidth < 380 ? "" : " · " + now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", ...timeOpts() }));
    const cur = (b, on) => { b.classList.toggle("on", on); on ? b.setAttribute("aria-current", "page") : b.removeAttribute("aria-current");
      if (!b.title) b.title = b.querySelector(".lbl")?.textContent || ""; };
    $$("#nav [data-f]").forEach(b => cur(b, b.dataset.f === view));
    $(".more-btn").classList.toggle("on", !$(`#nav [data-f="${CSS.escape(view)}"][data-phone]`));
    $$("#more [data-f]").forEach(b => cur(b, b.dataset.f === view));
    const gb = $("#groupby"), gbOn = groupable(); gb.hidden = !gbOn;
    if (gbOn && gb.dataset.key !== gbNow) { gb.dataset.key = gbNow;
      gb.querySelector(".segmented").innerHTML = [["room", "Room", "door_front"], ["type", "Type", "category"]].map(([v, l, ic]) =>
        `<button type="button" data-groupby="${v}" class="${gbNow === v ? "on" : ""}" aria-pressed="${gbNow === v}" title="Group by ${l.toLowerCase()}">${icon(ic, gbNow === v)}<span class="gl">${l}</span></button>`).join(""); }
    const vm = $("#viewmode"); vm.innerHTML = icon(mode === "table" ? "grid_view" : "table_rows");
    vm.title = vm.ariaLabel = mode === "table" ? "Card view" : "Table view";
  }
  document.addEventListener("change", e => {
    const p = e.target.closest?.("[data-hpage]"); if (!p || !homeDraft) return;
    const hid = new Set(homeDraft.hidden_pages || []); p.checked ? hid.delete(p.dataset.hpage) : hid.add(p.dataset.hpage);
    homeDraft.hidden_pages = [...hid]; homeDraft.title = ($("#htitle")?.value || "").trim(); renderSettings();
  });
  function go(v) {
    view = v; store("filter", v); document.body.classList.remove("quiet");
    if (v === "settings") { settingsSub = null; homeDraft = null; $("#rooms").innerHTML = ""; loadSettings(); }
    if (v === "power") loadPower();
    schedule(); window.scrollTo({ top: 0, behavior: "smooth" });
  }

  // ---------- data ----------
  async function loadSparks() {
    await Promise.all(visible().map(async d => {
      const sc = sparkCap(d); if (!sc) return;
      try { sparks.set(d.id + "|" + sc, await api(`/api/devices/${encodeURIComponent(d.id)}/history/${sc}`)); } catch {}
    }));
    if (!PAGES.has(view)) scheduleQuiet();
  }
  async function loadStatus() {
    try {
      if (!isAdmin()) return;
      const h = await api("/api/health");
      $("#status").innerHTML = Object.entries(h.adapters).map(([n, s]) => `<span><b>${esc(SRC[n] || n)}</b> ${esc(s)}</span>`).join("") + `<span>${h.devices} devices</span>`;
    } catch {}
  }
  function connect() {
    const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
    ws.onopen = () => {
      if (token) ws.send(JSON.stringify({ type: "auth", token }));   // the password never goes in the URL
      $("#conn").classList.add("on"); $("#conn").ariaLabel = "Live"; connect.delay = 2000; };
    ws.onclose = e => {
      $("#conn").classList.remove("on"); $("#conn").ariaLabel = "Disconnected, reconnecting";
      if (e.code === 4401) return fetch("/api/me", { headers: authHdr() }).then(r => r.status === 401 ? signInBanner() : setTimeout(connect, 2000), () => setTimeout(connect, 5000));   // 4401 with a token that still works (password just changed here): reconnect
      if (e.code === 4429) { connect.delay = 30000; snack("Too many wrong passwords from this device. Waiting before trying again."); }
      if (e.code === 4403) return snack("This page was opened from another site, so live updates are blocked.");
      connect.delay = Math.min(30000, (connect.delay || 2000) * 1.6);       // back off: 2 s … 30 s
      setTimeout(connect, connect.delay);
    };
    ws.onmessage = e => {
      let m; try { m = JSON.parse(e.data); } catch { return; }            // never let one bad message blank the page
      msgHooks.forEach(fn => { try { fn(m); } catch {} });
      if (m.type === "layout") { layout = m.layout; applyNavPrefs(); if (!dragging) schedule(); return; }
      if (m.type === "snapshot") { if (m.layout) { layout = m.layout; applyNavPrefs(true); } devices.clear(); m.devices.forEach(d => devices.set(d.id, d)); schedule(); loadSparks(); if (view === "power") loadPower(); }
      else if (m.type === "device") { devices.set(m.device.id, m.device); scheduleQuiet(); liveIngest(m.device); if (panelId === m.device.id && $("#devpanel").open && !sliding && panelTab === "now") renderDevicePanel(); }
      else if (m.type === "remove") { devices.delete(m.id); scheduleQuiet(); }
    };
  }

  // ---------- feedback ----------
  let snackTimer;
  function snack(text) {
    const s = $("#snackbar"); s.textContent = text; s.style.overflowWrap = "anywhere"; s.classList.add("show");
    clearTimeout(snackTimer); snackTimer = setTimeout(() => s.classList.remove("show"), Math.max(3600, String(text).length * 60));   // long messages stay readable
  }
  // the confirm button says what happens ("Unlock", "Delete"…); destructive ones are in the error colour
  const CONFIRM_VERB = /^(Turn off|Turn on|Hand over|Take over|Sound siren|Make|Delete|Reset|Unlock|Lock|Open|Close|Disarm|Arm|Test|Mute|Remove|Sign out)\b/;
  function confirmAction(title, text, ic, verb) {
    const dlg = $("#confirm");
    $("#confirm-title").textContent = title; $("#confirm-text").textContent = text;
    verb ||= CONFIRM_VERB.exec(title)?.[1] || "Confirm";
    const yes = $("#confirm-yes"); yes.textContent = verb;
    yes.classList.toggle("danger", /^(Delete|Reset|Unlock|Disarm|Remove|Sound siren)/.test(verb));
    $("#confirm-icon").innerHTML = icon(ic); dlg.returnValue = "";
    dlg.showModal();
    return new Promise(res => dlg.onclose = () => res(dlg.returnValue === "yes"));
  }

  // ---------- sign-in flows (Ring, Aqara) ----------
  function genericSignin(sec) {
    const dlg = $("#login"), fields = $("#login-fields"), help = $("#login-help");
    let step = 1; const creds = {};
    const tf = f => `<label class="textfield"><input name="${f.key}" type="${f.type === "password" ? "password" : "text"}" placeholder=" " ${f.optional ? "" : "required"} autocomplete="off"><span>${esc(f.label)}</span></label>`;
    // step 3: nothing to type, the user confirms something elsewhere (e.g. enters a PIN on the vendor's site)
    const pinBox = p => `<div class="pin-box" style="font:600 32px/1.2 ui-monospace,monospace;letter-spacing:.3em;text-align:center;padding:16px;border-radius:var(--shape-md,12px);background:var(--md-surface-container-high,rgba(127,127,127,.12));user-select:all" aria-label="PIN ${esc(p)}">${esc(p)}</div>`;
    const show = (msg, pin) => { $("#login-title").textContent = `Sign in to ${sec.label}`;
      help.textContent = msg || (step === 1 ? sec.login_help || "" : "Enter the code that was just sent to you.");
      fields.innerHTML = step === 1 ? sec.login_fields.map(tf).join("") : step === 3 ? pinBox(pin || "") : tf({ key: "code", label: "Verification code" });
      $("#login-go").textContent = step === 3 ? "Finish sign-in" : "Continue"; setTimeout(() => $("input", fields)?.focus(), 50); };
    $("#login-form").onsubmit = async e => {
      if (e.submitter?.value !== "go") return; e.preventDefault();
      Object.assign(creds, Object.fromEntries(new FormData($("#login-form"))));
      $("#login-go").disabled = true; $("#login-go").textContent = "Working…";
      try { const res = await api(`/api/settings/${sec.id}/signin`, { method: "POST", body: JSON.stringify(creds) });
        if (res.need_confirm) { step = 3; creds.confirm = "1"; show(res.message, res.pin); }
        else if (res.need_code) { step = 2; show(res.message); } else { dlg.close(); snack(`Signed in to ${sec.label}`); loadSettings(); } }
      catch (err) { help.textContent = err.message; $("#login-go").textContent = step === 3 ? "Finish sign-in" : "Try again"; }
      finally { $("#login-go").disabled = false; }
    };
    show(); dlg.showModal();
  }
  function loginFlow(kind) {
    const gsec = settingsData?.sections?.find(x => x.id === kind && x.login_fields);
    if (gsec) return genericSignin(gsec);
    const dlg = $("#login"), fields = $("#login-fields"), help = $("#login-help");
    let step = 1, creds = {};
    const tf = (n, l, t = "text") => `<label class="textfield"><input name="${n}" type="${t}" placeholder=" " required autocomplete="${t === "password" ? "current-password" : "off"}"><span>${l}</span></label>`;
    const NAMES = { ring: "Ring", aqara: "Aqara", hue: "Philips Hue" };
    const show = async () => {
      $("#login-title").textContent = kind === "hue" ? "Pair Hue Bridge" : `Sign in to ${NAMES[kind]}`;
      if (kind === "hue") {
        $("#login-go").textContent = "Continue";
        if (step === 1) {
          help.textContent = "Looking for Hue bridges on your network…";
          fields.innerHTML = tf("host", "Bridge IP address");
          const current = settingsData?.sections?.find(x => x.id === "hue")?.values?.host;
          if (current) $("input[name=host]", fields).value = current;
          try { const r = await api("/api/settings/hue/discover");
            const found = (r.bridges || []).map(b => b.host);
            if (found.length && !$("input[name=host]", fields).value) $("input[name=host]", fields).value = found[0];
            help.textContent = found.length ? `Found ${found.length} bridge${found.length > 1 ? "s" : ""}: ${found.join(", ")}` :
              "No bridge found automatically. Enter its IP address (Hue app → Settings → Bridges → ⓘ).";
          } catch { help.textContent = "Enter your Hue Bridge's IP address (Hue app → Settings → Bridges → ⓘ)."; }
        } else {
          help.textContent = "Press the round link button on top of the Hue Bridge, then tap Continue within 30 seconds.";
          fields.innerHTML = "";
        }
        return;
      }
      if (step === 1) {
        help.textContent = kind === "ring" ? "Your password is only used once to get a token; it isn't stored." : "Aqara will send a verification code to this account.";
        fields.innerHTML = kind === "ring" ? tf("email", "Email") + tf("password", "Password", "password") : tf("account", "Aqara account (email or phone)");
      } else {
        help.textContent = kind === "ring" ? "Enter the verification code Ring just sent you." : "Enter the code Aqara sent you.";
        fields.innerHTML = tf("code", "Verification code");
      }
      $("#login-go").textContent = "Continue";
      setTimeout(() => $("input", fields)?.focus(), 50);
    };
    $("#login-form").onsubmit = async e => {
      if (e.submitter?.value !== "go") return;
      e.preventDefault();
      const data = Object.fromEntries(new FormData($("#login-form")));
      Object.assign(creds, data);
      $("#login-go").disabled = true; $("#login-go").textContent = "Working…";
      try {
        let res;
        if (kind === "hue") res = await api("/api/settings/hue/pair", { method: "POST", body: JSON.stringify({ host: creds.host }) });
        else {
          const body = kind === "ring" ? { email: creds.email, password: creds.password, code: creds.code } : { account: creds.account, code: creds.code };
          res = await api(`/api/settings/${kind}/login`, { method: "POST", body: JSON.stringify(body) });
        }
        if (res.need_code || res.need_button) { step = 2; await show(); }
        else { dlg.close(); snack(kind === "hue" ? "Hue Bridge paired" : `Signed in to ${NAMES[kind]}`); loadSettings(); }
      } catch (err) { help.textContent = err.message; $("#login-go").textContent = "Try again"; }
      finally { $("#login-go").disabled = false; }
    };
    show(); dlg.showModal();
  }

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
      const joined = i && p.t - pts[i - 1].t <= gap, next = i + 1 < pts.length && pts[i + 1].t - p.t <= gap;
      const xy = [X(p.t), Y(conv(p.v))];
      if (joined) segs[segs.length - 1].push(xy); else segs.push([xy]);
      if (!joined && !next && chartStyle !== "bars") dots += `<circle class="lone" cx="${f1x(xy[0])}" cy="${f1x(xy[1])}" r="2.5"/>`;
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

  // ---------- interactions ----------
  const VERB = { lock: "Lock", unlock: "Unlock", open: "Open", close: "Close", test: "Test", mute: "Mute", siren: "Sound siren on",
    disarm: "Disarm", arm_home: "Arm (home)", arm_away: "Arm (away)" };
  document.addEventListener("click", async e => {
    const t = e.target;
    const b = t.closest("[data-cmd]");
    if (b) {
      if (!canControl()) return snack("Viewing only: sign in to control devices");
      const id = b.closest("[data-id]").dataset.id, d = devices.get(id);
      const capName = b.dataset.cmd, value = JSON.parse(b.dataset.val);
      if (b.closest(".segmented") && b.classList.contains("on")) return;   // already in that state
      const quiet = capName === "action" && !["test", "siren", "mute"].includes(value);
      if (!quiet && ["lock", "valve", "action", "alarm_panel"].includes(capName)) {
        const ic = { lock: value === "lock" ? "lock" : "lock_open", valve: "valve", action: value === "siren" ? "campaign" : "detector_smoke", alarm_panel: "shield" }[capName];
        const msg = capName === "action" ? (value === "siren" ? "The siren will sound for 30 seconds." : "The alarm will sound briefly.") : "This controls a physical device in your home.";
        if (!(await confirmAction(`${VERB[value] || value} ${d.name}?`, msg, ic, VERB[value] === "Sound siren on" ? "Sound siren" : VERB[value]))) return;
      }
      if (b.dataset.busy) return;
      b.dataset.busy = "1"; b.setAttribute("aria-disabled", "true");   // not .disabled: that drops keyboard focus
      try {
        await api(`/api/devices/${encodeURIComponent(id)}/command`, { method: "POST", body: JSON.stringify({ capability: capName, value }) });
        snack(["switch", "light"].includes(capName) ? `${d.name} turned ${value ? "on" : "off"}` : `${VERB[value] || value} sent to ${d.name}`);
      } catch (err) { snack(`Couldn't reach ${d.name}: ${err.message}`); resetView(); }
      finally { delete b.dataset.busy; b.removeAttribute("aria-disabled"); }
      return;
    }
    if (t.closest("[data-snapshot]")) return showSnapshot(t.closest("[data-id]").dataset.id);
    if (t.closest("[data-diag-dl]") || t.closest("[data-diag-copy]")) {
      const copy = !!t.closest("[data-diag-copy]"), b = t.closest("button"); b.dataset.busy = "1";
      try {
        const r = await fetch("/api/diagnostics", { headers: authHdr() });
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || r.statusText);
        const data = await r.json(), text = JSON.stringify(data, null, 2);
        const s = data.summary || {}, sumText = `Haven ${data.haven?.edition === "og" ? "OG" : "for Home Assistant"}${data.haven?.version ? " " + data.haven.version : ""} · ${s.devices} devices (${s.offline} offline) · ` +
          Object.entries(s.by_integration || {}).map(([k, v]) => `${k} ${v}`).join(", ");
        const el = $("#diag-sum"); if (el) el.textContent = sumText;
        if (copy) {
          const lines = [sumText, "Integrations: " + Object.entries(data.integrations || {}).map(([k, v]) => `${k}: ${v}`).join("; "),
            ...((data.recent_warnings || []).slice(-10).map(w => `${w.level} ${w.logger}: ${w.message}`))];
          await navigator.clipboard.writeText(lines.join("\n")); snack("Summary copied");
        } else {
          const a = document.createElement("a"), url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
          a.href = url; a.download = `haven-diagnostics-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "")}.json`;
          document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 5000);
          snack("Diagnostics downloaded");
        }
      } catch (err) { snack(`Couldn't create diagnostics: ${err.message}`); }
      finally { delete b.dataset.busy; }
      return;
    }
    const at = t.closest("[data-alerts-toggle]"); if (at) { alertsOpen = alertsOpen === at.dataset.alertsToggle ? null : at.dataset.alertsToggle; return schedule(); }
    if (t.closest("[data-open-device]") || (t.closest(".card .name") && !editing())) return openDevicePanel(t.closest("[data-id]").dataset.id);
    const hb = t.closest("[data-hist]"); if (hb) { const owner = hb.closest("[data-id]"); if (owner?.dataset.id && devices.has(owner.dataset.id)) return openDevicePanel(owner.dataset.id, "history", hb.dataset.hist); return; }
    const pt = t.closest("[data-ptab]");
    if (pt) { panelTab = pt.dataset.ptab; dh.focus = null; if (panelTab === "history" && (!dh.data || dh.id !== panelId)) loadDevHistory(panelId, dh.range);
      if (panelTab === "now") loadLive(panelId); else stopLive(); renderDevicePanel(); return; }
    const dr = t.closest("[data-dhrange]");
    if (dr) { pickDevRange(dr.dataset.dhrange); return; }
    if (t.closest("[data-dhcustom]")) { applyCustomRange(); return; }
    const pr = t.closest("[data-prange]"); if (pr) { powerRange = pr.dataset.prange; store("powerRange", powerRange); return loadPower(); }
    if (t.closest("[data-edit]") && isAdmin()) {
      const id = t.closest("[data-id]").dataset.id, d = devices.get(id), dlg = $("#edit"), f = dlg.querySelector("form");
      f.name.value = d.name; f.room.value = d.room || ""; f.hidden.checked = d.hidden; f.pinned.checked = layout.pinned.includes(id); dlg.returnValue = "";
      dlg.showModal();
      dlg.onclose = async () => { if (dlg.returnValue !== "save") return;
        try { await api(`/api/devices/${encodeURIComponent(id)}`, { method: "PATCH",
          body: JSON.stringify({ name: f.name.value, room: f.room.value, hidden: f.hidden.checked }) });
          const pin = f.pinned.checked, was = layout.pinned.includes(id);
          if (pin !== was) { layout.pinned = pin ? [...layout.pinned, id] : layout.pinned.filter(x => x !== id); await saveLayout(); schedule(); }
          snack("Saved"); }
        catch (err) { snack(err.message); } };
      return;
    }
    const th = t.closest("th[data-sort]");
    if (th) { const k = th.dataset.sort; sort = { key: k, dir: sort.key === k ? -sort.dir : 1 }; store("sort", JSON.stringify(sort)); scheduleQuiet(); return; }
    const tabBtn = t.closest(".devrow [data-tab]");
    if (tabBtn && isAdmin()) { const id = tabBtn.closest("[data-id]").dataset.id, d = devices.get(id), tab = tabBtn.dataset.tab;
      const cur = tabsOf(d), next = cur.includes(tab) ? cur.filter(x => x !== tab) : [...cur, tab];
      const label = TABS.find(x => x[0] === tab)[1];
      return patchDevice(id, { categories: TAB_IDS.filter(x => next.includes(x)) }, `${d.name} ${cur.includes(tab) ? "removed from" : "added to"} ${label}`); }
    if (t.closest("[data-reset-tabs]") && isAdmin()) { const id = t.closest("[data-id]").dataset.id;
      return patchDevice(id, { auto_categories: true }, `${devices.get(id).name} back to automatic tabs`); }
    if (t.closest(".devrow [data-visible]") && isAdmin()) { const id = t.closest("[data-id]").dataset.id, d = devices.get(id);
      return patchDevice(id, { hidden: !d.hidden }, `${d.name} ${d.hidden ? "shown" : "hidden"}`); }
    if (t.closest("[data-clear-devfilters]")) { devQuery = ""; devFilter = "all"; devSel = { source: "", type: "", room: "" }; devicesPage(); $("#devsearch")?.focus(); return; }
    const df = t.closest("[data-devfilter]"); if (df) { devFilter = devFilter === df.dataset.devfilter ? "all" : df.dataset.devfilter; devicesPage(); return; }
    if (t.closest("#devsortdir")) { devSort.dir = -devSort.dir; store("devSort", JSON.stringify(devSort)); devicesPage(); return; }
    const os = t.closest("[data-open-setting]"); if (os) { settingsSub = os.dataset.openSetting; homeDraft = null; renderSettings(); window.scrollTo({ top: 0 }); return; }
    if (view === "settings" && settingsSub === "home" && homeSettingsClick(t)) return;
    const sa = t.closest("[data-sec-action]");
    if (sa && view === "settings" && settingsSub) {
      sa.disabled = true;
      try { const r = await api(`/api/settings/${encodeURIComponent(settingsSub)}/action/${encodeURIComponent(sa.dataset.secAction)}`, { method: "POST" });
        snack(r.message || "Done"); setTimeout(loadSettings, 4000); }
      catch (err) { snack(err.message); } finally { sa.disabled = false; }
      return;
    }
    const ea = t.closest("[data-eco-approve], [data-eco-forget]");
    if (ea) {
      const approve = ea.hasAttribute("data-eco-approve"), id = ea.dataset.ecoApprove || ea.dataset.ecoForget;
      try { ecoGw.data = await api(`/api/ecowitt/gateways/${encodeURIComponent(id)}${approve ? "/approve" : ""}`, { method: approve ? "POST" : "DELETE" });
        snack(approve ? "Gateway trusted. Its sensors appear with its next report." : "Gateway removed"); loadSettings(); }
      catch (err) { snack(err.message); }
      return;
    }
    if (t.closest("[data-settings-back]")) { settingsSub = null; renderSettings(); window.scrollTo({ top: 0 }); return; }
    if (t.closest("[data-new-view]") && isAdmin()) { if ($("#more").open) $("#more").close(); return openViewEditor(null); }
    if (isAdmin() && (t.closest("[data-edit-view]") || t.closest("#editview"))) return openViewEditor(customView());
    const nav = t.closest("[data-f]");
    if (nav) { if (nav.closest("#more")) $("#more").close(); go(nav.dataset.f); return; }
    if (t.closest("[data-open=more]")) { hydrateIcons($("#more")); $("#more").showModal(); return; }
    if (t.closest("[data-goto]")) return go(t.closest("[data-goto]").dataset.goto);
    const gs = t.closest("[data-goto-setting]"); if (gs) { go("settings"); settingsSub = gs.dataset.gotoSetting; return; }
    if (t.closest("[data-ha-failover]")) return haFailover();
    if (t.closest("[data-ha-adopt]")) return haAdopt();
    const cp = t.closest("[data-copy]");
    if (cp) { try { await navigator.clipboard.writeText(cp.dataset.copy); snack("Copied"); } catch { snack("Couldn't copy here. Select the text and copy it instead."); } return; }
    // settings page
    const card = t.closest(".set-card[data-section]");
    if (card) {
      if (t.closest("[data-enable]")) { const sw = t.closest("[data-enable]"); sw.classList.toggle("on"); sw.ariaChecked = sw.classList.contains("on");
        if (sw.parentElement.classList.contains("enable-lbl")) sw.parentElement.firstChild.textContent = sw.classList.contains("on") ? "On" : "Off";
        return; }
      if (t.closest("[data-add-host]")) { const b = t.closest("[data-add-host]"); b.insertAdjacentHTML("beforebegin", hostRow("", b.closest(".hostlist")?.dataset.itemLabel)); b.previousElementSibling.querySelector("input")?.focus(); return; }
      if (t.closest("[data-del-host]")) { const r = t.closest(".host-row"), list = r.parentElement; r.remove(); if (!$(".host-row", list)) $("[data-add-host]", list)?.insertAdjacentHTML("beforebegin", hostRow("", list.dataset.itemLabel)); return; }
      if (t.closest("[data-add-server]")) { t.closest("[data-add-server]").insertAdjacentHTML("beforebegin", serverRow()); return; }
      if (t.closest("[data-del-server]")) { t.closest(".server-row").remove(); return; }
      if (t.closest("[data-login]")) return loginFlow(t.closest("[data-login]").dataset.login);
      if (t.closest("[data-save]")) {
        const btn = t.closest("[data-save]"); btn.disabled = true;
        try {
          const sec = await api(`/api/settings/${card.dataset.section}`, { method: "PUT", body: JSON.stringify(collectSection(card)) });
          const i = settingsData.sections.findIndex(s => s.id === sec.id); settingsData.sections[i] = sec;
          snack(`${sec.label} saved${sec.enabled ? " and restarted" : " and turned off"}`);
          setTimeout(loadSettings, 2500);
          renderSettings(); loadStatus();
        } catch (err) { snack(err.message); }
        finally { btn.disabled = false; }
        return;
      }
    }
    const ms = t.closest("#mode-seg [data-mode]"); if (ms) { store("mode", ms.dataset.mode); applyMode(ms.dataset.mode); renderSettings(); return; }
    const sw = t.closest("#swatches .swatch"); if (sw) { root.dataset.seed = sw.dataset.seed; store("seed", sw.dataset.seed); applyMode(load("mode", "auto")); renderSettings(); return; }
    const us = t.closest("#unit-seg [data-unit]"); if (us) { unit = us.dataset.unit; store("unit", unit); renderSettings(); return; }
    const ch = t.closest("#chart-seg [data-chart]");
    if (ch) { chartStyle = ch.dataset.chart; store("chartStyle", chartStyle); renderSettings(); schedule(); return; }
    const cs = t.closest("#style-seg [data-cstyle]"); if (cs) { cardStyle = cs.dataset.cstyle; store("cardStyle", cardStyle); document.body.dataset.cardStyle = cardStyle; renderSettings(); return; }
    const gd = t.closest("#groupby-seg [data-gbdefault]"); if (gd) { store("groupByDefault", gd.dataset.gbdefault); renderSettings(); return; }
    const ls = t.closest("#layout-seg [data-layout]"); if (ls) { mode = ls.dataset.layout; store("viewmode", mode); renderSettings(); renderHeader(); return; }
  });

  async function sendCmd(id, capability, value, quiet = true) {
    if (!canControl()) { snack("Viewing only: sign in to control devices"); resetView(); return; }
    const d = devices.get(id);
    try { await api(`/api/devices/${encodeURIComponent(id)}/command`, { method: "POST", body: JSON.stringify({ capability, value }) }); }
    catch (err) { snack(`Couldn't reach ${d?.name || "device"}: ${err.message}`); resetView(); if (!quiet) throw err; }
  }
  document.addEventListener("toggle", e => { if (e.target.matches?.("details.devnote")) store("devNoteClosed", e.target.open ? undefined : "1"); }, true);
  document.addEventListener("keydown", e => {
    if ((e.key === "Enter" || e.key === " ") && e.target.matches?.(".hcardx[role=button], .meta .more-n")) { e.preventDefault(); e.target.click(); return; }
    if ((e.key === "Enter" || e.key === " ") && e.target.matches?.(".card .name[role=button]") && !editing()) {
      e.preventDefault(); openDevicePanel(e.target.closest("[data-id]").dataset.id); }
  });
  document.addEventListener("input", e => {
    if (e.target.id === "devsearch") { devQuery = e.target.value; renderDeviceList(); return; }
    const r = e.target.closest("[data-slider]"); if (!r) return;
    const pct = (r.value - r.min) / (r.max - r.min) * 100; r.style.setProperty("--pct", pct + "%");
    r.nextElementSibling.textContent = `${r.value}${r.dataset.suffix ?? "%"}`;
    sliding = true;
  });
  document.addEventListener("change", e => {
    const ds = e.target.closest("[data-devsel]");
    if (ds) { devSel[ds.dataset.devsel] = ds.value; devicesPage(); return; }
    if (e.target.id === "devsort") { devSort = { key: e.target.value, dir: 1 }; store("devSort", JSON.stringify(devSort)); devicesPage(); return; }
    const r = e.target.closest("[data-slider]");
    if (r) { sliding = false; const v = +r.value;
      sendCmd(r.closest("[data-id]").dataset.id, r.dataset.slider, r.classList.contains("temp-set") && unit === "F" ? Math.round((v - 32) * 5 / 9 * 100) / 100 : v); return; }
    const cs = e.target.closest("[data-cmdsel]");
    if (cs) { sendCmd(cs.closest("[data-id]").dataset.id, cs.dataset.cmdsel, cs.value); return; }
    const cp = e.target.closest("[data-colorpick]");
    if (cp) sendCmd(cp.closest("[data-id]").dataset.id, "color", cp.value);
  });
  document.addEventListener("click", e => {
    const c = e.target.closest("[data-color]");
    if (c) return sendCmd(c.closest("[data-id]").dataset.id, "color", c.dataset.color);
    const all = e.target.closest("[data-all-lights]");
    if (all && canControl()) { const on = all.dataset.allLights === "true";
      const targets = visible().filter(d => isLight(d) && !isGroup(d) && !!val(d, "light") !== on);
      targets.forEach(d => sendCmd(d.id, "light", on)); snack(`Turning ${targets.length} light${targets.length === 1 ? "" : "s"} ${on ? "on" : "off"}`); }
  });

  function applyMode(pref) {
    root.dataset.mode = pref === "auto" ? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : pref;
    $('meta[name="theme-color"]').content = getComputedStyle(root).getPropertyValue("--md-surface").trim();
  }
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => load("mode", "auto") === "auto" && applyMode("auto"));
  const setEditing = on => { document.body.classList.toggle("editing", on); $("#editmode").classList.toggle("on", on);
    if (on && mode === "table") snack("Switch to card view to drag things around"); document.body.classList.remove("quiet"); schedule(); };
  $("#editmode").onclick = () => isAdmin() && setEditing(!editing());
  document.addEventListener("click", async e => {
    if (e.target.closest("[data-done-edit]")) { setEditing(false); snack("Layout saved"); }
    if (e.target.closest("[data-reset-layout]") && await confirmAction("Reset layout?", "Rooms and devices go back to automatic order and Favorites are cleared. Room assignments stay.", "dashboard")) {
      layout = { rooms: [], order: {}, pinned: [], views: layout.views || [] }; await saveLayout(); schedule(); snack("Layout reset"); }
  });
  document.addEventListener("click", e => {
    const g = e.target.closest("[data-groupby]"); if (!g || !groupable()) return;
    const v = g.dataset.groupby; if (v === gbNow) return;
    store("groupBy:" + view, v); document.body.classList.remove("quiet");
    const refocus = g.closest("#groupby") ? `#groupby [data-groupby="${v}"]` : null;
    render(); if (refocus) $(refocus)?.focus();
    snack(v === "type" ? "Grouped by device type" : "Grouped by room");
  });
  $("#viewmode").onclick = () => { mode = mode === "table" ? "cards" : "table"; store("viewmode", mode); document.body.classList.remove("quiet"); schedule(); };
  addEventListener("scroll", () => $(".appbar").classList.toggle("scrolled", scrollY > 24), { passive: true });

  // ---------- in-place updates: live data must not wipe focus, scroll or open menus ----------
  const nativeHTML = Object.getOwnPropertyDescriptor(Element.prototype, "innerHTML");
  const KEYED = ".card[data-id], tr[data-id], .devrow[data-id], .batt-row[data-id], .ups-panel[data-id], .aqhero[data-id]";
  // outermost keyed items only (a keyed panel may hold keyed rows; those are patched with their panel)
  const topKeyed = root => [...root.querySelectorAll(KEYED)].filter(k => !k.parentElement?.closest(KEYED) || !root.contains(k.parentElement.closest(KEYED)));
  function skeleton(root) {            // structure with keyed items blanked out (but their identity kept)
    const c = document.createElement("div");           // a fragment or an element, compared the same way
    const copy = root.cloneNode(true);
    if (root.nodeType === 1) c.append(...copy.childNodes); else c.append(copy);
    topKeyed(c).forEach(k => k.replaceWith(document.createComment(k.dataset.id)));
    return nativeHTML.get.call(c);
  }
  function focusKey(node) {
    const a = document.activeElement; if (!a || !node.contains(a)) return null;
    for (const attr of ["data-cmd", "data-cmdsel", "data-slider", "data-hist", "data-edit", "data-open-device", "data-tab", "data-visible", "data-color", "data-colorpick", "data-snapshot"])
      if (a.hasAttribute(attr)) return `[${attr}="${CSS.escape(a.getAttribute(attr))}"]` + (a.dataset.val && a.getAttribute("role") !== "switch" && !a.classList.contains("quick") ? `[data-val="${CSS.escape(a.dataset.val)}"]` : "");
    return a.classList.contains("name") ? ".name" : null;
  }
  function patchHTML(el, html) {
    if (el._html === html) return;                       // nothing changed
    const tpl = document.createElement("template"); nativeHTML.set.call(tpl, html);
    const olds = topKeyed(el), news = topKeyed(tpl.content);
    if (el._html != null && olds.length && olds.length === news.length && olds.every((o, i) => o.dataset.id === news[i].dataset.id)
        && skeleton(el) === skeleton(tpl.content)) {
      const scrolls = [...el.querySelectorAll(".table-wrap")].map(w => w.scrollLeft);
      let deferred = false;
      olds.forEach((o, i) => {
        const nn = news[i];
        if (o.outerHTML === nn.outerHTML) return;
        // an open <select> must not close under the user's finger: patch it later
        if (document.activeElement?.tagName === "SELECT" && o.contains(document.activeElement)) { deferred = true; return; }
        const opened = [...o.querySelectorAll("details")].map(x => x.open);
        const fk = focusKey(o); o.replaceWith(nn);
        nn.querySelectorAll("details").forEach((x, i) => { if (opened[i]) x.open = true; });
        if (fk) nn.querySelector(fk)?.focus({ preventScroll: true });
      });
      el.querySelectorAll(".table-wrap").forEach((w, i) => { w.scrollLeft = scrolls[i] || 0; });
      if (deferred) { el._html = "\u0000stale"; document.activeElement.addEventListener("blur", () => schedule(), { once: true }); return; }
    } else {
      // full rebuild: still put focus back on the same control of the same device
      const a = document.activeElement, owner = a && el.contains(a) ? a.closest("[data-id]") : null;
      const fk = owner ? focusKey(owner) : null, oid = owner?.dataset.id;
      nativeHTML.set.call(el, html);
      if (fk && oid) el.querySelector(`[data-id="${CSS.escape(oid)}"]`)?.querySelector(fk)?.focus({ preventScroll: true });
    }
    el._html = html;
  }
  for (const id of ["rooms", "summary", "alerts"]) {
    const el = document.getElementById(id);
    Object.defineProperty(el, "innerHTML", { configurable: true, get() { return nativeHTML.get.call(this); }, set(v) { patchHTML(this, String(v)); } });
  }

  { const d = document.querySelector(".destinations");
    const upd = () => d && d.classList.toggle("more-below", d.scrollTop + d.clientHeight < d.scrollHeight - 4);
    d?.addEventListener("scroll", upd, { passive: true }); addEventListener("resize", upd); setTimeout(upd, 300); }
  { let wasPhone = phone(); addEventListener("resize", () => { if (phone() !== wasPhone) { wasPhone = phone(); render(); } }); }

  // after a failed command, redraw from the real state (a slider/select left where the user put it is wrong)
  function resetView() { for (const id of ["rooms", "summary", "alerts"]) { const el = document.getElementById(id); el._html = null; } $("#devpanel-body") && ($("#devpanel-body")._html = null); schedule(); }

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
    setInterval(loadSparks, 300000);
    setInterval(() => view === "power" && loadPower(), 10000);
    setInterval(loadStatus, 15000);
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
})();