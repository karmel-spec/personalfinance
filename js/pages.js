/* Page renderers. Each returns HTML into #page and wires events. */
const Pages = {};
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const SPEND_EXCLUDE = new Set(["Income", "Transfers & P2P", "Investing", "Credit Card Payment"]);

function spendTx(list) {
  return list.filter((t) => t.amount < 0 && !SPEND_EXCLUDE.has(t.category));
}
function monthKey(d) { return d.slice(0, 7); }

/* ---------------- DASHBOARD ---------------- */
Pages.dashboard = function () {
  const st = PF.state.statement;
  const totalAssets = st.assets.reduce((s, a) => s + (+a.value || 0), 0);
  const totalLiab = st.liabilities.reduce((s, a) => s + (+a.balance || 0), 0);
  const net = totalAssets - totalLiab;

  const nowMonth = monthKey(PF.today());
  const monthTx = PF.allTx().filter((t) => monthKey(t.date) === nowMonth);
  const monthSpend = spendTx(monthTx).reduce((s, t) => s + Math.abs(t.amount), 0);
  const monthIncome = monthTx.filter((t) => t.category === "Income").reduce((s, t) => s + t.amount, 0);

  const catTotals = {};
  spendTx(monthTx).forEach((t) => (catTotals[t.category] = (catTotals[t.category] || 0) + Math.abs(t.amount)));
  const topCats = Object.entries(catTotals).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const maxCat = topCats[0]?.[1] || 1;

  const kids = PF.state.kids;
  const kidBalances = kids.kids.map((k) => {
    const open = kids.entries.filter((e) => e.kidId === k.id && e.status === "open");
    const bal = open.reduce((s, e) => s + (e.direction === "we-owe" ? e.amount : -e.amount), 0);
    return { name: k.name, bal };
  }).filter((k) => k.bal !== 0);

  const meta = PF.state.meta || {};
  return `
  <div class="page-head"><h1>Dashboard</h1>
    <div class="muted">${meta.lastUpdated ? "Last update " + new Date(meta.lastUpdated).toLocaleString() + " by " + PF.esc(meta.lastUpdatedBy || "") : "No updates logged yet"}</div>
  </div>
  <div class="cards">
    <div class="card stat"><div class="label">Net worth</div><div class="big">${PF.fmt0(net)}</div>
      <div class="sub">${PF.fmt0(totalAssets)} assets · ${PF.fmt0(totalLiab)} liabilities</div>
      <a href="#statement" class="cardlink">Open statement →</a></div>
    <div class="card stat"><div class="label">Spending — ${PF.monthName(+nowMonth.slice(5) - 1)} ${nowMonth.slice(0, 4)}</div>
      <div class="big">${PF.fmt0(monthSpend)}</div>
      <div class="sub">${monthIncome ? PF.fmt0(monthIncome) + " income logged" : "No income logged this month"}</div>
      <a href="#register" class="cardlink">Open register →</a></div>
    <div class="card stat"><div class="label">Kid ledger</div>
      ${kidBalances.length ? kidBalances.map((k) => `<div class="kidrow"><span>${PF.esc(k.name)}</span><b class="${k.bal > 0 ? "neg" : "pos"}">${k.bal > 0 ? "we owe " : "owes us "}${PF.fmt(Math.abs(k.bal))}</b></div>`).join("") : '<div class="sub">All settled 🎉</div>'}
      <a href="#kids" class="cardlink">Open kid ledger →</a></div>
  </div>
  <div class="cards">
    <div class="card" style="flex:2">
      <h3>Top categories this month</h3>
      ${topCats.length ? topCats.map(([c, v]) => `
        <div class="bar-row"><span class="bar-label">${PF.esc(c)}</span>
          <div class="bar-track"><div class="bar-fill" style="width:${(v / maxCat) * 100}%"></div></div>
          <span class="bar-val">${PF.fmt0(v)}</span></div>`).join("")
      : '<p class="muted">No transactions yet — import a CSV in the <a href="#register">Register</a> to light this up.</p>'}
    </div>
    <div class="card" style="flex:1">
      <h3>Quick actions</h3>
      <a class="btn block" href="#register" onclick="setTimeout(()=>document.getElementById('csv-file')?.click(),300)">📥 Import bank CSV</a>
      <a class="btn block" href="#statement">🖨️ Print statement for banker</a>
      <a class="btn block" href="#kids">👧 Log kid money</a>
      <a class="btn block" href="#reports">📊 Monthly report</a>
    </div>
  </div>`;
};

