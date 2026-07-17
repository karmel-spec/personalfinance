// Personal Finance API — single function router.
// Auth: Google Identity Services ID token -> verified server-side -> HMAC session token.
// Agent access: Authorization: Bearer <HERMES_API_KEY> works on all /data and /tx routes,
// so Claude / the finance Hermes agent can keep the statement and register updated.
import { getStore } from "@netlify/blobs";
import crypto from "node:crypto";

const store = () => getStore({ name: "pfdata", consistency: "strong" });

const ENV = (k, d = "") => process.env[k] ?? d;
const SECRET = () => ENV("SESSION_SECRET", "dev-secret-change-me");
const ALLOWED = () =>
  ENV("ALLOWED_EMAILS", "")
    .split(/[,\s]+/)
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);

// Keys the client may read/write. Transactions live at tx-<year>.
const DATA_KEYS = new Set([
  "statement", "accounts", "rules", "envelopes", "kids", "meta", "settings",
]);
const isTxKey = (k) => /^tx-\d{4}$/.test(k);

const json = (body, status = 200, extra = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...extra },
  });

const b64u = (buf) => Buffer.from(buf).toString("base64url");

function signSession(email) {
  const payload = b64u(JSON.stringify({ email, exp: Date.now() + 1000 * 60 * 60 * 24 * 30 }));
  const sig = b64u(crypto.createHmac("sha256", SECRET()).update(payload).digest());
  return `${payload}.${sig}`;
}

function verifySession(token) {
  if (!token || !token.includes(".")) return null;
  const [payload, sig] = token.split(".");
  const expect = b64u(crypto.createHmac("sha256", SECRET()).update(payload).digest());
  if (sig.length !== expect.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString());
    if (data.exp < Date.now()) return null;
    return data;
  } catch {
    return null;
  }
}

function authContext(req) {
  const hdr = req.headers.get("authorization") || "";
  const token = hdr.replace(/^Bearer\s+/i, "").trim();
  const hermesKey = ENV("HERMES_API_KEY");
  if (hermesKey && token === hermesKey) return { kind: "agent", email: "hermes-agent" };
  const session = verifySession(token);
  if (session) return { kind: "user", email: session.email };
  // If no auth is configured yet at all, run open (setup mode).
  if (!ENV("GOOGLE_CLIENT_ID") && !ENV("APP_PASSWORD")) return { kind: "open", email: "setup-mode" };
  return null;
}

