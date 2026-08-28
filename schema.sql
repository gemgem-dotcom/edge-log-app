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
-- calcMultiExitProfitLoss); r_multiple is the blended, contracts-weighted
-- R-multiple across the primary exit and every row here (see
-- calcBlendedRMultiple) - it reduces to the primary exit's own R-multiple
-- when this array is empty. session/continued_sessions above are still
-- derived from the primary exit only. Empty array (not null) for a
-- single-exit trade, so callers can always iterate it without a null
-- check.
alter table trades add column if not exists additional_exits jsonb not null default '[]'::jsonb;

-- The trader only ever types an exit price - exit_points is derived from
-- it at save time (lib/tradeMath.js's calcPointsFromExitPrice,
-- direction-aware the same way calcTargetPrice is) and stored alongside
-- it purely for future use (e.g. market-data matching); it's never shown
-- on the form. Nullable since trades logged before this existed only
-- ever had exit_price.
alter table trades add column if not exists exit_points numeric;

-- in_plan was superseded by reviewed_no_issues/discipline_tags (the
-- Discipline field above) - confirmed nothing in the codebase still reads
-- or writes it, so unlike every other change in this file, this one is a
-- genuine drop rather than an addition: dead weight, not historical data
-- worth preserving.
alter table trades drop column if exists in_plan;

-- screenshot_url (singular) is legacy, going forward - TradeForm.js only
-- ever writes screenshot_urls now (see the comment above that column
-- further up), and screenshot_url is read in exactly one place
-- (app/app/[instrument]/log/[tradeId]/edit/page.js's fallback for a trade
-- whose screenshot_urls is still null). Left in place rather than
-- dropped, since there's no way to be certain every existing row's
-- one-time backfill into screenshot_urls above actually ran.

