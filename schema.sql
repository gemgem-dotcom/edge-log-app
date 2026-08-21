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

-- "Remove instrument" (the instrument-page kebab menu) is a soft hide, not
-- a delete - trades and strategies stay exactly as they are, still keyed
-- to this same instruments row, so re-adding the same symbol later from
-- "+ Add instrument" can just flip this back to false instead of losing
-- history or hitting the unique(user_id, symbol) constraint with a fresh
-- insert. Every instruments query across the app filters on this.
alter table instruments add column if not exists archived boolean not null default false;

-- Trade session metadata (hidden - no page surfaces this yet, see
-- lib/tradeSessions.js) computed once at write time from each trade's own
-- entry time: `session` is the named session (lib/marketHours.js's
-- sessionFor: London session, US pre-market, New York AM, Midday lull,
-- New York PM, Asian session) the trade was opened in; `continued_sessions`
-- is every other session boundary crossed, in order, before it closed -
-- always empty for a trade with no exit_time recorded, since duration
-- (and so whether it crossed into another session at all) can't be known
-- without one.
alter table trades add column if not exists session text;
alter table trades add column if not exists continued_sessions text[];

-- Backfill for trades logged before this feature existed, mirroring
-- lib/tradeSessions.js's own logic (same session boundaries, same
-- wall-clock-has-no-timezone-of-its-own interpretation shift_trade_times
-- above already relies on) as closely as SQL allows. Two known gaps
-- against the JS live path, both self-correcting rather than permanent:
-- (1) a trader who's never saved an explicit timezone gets UTC+0 here,
-- since this backfill has no browser to ask unlike a trade being logged
-- live - but every account is now required to have a real saved offset
-- (app/app/layout.js's TimezoneGate blocks the whole app until one's set),
-- and the moment that happens it calls lib/tradeSessions.js's
-- backfillOwnTradeSessions() to recompute that trader's own history for
-- real, overwriting whatever this UTC+0 pass guessed; (2) the
-- continued-sessions walk here advances the already-ET-converted wall
-- clock by whole minutes rather than re-deriving each minute from the
-- underlying UTC instant the way computeTradeSessions does, so a trade
-- that happens to span the exact hour of a DST transition could land in
-- the wrong session for that hour - backfillOwnTradeSessions corrects
-- this too, being the same function new trades use. Only touches rows
-- where session is still null, so it's safe to run again (e.g. after
-- restoring trades some other way that skipped the app).
create or replace function _session_for_et_minutes(minutes_of_day int)
returns text
language sql
immutable
as $$
  select case
    when minutes_of_day >= 1080 or minutes_of_day < 180 then 'Asian session'
    when minutes_of_day < 510 then 'London session'
    when minutes_of_day < 570 then 'US pre-market'
    when minutes_of_day < 690 then 'New York AM'
    when minutes_of_day < 810 then 'Midday lull'
    else 'New York PM'
  end
$$;

create or replace function _continued_sessions_walk(entry_et_ts timestamp, duration_min int, entry_session text)
returns text[]
language plpgsql
immutable
as $$
declare
  result text[] := '{}';
  last_label text := entry_session;
  cur_label text;
  m int;
begin
  if duration_min is null or duration_min <= 0 then
    return result;
  end if;
  for m in 1..duration_min loop
    cur_label := _session_for_et_minutes(
      (extract(hour from entry_et_ts + (m * interval '1 minute')) * 60
        + extract(minute from entry_et_ts + (m * interval '1 minute')))::int
    );
    if cur_label <> last_label then
      result := array_append(result, cur_label);
      last_label := cur_label;
    end if;
  end loop;
  return result;
end;
$$;

with tz as (
  select id as user_id, coalesce((raw_user_meta_data->>'timezone')::numeric, 0) as offset_hours
  from auth.users
),
entry as (
  select
    t.id,
    t.trade_time,
    t.exit_time,
    (((t.trade_date + t.trade_time)::timestamp - (tz.offset_hours * interval '1 hour'))
      at time zone 'UTC' at time zone 'America/New_York') as entry_et_ts
  from trades t
  join tz on tz.user_id = t.user_id
  where t.session is null
),
computed as (
  select
    id,
    entry_et_ts,
    _session_for_et_minutes(
      (extract(hour from entry_et_ts) * 60 + extract(minute from entry_et_ts))::int
    ) as session,
    case when exit_time is null then null else (
      select case when d < 0 then d + 1440 else d end
      from (select (extract(epoch from (exit_time - trade_time)) / 60)::int as d) x
    ) end as duration_min
  from entry
)
update trades t
set
  session = c.session,
  continued_sessions = _continued_sessions_walk(c.entry_et_ts, c.duration_min, c.session)
from computed c
where t.id = c.id;

drop function _continued_sessions_walk(timestamp, int, text);
drop function _session_for_et_minutes(int);

-- Trade Review's Discipline field (Log New Trade / Edit Trade). A trade is
-- either reviewed clean (reviewed_no_issues) or flagged with one or more
-- fixed issue tags (discipline_tags, grouped in the UI under Entry
-- discipline/Risk management/Exit discipline/Behavioral - see
-- components/TradeForm.js's DISCIPLINE_GROUPS) - never both, the form
-- clears discipline_tags whenever reviewed_no_issues is checked. Mandatory
-- on the form (one of the two has to be set) but nullable/defaulted here
-- the same way tags is, since trades logged before this existed have
-- neither.
alter table trades add column if not exists reviewed_no_issues boolean not null default false;
alter table trades add column if not exists discipline_tags text[];

-- Multiple exits (Log New Trade / Edit Trade's Trade Management section).
-- The trade's existing exit_time/exit_price/contracts columns still hold
-- the first (or only) exit unchanged - this column holds every exit
-- beyond that one, in the order they were entered, each shaped the same
-- way: {exit_time, exit_price, exit_points, contracts} (see exit_points
-- below for what it's derived from). $ P&L sums calcProfitLoss across the
-- primary exit and every row here (see lib/tradeMath.js's
-- calcMultiExitProfitLoss); r_multiple and session/continued_sessions
-- above are still derived from the primary exit only. Empty array (not
-- null) for a single-exit trade, so callers can always iterate it without
-- a null check.
alter table trades add column if not exists additional_exits jsonb not null default '[]'::jsonb;

-- The trader only ever types an exit price - exit_points is derived from
-- it at save time (lib/tradeMath.js's calcPointsFromExitPrice,
-- direction-aware the same way calcTargetPrice is) and stored alongside
-- it purely for future use (e.g. market-data matching); it's never shown
-- on the form. Nullable since trades logged before this existed only
-- ever had exit_price.
alter table trades add column if not exists exit_points numeric;
