// Haven dashboard, part 8 of 11: Loading data, feedback, sign-in flows (Ring, Aqara).
// The parts are plain scripts that index.html loads in order; they share one scope (no build step).
// A part can use anything earlier parts declare. Code that runs while the page loads (not inside a
// function called later) must not use a later part.
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
      else if (m.type === "device") { devices.set(m.device.id, m.device); patchCard(m.device); scheduleQuiet(); liveIngest(m.device); if (panelId === m.device.id && $("#devpanel").open && !sliding && panelTab === "now") renderDevicePanel(); }
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

