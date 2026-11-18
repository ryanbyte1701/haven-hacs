// Copy text: the clipboard API only exists on https and localhost, so fall back to a hidden text box (plain http)
async function copyText(text) {
  try { if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return true; } } catch { /* try the fallback */ }
  const ta = document.createElement("textarea");
  ta.value = text; ta.setAttribute("readonly", ""); ta.style.cssText = "position:fixed;top:0;left:0;opacity:0";
  document.body.appendChild(ta); ta.select(); ta.setSelectionRange(0, text.length);
  let ok = false; try { ok = document.execCommand("copy"); } catch { ok = false; }
  ta.remove(); return ok;
}

// Haven dashboard, part 10 of 11: Clicks, changes, keyboard and in-place updates.
// The parts are plain scripts that index.html loads in order; they share one scope (no build step).
// A part can use anything earlier parts declare. Code that runs while the page loads (not inside a
// function called later) must not use a later part.
  // ---------- interactions ----------
  const VERB = { lock: "Lock", unlock: "Unlock", open: "Open", close: "Close", test: "Test", mute: "Mute", siren: "Sound siren on",
    disarm: "Disarm", arm_home: "Arm (home)", arm_away: "Arm (away)" };
  document.addEventListener("click", async e => {
    const t = e.target;
    const ts = t.closest("[data-tstep]"); if (ts) return thermoStep(ts);
    if (view === "settings" && settingsSub === "smart") {
      const all = t.closest("[data-sa-all]");
      if (all) { saOff = new Set(); smartSuggestions().forEach(x => all.dataset.saAll === "1" ? (!x.on && saOff.add("+" + x.key)) : saOff.add(x.key)); return renderSettings(); }
      if (t.closest("[data-sa-rescan]")) { saOff = new Set(); renderSettings(); return snack("Checked again"); }
      const ap = t.closest("[data-sa-apply]"); if (ap) return smartApply(ap);
    }
    const b = t.closest("[data-cmd]");
    if (b) {
      if (!canControl()) return snack("Viewing only: sign in to control devices");
      const id = b.closest("[data-id]").dataset.id, d = devices.get(id);
      const capName = b.dataset.cmd, value = JSON.parse(b.dataset.val);
      if (b.closest(".segmented") && b.classList.contains("on")) return;   // already in that state
      const quiet = capName === "action" && !["test", "siren", "mute"].includes(value);
      const sirenSw = /siren/i.test(capName) || /siren/i.test(d.capabilities[capName]?.label || "");
      if (sirenSw && value === true && !(await confirmAction(`Sound siren on ${d.name}?`, "The siren sounds until you turn it off (or the device stops it).", "campaign", "Sound siren"))) return;
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
    if (t.closest("[data-diag-dl]") || t.closest("[data-diag-copy]") || t.closest("[data-diag-gh]")) {
      const b = t.closest("button"), what = b.matches("[data-diag-copy]") ? "copy" : b.matches("[data-diag-gh]") ? "gh" : "dl";
      if (b.dataset.busy) return; b.dataset.busy = "1";
      // GitHub opens in a new tab: open it now (inside the click) so pop-up blockers allow it, fill it in afterwards
      const ghWin = what === "gh" ? window.open("about:blank", "_blank") : null;
      try {
        // the server makes the file and a short-lived download link (a plain link downloads on phones and in the
        // Home Assistant app, where a file made in the page can't be saved)
        const data = await api("/api/diagnostics/link", { method: "POST" });
        const s = data.summary || {}, sumText = `Haven ${data.haven?.edition === "og" ? "OG" : "for Home Assistant"}${data.haven?.version ? " " + data.haven.version : ""} · ${s.devices} devices (${s.offline} offline) · ` +
          Object.entries(s.by_integration || {}).map(([k, v]) => `${k} ${v}`).join(", ");
        const lines = [sumText, "Integrations: " + Object.entries(data.integrations || {}).map(([k, v]) => `${k}: ${v}`).join("; "),
          ...((data.recent_warnings || []).map(w => `${w.level} ${w.logger}: ${w.message}`))];
        const el = $("#diag-sum"); if (el) el.textContent = sumText;
        const href = (window.HAVEN_URL || (p => p))(data.path);
        if (what === "copy") {
          if (await copyText(lines.join("\n"))) snack("Summary copied");
          else { if (el) { el.style.whiteSpace = "pre-wrap"; el.style.userSelect = "all"; el.textContent = lines.join("\n"); } snack("Couldn't copy here: select the text above and copy it"); }
        }
        else if (what === "gh") {
          const body = `**What happened**\n\n<!-- describe the problem -->\n\n**Diagnostics summary** (anonymous)\n\n\`\`\`\n${lines.join("\n").slice(0, 5000)}\n\`\`\`\n\n` +
            `<!-- Drag the downloaded haven-diagnostics-….json file here before submitting -->\n`;
          const url = `https://github.com/ryanbyte1701/haven/issues/new?labels=diagnostics&title=${encodeURIComponent("Diagnostics: ")}&body=${encodeURIComponent(body)}`;
          if (ghWin) ghWin.location.href = url; else window.open(url, "_blank", "noopener");
          snack("Opened GitHub: add the downloaded file to the issue");
        }
        if (what !== "copy") {
          if (what === "dl") { const a = document.createElement("a"); a.href = href; a.target = "_blank"; a.rel = "noopener";
            a.download = data.path.split("/").pop(); document.body.appendChild(a); a.click(); a.remove(); snack("Downloading diagnostics"); }
          const box = $("#diag-link");
          if (box) { box.hidden = false; box.innerHTML = `${icon("download")}<span>${what === "gh" ? "Download the file to attach:" : "Didn't download?"} <a href="${esc(href)}" target="_blank" rel="noopener" download>${esc(data.path.split("/").pop())}</a> <small class="muted">(link works for ${Math.round((data.expires_in || 600) / 60)} minutes)</small></span>`; }
        }
      } catch (err) { if (ghWin) ghWin.close(); snack(`Couldn't create diagnostics: ${err.message}`); }
      finally { delete b.dataset.busy; }
      return;
    }
    const at = t.closest("[data-alerts-toggle]"); if (at) { alertsOpen = alertsOpen === at.dataset.alertsToggle ? null : at.dataset.alertsToggle; return schedule(); }
    if (t.closest("[data-open-device]") || (t.closest(".card .name") && !editing())) return openDevicePanel(t.closest("[data-id]").dataset.id);
    const cardHit = t.closest(".card[data-id], .dtable tbody tr[data-id], .batt-row[data-id]");
    if (cardHit && !editing() && !t.closest("button, a, input, select, textarea, label, [role=switch], [role=slider], .segmented, .slider, .meta .more-n, svg.spark")
        && devices.has(cardHit.dataset.id)) return openDevicePanel(cardHit.dataset.id);
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
    if (t.closest("#devlist") && (t.closest("[data-close-list]") || t.closest("[data-open-device]"))) $("#devlist")?.close();
    const lt = t.closest("[data-ids]");
    if (t.closest("[data-close-list]") && !t.closest("[data-goto]")) return;
    if (lt && lt.dataset.ids) return showDeviceList(lt.dataset.listTitle || "Devices", lt.dataset.ids.split(" "), lt.dataset.goto);
    if (t.closest("[data-goto]")) return go(t.closest("[data-goto]").dataset.goto);
    const gs = t.closest("[data-goto-setting]"); if (gs) { go("settings"); settingsSub = gs.dataset.gotoSetting; return; }
    if (t.closest("[data-ha-failover]")) return haFailover();
    if (t.closest("[data-ha-adopt]")) return haAdopt();
    const cp = t.closest("[data-copy]");
    if (cp) { snack(await copyText(cp.dataset.copy) ? "Copied" : "Couldn't copy here. Select the text and copy it instead."); return; }
    // settings page
    const card = t.closest(".set-card[data-section]");
    if (card) {
      if (t.closest("[data-enable]")) { const sw = t.closest("[data-enable]"); sw.classList.toggle("on"); sw.ariaChecked = sw.classList.contains("on");
        if (sw.parentElement.classList.contains("enable-lbl")) sw.parentElement.firstChild.textContent = sw.classList.contains("on") ? "On" : "Off";
        return; }
      const tg = t.closest("[data-tg]");
      if (tg && !tg.disabled) { tg.classList.toggle("on"); tg.setAttribute("aria-checked", tg.classList.contains("on"));
        const box = tg.closest(".toggles");
        if (box.dataset.mode === "on" && !$$("[data-tg].on", box).length) { tg.classList.add("on"); tg.setAttribute("aria-checked", "true"); snack("Keep at least one on"); }
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
    if (t.closest("[data-joingaps]")) { joinGaps = !joinGaps; store("joinGaps", joinGaps); renderSettings(); schedule(); return; }
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
    const sa = e.target.closest?.("[data-sa]");
    if (sa) { const k = sa.dataset.sa, x = smartSuggestions().find(y => y.key === k);
      saOff.delete(k); saOff.delete("+" + k); if (x && sa.checked !== x.on) saOff.add(sa.checked ? "+" + k : k); return renderSettings(); }
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

  // a live update for one device: swap just its card(s) now; the throttled full render catches up the rest
  function patchCard(d) {
    if (sliding || dragging || editing() || mode !== "cards" || view === "settings" || pluginPages[view]) return;
    const olds = [...document.querySelectorAll(`#rooms .card[data-id="${CSS.escape(d.id)}"]`)];
    if (!olds.length || d.hidden) return;
    const html = card(d);
    for (const o of olds) {
      if (o.outerHTML === html) continue;
      const a = document.activeElement;
      if (a && o.contains(a) && (a.tagName === "SELECT" || a.tagName === "INPUT")) continue;   // don't pull it from under the user
      const tpl = document.createElement("template"); nativeHTML.set.call(tpl, html);
      const nn = tpl.content.firstElementChild; if (!nn) continue;
      const fk = focusKey(o); o.replaceWith(nn);
      if (fk) nn.querySelector(fk)?.focus({ preventScroll: true });
    }
  }

  // after a failed command, redraw from the real state (a slider/select left where the user put it is wrong)
  function resetView() { for (const id of ["rooms", "summary", "alerts"]) { const el = document.getElementById(id); el._html = null; } $("#devpanel-body") && ($("#devpanel-body")._html = null); schedule(); }

