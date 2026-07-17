/* Core: state, API client (Netlify Blobs backend with localStorage fallback), auth, utils */
const PF = {
  state: {
    session: JSON.parse(localStorage.getItem("pf-session") || "null"),
    config: null,          // {googleClientId, authRequired}
    online: true,          // backend reachable?
    statement: null, accounts: null, rules: null, envelopes: null, kids: null, meta: null, settings: null,
    tx: {},                // {year: [transactions]}
    txYears: [],
  },

  fmt(n, opts = {}) {
    if (n === null || n === undefined || isNaN(n)) return "—";
    return n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: opts.cents === false ? 0 : 2, minimumFractionDigits: opts.cents === false ? 0 : 2 });
  },
  fmt0(n) { return PF.fmt(n, { cents: false }); },
  esc(s) { return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); },
  uid() { return Math.random().toString(36).slice(2, 10); },
  today() { return new Date().toISOString().slice(0, 10); },
  monthName(m) { return ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][m]; },

  toast(msg, bad = false) {
    const t = document.createElement("div");
    t.className = "toast" + (bad ? " bad" : "");
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.classList.add("show"), 10);
    setTimeout(() => { t.classList.remove("show"); setTimeout(() => t.remove(), 400); }, 3200);
  },

  // ---------- API ----------
  async api(path, opts = {}) {
    const headers = { "content-type": "application/json", ...(opts.headers || {}) };
    if (PF.state.session?.token) headers.authorization = "Bearer " + PF.state.session.token;
    const res = await fetch("/api/" + path, { ...opts, headers });
    if (res.status === 401 && PF.state.config?.authRequired) {
      PF.signOut(false);
      throw new Error("Session expired — please sign in again.");
    }
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `API error ${res.status}`);
    }
    return res.json();
  },

  // load a data key: backend first, localStorage fallback (offline/local dev)
  async load(key, fallback) {
    if (PF.state.online) {
      try {
        const val = await PF.api("data/" + key);
        if (val !== null) { localStorage.setItem("pf-" + key, JSON.stringify(val)); return val; }
        // backend empty: migrate any local copy up
        const local = JSON.parse(localStorage.getItem("pf-" + key) || "null");
        if (local) { PF.save(key, local); return local; }
        return fallback;
      } catch (e) { PF.state.online = false; }
    }
    return JSON.parse(localStorage.getItem("pf-" + key) || "null") ?? fallback;
  },

  async save(key, value) {
    PF.state[keyToState(key)] = value;
    localStorage.setItem("pf-" + key, JSON.stringify(value));
    if (PF.state.online) {
      try { await PF.api("data/" + key, { method: "PUT", body: JSON.stringify(value) }); }
      catch (e) { PF.state.online = false; PF.toast("Saved locally — backend unreachable", true); }
    }
    PF.updateSyncBadge();
  },

  async loadTx(years) {
    if (PF.state.online) {
      try {
        const out = await PF.api("tx?years=" + years.join(","));
        for (const [y, list] of Object.entries(out)) {
          PF.state.tx[y] = list;
          localStorage.setItem("pf-tx-" + y, JSON.stringify(list));
        }
        return;
      } catch { PF.state.online = false; }
    }
    for (const y of years) PF.state.tx[y] = JSON.parse(localStorage.getItem("pf-tx-" + y) || "[]");
  },

  async importTx(transactions) {
    // hash ids client-side too, for local mode dedupe
    for (const t of transactions) {
      if (!t.id) t.id = PF.txHash(t);
    }
    if (PF.state.online) {
      try {
        const r = await PF.api("tx/import", { method: "POST", body: JSON.stringify({ transactions }) });
        const years = [...new Set(transactions.map((t) => t.date.slice(0, 4)))];
        await PF.loadTx(years);
        return r;
      } catch { PF.state.online = false; }
    }
    // local fallback
    let added = 0, skipped = 0;
    const byYear = {};
    transactions.forEach((t) => (byYear[t.date.slice(0, 4)] ||= []).push(t));
    for (const [y, list] of Object.entries(byYear)) {
      const existing = JSON.parse(localStorage.getItem("pf-tx-" + y) || "[]");
      const seen = new Set(existing.map((t) => t.id));
      list.forEach((t) => { if (seen.has(t.id)) skipped++; else { existing.push(t); seen.add(t.id); added++; } });
      existing.sort((a, b) => (a.date < b.date ? 1 : -1));
      localStorage.setItem("pf-tx-" + y, JSON.stringify(existing));
      PF.state.tx[y] = existing;
    }
    return { added, skipped, local: true };
  },

  txHash(t) {
    const s = `${t.date}|${t.amount}|${t.desc}|${t.account}`;
    let h = 0;
    for (let i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) | 0; }
    return "loc" + Math.abs(h).toString(36) + s.length.toString(36);
  },

  async saveTxYear(year) {
    const list = PF.state.tx[year] || [];
    localStorage.setItem("pf-tx-" + year, JSON.stringify(list));
    if (PF.state.online) {
      try { await PF.api("data/tx-" + year, { method: "PUT", body: JSON.stringify(list) }); }
      catch { PF.state.online = false; }
    }
  },

  allTx() {
    return Object.values(PF.state.tx).flat();
  },

  // ---------- auth ----------
  async initAuth() {
    try { PF.state.config = await PF.api("config"); PF.state.online = true; }
    catch { PF.state.config = { authRequired: false, googleClientId: null }; PF.state.online = false; }

    if (!PF.state.config.authRequired) return true;             // setup mode / no client id yet
    if (PF.state.session?.token) {
      try { await PF.api("whoami"); return true; } catch { /* fall through to sign-in */ }
    }
    return false;
  },

  showSignIn() {
    document.getElementById("signin-overlay").style.display = "flex";
    if (PF.state.config.authMode === "password") {
      document.getElementById("pw-form").style.display = "flex";
      document.getElementById("pw-input").focus();
      document.getElementById("pw-form").addEventListener("submit", async (e) => {
        e.preventDefault();
        try {
          const r = await PF.api("auth/password", { method: "POST", body: JSON.stringify({ password: document.getElementById("pw-input").value }) });
          PF.state.session = r;
          localStorage.setItem("pf-session", JSON.stringify(r));
          document.getElementById("signin-overlay").style.display = "none";
          App.start();
        } catch (err) { document.getElementById("signin-error").textContent = err.message; }
      });
      return;
    }
    const gsi = document.createElement("script");
    gsi.src = "https://accounts.google.com/gsi/client";
    gsi.onload = () => {
      google.accounts.id.initialize({
        client_id: PF.state.config.googleClientId,
        callback: async (resp) => {
          try {
            const r = await PF.api("auth/google", { method: "POST", body: JSON.stringify({ credential: resp.credential }) });
            PF.state.session = r;
            localStorage.setItem("pf-session", JSON.stringify(r));
            document.getElementById("signin-overlay").style.display = "none";
            App.start();
          } catch (e) { document.getElementById("signin-error").textContent = e.message; }
        },
      });
      google.accounts.id.renderButton(document.getElementById("gsi-button"), { theme: "filled_black", size: "large", shape: "pill", width: 280 });
    };
    document.head.appendChild(gsi);
  },

  signOut(reload = true) {
    PF.state.session = null;
    localStorage.removeItem("pf-session");
    if (reload) location.reload();
  },

  updateSyncBadge() {
    const el = document.getElementById("sync-badge");
    if (!el) return;
    if (PF.state.online) { el.textContent = "● synced"; el.className = "sync ok"; }
    else { el.textContent = "● local only"; el.className = "sync off"; }
  },
};

function keyToState(key) {
  return key; // data keys map 1:1 onto PF.state slots
}
