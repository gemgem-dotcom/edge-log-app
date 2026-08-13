# EdgeLog — Setup Guide (v1)

This version adds accounts, multiple instruments, and per-instrument strategies.
If you're upgrading from the earlier single-page version, **this replaces that schema** — see step 1.

Before changing the code, read `NOTES.md` — it covers the branch/pull-request
workflow, project layout, UI conventions and known gotchas.

## 1. Reset the database

In Supabase **SQL Editor**, if you have an old `trades` table from before, drop it first:

```sql
drop table if exists trades cascade;
```

Then paste in the entire contents of `schema.sql` (included in this project) and run it. This creates
three tables — `instruments`, `strategies`, `trades` — each with Row Level Security enabled,
so every user can only ever see and edit their own data.

## 2. Confirm email auth is on

In Supabase: **Authentication → Providers** → make sure **Email** is enabled (it is by default).
By default new accounts also require email confirmation — if you want to skip that while testing solo,
go to **Authentication → Settings** and turn off "Confirm email," or just check your inbox after signing up.

## 2b. Google sign-in (optional)

The login and signup pages have a "Continue with Google" button, but it won't work until you do
the following **in your own accounts** — none of this can be done from the code:

1. Create an OAuth client in [Google Cloud Console](https://console.cloud.google.com/apis/credentials)
   (type "Web application"). Add `https://<your-supabase-project-ref>.supabase.co/auth/v1/callback`
   as an authorized redirect URI. Copy the Client ID and Client Secret.
2. In Supabase: **Authentication → Providers**, enable **Google**, and paste in the credentials
   from step 1.
3. Add your production and local URLs (e.g. `http://localhost:3000/**`, `https://your-app.vercel.app/**`)
   under **Authentication → URL Configuration → Redirect URLs**, or the provider will reject the
   callback after sign-in.

Skip this and the button will just show a Supabase error — email/password sign-in is unaffected either way.

## 3. Storage bucket (same as before — skip if already set up)

**Storage** → **New bucket** → name it exactly `screenshots` → toggle **Public bucket** ON → **Create bucket**.

## 4. Environment variables

Copy `.env.local.example` to `.env.local` and fill in the three values:

- `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` — from **Project Settings → API**.
- `SUPABASE_SERVICE_ROLE_KEY` — also on that page, under "service_role". This one is
  **server only**: it bypasses Row Level Security, so never rename it with a
  `NEXT_PUBLIC_` prefix. The two routes in `app/api/` (recording sign-ins, deleting an
  account) are the only things that use it.

All three also need to be added in Vercel under **Project Settings → Environment Variables**.

The economic calendar, volatility, and key-levels cards on the Overview pages
currently show mock/placeholder data (`lib/marketContextMock.js`) — no API key or
setup needed for those. See `NOTES.md` for the plan to replace them with a real
market-data provider.

## 5. Run it

```bash
npm install
npm run dev
```

Open `http://localhost:3000` — you'll land on the login screen. Sign up, then you'll be walked through
adding your first instrument and first strategy before reaching the dashboard.

## 6. Deploy

Same as before: push to GitHub, import into Vercel, add the three environment variables there too, deploy.

## What's new in this version

- **New sidebar layout** — Overview, expandable Strategies list (color-coded), Trades and Insights (Insights is a placeholder for now)
- **Monthly P&L calendar** — lives on the Overview page under Strategy performance, with monthly stats, a weekly column, and a strategy filter
- **Aggregate dashboard stats** — Total Trades, Win Rate, Avg R, Expectancy, Profit Factor, Total PnL
- **Strategy performance table** — one scannable table instead of a card per strategy, click any row to jump to that strategy's filtered log
- **New dependency**: `lucide-react` (icons) — if you're updating an existing local copy, run `npm install` again after pulling these changes, or the icons won't resolve.

## Previously added

- **Accounts** — email/password login, every user's data isolated by Row Level Security
- **Instrument switcher** — add multiple instruments, switch between them from the nav
- **Strategy Manager** — add, rename, archive strategies per instrument
- **Per-strategy dashboard** — win rate, avg R, expectancy, avg time in trade, per strategy
- **Trade log with strategy tabs** — logs never mix across strategies
- **Trade detail page** — full technical fields, screenshot, reasoning
- **Seconds-precision timestamps** — entry/exit time inputs now support HH:MM:SS

## Known limitation to test on your device

Native `<input type="time" step="1">` seconds support is inconsistent across mobile browsers. Test the
"Log New Trade" time fields on your actual phone — if the seconds picker doesn't appear, we'll swap it
for a validated text input instead.

## What's next (later phases)

- Market data infrastructure (Phase 2) — Databento backfill into a `market_bars` table
- Feature extraction (Phase 3) — market-context vectors per trade
- Strategy verification, population scan, edge verification (Phases 4–6)
- Strategy generation (Phase 7)
