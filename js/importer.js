/* CSV import: parse, map columns via bank presets, auto-categorize, dedupe */
const Importer = {
  // Column presets for the banks Karmel uses. header match is case-insensitive "includes".
  presets: [
    {
      id: "discover", label: "Discover Card",
      detect: (h) => h.includes("trans. date") && h.includes("post date"),
      map: { date: "trans. date", desc: "description", amount: "amount", category: "category" },
      // Discover: positive amount = purchase (spend), negative = payment/credit
      sign: (amt) => -amt,
    },
    {
      id: "relay", label: "Relay",
      detect: (h) => h.includes("account name") || (h.includes("date") && h.includes("description") && h.includes("amount") && h.includes("account")),
      map: { date: "date", desc: "description", amount: "amount", account: "account name|account" },
      sign: (amt) => amt, // Relay: negative = spend already
    },
    {
      id: "uccu", label: "UCCU",
      detect: (h) => (h.includes("debit") && h.includes("credit")) || h.includes("posting date"),
      map: { date: "posting date|date", desc: "description|memo", debit: "debit", credit: "credit", amount: "amount" },
      sign: (amt) => amt,
    },
    {
      id: "venmo", label: "Venmo statement",
      detect: (h) => h.includes("datetime") && (h.includes("note") || h.includes("from")),
      map: { date: "datetime", desc: "note", amount: "amount (total)|amount", from: "from", to: "to", type: "type" },
      sign: (amt) => amt,
      postProcess: (t, row) => {
        const from = row["from"] || "", to = row["to"] || "";
        t.desc = [row["type"], from && "from " + from, to && "to " + to, t.desc].filter(Boolean).join(" · ");
        t.counterparty = t.amount < 0 ? to : from;
      },
    },
    {
      id: "generic", label: "Generic CSV (Date, Description, Amount)",
      detect: () => true,
      map: { date: "date", desc: "description|desc|payee|memo", amount: "amount", debit: "debit|withdrawal", credit: "credit|deposit" },
      sign: (amt) => amt,
    },
  ],

  // Starter auto-categorization: merchant keyword -> category. User rules (Settings) run first.
  builtinRules: [
    ["costco|walmart|target|winco|smiths|kroger|harmons|macey|sam's club|grocery", "Groceries"],
    ["maverik|chevron|shell|exxon|texaco|sinclair|holiday oil|fuel|gas station", "Gas & Auto"],
    ["mcdonald|chick-fil-a|cafe rio|chipotle|wendy|in-n-out|dominos|pizza|doordash|grubhub|restaurant|grill|taco|sushi|dining", "Dining Out"],
    ["netflix|spotify|hulu|disney|youtube|apple.com/bill|prime video|audible|patreon", "Subscriptions"],
    ["amazon|amzn", "Shopping"],
    ["rocky mountain power|dominion|questar|utility|city of |water|sewer|garbage", "Utilities"],
    ["comcast|xfinity|t-mobile|verizon|at&t|internet|wireless", "Phone & Internet"],
    ["tristate|mortgage", "Mortgage"],
    ["state farm|geico|progressive|allstate|insurance", "Insurance"],
    ["intermountain|clinic|pharmacy|cvs|walgreens|dental|medical|hospital|copay", "Medical"],
    ["byu|uvu|school|tuition|lunch|pta", "Kids & School"],
    ["venmo|zelle", "Transfers & P2P"],
    ["tithing|donation|lds|charity|foundation", "Giving"],
    ["payroll|direct dep|deposit|salary", "Income"],
    ["vanguard|fidelity|schwab|merrill|commonwealth|investment", "Investing"],
    ["delta|southwest|airbnb|marriott|hotel|vrbo|airline", "Travel"],
    ["home depot|lowes|lowe's|ace hardware", "Home & Yard"],
  ],

  parseCSV(text) {
    const rows = [];
    let row = [], cell = "", inQ = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inQ) {
        if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
        else if (c === '"') inQ = false;
        else cell += c;
      } else if (c === '"') inQ = true;
      else if (c === ",") { row.push(cell); cell = ""; }
      else if (c === "\n" || c === "\r") {
        if (c === "\r" && text[i + 1] === "\n") i++;
        row.push(cell); cell = "";
        if (row.some((x) => x.trim() !== "")) rows.push(row);
        row = [];
      } else cell += c;
    }
    if (cell !== "" || row.length) { row.push(cell); if (row.some((x) => x.trim() !== "")) rows.push(row); }
    return rows;
  },

  detectPreset(headers) {
    const h = headers.join("|").toLowerCase();
    return this.presets.find((p) => p.detect(h)) || this.presets[this.presets.length - 1];
  },

  findCol(headers, spec) {
    if (!spec) return -1;
    const names = spec.split("|");
    const lower = headers.map((x) => x.toLowerCase().trim());
    for (const n of names) {
      const i = lower.findIndex((h) => h === n);
      if (i >= 0) return i;
    }
    for (const n of names) {
      const i = lower.findIndex((h) => h.includes(n));
      if (i >= 0) return i;
    }
    return -1;
  },

  parseAmount(s) {
    if (s === null || s === undefined) return NaN;
    let str = String(s).trim().replace(/[$,]/g, "");
    if (!str) return NaN;
    let neg = false;
    if (/^\(.*\)$/.test(str)) { neg = true; str = str.slice(1, -1); }
    if (str.startsWith("+")) str = str.slice(1);
    const n = parseFloat(str);
    return neg ? -n : n;
  },

  parseDate(s) {
    if (!s) return null;
    const str = String(s).trim();
    let m = str.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return `${m[1]}-${m[2]}-${m[3]}`;
    m = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
    if (m) {
      const y = m[3].length === 2 ? "20" + m[3] : m[3];
      return `${y}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
    }
    const d = new Date(str);
    return isNaN(d) ? null : d.toISOString().slice(0, 10);
  },

  categorize(desc, userRules) {
    const d = (desc || "").toLowerCase();
    for (const r of userRules || []) {
      try { if (d.includes((r.pattern || "").toLowerCase())) return r.category; } catch {}
    }
    for (const [pat, cat] of this.builtinRules) {
      if (new RegExp(pat, "i").test(d)) return cat;
    }
    return "Uncategorized";
  },

  // Main entry: csv text + account label -> {transactions, preset, headers}
  process(text, accountLabel, userRules) {
    const rows = this.parseCSV(text);
    if (rows.length < 2) throw new Error("CSV has no data rows.");
    const headers = rows[0];
    const preset = this.detectPreset(headers);
    const col = {};
    for (const [field, spec] of Object.entries(preset.map)) col[field] = this.findCol(headers, spec);

    const transactions = [];
    for (const raw of rows.slice(1)) {
      const rowObj = {};
      headers.forEach((h, i) => (rowObj[h.toLowerCase().trim()] = raw[i]));
      const date = this.parseDate(raw[col.date]);
      if (!date) continue;
      let amount;
      if (col.amount >= 0 && raw[col.amount] !== "" && raw[col.amount] !== undefined) {
        amount = this.parseAmount(raw[col.amount]);
      } else if (col.debit >= 0 || col.credit >= 0) {
        const deb = col.debit >= 0 ? this.parseAmount(raw[col.debit]) : NaN;
        const cred = col.credit >= 0 ? this.parseAmount(raw[col.credit]) : NaN;
        amount = !isNaN(deb) && deb !== 0 ? -Math.abs(deb) : !isNaN(cred) ? Math.abs(cred) : NaN;
      }
      if (amount === undefined || isNaN(amount)) continue;
      amount = preset.sign(amount);

      const t = {
        date,
        desc: (raw[col.desc] || "").trim(),
        amount: Math.round(amount * 100) / 100,
        account: (col.account >= 0 && raw[col.account]?.trim()) || accountLabel,
        source: preset.id,
        category: null,
      };
      if (preset.postProcess) preset.postProcess(t, rowObj);
      // Discover ships its own category — keep as hint if we can't do better
      const discoverCat = col.category >= 0 ? (raw[col.category] || "").trim() : "";
      t.category = this.categorize(t.desc, userRules);
      if (t.category === "Uncategorized" && discoverCat) t.category = discoverCat;
      transactions.push(t);
    }
    return { transactions, preset, headers };
  },
};
