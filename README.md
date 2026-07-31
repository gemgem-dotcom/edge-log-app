# Edge Log — Setup Guide

This is a real Next.js + Supabase app. Follow these steps in order.

## 1. Create the database table

In your Supabase project: **SQL Editor** → **New query** → paste this in and click **Run**.

```sql
create table trades (
  id uuid default gen_random_uuid() primary key,
  instrument text not null,
  trade_date date not null,
  trade_time time not null,
  direction text not null,
  entry numeric not null,
  stop numeric not null,
  r_multiple numeric not null,
  in_plan boolean not null default true,
  tag text,
  reasoning text,
  created_at timestamptz default now()
);
```

This creates one table, `trades`, with one column per field on the form. `uuid default gen_random_uuid()`
means every trade gets a unique ID generated automatically — you never have to think about it.

**Note on security:** this table has no access restrictions (no "Row Level Security" policies), which
means anyone with your app's URL and Supabase keys could technically read or write to it. That's fine
for now, while it's just you testing — but before sharing this app with anyone else, or storing anything
you'd consider sensitive, we'll want to add Supabase Auth (login) and RLS policies. Flag it to me when
you're ready and we'll add that layer.

## 2. Get your API keys

In Supabase: **Project Settings** → **API**. You'll see:
- **Project URL** — looks like `https://xxxxx.supabase.co`
- **anon public** key — a long string

## 3. Set up the project locally

Open a terminal in this folder and run:

```bash
npm install
cp .env.local.example .env.local
```

Then open `.env.local` in any text editor and paste in your real URL and anon key from step 2.

## 4. Run it locally

```bash
npm run dev
```

Open `http://localhost:3000` — you should see the app, and be able to log a trade and see it saved
(refresh the page — it'll still be there, because it's now in your real database, not just memory).

## 5. Push to GitHub

```bash
git init
git add .
git commit -m "Initial commit"
```

Then create a new empty repository on GitHub (no README/license — just the bare repo), and run the two
commands GitHub shows you under "…or push an existing repository from the command line."

## 6. Deploy to Vercel

1. Go to vercel.com → **Add New Project** → import the GitHub repo you just pushed.
2. Before deploying, expand **Environment Variables** and add the same two values from your `.env.local`:
   `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY`.
3. Click **Deploy**.

A minute later you'll have a real URL (something like `edge-log-app.vercel.app`) that works from your
phone, logs to the same Supabase database, and stays up even if your laptop is off.

## What's next

This is intentionally scoped to exactly what you asked for: log trades, store them for real, track
progress toward 50. Once you've got this running, the natural next additions are:
- Login/auth + Row Level Security (needed before this should ever be multi-user)
- The market-data enrichment engine (pulling historical price data around each trade's timestamp)
- The pattern-analysis / similarity-search layer once you're past 50 logged trades