/* ---------------- STATEMENT ---------------- */
Pages.statement = function () {
  const st = PF.state.statement;
  const totalAssets = st.assets.reduce((s, a) => s + (+a.value || 0), 0);
  const totalLiab = st.liabilities.reduce((s, a) => s + (+a.balance || 0), 0);
  const net = totalAssets - totalLiab;
  const totalIncome = (st.income || []).reduce((s, a) => s + (+a.annual || 0), 0);

  const assetCats = ["Cash & Bank Accounts", "Investments & Retirement", "Real Estate", "Business Interests", "Vehicles", "Other Assets"];
  const liabCats = ["Mortgages", "Credit Cards", "Auto & Other Loans", "Other Liabilities"];

  const section = (items, cats, kind) => cats.map((cat) => {
    const rows = items.filter((i) => i.category === cat);
    return `
    <tr class="cat-row"><td colspan="4">${cat}
      <button class="mini no-print" onclick="Pages.addStatementRow('${kind}','${cat}')">+ add</button></td></tr>
    ${rows.map((i) => `
      <tr data-id="${i.id}">
        <td><input class="cell" data-kind="${kind}" data-id="${i.id}" data-f="name" value="${PF.esc(i.name)}"></td>
        <td><input class="cell num" data-kind="${kind}" data-id="${i.id}" data-f="${kind === "assets" ? "value" : "balance"}" value="${(+i.value || +i.balance || 0) || ""}" placeholder="0"></td>
        <td><input class="cell" data-kind="${kind}" data-id="${i.id}" data-f="notes" value="${PF.esc(i.notes || "")}" placeholder="notes"></td>
        <td class="no-print"><button class="mini danger" onclick="Pages.delStatementRow('${kind}','${i.id}')">✕</button></td>
      </tr>`).join("")}`;
  }).join("");

  return `
  <div class="page-head"><h1>Personal Financial Statement</h1>
    <div class="head-actions no-print">
      <button class="btn" onclick="Pages.snapshotStatement()">📸 Save monthly snapshot</button>
      <button class="btn" onclick="window.print()">🖨️ Print / Save as PDF</button>
      <button class="btn" onclick="Pages.emailStatement()">✉️ Email to banker</button>
    </div>
  </div>
  <div class="statement-doc" id="statement-doc">
    <div class="pfs-header">
      <div>
        <div class="pfs-title">Personal Financial Statement</div>
        <div class="pfs-sub">Prepared for: <input class="cell inline" data-kind="root" data-f="preparedFor" value="${PF.esc(st.preparedFor || "")}" placeholder="Name(s)"></div>
      </div>
      <div class="pfs-date">As of <input class="cell inline" type="date" data-kind="root" data-f="asOf" value="${st.asOf || PF.today()}"></div>
    </div>

    <div class="pfs-grid">
      <div>
        <h3 class="pfs-h">Assets</h3>
        <table class="pfs-table"><thead><tr><th>Description</th><th class="r">Value</th><th>Notes</th><th class="no-print"></th></tr></thead>
        <tbody>${section(st.assets, assetCats, "assets")}</tbody>
        <tfoot><tr><td>Total assets</td><td class="r"><b>${PF.fmt(totalAssets)}</b></td><td></td><td class="no-print"></td></tr></tfoot></table>
      </div>
      <div>
        <h3 class="pfs-h">Liabilities</h3>
        <table class="pfs-table"><thead><tr><th>Description</th><th class="r">Balance</th><th>Notes</th><th class="no-print"></th></tr></thead>
        <tbody>${section(st.liabilities, liabCats, "liabilities")}</tbody>
        <tfoot><tr><td>Total liabilities</td><td class="r"><b>${PF.fmt(totalLiab)}</b></td><td></td><td class="no-print"></td></tr></tfoot></table>

        <div class="networth-box">Net worth <b>${PF.fmt(net)}</b></div>
      </div>
    </div>

    <h3 class="pfs-h">Annual income</h3>
    <table class="pfs-table half"><tbody>
      ${(st.income || []).map((i) => `<tr>
        <td><input class="cell" data-kind="income" data-id="${i.id}" data-f="source" value="${PF.esc(i.source)}"></td>
        <td><input class="cell num" data-kind="income" data-id="${i.id}" data-f="annual" value="${+i.annual || ""}" placeholder="0"></td>
        <td class="no-print"><button class="mini danger" onclick="Pages.delStatementRow('income','${i.id}')">✕</button></td></tr>`).join("")}
      <tr class="no-print"><td colspan="3"><button class="mini" onclick="Pages.addStatementRow('income','')">+ add income source</button></td></tr>
    </tbody><tfoot><tr><td>Total annual income</td><td class="r"><b>${PF.fmt(totalIncome)}</b></td><td class="no-print"></td></tr></tfoot></table>

    <div class="pfs-sign">
      <div>Signature ______________________________ &nbsp; Date ____________</div>
      <div>Signature ______________________________ &nbsp; Date ____________</div>
    </div>
    <div class="pfs-foot muted">This statement is provided for lending review. Figures are estimates as of the date shown.</div>
  </div>

  <div class="card no-print" style="margin-top:18px">
    <h3>Snapshot history</h3>
    ${st.history?.length ? `<table class="table"><thead><tr><th>As of</th><th class="r">Assets</th><th class="r">Liabilities</th><th class="r">Net worth</th></tr></thead>
      <tbody>${st.history.slice().reverse().map((h) => `<tr><td>${h.asOf}</td><td class="r">${PF.fmt0(h.assets)}</td><td class="r">${PF.fmt0(h.liabilities)}</td><td class="r"><b>${PF.fmt0(h.netWorth)}</b></td></tr>`).join("")}</tbody></table>`
    : '<p class="muted">No snapshots yet. Save one each month (or let the Hermes agent do it via the API) to build the year-over-year picture.</p>'}
  </div>`;
};

