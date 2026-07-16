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
  // If Google login is not configured yet, run open (setup mode).
  if (!ENV("GOOGLE_CLIENT_ID")) return { kind: "open", email: "setup-mode" };
  return null;
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
    return json({
      googleClientId: ENV("GOOGLE_CLIENT_ID") || null,
      authRequired: Boolean(ENV("GOOGLE_CLIENT_ID")),
    });
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
    const byYear = {};
    for (const t of transactions) {
      if (!t || !t.date || typeof t.amount !== "number") continue;
      const y = String(t.date).slice(0, 4);
      if (!/^\d{4}$/.test(y)) continue;
      (byYear[y] ||= []).push(t);
    }
    let added = 0, skipped = 0;
    for (const [y, list] of Object.entries(byYear)) {
      const key = `tx-${y}`;
      const existing = (await store().get(key, { type: "json" })) || [];
      const seen = new Set(existing.map((t) => t.id));
      for (const t of list) {
        if (!t.id) t.id = crypto.createHash("sha1")
          .update(`${t.date}|${t.amount}|${t.desc}|${t.account}`).digest("hex").slice(0, 16);
        if (seen.has(t.id)) { skipped++; continue; }
        seen.add(t.id);
        existing.push(t);
        added++;
      }
      existing.sort((a, b) => (a.date < b.date ? 1 : -1));
      await store().setJSON(key, existing);
    }
    await touchMeta(auth, `import:${added} tx`);
    return json({ ok: true, added, skipped });
  }

  return json({ error: `No route: ${req.method} ${route}` }, 404);
};

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