-- Edge Engine belief state (lib/edgeBeliefs.js) - a persistent, incrementally
-- updated companion to lib/edgeEngine.js's queryPerformance(). queryPerformance
-- recomputes stats from scratch from the trades table on every read; this table
-- instead keeps a running Bayesian posterior per "slice" (the same dimensions
-- queryPerformance groups by - session, strategy_id, instrument_id, discipline,
-- outcome, day_of_week, volatility/volume regime, and 2-way intersections of
-- these (see lib/edgeEngine.js's COMPOSITE_SLICES, e.g. outcome x discipline
-- or strategy_id x volatility_regime) - plus one root 'overall' slice), plus
-- one slice per individual discipline tag (lib/edgeBeliefs.js's tagSlices),
-- plus that same tag crossed with outcome (tagOutcomeSlices) - neither is a
-- queryPerformance groupBy dimension, since a trade can carry more than one
-- tag at once and contribute to more than one tag (or tag x outcome) slice,
-- unlike every dimension above where a trade belongs to exactly one value.
-- Updated incrementally at trade save/edit/delete time rather than rebuilt
-- from the full trade history on every read.
--
-- slice_key is a stable, human-diffable string encoding of bindings, e.g.
-- 'strategy_id:<uuid>' or 'strategy_id:<uuid>|volatility_regime:high' for a
-- 2-way intersection - see lib/edgeBeliefs.js's sliceKeyFor. bindings holds
-- the same information structured, for querying without parsing the key.
--
-- win_alpha/win_beta: beta-binomial posterior over this slice's win rate
-- (+1 alpha per win, +1 beta per loss; breakeven trades touch neither).
-- WARNING - degenerate for any slice built on the outcome dimension (e.g.
-- outcome:loss, outcome:win|discipline:clean): every trade contributing to
-- such a slice is by definition a win/loss/breakeven, so win_alpha/win_beta
-- there only restate the slice's own definition rather than measuring
-- anything, and drift toward 0%/100% as n grows. See the longer warning
-- above BASE_DIMENSIONS.outcome in lib/edgeEngine.js. avg_r_mean/n remain
-- meaningful for these slices (average win/loss size is real signal) - only
-- win_alpha/win_beta-derived "win rate" is degenerate, and no read-side
-- feature should surface a win rate for a slice_key containing "outcome:".
-- expectancy_mean/expectancy_m2 and avg_r_mean/avg_r_m2: two Welford
-- online-update accumulators (mean + M2, the sum-of-squared-deviations
-- Welford's algorithm carries instead of a running variance directly), both
-- currently fed the same per-trade r_multiple samples - see the comment in
-- lib/edgeBeliefs.js's applyOutcome for why they're kept as separate
-- accumulators today even though that makes them numerically identical to
-- each other (and to queryPerformance's own expectancy, which is likewise
-- identical to avgR by construction there).
--
-- parent_slice_key: the coarser slice a brand-new row is seeded from (e.g.
-- 'strategy_id:<uuid>' for 'strategy_id:<uuid>|volatility_regime:high', or
-- 'overall' for a top-level single-dimension slice) - win_alpha/win_beta and
-- avg_r_mean/expectancy_mean alike seed from the parent's current posterior
-- scaled by a fixed pseudo-count (win_alpha/win_beta additively, avg_r_mean/
-- expectancy_mean by treating that pseudo-count as phantom prior
-- observations fed through the same Welford update real trades use), so a
-- new slice starts from "what we already believe" rather than an
-- uninformative prior. That same pseudo-count is what a real trade's own
-- Welford update weights against for as long as the row exists (n +
-- pseudo-count, not n alone) - see lib/edgeBeliefs.js's buildSliceRow for
-- why. null only for the root 'overall' slice, which has no parent.
--
-- recent_outcomes: a capped (see lib/edgeBeliefs.js's RECENT_OUTCOMES_CAP)
-- most-recent-first array of {trade_id, r_multiple, trade_date}, used so an
-- edit/delete can reverse a specific trade's contribution by trade_id rather
-- than only ever being able to undo the last one applied.
create table edge_beliefs (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references auth.users not null,
  slice_key text not null,
  bindings jsonb not null,
  parent_slice_key text,
  win_alpha numeric not null,
  win_beta numeric not null,
  expectancy_mean numeric,
  expectancy_m2 numeric,
  avg_r_mean numeric,
  avg_r_m2 numeric,
  n integer not null default 0,
  confidence_tier text not null default 'too_early',
  recent_outcomes jsonb not null default '[]'::jsonb,
  last_trade_at timestamptz,
  last_revised_at timestamptz,
  revision_note text,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique(user_id, slice_key)
);

alter table edge_beliefs enable row level security;
create policy "Users manage their own belief state"
  on edge_beliefs for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Daily completed-session market data (lib/databento.js, scripts/
-- fetch-daily-market-stats.js) - one row per trading day, shared by every
-- trader rather than duplicated per user. The brief this shipped under
-- specified `instrument_id uuid references instruments(id)` as this table's
-- key, but instruments is a per-user table (unique(user_id, symbol)) with no
-- single shared "NQ" row to reference, and CLAUDE.md's own domain rules say
-- future market-data lookups should key off data_symbol, not a specific
-- instruments row, since that's what groups mini/micro contracts (MNQ, NQ)
-- onto the same underlying series. Flagged to the user, who confirmed
-- data_symbol over the brief's literal instrument_id FK - see the PR
-- description for the full reasoning.
--
-- No RLS ownership policy makes sense here (no user_id - this isn't anyone's
-- data) - RLS is still enabled, but only a read policy exists. Writes come
-- exclusively from scripts/fetch-daily-market-stats.js using
-- SUPABASE_SERVICE_ROLE_KEY (bypasses RLS entirely), the same key already
-- used by the two API routes in app/api/ - see README.md/NOTES.md.
create table market_session_stats (
  data_symbol text not null,
  session_date date not null,
  total_range numeric not null,
  total_volume numeric not null,
  created_at timestamptz default now(),
  primary key (data_symbol, session_date)
);

alter table market_session_stats enable row level security;
create policy "Anyone signed in can read market session stats"
  on market_session_stats for select
  using (auth.role() = 'authenticated');

-- Per-trade regime labels (lib/tradeRegimes.js) - high/normal/low, bucketed
-- by comparing the trade's own session's total_range/total_volume against
-- the trailing 20 sessions in market_session_stats. Nullable and lazily
-- backfilled at read time (app/app/layout.js, on every app-shell mount) -
-- null means "not yet applicable" (a same-day trade whose session hasn't
-- closed, the daily job hasn't run yet, or the trade isn't on an NQ-family
-- instrument), never a guessed value, same principle as `session` above.
alter table trades add column if not exists volatility_regime text;
alter table trades add column if not exists volume_regime text;

-- MFE/MAE/drawdown (lib/tradeExcursions.js, app/api/backfill-trade-
-- excursion/route.js, scripts/retry-trade-excursions.js) - computed once
-- from a fixed entry-to-final-exit window (trades are only ever logged
-- after they've closed, so there's no "still updating" state), from real
-- NQ trade prints (Databento's `trades` schema, tick-level - not ohlcv-1m
-- bars; this account's plan has confirmed live access to both `ohlcv-1s`
-- and `trades`). mfe_points/mae_points are raw, direction-aware points
-- (long: mfe = high-entry, mae = entry-low; short: mirrored), the true
-- highest/lowest price the market actually traded at between entry and
-- exit - displayed as an R-multiple (divide by stop_distance) rather than
-- stored twice, the same pattern realized R already follows. An earlier
-- version of this capped MFE/MAE at the trade's own stop/target instead of
-- using 1-minute-bar extremes directly, to correct for coarse-bar
-- ambiguity - superseded by the move to tick-level data, which has no such
-- ambiguity to correct for and doesn't depend on trusting `stop`/`target`
-- values a trader could edit after the fact (see NOTES.md). drawdown_
-- seconds is cumulative real elapsed time the position's unrealized P&L
-- was underwater (walking consecutive trade prints, not a bar-count
-- multiple), summed across every separate underwater period, not just
-- time-to-first-recovery.
--
-- market_data_status drives display and the retry job, not just a cache
-- flag: 'pending' means blocked on this account's confirmed ~8-hour
-- GLBX.MDP3 access embargo (not a bug - see NOTES.md) *or* on a fetch
-- attempt that failed for some other, not-reliably-classifiable reason
-- (network hiccup, transient 5xx, rate limit) *or* on a successful fetch
-- that returned zero trade prints - a real NQ session window this narrow
-- essentially never genuinely lacks real prints, so an empty response is
-- treated as transient too, not just a thrown error (a real trade proved
-- this: 'unavailable' with zero ticks one moment, 20k+ ticks and a clean
-- fill match on the exact same window minutes later). All three are left
-- retryable by design, since a real trade was once silently and
-- permanently lost to exactly this pattern (a transient failure treated
-- as terminal) before this comment was corrected; see NOTES.md.
-- 'unavailable' means a genuine, deterministic, non-retryable miss
-- (wrong/unsupported instrument, no timezone or exit window) - set
-- explicitly rather than left stuck in 'pending' forever. null (no
-- default) means this trade has never been attempted yet, or isn't on an
-- NQ-family instrument - same "not yet applicable" principle as
-- volatility_regime/volume_regime above, not a fourth status to branch on.
alter table trades add column if not exists mfe_points numeric;
alter table trades add column if not exists mae_points numeric;
alter table trades add column if not exists drawdown_seconds integer;
alter table trades add column if not exists market_data_status text;

-- trade_time/exit_time are only reliably accurate to the minute - the
-- seconds field is frequently a TimePicker default, not a real observation
-- (see lib/tradeExcursions.js's findFillTick/deriveFillTicks for the full
-- mechanism). Rather than trust that logged second as the window boundary,
-- the entry/exit instants actually fed into computeExcursion are derived
-- from the first real trade print that touches the fill level (entry price
-- / that leg's own exit price), searched within roughInstant ±
-- FILL_SEARCH_PAD_MINUTES. excursion_fallback is true when that search
-- failed for the entry or any exit leg and fell back to the raw logged
-- timestamp instead - a trade marked true still carries the original
-- second-level imprecision this mechanism exists to remove, so it needs to
-- stay visible and queryable, not silently indistinguishable from a trade
-- whose window was fully price-derived.
alter table trades add column if not exists excursion_fallback boolean;

-- Whether trade_time/exit_time's *own logged second* could be corrected to
-- a real one. Unlike excursion_fallback above, this doesn't touch the
-- ±FILL_SEARCH_PAD_MINUTES search used for MFE/MAE windowing - it's a
-- separate, stricter search (lib/tradeExcursions.js's
-- findVerifiedMinuteFill/deriveVerifiedTimes) bounded to exactly the
-- trader's own logged minute, on the premise that the minute itself is
-- trustworthy and only the second (usually just a TimePicker default, per
-- the comment above) isn't. app/api/backfill-trade-excursion/route.js
-- overwrites trade_time/exit_time (and each additional_exits leg) with the
-- real second whenever that search succeeds, using the same trade-print
-- fetch already made for excursion computation - no extra Databento call.
-- trade_time_unverified is true when it *didn't* for the entry or some
-- exit leg - that logged price never actually traded during its own
-- logged minute, so that field was left exactly as logged and the trader
-- should double-check it. Surfaced on the trade detail page and the trade
-- log's expand row (unlike excursion_fallback, which stays developer-only)
-- for exactly that reason - it's a claim about what the trader themselves
-- logged, not an internal computation detail.
alter table trades add column if not exists trade_time_unverified boolean;

-- edge_beliefs.user_id referenced auth.users with no cascade, same failure
-- mode login_events had above (see that fix's comment) - any belief row for
-- a user hard-blocked deleting their account, surfaced as GoTrue's generic
-- "Database error deleting user" rather than anything pointing at the real
-- cause. Since a belief row exists per (user, dimension-slice) and gets
-- created on a user's very first trade (lib/edgeBeliefs.js's applyTrade),
-- this blocked deletion for essentially any account that had ever logged a
-- trade. app/api/delete-account/route.js now also clears this table
-- explicitly, same as trades/strategies/instruments/login_events; this
-- cascade is the same backstop login_events' fix added, for whichever table
-- gets forgotten next. Guarded on confdeltype so re-running is a no-op.
do $$
begin
  if exists (
    select 1 from pg_constraint
    where conrelid = 'public.edge_beliefs'::regclass
      and conname = 'edge_beliefs_user_id_fkey'
      and confdeltype <> 'c'
  ) then
    alter table edge_beliefs drop constraint edge_beliefs_user_id_fkey;
    alter table edge_beliefs
      add constraint edge_beliefs_user_id_fkey
      foreign key (user_id) references auth.users(id) on delete cascade;
  end if;
end $$;

-- MFE/MAE/drawdown per belief slice (lib/edgeBeliefs.js's applyExcursion/
-- reverseExcursion) - three more Welford accumulators, same shape as
-- avg_r_mean/expectancy_mean, but NOT populated by the ordinary
-- applyTrade/reverseTrade path above. mfe_points/mae_points/
-- drawdown_seconds (see the comment above that column on `trades`)
-- usually aren't known yet when a trade is first saved - Databento access
-- is embargoed for several hours, so this data typically only exists once
-- app/api/backfill-trade-excursion/route.js or the hourly retry job fills
-- it in, well after the trade's own core belief contribution has already
-- been applied - hence the separate apply/reverse pair, triggered from
-- wherever mfe_points actually gets written, not from the trade save/
-- edit/delete flow. mfe_r_mean/mae_r_mean store MFE/MAE as an R-multiple
-- (mfe_points/mae_points divided by the trade's own stop_distance), the
-- same convention the trade detail page already displays them in, so they
-- stay comparable across instruments with different point values rather
-- than being raw, incomparable points. excursion_n is a SEPARATE count
-- from n above - only some trades in any slice will ever have this data
-- (currently NQ-family only, though Databento coverage is expected to
-- extend to other instruments later), so it can't share n's count without
-- corrupting the Welford weighting for every slice member that never gets
-- excursion data at all.
--
-- scripts/retry-trade-excursions.js keeps its own duplicate copy of the
-- Welford/seeding math involved here, rather than importing this file -
-- see that script's own header comment for why (it's a standalone script
-- outside the app's module system, deliberately self-contained so a
-- change to the app's tooling can never silently break its hourly run).
-- If the math in lib/edgeBeliefs.js's applyExcursion/buildExcursionRow
-- ever changes, mirror the exact same change in that script's copy, or
-- the two will silently disagree about a slice's MFE/MAE numbers
-- depending on which of the two paths backfilled a given trade.
alter table edge_beliefs add column if not exists mfe_r_mean numeric not null default 0;
alter table edge_beliefs add column if not exists mfe_r_m2 numeric not null default 0;
alter table edge_beliefs add column if not exists mae_r_mean numeric not null default 0;
alter table edge_beliefs add column if not exists mae_r_m2 numeric not null default 0;
alter table edge_beliefs add column if not exists drawdown_seconds_mean numeric not null default 0;
alter table edge_beliefs add column if not exists drawdown_seconds_m2 numeric not null default 0;
alter table edge_beliefs add column if not exists excursion_n integer not null default 0;
