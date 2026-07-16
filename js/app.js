/* App boot, router, seed data */
const App = {
  routes: {
    dashboard: { title: "Dashboard", icon: "🏠" },
    statement: { title: "Statement", icon: "📄", wire: "wireStatement" },
    register: { title: "Register", icon: "🧾", wire: "wireRegister" },
    reports: { title: "Reports", icon: "📊", wire: "wireReports" },
    envelopes: { title: "Envelopes", icon: "✉️", wire: "wireEnvelopes" },
    kids: { title: "Kids", icon: "🧒" },
    accounts: { title: "Accounts", icon: "🏦", wire: "wireAccounts" },
    settings: { title: "Settings", icon: "⚙️", wire: "wireSettings" },
  },

  seeds: {
    statement: {
      preparedFor: "", asOf: new Date().toISOString().slice(0, 10),
      assets: [
        { cat: "Cash & Bank Accounts", name: "UCCU Checking" },
        { cat: "Cash & Bank Accounts", name: "Relay — Main Checking" },
        { cat: "Cash & Bank Accounts", name: "Relay — Envelope accounts (combined)" },
        { cat: "Investments & Retirement", name: "Investor360 portfolio (via financial advisor)" },
        { cat: "Real Estate", name: "Primary residence (market value)" },
        { cat: "Real Estate", name: "WA real estate investments (see starlar.com)" },
        { cat: "Business Interests", name: "Business ownership interest(s)" },
        { cat: "Vehicles", name: "Vehicles (combined)" },
      ].map((a) => ({ id: Math.random().toString(36).slice(2, 10), category: a.cat, name: a.name, value: 0, notes: "" })),
      liabilities: [
        { cat: "Mortgages", name: "TriState mortgage — primary residence" },
        { cat: "Mortgages", name: "Mortgage(s) — WA properties" },
        { cat: "Credit Cards", name: "Discover Card" },
        { cat: "Auto & Other Loans", name: "" },
      ].map((a) => ({ id: Math.random().toString(36).slice(2, 10), category: a.cat, name: a.name, balance: 0, notes: "" })),
      income: [{ id: "inc1", source: "Household income (combined)", annual: 0 }],
      history: [],
    },
    accounts: [
      { name: "UCCU Checking", institution: "UCCU", type: "checking", url: "https://www.uccu.com" },
      { name: "Relay — Main", institution: "Relay", type: "checking", url: "https://relayfi.com" },
      { name: "Discover Card", institution: "Discover", type: "credit card", url: "https://www.discover.com" },
      { name: "Venmo", institution: "Venmo", type: "p2p", url: "https://venmo.com" },
      { name: "Zelle (via UCCU)", institution: "UCCU", type: "p2p", url: "" },
      { name: "Investor360 portfolio", institution: "Financial advisor", type: "investment", url: "https://www.investor360.com" },
      { name: "WA real estate", institution: "Starlar", type: "real estate", url: "https://starlar.com" },
    ].map((a) => ({ id: Math.random().toString(36).slice(2, 10), balance: null, ...a })),
    rules: [],
    envelopes: { monthlyIncome: 0, envelopes: [] },
    kids: { kids: [], entries: [] },
  },

  setTheme(name) {
    document.documentElement.dataset.theme = name;
    localStorage.setItem("pf-theme", name);
    const sel = document.getElementById("theme-select");
    if (sel) sel.value = name;
  },

  async start() {
    const sel = document.getElementById("theme-select");
    if (sel) sel.value = localStorage.getItem("pf-theme") || "evergreen";
    document.getElementById("app").style.display = "flex";
    PF.state.statement = await PF.load("statement", App.seeds.statement);
    PF.state.accounts = await PF.load("accounts", App.seeds.accounts);
    PF.state.rules = await PF.load("rules", App.seeds.rules);
    PF.state.envelopes = await PF.load("envelopes", App.seeds.envelopes);
    PF.state.kids = await PF.load("kids", App.seeds.kids);
    PF.state.meta = await PF.load("meta", null);
    // load transactions: known years from backend, else current + last year
    let years = [];
    if (PF.state.online) { try { years = await PF.api("tx/years"); } catch {} }
    if (!years.length) {
      const y = new Date().getFullYear();
      years = [String(y - 1), String(y)];
      // include any local years too
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k?.startsWith("pf-tx-")) years.push(k.slice(6));
      }
      years = [...new Set(years)];
    }
    await PF.loadTx(years);
    PF.updateSyncBadge();
    window.addEventListener("hashchange", () => App.render());
    App.render();
  },

  render() {
    const route = (location.hash || "#dashboard").slice(1).split("?")[0];
    const page = App.routes[route] ? route : "dashboard";
    document.getElementById("nav").innerHTML = Object.entries(App.routes)
      .map(([r, cfg]) => `<a href="#${r}" class="${r === page ? "active" : ""}"><span class="icon">${cfg.icon}</span><span>${cfg.title}</span></a>`)
      .join("");
    document.getElementById("page").innerHTML = Pages[page]();
    const wire = App.routes[page].wire;
    if (wire && Pages[wire]) Pages[wire]();
  },
};

(async function boot() {
  const ok = await PF.initAuth();
  if (ok) App.start();
  else PF.showSignIn();
})();
