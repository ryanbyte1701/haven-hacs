// Haven dashboard, part 7 of 11: Custom views, arranging, search and the main render.
// The parts are plain scripts that index.html loads in order; they share one scope (no build step).
// A part can use anything earlier parts declare. Code that runs while the page loads (not inside a
// function called later) must not use a later part.
  // ---------- custom views ----------
  function openViewEditor(existing) {
    const dlg = $("#viewdlg"), f = $("#view-form");
    const v = existing ? JSON.parse(JSON.stringify(existing)) : { id: Math.random().toString(36).slice(2, 9), name: "", icon: "dashboard", rooms: [], types: [], sources: [], devices: [], keywords: [] };
    v.keywords ||= [];
    const kw = $("#view-keywords"), ds = $("#view-devsearch");
    kw.value = v.keywords.join(", "); ds.value = "";
    const devShown = () => { const q = ds.value.trim().toLowerCase();
      return all.filter(d => !q || `${d.name} ${d.room || ""} ${srcLabel(d)}`.toLowerCase().includes(q)); };
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
      const shown = devShown();
      $("#pick-devices").innerHTML = (shown.sort((a, b) => (a.room || "").localeCompare(b.room || "") || a.name.localeCompare(b.name)).map(d =>
        `<label><input type="checkbox" data-pick-dev="${esc(d.id)}" ${v.devices.includes(d.id) ? "checked" : ""}><span>${esc(d.name)}</span><small>${esc(d.room || "Other")} · ${esc(srcLabel(d))}</small></label>`).join("")) || `<p class="muted small">No device matches “${esc(ds.value)}”.</p>`;
      $("#view-pickall").textContent = shown.length && shown.every(d => v.devices.includes(d.id)) ? "Unpick all shown" : `Pick all shown (${shown.length})`;
      const n = all.filter(d => viewMatch(v, d)).length;
      $("#view-count").innerHTML = `${icon("info")}<span>${n} device${n === 1 ? "" : "s"} match${n === 1 ? "es" : ""} right now</span>`;
    };
    f.onclick = e => {
      const c = e.target.closest("[data-pick]"); if (c) { const k = c.dataset.pick, x = c.dataset.v;
        v[k] = v[k].includes(x) ? v[k].filter(y => y !== x) : [...v[k], x]; draw(); return; }
      const ip = e.target.closest("[data-icon-pick]"); if (ip) { v.icon = ip.dataset.iconPick; draw(); }
    };
    kw.oninput = () => { v.keywords = kw.value.split(",").map(x => x.trim()).filter(Boolean).slice(0, 20); draw(); kw.focus(); };
    ds.oninput = () => draw();
    ds.onkeydown = e => { if (e.key === "Enter") e.preventDefault(); };
    kw.onkeydown = e => { if (e.key === "Enter") e.preventDefault(); };
    $("#view-pickall").onclick = () => { const ids = devShown().map(d => d.id), allIn = ids.length && ids.every(id => v.devices.includes(id));
      v.devices = allIn ? v.devices.filter(id => !ids.includes(id)) : [...new Set([...v.devices, ...ids])]; draw(); };
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
  // ---------- search on every device page ----------
  let pageQuery = "";
  const searchable = () => !["settings", "devices", "automations"].includes(view) && !pluginPages[view];
  function searchFilter(list) {
    const q = searchable() ? pageQuery.trim().toLowerCase() : "";
    if (!q) return list;
    const words = q.split(/\s+/);
    return list.filter(d => { const hay = `${d.name} ${d.room || ""} ${d.model || ""} ${srcLabel(d)} ${readingText(d)} ${(statusOf(d) || [""])[0]}`.toLowerCase();
      return words.every(w => hay.includes(w)); });
  }
  function renderSearch() {
    const box = $("#pagesearch"); if (!box) return;
    box.hidden = !searchable();
    const i = $("#pagesearch input"); if (i && document.activeElement !== i && i.value !== pageQuery) i.value = pageQuery;
  }
  function render() {
    destroySortables();
    renderViewNav();
    if (view.startsWith("v:") && !customView() && layout.views) { view = "all"; store("filter", view); }
    gbNow = groupBy(); document.body.dataset.groupBy = gbNow;
    renderHeader();
    renderEditBar();
    renderBadges();
    const list = searchFilter(visible());
    renderSearch();
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
    $("#summary").innerHTML = view === "all" && list.length ? homeTiles(list) : view === "doors" ? doorTiles(list.filter(d => !isWindow(d)))
      : view === "windows" ? doorTiles(list.filter(isWindow), "windows") : "";
    renderChips(list);
    const shown = list.filter(matches);
    if (view === "doors" || view === "windows") shown.sort((a, b) => (val(b, "contact") === "open") - (val(a, "contact") === "open"));
    if (!shown.length) { $("#rooms").innerHTML = customView() ? `<div class="empty-state">${icon(customView().icon)}<h3>Nothing matches this view yet</h3><p>Pick rooms, types, brands or devices for it.</p><button class="tonal-btn" data-edit-view>${icon("tune")}Edit view</button></div>`
      : `<p class="empty">${list.length ? "Nothing in this view yet." : "No devices yet. Add your accounts in Settings."}</p>`; return; }
    if (mode === "table") { $("#rooms").innerHTML = tableView(shown); return; }
    const fallback = (a, b) => isAlarm(b) - isAlarm(a) || (view === "doors" ? (val(b, "contact") === "open") - (val(a, "contact") === "open") : 0) || a.name.localeCompare(b.name);
    const hc = view === "all" ? homeCfg() : null;
    // Security by room: smoke and CO alarms together in one section first, not spread over the rooms
    const smoke = view === "security" && gbNow === "room" ? shown.filter(d => deviceType(d) === "smoke").sort(fallback) : [];
    const smokeSec = smoke.length ? `<section class="room" data-fixed><h2>Smoke &amp; CO alarms</h2><div class="grid">${smoke.map(card).join("")}</div></section>` : "";
    $("#rooms").innerHTML = hc && !hc.rooms && !editing()
      ? (hc.favorites ? roomSections(shown.filter(d => layout.pinned.includes(d.id)), { favorites: true, fallback }) : "")
      : roomSections(smoke.length ? shown.filter(d => !smoke.includes(d)) : shown, { favorites: view === "all" && (!hc || hc.favorites || editing()), fallback, extraFirst: smokeSec });
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
    // Pool shows in the menu once there is something on it
    const poolHid = !list.some(d => tabsOf(d).includes("pool")) || (homeCfg().hidden_pages || []).includes("pool");
    $$('#nav [data-f="pool"], #more [data-f="pool"]').forEach(b => { b.hidden = poolHid; });
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
  let pending = false, sliding = false, lastRender = 0, quietTimer = null;
  const schedule = () => { if (!pending) { pending = true; requestAnimationFrame(() => { pending = false; if (sliding || dragging) return setTimeout(schedule, 300); render(); lastRender = performance.now(); }); } };
  // live data: a changed card is patched at once (patchCard, below); the whole page (counts, order, chips) is
  // rebuilt at most once a second, so a burst of updates from a busy home doesn't redraw everything each time
  const QUIET_MS = 1000;
  const scheduleQuiet = () => {
    document.body.classList.add("quiet");
    if (quietTimer) return;
    const wait = lastRender + QUIET_MS - performance.now();
    if (wait <= 0) return schedule();
    quietTimer = setTimeout(() => { quietTimer = null; schedule(); }, wait);
  };

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
    if (v !== view) { pageQuery = ""; const i = $("#pagesearch-input"); if (i) i.value = ""; }
    view = v; store("filter", v); document.body.classList.remove("quiet");
    if (v === "settings") { settingsSub = null; homeDraft = null; $("#rooms").innerHTML = ""; loadSettings(); }
    if (v === "power") loadPower();
    schedule(); window.scrollTo({ top: 0, behavior: "smooth" });
  }

