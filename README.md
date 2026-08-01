# EdgeLog — Setup Guide (v1)

This version adds accounts, multiple instruments, per-instrument strategies, and multi-exit trades.
If you're upgrading from the earlier single-page version, **this replaces that schema** — see step 1.

## 1. Reset the database

In Supabase **SQL Editor**, if you have an old `trades` table from before, drop it first:

```sql
drop table if exists trades cascade;
```

Then paste in the entire contents of `schema.sql` (included in this project) and run it. This creates
four tables — `instruments`, `strategies`, `trades`, `exit_legs` — each with Row Level Security enabled,
so every user can only ever see and edit their own data.

## 2. Confirm email auth is on

In Supabase: **Authentication → Providers** → make sure **Email** is enabled (it is by default).
By default new accounts also require email confirmation — if you want to skip that while testing solo,
go to **Authentication → Settings** and turn off "Confirm email," or just check your inbox after signing up.

## 3. Storage bucket (same as before — skip if already set up)

**Storage** → **New bucket** → name it exactly `screenshots` → toggle **Public bucket** ON → **Create bucket**.

## 4. Environment variables

Same as before — copy `.env.local.example` to `.env.local` and fill in your Supabase URL and anon key
from **Project Settings → API**.

## 5. Run it

```bash
npm install
npm run dev
```

Open `http://localhost:3000` — you'll land on the login screen. Sign up, then you'll be walked through
adding your first instrument and first strategy before reaching the dashboard.

## 6. Deploy

Same as before: push to GitHub, import into Vercel, add the two environment variables there too, deploy.

## What's new in this version

- **Accounts** — email/password login, every user's data isolated by Row Level Security
- **Instrument switcher** — add multiple instruments, switch between them from the nav
- **Strategy Manager** — add, rename, archive strategies per instrument
- **Per-strategy dashboard** — win rate, avg R, expectancy, avg time in trade, per strategy
- **Trade log with strategy tabs** — logs never mix across strategies
- **Trade detail page** — full technical fields, exit legs, screenshot, reasoning
- **Multi-exit trades** — log multiple exit legs (price + exact time) per trade
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