Pages.wireStatement = function () {
  $$(".cell").forEach((inp) => inp.addEventListener("change", () => {
    const st = PF.state.statement;
    const { kind, id, f } = inp.dataset;
    const val = inp.classList.contains("num") ? (parseFloat(inp.value.replace(/[$,]/g, "")) || 0) : inp.value;
    if (kind === "root") st[f] = val;
    else {
      const item = st[kind].find((x) => x.id === id);
      if (item) item[f] = val;
    }
    PF.save("statement", st).then(() => App.render());
  }));
};

Pages.addStatementRow = function (kind, cat) {
  const st = PF.state.statement;
  const row = kind === "income"
    ? { id: PF.uid(), source: "", annual: 0 }
    : kind === "assets"
      ? { id: PF.uid(), category: cat, name: "", value: 0, notes: "" }
      : { id: PF.uid(), category: cat, name: "", balance: 0, notes: "" };
  st[kind].push(row);
  PF.save("statement", st).then(() => App.render());
};

Pages.delStatementRow = function (kind, id) {
  const st = PF.state.statement;
  st[kind] = st[kind].filter((x) => x.id !== id);
  PF.save("statement", st).then(() => App.render());
};

Pages.snapshotStatement = function () {
  const st = PF.state.statement;
  const assets = st.assets.reduce((s, a) => s + (+a.value || 0), 0);
  const liabilities = st.liabilities.reduce((s, a) => s + (+a.balance || 0), 0);
  st.history = (st.history || []).filter((h) => h.asOf !== st.asOf);
  st.history.push({ asOf: st.asOf || PF.today(), assets, liabilities, netWorth: assets - liabilities });
  st.history.sort((a, b) => (a.asOf < b.asOf ? -1 : 1));
  PF.save("statement", st).then(() => { PF.toast("Snapshot saved"); App.render(); });
};

Pages.emailStatement = function () {
  const st = PF.state.statement;
  const assets = st.assets.reduce((s, a) => s + (+a.value || 0), 0);
  const liabilities = st.liabilities.reduce((s, a) => s + (+a.balance || 0), 0);
  const body = [
    `Personal Financial Statement — as of ${st.asOf || PF.today()}`,
    `Prepared for: ${st.preparedFor || ""}`,
    ``,
    `Total assets: ${PF.fmt(assets)}`,
    `Total liabilities: ${PF.fmt(liabilities)}`,
    `Net worth: ${PF.fmt(assets - liabilities)}`,
    ``,
    `A signed PDF copy is attached. (Print the statement page and choose "Save as PDF", then attach it to this email.)`,
  ].join("\n");
  location.href = `mailto:?subject=${encodeURIComponent("Personal Financial Statement — " + (st.asOf || PF.today()))}&body=${encodeURIComponent(body)}`;
};

/* ---------------- REGISTER ---------------- */
Pages.registerFilters = { month: "", account: "", category: "", q: "" };

Pages.register = function () {
  const f = Pages.registerFilters;
  let list = PF.allTx();
  const months = [...new Set(list.map((t) => monthKey(t.date)))].sort().reverse();
  const accounts = [...new Set(list.map((t) => t.account))].sort();
  const cats = [...new Set(list.map((t) => t.category))].sort();

  if (f.month) list = list.filter((t) => monthKey(t.date) === f.month);
  if (f.account) list = list.filter((t) => t.account === f.account);
  if (f.category) list = list.filter((t) => t.category === f.category);
  if (f.q) list = list.filter((t) => (t.desc || "").toLowerCase().includes(f.q.toLowerCase()));
  list = list.slice().sort((a, b) => (a.date < b.date ? 1 : -1));
  const shown = list.slice(0, 400);
  const total = list.reduce((s, t) => s + t.amount, 0);

  const allCats = [...new Set([...cats, ...Importer.builtinRules.map((r) => r[1]), "Uncategorized", "Kids & School", "Credit Card Payment"])].sort();

  return `
  <div class="page-head"><h1>Spending Register</h1>
    <div class="head-actions">
      <label class="btn primary">📥 Import CSV<input type="file" id="csv-file" accept=".csv,text/csv" multiple hidden></label>
    </div>
  </div>
  <div class="card">
    <div class="filters">
      <select id="f-month"><option value="">All months</option>${months.map((m) => `<option ${f.month === m ? "selected" : ""}>${m}</option>`).join("")}</select>
      <select id="f-account"><option value="">All accounts</option>${accounts.map((a) => `<option ${f.account === a ? "selected" : ""}>${PF.esc(a)}</option>`).join("")}</select>
      <select id="f-category"><option value="">All categories</option>${cats.map((c) => `<option ${f.category === c ? "selected" : ""}>${PF.esc(c)}</option>`).join("")}</select>
      <input id="f-q" placeholder="Search description…" value="${PF.esc(f.q)}">
      <span class="muted">${list.length} transactions · net ${PF.fmt(total)}</span>
    </div>
    ${list.length ? `<table class="table tx-table"><thead><tr><th>Date</th><th>Description</th><th>Account</th><th>Category</th><th class="r">Amount</th></tr></thead>
    <tbody>${shown.map((t) => `
      <tr><td class="nowrap">${t.date}</td><td>${PF.esc(t.desc)}</td><td class="muted nowrap">${PF.esc(t.account)}</td>
      <td><select class="cat-select" data-id="${t.id}" data-year="${t.date.slice(0, 4)}">
        ${allCats.map((c) => `<option ${t.category === c ? "selected" : ""}>${PF.esc(c)}</option>`).join("")}</select></td>
      <td class="r ${t.amount < 0 ? "neg" : "pos"}">${PF.fmt(t.amount)}</td></tr>`).join("")}</tbody></table>
      ${list.length > 400 ? `<p class="muted">Showing first 400 — narrow the filters to see more.</p>` : ""}`
    : `<div class="empty">
        <h3>No transactions yet</h3>
        <p>Export a CSV from UCCU, Relay, Discover, or Venmo and drop it here. Each bank's format is auto-detected, transactions are auto-categorized, and re-imports never duplicate.</p>
        <p class="muted">UCCU: Online banking → Accounts → Export → CSV · Relay: Transactions → Export · Discover: Activity → Download → CSV (pick "All available" for history) · Venmo: Statements → Download CSV per month</p>
      </div>`}
  </div>
  <div id="import-preview"></div>`;
};

