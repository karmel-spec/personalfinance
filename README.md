# Larson Family Finance

Private personal-finance hub for Karmel's family. One place for:

- **Personal Financial Statement** — the banker-ready page. Editable line items, monthly
  snapshots, print → Save as PDF, one-click email draft. Replaces the old spreadsheet.
- **Spending Register** — QuickBooks-style aggregate of UCCU + Relay + Discover + Venmo/Zelle
  activity via CSV import. Auto-detects each bank's format, auto-categorizes, never duplicates
  on re-import. Import historical CSVs as far back as each bank allows to build the archive.
- **Reports** — monthly category breakdown with month-over-month deltas, plain-English
  observations, and a year-over-year category table for annual comparison. Print for family council.
- **Envelopes** — Profit First-style percentage allocation of monthly income, mapped to the
  Relay accounts, with an over/under-allocation check.
- **Kid Ledger** — who's owed what: reimbursements due to kids, advances they owe back,
  settle when the Venmo/Zelle goes through.
- **Accounts** — registry of every account with quick links (UCCU, Relay, Discover, Venmo,
  Investor360, starlar.com) and manually-tracked balances.

Stack: static HTML/JS (no build step) + one Netlify Function + Netlify Blobs, Google sign-in.
Works in **local mode** (browser localStorage) even before the backend/env vars exist.

## Deploy (Netlify)

1. New site from this repo. Build command: none. Publish directory: `.` (netlify.toml handles it).
2. Environment variables (Site settings → Environment):

| Variable | Purpose |
|---|---|
| `GOOGLE_CLIENT_ID` | Turns on the Google sign-in gate. Until it's set, the app runs open in setup mode. |
| `ALLOWED_EMAILS` | Comma-separated Google emails allowed in (Karmel + husband). |
| `SESSION_SECRET` | Any long random string — signs session tokens. |
| `HERMES_API_KEY` | Long random string. Lets Claude / the finance Hermes agent update data via the API. |

3. Google Client ID: [console.cloud.google.com](https://console.cloud.google.com) → APIs & Services →
   Credentials → Create OAuth client ID → Web application → add the Netlify URL (and custom domain)
   to **Authorized JavaScript origins**. Copy the client ID into `GOOGLE_CLIENT_ID`.

## Agent API (how Hermes keeps it updated monthly)

All routes accept `Authorization: Bearer $HERMES_API_KEY`.

```
GET  /api/data/statement          # current statement JSON
PUT  /api/data/statement          # write updated statement (append to .history for snapshots)
GET  /api/tx?years=2025,2026      # transactions by year
POST /api/tx/import               # {transactions:[{date,desc,amount,account,category}]} — deduped
GET  /api/data/meta               # last-updated audit log
```

Monthly routine for the agent: pull statement → update balances from latest imports/balances →
push a history snapshot with `asOf` = first of month → banker PDF is always one print away.

## Getting money data in (per bank)

- **UCCU**: Online banking → account → Export → CSV (choose date range; go back as far as offered).
- **Relay**: each account → Transactions → Export CSV. Relay includes the account name column, so
  one export per account or a combined one both work.
- **Discover**: Card activity → Download transactions → CSV → "All available" for history.
  Discover's own category column is used as a fallback hint.
- **Venmo**: Settings → Statements → Download CSV (per month). Zelle rides inside the UCCU export.

Drop any/all of these on **Register → Import CSV**. Re-importing overlapping ranges is safe —
duplicates are hashed out.

## Roadmap: true auto-sync (no CSVs)

Automatic daily pulls from UCCU / Relay / Discover need a bank aggregator:
- **Plaid** (what the big apps use): ~free for first 100 connections on the Development tier;
  needs a Plaid account + `PLAID_CLIENT_ID`/`PLAID_SECRET`, plus a small addition to the API
  function. Supports UCCU and Discover; Relay also offers its own API with direct API keys.
- Until then the CSV flow covers everything, including historical backfill.

Investor360 and Starlar have no public APIs — they're linked from Accounts, and their totals
are lines on the Statement (update monthly, or the agent can scrape starlar.com if we want).

## Local dev

`npx serve` (or any static server) — runs in local mode, data in localStorage.
`netlify dev` — full backend with Blobs + auth.
