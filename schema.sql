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
  exit_price numeric,
  exit_time time,

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

-- Fixed instrument catalog (see lib/instrumentCatalog.js). data_symbol is
-- what mini/micro contracts share with their full-size counterpart (e.g.
-- MNQ and NQ both carry data_symbol 'NQ'), since they track identical
-- price movement — future market-data lookups should key off this, not
-- the display symbol. Existing rows are best-effort backfilled to their
-- own symbol; fix any mini/micro ones by hand if you had them already.
alter table instruments add column if not exists data_symbol text;
update instruments set data_symbol = symbol where data_symbol is null;

-- Stop/target are entered in the UI as a distance in points from entry;
-- `stop`/`target` keep storing the absolute price as before (used for
-- R-multiple math and future market-data matching), while these columns
-- keep the raw distance the trader typed.
--
-- distance_unit is vestigial: the platform now treats a "point" as a raw
-- decimal price difference for every instrument, with no per-instrument
-- tick multiplier and no unit picker on the form, so every row is
-- 'points'. Kept (rather than dropped) because the column may already
-- exist, and it is harmless.
alter table trades add column if not exists stop_distance numeric;
alter table trades add column if not exists target_distance numeric;
alter table trades add column if not exists distance_unit text default 'points';

-- Backfill distances for trades logged before this feature existed, so
-- editing an old trade shows a sensible distance instead of blank.
update trades set stop_distance = abs(stop - entry) where stop_distance is null;
update trades set target_distance = abs(target - entry) where target_distance is null and target is not null;

-- r_multiple is derived from the exit price. Exit price is mandatory on the
-- logging form, so every trade saved through the app has an R — but the
-- column stays nullable because rows created while exit price was briefly
-- optional may already hold null, and re-adding the constraint would fail
-- against them. Stats still treat null as "no result" and exclude the
-- trade rather than scoring it as breakeven.
--
-- To tighten this later, first confirm there is nothing to trip over:
--   select count(*) from trades where r_multiple is null;
-- and only if that returns 0:
--   alter table trades alter column r_multiple set not null;
alter table trades alter column r_multiple drop not null;

-- Screenshots went from one image per trade to many. screenshot_url is
-- kept so older trades keep rendering; new writes populate the array.
alter table trades add column if not exists screenshot_urls text[];
update trades
  set screenshot_urls = array[screenshot_url]
  where screenshot_urls is null and screenshot_url is not null;

-- login_events.user_id referenced auth.users with no cascade, so any row
-- here hard-blocked deleting the account — Supabase's deleteUser surfaced
-- that as an empty error, which read as a silent failure. The API route
-- clears the table explicitly; this cascade is the backstop for the next
-- table someone forgets. Guarded on confdeltype so re-running is a no-op
-- ('c' is cascade).
do $$
begin
  if exists (
    select 1 from pg_constraint
    where conrelid = 'public.login_events'::regclass
      and conname = 'login_events_user_id_fkey'
      and confdeltype <> 'c'
  ) then
    alter table login_events drop constraint login_events_user_id_fkey;
    alter table login_events
      add constraint login_events_user_id_fkey
      foreign key (user_id) references auth.users(id) on delete cascade;
  end if;
end $$;

-- login_events had select/insert policies but no update policy, so
-- renaming a device in the account page's sign-in history table was
-- silently blocked by RLS - the UI showed it as saved anyway, since the
-- update call wasn't checked for whether it actually touched a row.
-- Guarded on pg_policies so re-running is a no-op.
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'login_events'
      and policyname = 'Users update their own login events'
  ) then
    create policy "Users update their own login events"
      on login_events for update
      using (auth.uid() = user_id)
      with check (auth.uid() = user_id);
  end if;
end $$;

-- Trade times are stored as plain wall-clock values with no timezone of
-- their own (see lib/timezone.js) - the account page's UTC offset is only
-- a label for what that clock meant. Changing the offset re-labels every
-- trade at once by physically shifting trade_date/trade_time/exit_time by
-- the delta, called from PreferencesSection.js as
-- `supabase.rpc('shift_trade_times', { delta_hours })` right before the
-- new offset itself is saved. security invoker (the default) means RLS
-- still applies as the calling user; the explicit user_id filter below is
-- a second line of defense, not a substitute for it.
--
-- trade_date/trade_time are combined into one timestamp so a shift that
-- crosses midnight rolls the date over correctly; exit_time has no date
-- column of its own (see the trades table above), so it's shifted as a
-- bare time-of-day, wrapping at 24h in place - it stays exactly as far
-- from trade_time as it started, which is all trade duration math
-- (lib/tradeMath.js's tradeDurationMinutes) actually depends on.
create or replace function shift_trade_times(delta_hours numeric)
returns void
language sql
security invoker
as $$
  update trades
  set
    trade_time = ((trade_date + trade_time)::timestamp + (delta_hours * interval '1 hour'))::time,
    trade_date = ((trade_date + trade_time)::timestamp + (delta_hours * interval '1 hour'))::date,
    exit_time = case when exit_time is not null
      then (exit_time + (delta_hours * interval '1 hour'))::time
      else null
    end
  where user_id = auth.uid();
$$;

-- Free-text tags a trader can attach to a trade (e.g. "FOMC", "revenge
-- trade") - added/removed on the Log New Trade / Edit Trade forms, shown
-- read-only on the trade detail page and the trade log's expand row.
-- No separate tags table: there's no shared/managed tag list (unlike
-- strategies), so a plain array on the trade itself is all this needs.
alter table trades add column if not exists tags text[];

-- Fixed multi-select set of execution mistakes ('early entry', 'moved
-- stop', 'oversized', 'hesitated', 'other'), tagged on review rather than
-- at entry time so there's no pressure to self-judge while logging the
-- trade. Drives the mistake-tag breakdown table on the strategy detail
-- page - the "bad execution vs. no edge" signal.
alter table trades add column if not exists mistake_tags text[];

-- in_plan (from the v1 table above) was never read or written anywhere in
-- the app - mistake_tags is its replacement for the same "did this trade
-- deviate from plan" signal, at the granularity of which mistake it was
-- rather than a bare yes/no. Its existing values can't be backfilled into
-- mistake_tags (a boolean doesn't say which mistake), so this drops the
-- column outright rather than leaving a second, unused field alongside it.
alter table trades drop column if exists in_plan;