Pages.wireRegister = function () {
  ["month", "account", "category"].forEach((k) => {
    $("#f-" + k)?.addEventListener("change", (e) => { Pages.registerFilters[k] = e.target.value; App.render(); });
  });
  $("#f-q")?.addEventListener("input", (e) => {
    Pages.registerFilters.q = e.target.value;
    clearTimeout(Pages._qT); Pages._qT = setTimeout(() => App.render(), 350);
  });
  $$(".cat-select").forEach((sel) => sel.addEventListener("change", async () => {
    const { id, year } = sel.dataset;
    const tx = (PF.state.tx[year] || []).find((t) => t.id === id);
    if (!tx) return;
    tx.category = sel.value;
    await PF.saveTxYear(year);
    // offer to make it a rule
    const merchant = (tx.desc || "").split(/\s{2,}|#|\*/)[0].trim().slice(0, 24);
    if (merchant.length > 3 && confirm(`Always file "${merchant}" under ${sel.value}?`)) {
      PF.state.rules.push({ pattern: merchant, category: sel.value });
      await PF.save("rules", PF.state.rules);
      PF.toast(`Rule saved: ${merchant} → ${sel.value}`);
    }
  }));
  $("#csv-file")?.addEventListener("change", async (e) => {
    const files = [...e.target.files];
    if (!files.length) return;
    for (const file of files) {
      const text = await file.text();
      const label = prompt(`Which account is "${file.name}" from?\n(e.g. UCCU Checking, Relay Main, Discover, Venmo)`, guessAccount(file.name)) || file.name;
      try {
        const { transactions, preset } = Importer.process(text, label, PF.state.rules);
        if (!transactions.length) { PF.toast(`No usable rows in ${file.name}`, true); continue; }
        const r = await PF.importTx(transactions);
        PF.toast(`${file.name} (${preset.label}): ${r.added} added, ${r.skipped} duplicates skipped`);
      } catch (err) { PF.toast(`${file.name}: ${err.message}`, true); }
    }
    const years = [...new Set(PF.allTx().map((t) => t.date.slice(0, 4)))];
    await PF.loadTx(years);
    App.render();
  });
};

function guessAccount(name) {
  const n = name.toLowerCase();
  if (n.includes("discover")) return "Discover Card";
  if (n.includes("relay")) return "Relay";
  if (n.includes("uccu")) return "UCCU Checking";
  if (n.includes("venmo")) return "Venmo";
  return "";
}

/* ---------------- REPORTS ---------------- */
Pages.reportsView = { mode: "month", month: monthKey(new Date().toISOString()) };

Pages.reports = function () {
  const all = PF.allTx();
  if (!all.length) return `<div class="page-head"><h1>Reports</h1></div>
    <div class="card empty"><h3>Nothing to report yet</h3><p>Import CSVs in the <a href="#register">Register</a> first — then this page turns into your monthly & annual spending story.</p></div>`;

  const v = Pages.reportsView;
  const months = [...new Set(all.map((t) => monthKey(t.date)))].sort().reverse();
  if (!months.includes(v.month)) v.month = months[0];
  const years = [...new Set(all.map((t) => t.date.slice(0, 4)))].sort();

  // month view
  const monthTx = all.filter((t) => monthKey(t.date) === v.month);
  const cat = {};
  spendTx(monthTx).forEach((t) => (cat[t.category] = (cat[t.category] || 0) + Math.abs(t.amount)));
  const rows = Object.entries(cat).sort((a, b) => b[1] - a[1]);
  const totalSpend = rows.reduce((s, r) => s + r[1], 0);
  const income = monthTx.filter((t) => t.category === "Income").reduce((s, t) => s + t.amount, 0);
  const max = rows[0]?.[1] || 1;

  // prior month for insights
  const prevMonth = months[months.indexOf(v.month) + 1];
  const prevCat = {};
  if (prevMonth) spendTx(all.filter((t) => monthKey(t.date) === prevMonth)).forEach((t) => (prevCat[t.category] = (prevCat[t.category] || 0) + Math.abs(t.amount)));

  // annual comparison table
  const byYearCat = {};
  years.forEach((y) => (byYearCat[y] = {}));
  spendTx(all).forEach((t) => {
    const y = t.date.slice(0, 4);
    byYearCat[y][t.category] = (byYearCat[y][t.category] || 0) + Math.abs(t.amount);
  });
  const allCats = [...new Set(spendTx(all).map((t) => t.category))].sort(
    (a, b) => (byYearCat[years.at(-1)][b] || 0) - (byYearCat[years.at(-1)][a] || 0));

  return `
  <div class="page-head"><h1>Reports</h1>
    <div class="head-actions no-print"><button class="btn" onclick="window.print()">🖨️ Print for family council</button></div>
  </div>
  <div class="card">
    <div class="filters no-print">
      <label>Month <select id="r-month">${months.map((m) => `<option ${v.month === m ? "selected" : ""}>${m}</option>`).join("")}</select></label>
    </div>
    <h3>${v.month}: spent ${PF.fmt0(totalSpend)}${income ? ` · income ${PF.fmt0(income)} · ${income - totalSpend >= 0 ? "saved " + PF.fmt0(income - totalSpend) : "overspent by " + PF.fmt0(totalSpend - income)}` : ""}</h3>
    ${rows.map(([c, vv]) => {
      const delta = prevMonth && prevCat[c] !== undefined ? vv - prevCat[c] : null;
      return `<div class="bar-row"><span class="bar-label">${PF.esc(c)}</span>
        <div class="bar-track"><div class="bar-fill" style="width:${(vv / max) * 100}%"></div></div>
        <span class="bar-val">${PF.fmt0(vv)} <small class="muted">${(vv / totalSpend * 100).toFixed(0)}%</small>
        ${delta !== null && Math.abs(delta) > 20 ? `<small class="${delta > 0 ? "neg" : "pos"}">${delta > 0 ? "▲" : "▼"}${PF.fmt0(Math.abs(delta))}</small>` : ""}</span></div>`;
    }).join("")}
  </div>

  <div class="card">
    <h3>Observations</h3>
    <ul class="insights">${Pages.insights(rows, totalSpend, income, prevMonth, prevCat).map((i) => `<li>${i}</li>`).join("")}</ul>
    <p class="muted">General budgeting observations from your own numbers — not financial or investment advice.</p>
  </div>

  <div class="card">
    <h3>Year-over-year by category</h3>
    <div class="scroll-x"><table class="table"><thead><tr><th>Category</th>${years.map((y) => `<th class="r">${y}</th>`).join("")}</tr></thead>
    <tbody>${allCats.map((c) => `<tr><td>${PF.esc(c)}</td>${years.map((y) => `<td class="r">${byYearCat[y][c] ? PF.fmt0(byYearCat[y][c]) : "—"}</td>`).join("")}</tr>`).join("")}
    <tr class="total-row"><td><b>Total</b></td>${years.map((y) => `<td class="r"><b>${PF.fmt0(Object.values(byYearCat[y]).reduce((s, x) => s + x, 0))}</b></td>`).join("")}</tr></tbody></table></div>
    <p class="muted">Import older CSVs (as far back as each bank allows) and this table fills in automatically for true annual comparison.</p>
  </div>`;
};

Pages.insights = function (rows, totalSpend, income, prevMonth, prevCat) {
  const out = [];
  if (!rows.length) return ["Import more months to see patterns."];
  const [topCat, topVal] = rows[0];
  out.push(`Biggest category: <b>${PF.esc(topCat)}</b> at ${PF.fmt0(topVal)} (${(topVal / totalSpend * 100).toFixed(0)}% of spending).`);
  const dining = rows.find((r) => r[0] === "Dining Out")?.[1] || 0;
  const groceries = rows.find((r) => r[0] === "Groceries")?.[1] || 0;
  if (dining && groceries && dining > groceries * 0.6)
    out.push(`Dining Out (${PF.fmt0(dining)}) is ${(dining / groceries * 100).toFixed(0)}% of the grocery bill — a classic envelope to tighten first.`);
  const subs = rows.find((r) => r[0] === "Subscriptions")?.[1] || 0;
  if (subs > 50) out.push(`Subscriptions total ${PF.fmt0(subs)}/mo (${PF.fmt0(subs * 12)}/yr). Worth a cancel-audit pass.`);
  if (prevMonth) {
    const deltas = rows.map(([c, v]) => [c, v - (prevCat[c] || 0)]).sort((a, b) => b[1] - a[1]);
    if (deltas[0] && deltas[0][1] > 100) out.push(`Biggest jump vs ${prevMonth}: <b>${PF.esc(deltas[0][0])}</b> up ${PF.fmt0(deltas[0][1])}.`);
  }
  if (income > 0) {
    const rate = ((income - totalSpend) / income) * 100;
    out.push(rate >= 0 ? `You kept ${rate.toFixed(0)}% of income this month.` : `Spending exceeded logged income by ${PF.fmt0(totalSpend - income)}.`);
  }
  const env = PF.state.envelopes;
  if (env?.monthlyIncome > 0 && env.envelopes?.length) {
    out.push(`Envelope plan allocates ${env.envelopes.reduce((s, e) => s + (+e.pct || 0), 0)}% of ${PF.fmt0(env.monthlyIncome)} — check the <a href="#envelopes">Envelopes</a> page against actuals.`);
  }
  return out;
};

Pages.wireReports = function () {
  $("#r-month")?.addEventListener("change", (e) => { Pages.reportsView.month = e.target.value; App.render(); });
};

/* ---------------- ENVELOPES ---------------- */
Pages.envelopes = function () {
  const env = PF.state.envelopes;
  const totalPct = env.envelopes.reduce((s, e) => s + (+e.pct || 0), 0);
  const income = +env.monthlyIncome || 0;
  return `
  <div class="page-head"><h1>Profit First Envelopes</h1>
    <div class="head-actions"><button class="btn" onclick="Pages.pfPreset()">Load Profit First starter %</button></div>
  </div>
  <div class="card">
    <p>Every dollar of income gets a job the day it arrives. Set the percentages here, then move the money into the matching <b>Relay account</b> on the 10th &amp; 25th (Profit First rhythm). The register shows whether real spending stayed inside each envelope.</p>
    <div class="filters"><label>Monthly take-home income <input id="env-income" class="num" value="${income || ""}" placeholder="e.g. 12000"></label></div>
    <table class="table"><thead><tr><th>Envelope</th><th class="r">%</th><th class="r">$ / month</th><th>Relay account it maps to</th><th></th></tr></thead>
    <tbody>${env.envelopes.map((e) => `
      <tr><td><input class="cell env-cell" data-id="${e.id}" data-f="name" value="${PF.esc(e.name)}"></td>
      <td class="r"><input class="cell num env-cell" style="width:60px" data-id="${e.id}" data-f="pct" value="${+e.pct || ""}"></td>
      <td class="r"><b>${PF.fmt0(income * (+e.pct || 0) / 100)}</b></td>
      <td><input class="cell env-cell" data-id="${e.id}" data-f="account" value="${PF.esc(e.account || "")}" placeholder="e.g. Relay – Groceries"></td>
      <td><button class="mini danger" onclick="Pages.delEnvelope('${e.id}')">✕</button></td></tr>`).join("")}
    </tbody>
    <tfoot><tr><td><button class="mini" onclick="Pages.addEnvelope()">+ add envelope</button></td>
      <td class="r ${totalPct === 100 ? "pos" : "neg"}"><b>${totalPct}%</b></td>
      <td class="r"><b>${PF.fmt0(income * totalPct / 100)}</b></td>
      <td colspan="2" class="${totalPct === 100 ? "pos" : "neg"}">${totalPct === 100 ? "✓ every dollar has a job" : totalPct < 100 ? (100 - totalPct) + "% unallocated" : "over-allocated by " + (totalPct - 100) + "%"}</td></tr></tfoot></table>
    <p class="muted">Why the Relay version “wasn't working”: percentages only work when the transfer is <i>automatic and first</i>, the envelopes match real categories, and there's a small buffer envelope for surprises. This page gives each Relay account a target so the auto-transfer rules have a spec to follow.</p>
  </div>`;
};

Pages.pfPreset = function () {
  const env = PF.state.envelopes;
  env.envelopes = [
    ["Giving / Tithing", 10], ["Savings (pay yourself first)", 5], ["Fixed costs (mortgage, utilities, insurance)", 50],
    ["Groceries & household", 12], ["Everyday spending", 10], ["Kids", 5], ["Fun & vacation", 5], ["Buffer", 3],
  ].map(([name, pct]) => ({ id: PF.uid(), name, pct, account: "" }));
  PF.save("envelopes", env).then(() => App.render());
};
Pages.addEnvelope = function () {
  PF.state.envelopes.envelopes.push({ id: PF.uid(), name: "", pct: 0, account: "" });
  PF.save("envelopes", PF.state.envelopes).then(() => App.render());
};
Pages.delEnvelope = function (id) {
  PF.state.envelopes.envelopes = PF.state.envelopes.envelopes.filter((e) => e.id !== id);
  PF.save("envelopes", PF.state.envelopes).then(() => App.render());
};
Pages.wireEnvelopes = function () {
  $("#env-income")?.addEventListener("change", (e) => {
    PF.state.envelopes.monthlyIncome = parseFloat(e.target.value.replace(/[$,]/g, "")) || 0;
    PF.save("envelopes", PF.state.envelopes).then(() => App.render());
  });
  $$(".env-cell").forEach((inp) => inp.addEventListener("change", () => {
    const e = PF.state.envelopes.envelopes.find((x) => x.id === inp.dataset.id);
    if (!e) return;
    e[inp.dataset.f] = inp.classList.contains("num") ? (parseFloat(inp.value) || 0) : inp.value;
    PF.save("envelopes", PF.state.envelopes).then(() => App.render());
  }));
};

/* ---------------- KIDS ---------------- */
Pages.kids = function () {
  const k = PF.state.kids;
  const balances = k.kids.map((kid) => {
    const open = k.entries.filter((e) => e.kidId === kid.id && e.status === "open");
    return { kid, bal: open.reduce((s, e) => s + (e.direction === "we-owe" ? e.amount : -e.amount), 0) };
  });
  const entries = k.entries.slice().sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, 100);
  return `
  <div class="page-head"><h1>Kid Money Ledger</h1></div>
  <div class="cards">
    ${balances.map(({ kid, bal }) => `<div class="card stat"><div class="label">${PF.esc(kid.name)}</div>
      <div class="big ${bal > 0 ? "neg" : bal < 0 ? "pos" : ""}">${bal === 0 ? "settled" : (bal > 0 ? "we owe " : "owes us ") + PF.fmt(Math.abs(bal))}</div></div>`).join("")}
    <div class="card stat"><div class="label">Add kid</div>
      <div class="filters"><input id="new-kid" placeholder="Name"><button class="btn" onclick="Pages.addKid()">Add</button></div></div>
  </div>
  <div class="card">
    <h3>Log an entry</h3>
    <div class="filters">
      <select id="ke-kid">${k.kids.map((kid) => `<option value="${kid.id}">${PF.esc(kid.name)}</option>`).join("")}</select>
      <select id="ke-dir"><option value="we-owe">They're owed (reimbursement / allowance due)</option><option value="kid-owes">They owe us (advance / loan)</option></select>
      <input id="ke-amt" class="num" placeholder="Amount" style="width:100px">
      <input id="ke-note" placeholder="What for? (e.g. gas money, Venmo'd for shoes)" style="flex:1">
      <input id="ke-date" type="date" value="${PF.today()}">
      <button class="btn primary" onclick="Pages.addKidEntry()">Log it</button>
    </div>
    <p class="muted">Tip: when you pay a kid back through Venmo/Zelle, mark the entry settled here — and the Venmo CSV import will show the matching transaction in the register under Transfers &amp; P2P.</p>
    ${entries.length ? `<table class="table"><thead><tr><th>Date</th><th>Kid</th><th>Note</th><th class="r">Amount</th><th>Status</th></tr></thead>
    <tbody>${entries.map((e) => {
      const kid = k.kids.find((x) => x.id === e.kidId);
      return `<tr class="${e.status === "settled" ? "settled" : ""}"><td class="nowrap">${e.date}</td><td>${PF.esc(kid?.name || "?")}</td>
        <td>${PF.esc(e.note)} <small class="muted">${e.direction === "we-owe" ? "owed to them" : "they owe us"}</small></td>
        <td class="r">${PF.fmt(e.amount)}</td>
        <td>${e.status === "open" ? `<button class="mini" onclick="Pages.settleKidEntry('${e.id}')">mark settled</button>` : "✓ settled"}</td></tr>`;
    }).join("")}</tbody></table>` : ""}
  </div>`;
};