function safeEqual(a, b) {
  const ab = Buffer.from(String(a)), bb = Buffer.from(String(b));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

async function verifyGoogleIdToken(credential) {
  const res = await fetch(
    "https://oauth2.googleapis.com/tokeninfo?id_token=" + encodeURIComponent(credential)
  );
  if (!res.ok) return null;
  const info = await res.json();
  if (info.aud !== ENV("GOOGLE_CLIENT_ID")) return null;
  if (info.email_verified !== "true" && info.email_verified !== true) return null;
  return info;
}

export default async (req) => {
  const url = new URL(req.url);
  // Path after the function mount: /.netlify/functions/api/<route> or /api/<route>
  const route = url.pathname.replace(/^\/(\.netlify\/functions\/)?api\/?/, "").replace(/\/$/, "");

  if (req.method === "OPTIONS") return new Response("", { status: 204 });

  // ---- public routes ----
  if (route === "config") {
    const mode = ENV("GOOGLE_CLIENT_ID") ? "google" : ENV("APP_PASSWORD") ? "password" : "open";
    return json({
      googleClientId: ENV("GOOGLE_CLIENT_ID") || null,
      authMode: mode,
      authRequired: mode !== "open",
    });
  }

  if (route === "auth/password" && req.method === "POST") {
    const { password } = await req.json().catch(() => ({}));
    const expected = ENV("APP_PASSWORD");
    if (!expected) return json({ error: "Password login is not enabled." }, 400);
    if (!password || !safeEqual(password, expected))
      return json({ error: "Wrong password." }, 401);
    return json({ token: signSession("family"), email: "family", name: "Larson family" });
  }

  if (route === "auth/google" && req.method === "POST") {
    const { credential } = await req.json().catch(() => ({}));
    const info = credential && (await verifyGoogleIdToken(credential));
    if (!info) return json({ error: "Google sign-in could not be verified." }, 401);
    const email = (info.email || "").toLowerCase();
    const allowed = ALLOWED();
    if (allowed.length && !allowed.includes(email))
      return json({ error: `${email} is not on the allowed list for this app.` }, 403);
    return json({ token: signSession(email), email, name: info.name || email });
  }

  // ---- everything below requires auth ----
  const auth = authContext(req);
  if (!auth) return json({ error: "Sign in required." }, 401);

  if (route === "whoami") return json(auth);

  // GET/PUT /data/<key>
  const dataMatch = route.match(/^data\/([a-z0-9-]+)$/);
  if (dataMatch) {
    const key = dataMatch[1];
    if (!DATA_KEYS.has(key) && !isTxKey(key)) return json({ error: "Unknown data key." }, 400);
    if (req.method === "GET") {
      const val = await store().get(key, { type: "json" });
      return json(val ?? null);
    }
    if (req.method === "PUT") {
      const body = await req.json().catch(() => null);
      if (body === null) return json({ error: "Invalid JSON body." }, 400);
      await store().setJSON(key, body);
      await touchMeta(auth, `put:${key}`);
      return json({ ok: true, key, by: auth.email });
    }
  }

  // GET /tx?years=2024,2025  |  POST /tx/import {transactions:[...]}
  if (route === "tx" && req.method === "GET") {
    const years = (url.searchParams.get("years") || String(new Date().getFullYear()))
      .split(",").map((y) => y.trim()).filter((y) => /^\d{4}$/.test(y));
    const out = {};
    for (const y of years) out[y] = (await store().get(`tx-${y}`, { type: "json" })) || [];
    return json(out);
  }

  if (route === "tx/years" && req.method === "GET") {
    const { blobs } = await store().list({ prefix: "tx-" });
    return json(blobs.map((b) => b.key.replace("tx-", "")).sort());
  }

  if (route === "tx/import" && req.method === "POST") {
    const { transactions } = await req.json().catch(() => ({}));
    if (!Array.isArray(transactions)) return json({ error: "transactions array required" }, 400);
    const { added, skipped } = await importTransactions(transactions);
    await touchMeta(auth, `import:${added} tx`);
    return json({ ok: true, added, skipped });
  }

  // ---- Plaid (auto-sync) — activates when PLAID_CLIENT_ID/PLAID_SECRET are set ----
  if (route.startsWith("plaid/")) return plaidRoutes(route, req, auth);

  return json({ error: `No route: ${req.method} ${route}` }, 404);
};

const PLAID_HOST = () =>
  ({ sandbox: "https://sandbox.plaid.com", development: "https://development.plaid.com", production: "https://production.plaid.com" }[
    ENV("PLAID_ENV", "production")
  ]);

async function plaid(path, body) {
  const res = await fetch(PLAID_HOST() + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_id: ENV("PLAID_CLIENT_ID"), secret: ENV("PLAID_SECRET"), ...body }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error_message || data.error_code || `Plaid error ${res.status}`);
  return data;
}

