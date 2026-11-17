// Sign-in page, the Account page and (admins) Users & access.
// Loaded before app.js. app.js calls window.HavenAccounts.showLogin() / .render(page, el); the pages use
// window.Haven (api, icon, esc, snack, confirmAction, me, setToken) at run time.
(() => {
  const $ = (s, el = document) => el.querySelector(s);
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const icon = (name, filled = false) => {
    const p = (window.MD_ICONS || {})[name] || (window.MD_ICONS || {}).sensors;
    return p ? `<svg class="ic" viewBox="0 -960 960 960" aria-hidden="true"><path d="${p[filled ? 1 : 0]}"/></svg>` : "";
  };
  const setStoredToken = t => { try { t ? localStorage.setItem("token", t) : localStorage.removeItem("token"); } catch {} };
  const ROLE_LABEL = { admin: "Admin", user: "Regular", monitor: "Monitor" };
  const ROLE_HELP = {
    admin: "Full control: devices, settings, integrations, automations and users.",
    user: "Can control devices. Settings, integrations and automations are managed by an admin.",
    monitor: "View only: sees readings and status, can't change anything, see cameras or open settings.",
  };
  const MIN_PW = 10;

  // JSON POST without the app's token handling (the sign-in page runs before there is a session)
  async function send(path, body, method = "POST", token = null) {
    let r;
    const headers = { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) };
    try {
      r = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
    } catch { throw new Error("Can't reach Haven. Check your connection."); }
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(typeof data.detail === "string" ? data.detail
      : r.status === 429 ? "Too many attempts. Wait a few seconds and try again."
      : `Haven answered with an error (${r.status} ${r.statusText || ""}). Try again in a moment.`.replace(" )", ")")), { status: r.status });
    return data;
  }

  // ---------------- sign-in page ----------------
  let loginState = null, showing = false;
  async function showLogin(opts = {}) {
    if (showing && !opts.force) return;          // many 401s at once: one sign-in page
    showing = true;
    if (!opts.keepSession) setStoredToken(null);    // a stale token would count as a wrong password
    let st = opts.state || loginState;
    if (!st) { try { st = await fetch("/api/auth/state").then(r => r.json()); } catch { st = { guest_view: false }; } }
    loginState = st;
    let page = $("#authpage");
    if (!page) {
      document.body.insertAdjacentHTML("beforeend", `<div id="authpage" class="authpage" role="dialog" aria-modal="true" aria-labelledby="auth-title"></div>`);
      page = $("#authpage");
    }
    document.body.classList.add("auth-open");
    page.innerHTML = `<form class="authcard" id="auth-form" novalidate>
        <div class="auth-logo">${window.HAVEN_LOGO || icon("home", true)}</div>
        <h1 id="auth-title">Sign in to Haven</h1>
        <p class="auth-sub">${opts.reason ? esc(opts.reason) : "Use the account your Haven admin gave you."}</p>
        <label class="textfield"><input name="username" autocomplete="username" autocapitalize="none" spellcheck="false" maxlength="32" placeholder=" " required><span>Username</span></label>
        <label class="textfield"><input name="password" type="password" autocomplete="current-password" placeholder=" " required><span>Password</span></label>
        ${st.default_login ? `<p class="auth-note">${icon("info")}<span><b>First sign-in?</b> Use <code>admin</code> / <code>haven-admin</code>, or the
          HAVEN_ADMIN_USER / HAVEN_ADMIN_PASSWORD set in docker-compose.yml. You'll choose your own password next.</span></p>` : ""}
        <p class="auth-err" id="auth-err" role="alert" hidden></p>
        <button class="filled-btn auth-go" type="submit">${icon("login")}Sign in</button>
        ${st.guest_view ? `<div class="auth-or"><span>or</span></div>
          <button type="button" class="tonal-btn auth-guest" data-auth-guest>${icon("visibility")}Continue as viewer</button>
          <p class="auth-fine">Viewers can see readings but can't control devices or open settings.</p>` : ""}
        ${opts.cancelable ? `<button type="button" class="text-btn auth-cancel" data-auth-cancel>Back to the dashboard</button>` : ""}
      </form>`;
    const f = $("#auth-form", page), err = $("#auth-err", page);
    const fail = msg => { err.hidden = false; err.innerHTML = `${icon("error")}<span>${esc(msg)}</span>`; };
    setTimeout(() => f.username.focus(), 30);
    f.onsubmit = async e => {
      e.preventDefault(); err.hidden = true;
      const username = f.username.value.trim().toLowerCase(), password = f.password.value;
      if (!username || !password) return fail("Enter your username and password.");
      const btn = $(".auth-go", f); btn.disabled = true;
      try {
        const r = await send("/api/auth/login", { username, password });
        setStoredToken(r.token); location.reload();
      } catch (x) {
        btn.disabled = false;
        fail(x.status === 401 ? "Wrong username or password." : x.message);
        f.password.select?.();
      }
    };
    const g = $("[data-auth-guest]", page);
    if (g) g.onclick = async () => {
      g.disabled = true; err.hidden = true;
      try { const r = await send("/api/auth/guest"); setStoredToken(r.token); location.reload(); }
      catch (x) { g.disabled = false; fail(x.message); }
    };
    const c = $("[data-auth-cancel]", page);
    if (c) c.onclick = hideLogin;
  }
  // ---------------- first sign-in with the installation's password: choose your own ----------------
  function showMustChange(me, token) {
    let page = $("#authpage");
    if (!page) {
      document.body.insertAdjacentHTML("beforeend", `<div id="authpage" class="authpage" role="dialog" aria-modal="true" aria-labelledby="auth-title"></div>`);
      page = $("#authpage");
    }
    document.body.classList.add("auth-open"); showing = true;
    page.innerHTML = `<form class="authcard" id="mc-form" novalidate>
        <div class="auth-logo">${icon("key", true)}</div>
        <h1 id="auth-title">Choose your own password</h1>
        <p class="auth-sub">You signed in with the password from the installation. Pick your own before using Haven:
          until then devices, settings and pairing are locked.</p>
        <label class="textfield"><input name="username" autocomplete="username" autocapitalize="none" spellcheck="false" maxlength="32" placeholder=" " required value="${esc(me.user)}"><span>Username (you can change it)</span></label>
        <label class="textfield"><input name="new" type="password" autocomplete="new-password" placeholder=" " required><span>New password</span></label>
        <label class="textfield"><input name="confirm" type="password" autocomplete="new-password" placeholder=" " required><span>Repeat new password</span></label>
        <p class="auth-note">${icon("info")}<span>At least ${MIN_PW} characters, not the installation password. Usernames use lowercase letters, digits, dot, dash or underscore.</span></p>
        <p class="auth-err" id="auth-err" role="alert" hidden></p>
        <button class="filled-btn auth-go" type="submit">${icon("check")}Save and continue</button>
        <button type="button" class="text-btn auth-cancel" data-mc-out>Sign out</button>
      </form>`;
    const f = $("#mc-form", page), err = $("#auth-err", page);
    const fail = msg => { err.hidden = false; err.innerHTML = `${icon("error")}<span>${esc(msg)}</span>`; };
    setTimeout(() => f.new.focus(), 30);
    $("[data-mc-out]", page).onclick = async () => {
      try { await fetch("/api/auth/logout", { method: "POST", headers: { Authorization: `Bearer ${token}` } }); } catch {}
      setStoredToken(null); location.reload();
    };
    f.onsubmit = async e => {
      e.preventDefault(); err.hidden = true;
      const username = f.username.value.trim().toLowerCase();
      if (!/^[a-z0-9._-]{1,32}$/.test(username)) return fail("Usernames use lowercase letters, digits, dot, dash or underscore (up to 32).");
      if (f.new.value.length < MIN_PW) return fail(`Use at least ${MIN_PW} characters for the password.`);
      if (f.new.value !== f.confirm.value) return fail("The two passwords don't match.");
      const btn = $(".auth-go", f); btn.disabled = true;
      try {
        const d = await send("/api/me/password", { new: f.new.value, username }, "POST", token);
        window.removeEventListener("storage", onStorage);
        setStoredToken(d.token); location.reload();
      } catch (x) { btn.disabled = false; if (x.status === 401) return sessionGone(); fail(x.message); f.new.focus(); }
    };
    // the password was already chosen in another tab (it stored its new session): continue with that one
    const sessionGone = () => {
      let cur = null; try { cur = localStorage.getItem("token"); } catch {}
      if (cur && cur !== token) return location.reload();
      showLogin({ force: true, reason: "Your session ended (the password may have been changed elsewhere). Sign in again." });
    };
    function onStorage(e) { if (e.key === "token" && e.newValue && e.newValue !== token && $("#mc-form")) location.reload(); }
    window.addEventListener("storage", onStorage);
  }

  function hideLogin() { $("#authpage")?.remove(); document.body.classList.remove("auth-open"); showing = false; }

  async function signOut() {
    try { await window.Haven.api("/api/auth/logout", { method: "POST" }); } catch {}
    setStoredToken(null); location.reload();
  }

  // ---------------- Account page ----------------
  function renderAccount(el) {
    const H = window.Haven, me = H.me || {};
    const canPw = !me.guest;
    el.innerHTML = `<div class="dhead"><span class="avatar big">${icon(me.guest ? "visibility" : "person")}</span>
        <div><h2>${esc(me.guest ? "Viewer" : me.user)}</h2><small class="lstat ${me.role === "admin" ? "good" : "info"}"><i></i><span>${me.guest ? "Viewing without signing in" : `${ROLE_LABEL[me.role] || me.role} account`}</span></small></div></div>
      <section class="set-card acc-card">
        <h3>${icon("key")}What you can do</h3>
        <p class="muted">${esc(me.guest ? "You can see readings and status. Sign in to control devices or change settings." : ROLE_HELP[me.role] || "")}</p>
      </section>
      ${canPw ? `<section class="set-card acc-card"><form id="acc-pw" novalidate>
        <h3>${icon("lock")}Change password</h3>
        <p class="muted small">Changing it signs you out on every other device.</p>
        <input type="text" name="username" autocomplete="username" value="${esc(me.user)}" hidden>
        <label class="textfield"><input type="password" name="current" autocomplete="current-password" placeholder=" " required><span>Current password</span></label>
        <label class="textfield"><input type="password" name="new" autocomplete="new-password" placeholder=" " required minlength="${MIN_PW}"><span>New password (${MIN_PW}+ characters)</span></label>
        <label class="textfield"><input type="password" name="confirm" autocomplete="new-password" placeholder=" " required><span>Repeat new password</span></label>
        <p class="acc-err" role="alert" hidden></p>
        <div class="set-actions"><button type="submit" class="filled-btn">${icon("check")}Change password</button></div>
      </form></section>` : ""}
      <section class="set-card acc-card acc-out">
        ${me.guest ? `<button type="button" class="filled-btn" data-acc-signin>${icon("login")}Sign in</button>` : ""}
        <button type="button" class="${me.guest ? "text-btn" : "tonal-btn"}" data-acc-signout>${icon("logout")}${me.guest ? "Stop viewing" : "Sign out"}</button>
      </section>`;
    const f = $("#acc-pw", el);
    if (f) f.onsubmit = async e => {
      e.preventDefault();
      const err = $(".acc-err", f), fail = m => { err.hidden = false; err.innerHTML = `${icon("error")}<span>${esc(m)}</span>`; };
      err.hidden = true;
      if (!f.current.value) return fail("Enter your current password.");
      if (f.new.value.length < MIN_PW) return fail(`Use at least ${MIN_PW} characters for the new password.`);
      if (f.new.value !== f.confirm.value) return fail("The new passwords don't match.");
      const btn = $("button[type=submit]", f); btn.disabled = true;
      try {
        const r = await H.api("/api/me/password", { method: "POST", body: JSON.stringify({ current: f.current.value, new: f.new.value }) });
        H.setToken(r.token); f.reset(); H.snack("Password changed. Other devices were signed out.");
      } catch (x) { fail(x.message); }
      finally { btn.disabled = false; }
    };
  }

  // ---------------- Users & access (admins) ----------------
  let usersData = null, resetFor = null;
  async function loadUsers(el) {
    try { usersData = await window.Haven.api("/api/users"); }
    catch (x) { el.innerHTML = `<p class="empty">${esc(x.message)}</p>`; return; }
    drawUsers(el);
  }
  const roleSelect = (name, cur, attrs = "") => `<select ${attrs} aria-label="Role${name ? " of " + esc(name) : ""}">${Object.keys(ROLE_LABEL).map(r =>
    `<option value="${r}" ${r === cur ? "selected" : ""}>${ROLE_LABEL[r]}</option>`).join("")}</select>`;
  function drawUsers(el) {
    const H = window.Haven, me = H.me || {}, d = usersData;
    const admins = d.users.filter(u => u.role === "admin").length;
    const row = u => {
      const self = u.name === me.user, lastAdmin = u.role === "admin" && admins === 1;
      return `<div class="urow" data-user="${esc(u.name)}">
        <span class="avatar ${u.role === "admin" ? "" : "dim"}">${icon(u.role === "monitor" ? "visibility" : u.role === "admin" ? "admin_panel_settings" : "person")}</span>
        <span class="ltext"><b>${esc(u.name)}${self ? ` <em class="you">you</em>` : ""}</b><small class="muted">${esc(ROLE_HELP[u.role].split(":")[0].split(".")[0])}</small></span>
        <label class="urole">${roleSelect(u.name, u.role, `data-acc-role ${lastAdmin ? `disabled title="The last admin can't be changed"` : ""}`)}</label>
        <button type="button" class="icon-btn" data-acc-reset aria-label="Reset password of ${esc(u.name)}" title="Reset password">${icon("key")}</button>
        <button type="button" class="icon-btn" data-acc-delete aria-label="Delete ${esc(u.name)}" title="${lastAdmin ? "The last admin can't be deleted" : "Delete"}" ${lastAdmin ? "disabled" : ""}>${icon("delete")}</button>
      </div>${resetFor === u.name ? `<form class="ureset" data-acc-resetform="${esc(u.name)}" novalidate>
        <input type="text" name="username" autocomplete="off" value="${esc(u.name)}" hidden>
        <label class="textfield"><input type="password" name="pw" autocomplete="new-password" placeholder=" " required><span>New password for ${esc(u.name)}</span></label>
        <div class="set-actions"><button type="button" class="text-btn" data-acc-resetcancel>Cancel</button><button type="submit" class="filled-btn">${icon("check")}Set password</button></div>
        <p class="muted small">${self ? "You'll need to sign in again." : `${esc(u.name)} is signed out everywhere and uses this password next time.`}</p></form>` : ""}`;
    };
    el.innerHTML = `<div class="dhead"><span class="avatar big">${icon("manage_accounts")}</span>
        <div><h2>Users & access</h2><small class="lstat good"><i></i><span>${d.users.length} user${d.users.length === 1 ? "" : "s"} · ${admins} admin${admins === 1 ? "" : "s"}</span></small></div></div>
      <section class="set-card acc-card">
        <div class="acc-toggle"><span class="ltext"><b>Allow viewing without signing in</b>
          <small class="muted">Anyone on your home network can see readings and status ("Continue as viewer"). They can't control anything, see cameras or open settings.</small></span>
          <button type="button" class="m3-switch ${d.guest_view ? "on" : ""}" data-acc-guest role="switch" aria-checked="${d.guest_view}" aria-label="Allow viewing without signing in"></button></div>
      </section>
      <section class="lgroup"><div class="lgroup-head"><h3>Users</h3><small>Changing a role or password signs that person out</small></div>
        <div class="lcard ulist">${d.users.map(row).join("")}</div></section>
      <section class="set-card acc-card"><form id="acc-add" novalidate>
        <h3>${icon("person")}Add a user</h3>
        <label class="textfield"><input name="name" autocomplete="off" autocapitalize="none" spellcheck="false" maxlength="32" placeholder=" " required><span>Username</span></label>
        <label class="textfield"><input name="pw" type="password" autocomplete="new-password" placeholder=" " required><span>Password (${MIN_PW}+ characters)</span></label>
        <label class="textfield">${roleSelect("", "user", 'name="role"')}<span>Role</span></label>
        <ul class="acc-roles">${Object.keys(ROLE_LABEL).map(r => `<li><b>${ROLE_LABEL[r]}</b> ${esc(ROLE_HELP[r])}</li>`).join("")}</ul>
        <p class="acc-err" role="alert" hidden></p>
        <div class="set-actions"><button type="submit" class="filled-btn">${icon("check")}Add user</button></div>
      </form></section>`;
  }
  async function usersCall(el, path, method, body, ok) {
    const H = window.Haven;
    try { usersData = await H.api(path, { method, body: body ? JSON.stringify(body) : undefined }); if (ok) H.snack(ok); return true; }
    catch (x) { H.snack(x.message); return false; }
    finally { drawUsers(el); }
  }

  document.addEventListener("click", async e => {
    const page = e.target.closest(".acc-page"); if (!page) return;
    const H = window.Haven, t = e.target, el = $(".acc-body", page);
    if (t.closest("[data-acc-signout]")) return signOut();
    if (t.closest("[data-acc-signin]")) return showLogin({ keepSession: true, cancelable: true });
    if (!usersData) return;
    const gsw = t.closest("[data-acc-guest]");
    if (gsw) {
      const on = !usersData.guest_view;
      if (!on && !(await H.confirmAction("Turn off viewing without signing in?", "People viewing without an account are signed out and will need a username and password.", "visibility_off"))) return;
      return usersCall(el, "/api/auth/guest_view", "PUT", { enabled: on }, on ? "Anyone on your network can now view Haven" : "Viewing now needs an account");
    }
    const urow = t.closest("[data-user]"), name = urow?.dataset.user;
    if (t.closest("[data-acc-reset]") && name) { resetFor = resetFor === name ? null : name; drawUsers(el); $(`[data-acc-resetform] input[name=pw]`, el)?.focus(); return; }
    if (t.closest("[data-acc-resetcancel]")) { resetFor = null; drawUsers(el); return; }
    if (t.closest("[data-acc-delete]") && name) {
      if (!(await H.confirmAction(`Delete ${name}?`, "They're signed out everywhere and can't sign in again. This can't be undone.", "delete"))) return;
      const self = name === H.me?.user;
      if (await usersCall(el, `/api/users/${encodeURIComponent(name)}`, "DELETE", null, `${name} deleted`) && self) location.reload();
    }
  });
  document.addEventListener("change", async e => {
    const sel = e.target.closest(".acc-page [data-acc-role]"); if (!sel) return;
    const H = window.Haven, el = sel.closest(".acc-body"), name = sel.closest("[data-user]").dataset.user, role = sel.value;
    const self = name === H.me?.user;
    const ok = await H.confirmAction(`Make ${name} ${ROLE_LABEL[role] === "Admin" ? "an" : "a"} ${ROLE_LABEL[role]}?`,
      `${ROLE_HELP[role]} ${self ? "You'll be signed out and need to sign in again." : `${name} is signed out and signs in again with the same password.`}`, "manage_accounts");
    if (!ok) return drawUsers(el);
    if (await usersCall(el, `/api/users/${encodeURIComponent(name)}`, "PATCH", { role }, `${name} is now ${ROLE_LABEL[role]}`) && self) location.reload();
  });
  document.addEventListener("submit", async e => {
    const f = e.target; if (!f.closest?.(".acc-page")) return;
    const H = window.Haven, el = f.closest(".acc-body");
    if (f.id === "acc-add") {
      e.preventDefault();
      const err = $(".acc-err", f), fail = m => { err.hidden = false; err.innerHTML = `${icon("error")}<span>${esc(m)}</span>`; };
      const name = f.name.value.trim().toLowerCase();
      if (!/^[a-z0-9._-]{1,32}$/.test(name)) return fail("Usernames are 1–32 lowercase letters, digits, dot, dash or underscore.");
      if (f.pw.value.length < MIN_PW) return fail(`Use at least ${MIN_PW} characters for the password.`);
      try { usersData = await H.api("/api/users", { method: "POST", body: JSON.stringify({ name, password: f.pw.value, role: f.role.value }) });
        H.snack(`${name} added as ${ROLE_LABEL[f.role.value]}`); drawUsers(el); }
      catch (x) { fail(x.message); }
    } else if (f.dataset.accResetform) {
      e.preventDefault();
      const name = f.dataset.accResetform, pw = f.pw.value;
      if (pw.length < MIN_PW) return H.snack(`Use at least ${MIN_PW} characters for the password.`);
      resetFor = null;
      if (await usersCall(el, `/api/users/${encodeURIComponent(name)}`, "PATCH", { password: pw }, `New password set for ${name}`) && name === H.me?.user) location.reload();
    }
  });

  function render(page, el) {
    if (page === "users") { usersData = null; resetFor = null; el.innerHTML = `<p class="empty">Loading…</p>`; return loadUsers(el); }
    renderAccount(el);
  }

  window.HavenAccounts = { showLogin, showMustChange, hideLogin, render, signOut, ROLE_LABEL };
})();