Pages.addKid = function () {
  const name = $("#new-kid").value.trim();
  if (!name) return;
  PF.state.kids.kids.push({ id: PF.uid(), name });
  PF.save("kids", PF.state.kids).then(() => App.render());
};
Pages.addKidEntry = function () {
  const amt = parseFloat($("#ke-amt").value.replace(/[$,]/g, ""));
  if (!amt || !$("#ke-kid").value) { PF.toast("Pick a kid and enter an amount", true); return; }
  PF.state.kids.entries.push({
    id: PF.uid(), kidId: $("#ke-kid").value, direction: $("#ke-dir").value,
    amount: Math.abs(amt), note: $("#ke-note").value.trim(), date: $("#ke-date").value || PF.today(), status: "open",
  });
  PF.save("kids", PF.state.kids).then(() => App.render());
};
Pages.settleKidEntry = function (id) {
  const e = PF.state.kids.entries.find((x) => x.id === id);
  if (e) { e.status = "settled"; PF.save("kids", PF.state.kids).then(() => App.render()); }
};

/* ---------------- ACCOUNTS ---------------- */
Pages.accounts = function () {
  const accts = PF.state.accounts;
  return `
  <div class="page-head"><h1>Accounts</h1>
    <div class="head-actions"><button class="btn" onclick="Pages.addAccount()">+ add account</button></div>
  </div>
  <div class="card">
    <table class="table"><thead><tr><th>Account</th><th>Institution</th><th>Type</th><th class="r">Balance</th><th>Updated</th><th>Link</th><th></th></tr></thead>
    <tbody>${accts.map((a) => `
      <tr><td><input class="cell acct-cell" data-id="${a.id}" data-f="name" value="${PF.esc(a.name)}"></td>
      <td><input class="cell acct-cell" data-id="${a.id}" data-f="institution" value="${PF.esc(a.institution || "")}"></td>
      <td><select class="acct-cell" data-id="${a.id}" data-f="type">
        ${["checking", "savings", "credit card", "p2p", "investment", "real estate", "loan"].map((t) => `<option ${a.type === t ? "selected" : ""}>${t}</option>`).join("")}</select></td>
      <td class="r"><input class="cell num acct-cell" data-id="${a.id}" data-f="balance" value="${a.balance ?? ""}" placeholder="0"></td>
      <td class="muted nowrap">${a.balanceDate || "—"}</td>
      <td>${a.url ? `<a href="${PF.esc(a.url)}" target="_blank" rel="noopener">open ↗</a>` : ""}</td>
      <td><button class="mini danger" onclick="Pages.delAccount('${a.id}')">✕</button></td></tr>`).join("")}
    </tbody></table>
    <p class="muted">Balances entered here flow into nothing automatically (yet) — they're your quick reference. Investor360 and Starlar are linked, not synced: click through to check them, then update the matching line on the Statement. True auto-sync for UCCU / Relay / Discover needs a Plaid connection — see the README for what that takes.</p>
  </div>`;
};

