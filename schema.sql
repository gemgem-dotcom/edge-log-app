-- ============================================================
-- EdgeLog v1 schema — run this in Supabase SQL Editor.
-- If you have an existing `trades` table from before, back up
-- anything in it that matters, then drop it first:
--   drop table if exists trades cascade;
-- ============================================================

-- ---------- INSTRUMENTS ----------
-- One row per instrument a user has added to their journal.
-- The switcher in the nav reads from this table.
create table instruments (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references auth.users not null,
  symbol text not null,           -- e.g. 'NQ'
  display_name text,              -- optional, e.g. 'Nasdaq 100 Futures'
  created_at timestamptz default now(),
  unique(user_id, symbol)
);

alter table instruments enable row level security;

create policy "Users manage their own instruments"
  on instruments for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- ---------- STRATEGIES ----------
-- Scoped to one instrument each — a strategy can't span instruments.
create table strategies (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references auth.users not null,
  instrument_id uuid references instruments(id) on delete cascade not null,
  name text not null,
  archived boolean default false,
  created_at timestamptz default now(),
  unique(instrument_id, name)
);

alter table strategies enable row level security;

create policy "Users manage their own strategies"
  on strategies for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- ---------- TRADES ----------
create table trades (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references auth.users not null,
  instrument_id uuid references instruments(id) on delete cascade not null,
  strategy_id uuid references strategies(id), -- null = "Unclassified" (e.g. after its strategy was deleted)

  -- Technical: what the AI will eventually use to locate this setup
  trade_date date not null,
  trade_time time not null,        -- store to the second: '09:47:23'
  direction text not null,         -- 'long' | 'short'
  entry numeric not null,
  stop numeric not null,
  target numeric,                 -- planned TP price
  exit_price numeric,              -- single-exit trades
  exit_time time,

  -- Multi-exit support
  multi_exit boolean default false,
  r_multiple numeric not null,

  -- Behavioral: drives discipline stats, not used to locate the setup
  in_plan boolean not null default true,

  -- Context: for the trader only, ignored by any analysis stage
  reasoning text,
  screenshot_url text,
  contracts integer,

  created_at timestamptz default now()
);

alter table trades enable row level security;

create policy "Users manage their own trades"
  on trades for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create index trades_user_instrument_idx on trades(user_id, instrument_id);
create index trades_strategy_idx on trades(strategy_id);

-- ---------- EXIT LEGS ----------
-- Only populated when a trade has multi_exit = true.
create table exit_legs (
  id uuid default gen_random_uuid() primary key,
  trade_id uuid references trades(id) on delete cascade not null,
  exit_price numeric not null,
  exit_time time not null,
  created_at timestamptz default now()
);

alter table exit_legs enable row level security;

create policy "Users manage exit legs on their own trades"
  on exit_legs for all
  using (exists (select 1 from trades where trades.id = exit_legs.trade_id and trades.user_id = auth.uid()))
  with check (exists (select 1 from trades where trades.id = exit_legs.trade_id and trades.user_id = auth.uid()));

-- ---------- LOGIN EVENTS ----------
-- A lightweight sign-in history log, inserted from the login page on
-- every successful sign-in. Note: this is a history log, not a live
-- session/device manager — Supabase's client SDK doesn't expose
-- per-device session revocation, only "sign out others" / "sign out
-- everywhere" (both implemented in the account page via scope options
-- on supabase.auth.signOut()).
create table login_events (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references auth.users not null,
  user_agent text,
  created_at timestamptz default now()
);

alter table login_events enable row level security;

create policy "Users see their own login events"
  on login_events for select
  using (auth.uid() = user_id);

create policy "Users insert their own login events"
  on login_events for insert
  with check (auth.uid() = user_id);

-- ============================================================
-- CHANGES SINCE v1
--
-- Everything below was added after the original schema above, and is
-- written so the whole file stays safe to re-run from top to bottom.
-- Whenever a column or constraint is added by hand in the Supabase SQL
-- editor, add it here in the same pull request — otherwise this file
-- drifts away from the real database and rebuilding from it silently
-- loses features.
-- ============================================================

-- Optional dollar profit/loss per trade. Shown next to R on the log/edit
-- forms, the trade detail page, and the Monthly P&L calendar on Overview.
-- Nullable on purpose: trades logged in R only still work.
alter table trades add column if not exists pnl numeric;

-- The sign-in history became one row per device instead of one row per
-- sign-in, with an editable friendly name.
alter table login_events add column if not exists device text;
alter table login_events add column if not exists device_key text;
alter table login_events add column if not exists device_nickname text;
alter table login_events add column if not exists ip_address text;
alter table login_events add column if not exists location text;

-- Required by the upsert in app/api/record-login/route.js, which uses
-- onConflict: 'user_id,device_key'. Guarded so re-running is harmless.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.login_events'::regclass
      and contype = 'u'
      and conname = 'login_events_user_id_device_key_key'
  ) then
    alter table login_events
      add constraint login_events_user_id_device_key_key
      unique (user_id, device_key);
  end if;
end $$;