async function plaidRoutes(route, req, auth) {
  const configured = Boolean(ENV("PLAID_CLIENT_ID") && ENV("PLAID_SECRET"));

  if (route === "plaid/status") {
    const items = (await store().get("plaid-items", { type: "json" })) || [];
    return json({
      configured,
      env: ENV("PLAID_ENV", "production"),
      items: items.map((i) => ({ institution: i.institution, addedAt: i.addedAt, lastSync: i.lastSync, accounts: i.accounts })),
    });
  }
  if (!configured) return json({ error: "Plaid is not configured yet — set PLAID_CLIENT_ID and PLAID_SECRET in Netlify." }, 400);

  if (route === "plaid/link-token" && req.method === "POST") {
    const r = await plaid("/link/token/create", {
      user: { client_user_id: "larson-family" },
      client_name: "Larson Family Finance",
      products: ["transactions"],
      transactions: { days_requested: 730 },
      country_codes: ["US"],
      language: "en",
    }).catch((e) => ({ error: e.message }));
    return r.error ? json(r, 502) : json({ link_token: r.link_token });
  }

  if (route === "plaid/exchange" && req.method === "POST") {
    const { public_token, institution } = await req.json().catch(() => ({}));
    if (!public_token) return json({ error: "public_token required" }, 400);
    try {
      const r = await plaid("/item/public_token/exchange", { public_token });
      const items = (await store().get("plaid-items", { type: "json" })) || [];
      items.push({ accessToken: r.access_token, itemId: r.item_id, institution: institution || "bank", addedAt: new Date().toISOString(), cursor: null });
      await store().setJSON("plaid-items", items);
      await touchMeta(auth, `plaid:linked ${institution || "bank"}`);
      return json({ ok: true });
    } catch (e) { return json({ error: e.message }, 502); }
  }

  if (route === "plaid/sync" && req.method === "POST") {
    const items = (await store().get("plaid-items", { type: "json" })) || [];
    if (!items.length) return json({ error: "No banks linked yet." }, 400);
    let totalAdded = 0;
    const results = [];
    for (const item of items) {
      try {
        let cursor = item.cursor, hasMore = true, txs = [], accounts = {};
        while (hasMore) {
          const r = await plaid("/transactions/sync", { access_token: item.accessToken, cursor: cursor || undefined, count: 500 });
          (r.accounts || []).forEach((a) => (accounts[a.account_id] = a.name));
          txs.push(...r.added);
          cursor = r.next_cursor;
          hasMore = r.has_more;
        }
        // Plaid: positive amount = money out. App: negative = spend.
        const mapped = txs.map((t) => ({
          date: t.date,
          desc: t.merchant_name || t.name || "",
          amount: -t.amount,
          account: `${item.institution} — ${accounts[t.account_id] || "account"}`,
          source: "plaid",
          category: t.personal_finance_category?.primary
            ? t.personal_finance_category.primary.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase())
            : "Uncategorized",
        }));
        const imp = await importTransactions(mapped);
        totalAdded += imp.added;
        item.cursor = cursor;
        item.lastSync = new Date().toISOString();
        item.accounts = Object.values(accounts);
        results.push({ institution: item.institution, added: imp.added, skipped: imp.skipped });
      } catch (e) { results.push({ institution: item.institution, error: e.message }); }
    }
    await store().setJSON("plaid-items", items);
    await touchMeta(auth, `plaid-sync:${totalAdded} tx`);
    return json({ ok: true, results, totalAdded });
  }

  return json({ error: `No route: ${req.method} ${route}` }, 404);
}

async function importTransactions(transactions) {
  const byYear = {};
  for (const t of transactions) {
    if (!t || !t.date || typeof t.amount !== "number") continue;
    const y = String(t.date).slice(0, 4);
    if (/^\d{4}$/.test(y)) (byYear[y] ||= []).push(t);
  }
  let added = 0, skipped = 0;
  for (const [y, list] of Object.entries(byYear)) {
    const key = `tx-${y}`;
    const existing = (await store().get(key, { type: "json" })) || [];
    const seen = new Set(existing.map((t) => t.id));
    for (const t of list) {
      if (!t.id) t.id = crypto.createHash("sha1").update(`${t.date}|${t.amount}|${t.desc}|${t.account}`).digest("hex").slice(0, 16);
      if (seen.has(t.id)) { skipped++; continue; }
      seen.add(t.id);
      existing.push(t);
      added++;
    }
    existing.sort((a, b) => (a.date < b.date ? 1 : -1));
    await store().setJSON(key, existing);
  }
  return { added, skipped };
}

async function touchMeta(auth, action) {
  try {
    const meta = (await store().get("meta", { type: "json" })) || {};
    meta.lastUpdated = new Date().toISOString();
    meta.lastUpdatedBy = auth.email;
    meta.lastAction = action;
    (meta.log ||= []).unshift({ at: meta.lastUpdated, by: auth.email, action });
    meta.log = meta.log.slice(0, 200);
    await store().setJSON("meta", meta);
  } catch { /* non-fatal */ }
}