Pages.addAccount = function () {
  PF.state.accounts.push({ id: PF.uid(), name: "", institution: "", type: "checking", balance: null, url: "" });
  PF.save("accounts", PF.state.accounts).then(() => App.render());
};
Pages.delAccount = function (id) {
  if (!confirm("Remove this account row?")) return;
  PF.state.accounts = PF.state.accounts.filter((a) => a.id !== id);
  PF.save("accounts", PF.state.accounts).then(() => App.render());
};
Pages.wireAccounts = function () {
  $$(".acct-cell").forEach((inp) => inp.addEventListener("change", () => {
    const a = PF.state.accounts.find((x) => x.id === inp.dataset.id);
    if (!a) return;
    const f = inp.dataset.f;
    a[f] = inp.classList?.contains("num") ? (parseFloat(inp.value.replace(/[$,]/g, "")) || 0) : inp.value;
    if (f === "balance") a.balanceDate = PF.today();
    PF.save("accounts", PF.state.accounts).then(() => App.render());
  }));
};

/* ---------------- SETTINGS ---------------- */
Pages.settings = function () {
  const rules = PF.state.rules;
  return `
  <div class="page-head"><h1>Settings</h1></div>
  <div class="card">
    <h3>Category rules <small class="muted">(run before the built-in merchant list)</small></h3>
    <table class="table half"><thead><tr><th>If description contains…</th><th>File under</th><th></th></tr></thead>
    <tbody>${rules.map((r, i) => `<tr><td><input class="cell rule-cell" data-i="${i}" data-f="pattern" value="${PF.esc(r.pattern)}"></td>
      <td><input class="cell rule-cell" data-i="${i}" data-f="category" value="${PF.esc(r.category)}"></td>
      <td><button class="mini danger" onclick="Pages.delRule(${i})">✕</button></td></tr>`).join("")}
    <tr><td colspan="3"><button class="mini" onclick="Pages.addRule()">+ add rule</button></td></tr></tbody></table>
    <button class="btn" onclick="Pages.reapplyRules()">↻ Re-categorize all Uncategorized with current rules</button>
  </div>
  <div class="card">
    <h3>Access</h3>
    <p>${PF.state.config?.authRequired
      ? `Google sign-in is <b>on</b>. Allowed emails are controlled by the <code>ALLOWED_EMAILS</code> environment variable in Netlify.`
      : `⚠️ Google sign-in is <b>not configured yet</b> — the app is open. Add <code>GOOGLE_CLIENT_ID</code>, <code>ALLOWED_EMAILS</code>, and <code>SESSION_SECRET</code> in Netlify (steps in the README) to lock it down.`}</p>
    ${PF.state.session ? `<p>Signed in as <b>${PF.esc(PF.state.session.email)}</b> <button class="mini" onclick="PF.signOut()">sign out</button></p>` : ""}
  </div>
  <div class="card">
    <h3>Backup</h3>
    <button class="btn" onclick="Pages.exportAll()">⬇️ Download full backup (JSON)</button>
    <p class="muted">Everything — statement, transactions, envelopes, kids, accounts, rules — in one file.</p>
  </div>`;
};

