// Haven dashboard, part 1 of 11: Shared state, icons, helpers and device types.
// The parts are plain scripts that index.html loads in order; they share one scope (no build step).
// A part can use anything earlier parts declare. Code that runs while the page loads (not inside a
// function called later) must not use a later part.
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
  const VIEW_TYPES = { climate: "Climate", lights: "Lights", water: "Water", doors: "Doors", windows: "Windows", security: "Security",
    switches: "Switches", appliances: "Appliances", pool: "Pool", battery: "Batteries", power: "Power" };
  const VIEW_ICONS = ["dashboard", "home", "bedtime", "lightbulb", "thermostat", "water_drop", "sensor_door", "shield_lock",
    "power", "grass", "partly_cloudy_day", "videocam", "home_work", "tune", "battery_full", "lan", "sprinkler", "detector_smoke"];
  const customView = () => view.startsWith("v:") ? (layout.views || []).find(v => "v:" + v.id === view) : null;
  let cardStyle = load("cardStyle", "standard");
  let dragging = false, sortables = [];
  const FAV = "★ Favorites";
  let edition = "og";        // "og" (Docker) or "hacs" (Home Assistant edition), from /api/config

  const SEEDS = { ocean: "#1E88E5", violet: "#6750A4", teal: "#00897B", sage: "#7C9A3D", desert: "#D9772B" };
  const GROUPS = {
    climate: ["temperature", "humidity", "pressure", "co2", "pm25", "pm10", "voc", "aqi", "air_score", "illuminance", "wind_speed", "rain_daily", "moisture"],
    water: ["leak", "valve", "moisture", "rain_daily", "flow_rate", "water_pressure", "water_usage_today", "ph", "orp", "free_chlorine", "watering"],
    doors: ["contact"],
    security: ["contact", "lock", "motion", "presence", "occupancy", "vibration", "tamper", "smoke", "co", "co_ppm", "gas", "heat", "alarm_panel", "ding"],
    lights: ["light"],
  };
  const PAGES = new Set(["battery", "power", "settings", "devices", "air"]);
  const pluginPages = {};   // id -> { label, icon, title, render(el), onDevices?() }
  const TABS = [["climate", "Climate", "thermostat"], ["lights", "Lights", "lightbulb"], ["water", "Water", "water_drop"], ["pool", "Pool", "pool"],
    ["doors", "Doors", "sensor_door"], ["windows", "Windows", "window"], ["security", "Security", "shield_lock"],
    ["switches", "Switches", "toggle_on"], ["appliances", "Appliances", "kitchen"]];
  const TAB_IDS = TABS.map(t => t[0]);
  const TITLES = { lights: "Lights", climate: "Climate", water: "Water", doors: "Doors", security: "Security", windows: "Windows", switches: "Switches",
    battery: "Batteries", power: "Power", settings: "Settings", devices: "Devices", air: "Air quality", appliances: "Appliances", pool: "Pool" };
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
  // Pool: WaterGuru and anything named "pool" go to the Pool page only (not Whirlpool: "pool" as its own word)
  const POOL_NAME = /(^|[^a-z])pool([^a-z]|$)/i;
  const isPool = d => srcLabel(d) === "WaterGuru" || /waterguru/i.test(d.attributes?.integration || "") || kindOf(d) === "pool" || POOL_NAME.test(d.name);
  const META_ICON = { outdoor_temperature: "partly_cloudy_day", wind_speed: "air", wind_gust: "air", rain_daily: "rainy", rain_rate: "rainy", uv: "sunny", solar: "sunny",
    co2: "co2", pm25: "air", pressure: "science", illuminance: "light_mode", co_ppm: "detector_smoke", moisture: "grass",
    runtime: "timer", load: "speed", odometer: "speed", range: "route", fuel_level: "local_gas_station", input_voltage: "electrical_services", power: "bolt", brightness: "light_mode", color_temp: "thermostat", output_voltage: "electrical_services",
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
  // the system a device comes from: Home Assistant names the integration (Philips Hue, Nanoleaf…); otherwise Haven's own
  const brandOf = d => d.attributes?.integration || srcLabel(d);
  const srcLabel = d => { const s = (d.model || "").startsWith("demo (") ? d.model.slice(6, -1) : d.source; return SRC[s] || s; };
  const runtimeText = m => m == null ? "–" : m >= 90 ? `${Math.floor(m / 60)} h ${Math.round(m % 60)} min` : `${Math.round(m)} min`;

  const isAlarm = d => ["leak", "smoke", "co", "gas", "heat"].some(k => val(d, k) === true) || (val(d, "co_ppm") ?? 0) >= 50 ||
    val(d, "alarm_panel") === "triggered" || val(d, "ups_status") === "low_battery";
  const needsAttention = d => isAlarm(d) || (val(d, "contact") === "open" && !has(d, "lock")) || val(d, "lock") === "unlocked" ||
    val(d, "ups_status") === "on_battery" || batteryLow(d) || !d.online;
  const batteryLow = d => { const b = val(d, "battery"); return (b != null && b <= 25) || val(d, "battery_low") === true; };
  const isOutdoor = d => /outdoor|weather|backyard|patio|garden/i.test(`${d.room} ${d.name}`);
  const isUps = d => has(d, "ups_status");
  // window sensors (Home Assistant device class "window", or "window" in the name) get their own page, not Doors
  const isShade = d => has(d, "shade");
  const isWindow = d => isShade(d) || d.attributes?.opening === "window" || (d.attributes?.opening !== "door" && /\bwindows?\b/i.test(d.name));
  const isPlug = d => kindOf(d) === "smart_plug";
  // a wall switch or dimmer that Home Assistant lists as a light (Lutron, Kasa, Inovelli…): a switch, not a bulb
  const WALL_SWITCH = /(^|[^a-z])(switch|dimmer|keypad)([^a-z]|$)/i;
  // an outlet by its name or model (Hue Smart Plug comes through as a light; a power strip's outlets as switch_…)
  // a water valve or watering kit that Home Assistant gives as a plain switch
  const VALVE_NAME = /(^|[^a-z])(valves?|watering|irrigation|sprinklers?|water timer)([^a-z]|$)/i;
  const PLUG_NAME = /(^|[^a-z])(outlets?|plugs?|sockets?|power ?strips?|receptacles?)([^a-z]|$)/i;
  const writableSwitch = d => Object.entries(d.capabilities).some(([k, c]) => c.writable && (k === "switch" || k.startsWith("switch_")) && !/siren|chime|privacy|camera|motion/i.test(k + (c.label || "")));
  const coAlarm = d => has(d, "co") && typeof val(d, "co") !== "number";   // outdoor AQI services report CO as a number
  const isLight = d => d.attributes?.kind === "light" || d.attributes?.kind === "group" || (has(d, "light") && has(d, "brightness"));
  const isGroup = d => d.attributes?.kind === "group";
  const isThermostat = d => kindOf(d) === "thermostat" || has(d, "hvac_mode") || ["heat_setpoint", "cool_setpoint", "target_temperature"].some(k => has(d, k));
  const SETPOINTS = ["target_temperature", "heat_setpoint", "cool_setpoint"];
  const SMOKE_NAME = /\bsmoke\b|carbon monoxide|\bco ?(alarm|detector)|fire alarm|nest protect/i;
  // devices that report nothing Haven recognises: guess the type from the name or model
  const NAME_TYPES = [[/thermostat|ecobee|nest (learning|e)\b/i, "thermostat"], [/\b(leak|water sensor|flood)\b/i, "leak"],
    [/\b(lock|deadbolt)\b/i, "lock"], [/\b(camera|cam|doorbell)\b/i, "camera"], [/\b(blinds?|shades?|curtains?|shutters?)\b/i, "shade"],
    [/\b(door|gate|garage)\b/i, "door"], [/\b(motion|presence|occupancy)\b/i, "motion"], [/\b(lamp|light|bulb|sconce)\b/i, "light"],
    [/\b(plug|outlet|socket|power strip)\b/i, "plug"], [/\b(router|access point|mesh|modem|nas)\b/i, "network"],
    [/\b(vacuum|roomba|roborock)\b/i, "vacuum"], [/\b(purifier)\b/i, "purifier"], [/\b(valve)\b/i, "valve"], [/\b(ups)\b/i, "ups"]];
  // the setpoints that apply in the thermostat's current mode: one target (heat / cool / dry…), a heat–cool range
  // (auto / heat_cool), or none when it's off
  function shownSetpoints(d) {
    const w = SETPOINTS.filter(k => d.capabilities[k]?.writable), m = String(val(d, "hvac_mode") || "");
    if (m === "off") return [];
    const range = w.includes("heat_setpoint") && w.includes("cool_setpoint");
    if (w.includes("target_temperature")) return /^(heat_cool|auto)$/.test(m) && range ? ["heat_setpoint", "cool_setpoint"] : ["target_temperature"];
    if (/^(heat|aux_heat_only|emergency_heat)$/.test(m)) return w.filter(k => k === "heat_setpoint");
    if (m === "cool") return w.filter(k => k === "cool_setpoint");
    return w;
  }

  // ---------- device types (Group by: Type) ----------
  // One human type per device, in the order the sections appear. Edit this list to add or reorder types.
  const DEVICE_TYPES = [
    ["thermostat", "Thermostats", "thermostat"], ["climate", "Temperature & humidity", "device_thermostat"], ["air", "Air quality", "aq_indoor"],
    ["purifier", "Purifiers", "air_purifier"], ["light", "Lights", "lightbulb"], ["light_group", "Light groups", "home_iot_device"],
    ["plug", "Plugs & switches", "outlet"], ["lock", "Locks", "lock"], ["door", "Doors & windows", "door_front"], ["shade", "Blinds & shades", "blinds"],
    ["motion", "Motion & presence", "sensor_occupied"], ["camera", "Cameras & doorbells", "videocam"], ["alarm", "Alarm panels", "shield"],
    ["smoke", "Smoke & CO alarms", "detector_smoke"], ["leak", "Leak sensors", "water_damage"], ["valve", "Valves", "valve"],
    ["water", "Water", "water"], ["soil", "Soil moisture", "grass"], ["weather", "Weather", "partly_cloudy_day"], ["ups", "UPS", "battery_charging_full"],
    ["ev", "EV chargers", "ev_station"], ["vehicle", "Cars", "directions_car"], ["network", "Network", "router"], ["vacuum", "Vacuums", "vacuum"], ["other", "Other", "sensors"]];
  const TYPE_RANK = Object.fromEntries(DEVICE_TYPES.map((t, i) => [t[0], i]));
  const TYPE_INFO = Object.fromEntries(DEVICE_TYPES.map(t => [t[0], t]));
  function deviceType(d) {
    const k = kindOf(d), any = (...ks) => ks.some(x => has(d, x));
    if (k === "vehicle") return "vehicle";
    if (k === "network") return "network";
    if (isThermostat(d)) return "thermostat";
    if (isUps(d)) return "ups";
    if (k === "ev_charger" || has(d, "charger_status")) return "ev";
    if (k === "vacuum" || has(d, "vacuum_state")) return "vacuum";
    if (k === "air_purifier") return "purifier";
    if (k === "weather") return "weather";
    if (k === "aqi_station" || k === "air_monitor") return "air";
    if (has(d, "alarm_panel")) return "alarm";
    if (has(d, "smoke") || coAlarm(d) || any("heat", "gas") || k === "smoke_alarm" || (SMOKE_NAME.test(d.name) && !isLight(d))) return "smoke";
    if (has(d, "ding") || d.attributes?.has_snapshot || ["camera", "doorbell"].includes(k) || d.source === "ring") return "camera";
    if (isGroup(d)) return "light_group";
    if (isLight(d)) return "light";
    if (has(d, "lock")) return "lock";
    if (["pool", "water_monitor", "irrigation_zone", "irrigation_controller"].includes(k) || any("ph", "flow_rate", "watering", "water_usage_today")) return "water";
    if (has(d, "leak")) return "leak";
    if (has(d, "valve") || (has(d, "switch") && !isLight(d) && VALVE_NAME.test(`${d.name} ${d.model || ""}`))) return "valve";
    if (isShade(d)) return "shade";
    if (has(d, "contact")) return "door";
    if (any("motion", "presence") || (has(d, "occupancy") && typeof val(d, "occupancy") !== "number")) return "motion";
    if (k === "smart_plug" || has(d, "switch")) return "plug";
    if (any("air_score", "co2", "pm25", "voc", "aqi")) return "air";
    if (any("wind_speed", "rain_daily")) return "weather";
    if (has(d, "moisture") && !has(d, "temperature")) return "soil";
    if (any("temperature", "humidity")) return "climate";
    return NAME_TYPES.find(([re]) => re.test(`${d.name} ${d.model || ""}`))?.[1] || "other";
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