Pages.addRule = function () { PF.state.rules.push({ pattern: "", category: "" }); PF.save("rules", PF.state.rules).then(() => App.render()); };
Pages.delRule = function (i) { PF.state.rules.splice(i, 1); PF.save("rules", PF.state.rules).then(() => App.render()); };
Pages.wireSettings = function () {
  $$(".rule-cell").forEach((inp) => inp.addEventListener("change", () => {
    PF.state.rules[+inp.dataset.i][inp.dataset.f] = inp.value;
    PF.save("rules", PF.state.rules);
  }));
};
Pages.reapplyRules = async function () {
  let changed = 0;
  for (const [year, list] of Object.entries(PF.state.tx)) {
    let dirty = false;
    for (const t of list) {
      if (t.category === "Uncategorized") {
        const c = Importer.categorize(t.desc, PF.state.rules);
        if (c !== "Uncategorized") { t.category = c; changed++; dirty = true; }
      }
    }
    if (dirty) await PF.saveTxYear(year);
  }
  PF.toast(`${changed} transactions re-categorized`);
  App.render();
};
Pages.exportAll = function () {
  const data = {
    exportedAt: new Date().toISOString(),
    statement: PF.state.statement, accounts: PF.state.accounts, rules: PF.state.rules,
    envelopes: PF.state.envelopes, kids: PF.state.kids, tx: PF.state.tx,
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `personalfinance-backup-${PF.today()}.json`;
  a.click();
};
