# EdgeLog — working notes

Conventions, gotchas and workflow for anyone working on this repo (including AI
assistants). `README.md` is the setup guide; this file is the "how we work here" file.
Keep it up to date as things change.

## How to make a change

1. **Never commit straight to `main`.** `main` is what Vercel deploys to production,
   so a bad commit is instantly live.
2. Create a branch and open a pull request.
3. Two checks then run automatically:
   - **Build check** (GitHub Actions, `.github/workflows/ci.yml`) runs `npm run build`.
     A red X means the code does not compile — do not merge.
   - **Vercel preview deployment** gives the branch its own temporary URL.
4. Test the change on the preview URL, not on production.
5. Merge to `main` only once the Build check is green and the preview looks right.

## Project map

```
app/
  globals.css                      all styling for the entire app (one stylesheet)
  layout.js                        root layout
  page.js                          login screen
  signup/, forgot-password/, reset-password/
  api/record-login/route.js        writes/updates the sign-in history (server only)
  api/delete-account/route.js      deletes a user and their data (server only)
  app/page.js                      first-run instrument setup
  app/account/page.js              account settings shell; each concern is a
                                   component under components/account/
  app/[instrument]/
    layout.js                      app shell + sidebar nav + instrument switcher
    dashboard/page.js              Overview: stats, strategy performance, Monthly P&L
    log/page.js                    trade log
    log/new/page.js                log a new trade
    log/[tradeId]/page.js          trade detail (read only)
    log/[tradeId]/edit/page.js     edit a trade
    strategies/                    strategy manager + per-strategy pages
    insights/                      placeholder
components/                        shared UI (TradeForm, TradeLogTable, ...)
  account/                         one component per account-settings concern
lib/
  supabaseClient.js                the one browser Supabase client
  strategyColor.js                 strategy colour assignment
  validatePassword.js              signup password rules
  instrumentCatalog.js             fixed instrument list + data_symbol mapping (mini/micro → shared symbol)
  instruments.js                   addOrRestoreInstrument() - add/re-add an instrument, see below
  tradeMath.js                     stop/target distance → price, R-multiple and R:R calc
  tradeForm.js                     trade-form validation + currency parse/format
  screenshots.js                   screenshot upload, throws so callers word their own errors
  timezone.js                      UTC offset list + timestamp formatting
  useClickOutside.js               close a dropdown on outside click / Escape
  greeting.js                      time-of-day-aware greeting phrases for the Overview page
  streak.js                        current win/loss streak from a list of trades
  marketContextMock.js             placeholder key-levels/econ-event data (not live) +
                                    nextEconEvent(), which is real math over that mock list
  marketHours.js                   ET trading-session/open-closed logic, CME holidays layered in
  cmeHolidays.json                 static CME holiday/early-close calendar - see below
  contractRollover.js/.json        static per-underlying contract rollover/expiration dates
scripts/
  generate_cme_holidays.py         regenerates lib/cmeHolidays.json - see below
jsconfig.json                      the @/ import alias
schema.sql                         database tables + row level security
storage-setup.sql                  screenshots storage bucket
```

## Environment variables

| Name | Where | Notes |
| --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | browser + server | safe to expose |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | browser + server | safe to expose |
| `SUPABASE_SERVICE_ROLE_KEY` | **server only** | full admin access to the database. Used by the two API routes. Never import it into a page or prefix it with `NEXT_PUBLIC_`. |

All three must exist locally in `.env.local` and in Vercel (Project Settings →
Environment Variables). The CI build uses harmless placeholder values, because
nothing during a build talks to the database.

The Overview pages' "Economic calendar" and key-levels cards, plus three of the five
"Market context" stat cards (current session's range vs. typical, overnight gap,
volume vs. typical - shown honestly as "Needs Phase 2" rather than invented numbers)
currently render mock data from `lib/marketContextMock.js`
(`components/EconomicCalendarCard.js` and the inline key-levels block in
`OverviewDashboard.js` and `app/app/[instrument]/dashboard/page.js`). These previously
ran on a live BLS/FRED/FOMC pipeline (`app/api/economic-calendar`,
`lib/fredReleases.js`, `lib/computedReleases.js`) that was pulled out in favor of a
paid market-data provider - not yet wired up. `lib/marketContextMock.js`'s exports
keep the shape a real provider's data would need, so swapping it back to a live
source shouldn't require touching the cards themselves. The other two Market context
stats (days to contract rollover, time to next calendar event) are real, not mocked -
see `lib/contractRollover.js` and `marketContextMock.js`'s `nextEconEvent()`. Time to
next calendar event is per-instrument dashboard only - the all-instruments Overview
dropped it since a single shared countdown read as redundant repeated once per row.

## CME holiday calendar

`lib/cmeHolidays.json` is a static lookup of CME holiday closures and early-close
days (used by `lib/marketHours.js`, `components/HolidayNotice.js`, and
`lib/contractRollover.js`), generated by `scripts/generate_cme_holidays.py` from the
`pandas_market_calendars` `CME_Equity` calendar - the real, actively maintained
source for CME-specific rules (not just a copy of NYSE's calendar). There's no live
API for this; holiday schedules are published a year in advance and barely change,
so it doesn't need a runtime network call.

It also doesn't need a human to re-run it: `.github/workflows/refresh-cme-holidays.yml`
runs the script on a yearly schedule (Jan 2nd, plus manual `workflow_dispatch`), and if
the calendar actually changed, builds the app against the regenerated data (the same
`npm run build` the Build check runs) and only opens + squash-merges a PR if that
passes - no review step, by design. This has been proven end-to-end on a live run: the
PR it opened was merged with zero human clicks. Getting there needed one-time setup -
see the comment at the top of that workflow file for the full story - a
`CME_HOLIDAY_REFRESH_TOKEN` repo secret (a PAT with Contents + Pull requests write
access on this repo specifically) to get past a repo-wide "Actions can't create PRs"
setting that's off by default, and a `github.run_id` suffix on the branch name to avoid
same-day collisions with a leftover branch from an earlier run.

Rollover dates are calendar rules ("3rd Friday of the month", etc.) that don't
themselves know about holidays, so a listed date can land on one - `lib/contractRollover.js`'s
`daysToRollover`/`nextRolloverDate` walk a date that lands on a `cmeHolidays.json` full
closure back to the prior actual trading day before returning it (early closes are left
alone - the exchange is still open then). This runs automatically at read time against
whatever `cmeHolidays.json` currently holds, so it stays correct as that file gets
refreshed - no extra step needed when the yearly workflow above updates it.

## Databento market data

Historical only - `lib/databento.js` and `scripts/fetch-daily-market-stats.js` never
call anything but Databento's Historical API (`GLBX.MDP3` dataset, `ohlcv-1m` schema),
scoped to NQ's continuous front-month symbol (`NQ.c.0`) only. There's no official
Databento Node/JS SDK, so both talk to the underlying `v0/timeseries.get_range` HTTP
endpoint directly with `fetch` - `databento.com` itself isn't reachable from this
project's dev/CI network egress, so that request/response shape was cross-checked
against a community Databento MCP server's TypeScript implementation on GitHub instead
of official docs.

Smoke-tested live against a real `DATABENTO_API_KEY` (2026-08-24/25) - the request
shape itself was confirmed correct (Databento parsed it and replied with a proper
structured error, not an auth failure), but the job as first scheduled couldn't
actually get data: **this account's access to `GLBX.MDP3` lags wall-clock time by
~8 hours**, gated behind an explicit "requires a subscription and/or license" error.
The original schedule (23:30 UTC, same evening) asked for a session that had closed
on the calendar but that an 8-hours-behind account couldn't see yet - CME's own close
(~21:00-22:00 UTC) is itself less than 8 hours before 23:30 UTC, so the job was
structurally scheduled too early for what this account can access, no matter how the
request window was tuned. Fixed by moving the schedule to the following morning
(09:30 UTC, comfortably past the embargo from even the latest possible close) and
having the script fetch *yesterday's* ET session instead of "today's" - confirmed
with a real row landing in `market_session_stats` afterward. Nothing downstream needs
same-evening freshness (every reader already works off "the most recently completed
session"), so this cost nothing.

`.github/workflows/refresh-market-session-stats.yml` runs the fetch once daily (09:30
UTC, fixed - not a DST-aware local-time translation, since the embargo above is
wall-clock-based, not ET-based), computing the previous session's total range and
total volume from the fetched 1-minute bars and upserting one row into
`market_session_stats`, keyed by `data_symbol` ('NQ') rather than a specific
`instruments` row - see the long comment above `create table market_session_stats` in
`schema.sql` for why (that table has no per-user owner, so it isn't an
`instruments(id)`-scoped table the way `trades` is). Skips the day entirely (no
fetch, no row written) on a weekend or a `cmeHolidays.json` full closure; on an
early-close day it fetches only up through the shortened close time. Fails gracefully
(logs, skips, exits 0) rather than crashing the workflow if Databento is unreachable or
returns nothing for the day.

Needs three repo secrets that don't otherwise exist for GitHub Actions (Vercel has them
already, Actions doesn't share Vercel's env vars) - see the comment at the top of the
workflow file: `DATABENTO_API_KEY`, `SUPABASE_SERVICE_ROLE_KEY`,
`NEXT_PUBLIC_SUPABASE_URL`.

`lib/edgeEngine.js`'s `volatility_regime`/`volume_regime` trade dimensions read from
this table (trailing-20-session comparison) rather than calling Databento directly -
this daily job is the only place in the whole pass that talks to Databento on a
recurring basis, keeping usage small and predictable against the signed-up $125 free
credit.

### Known excursion (MFE/MAE/drawdown) data issues - needs a human look

One trade's `mfe_points`/`mae_points`/`drawdown_seconds` remains deliberately
un-recomputed and excluded from the bulk recompute, rather than silently
"fixed" or silently left stale:

- **`7e8616fb-334b-4465-8a2f-e572b634df5a`** - two independent, unrelated corrections
  (fill-instant precision, and volume-based front-month resolution near a quarterly
  roll) both failed to find real price action matching this trade's logged entry/exit
  levels nearby its logged times, on either candidate contract. The trade's own logged
  fields are internally consistent (correct stop/target sides for a short, exact
  target hit, `r_multiple` matching entry/stop/exit exactly) - so this isn't a garbled
  entry.

  **Follow-up (genuinely unresolvable, no correction made):** manually searched a
  full 3-calendar-day window (the day before, of, and after the logged trade date)
  on NQU6, the correct front-month contract for this trade's roll-proximity window.
  The entry price (29737.5) was touched by 196 separate one-minute bars across all
  three days; the exit/target price (29576) was touched by 34 bars across two of
  them. Both levels sit inside a wide, choppy multi-day range and get retested too
  often for a price-touch search to isolate a single real fill instant - widening
  the window past the automated fix's ±1 minute didn't narrow things down, it just
  surfaced how common both price levels are. (The other candidate contract, NQM6,
  returned zero bars for the entire window - it had already rolled off by this
  trade's date, consistent with the roll-aware fix's choice of NQU6.) No specific
  corrected timestamp could be identified from this data source with any
  confidence, so nothing was written - this needs the trader's own memory of the
  trade, not further automated searching.

  **Re-checked again after the tick-level rewrite (still unresolvable):** this
  investigation predates the switch from 1-minute bars to real trade prints, so it
  was worth a second attempt with the sharper tool - correct roll-aware contract
  (NQU6, instrument_id 42004177), 24,161 real ticks fetched in the standard
  ±`FILL_SEARCH_PAD_MINUTES` window, both the entry-price and the verified-minute
  searches run for real (not simulated). Neither found a match - `excursion_fallback`
  and `trade_time_unverified` both come back true, and MFE/MAE recompute to the same
  -11.00/+170.00 already on file. Confirms the original call rather than overturning
  it: this genuinely isn't in the data at any granularity tried so far, not a tooling
  limitation. Still excluded via `MANUAL_REVIEW_TRADE_IDS`, still needs the trader's
  own memory.

This trade keeps whatever `mfe_points`/`mae_points`/`drawdown_seconds`/
`excursion_fallback` values it already had before this note was written -
nothing here touched them, and it's excluded from every automated recompute
(`scripts/recompute-trade-excursions.js`'s `MANUAL_REVIEW_TRADE_IDS`).

**Two other flagged trades have since been corrected and removed from that set.**

`137c4594-c6d0-40f1-904f-acb9e71d9ef6` was flagged for the same reason
(`excursion_fallback = true`, no matching bar for at least one leg) but, unlike
`7e8616fb`, a specific real fill instant *could* be identified with confidence: a
manual tick-level search (`trades` schema, wide window) found the actual entry
print at `2026-08-19T13:41:51.549Z` and exit print at `2026-08-19T13:48:35.070Z` -
both about 10 minutes earlier than this trade's originally logged times, which the
trader confirmed was a logging error made at the time. Corrected and written by
hand (not by the automated recompute): `trade_time` 09:41:51 ET, `exit_time`
09:48:35 ET, `mfe_points = 63.50`, `mae_points = 36.00`, `drawdown_seconds = 39`,
`market_data_status = 'complete'`, `excursion_fallback = false`.

`076af9b3-312c-47c8-9987-1e6176545a6b` turned out to be a genuine data-entry
error, not an algorithm or roll-resolution problem: the original investigation
found its exit price (30669.25) matched cleanly but its entry (30901) matched no
real print anywhere within ±15 minutes. The trader identified the actual mistake
themselves and corrected the logged entry to `30870.25` directly through the edit
page. That save triggered the normal edit-time recompute, which briefly left the
trade `pending` (a transient fetch hiccup, not the embargo - this trade is months
old), picked up cleanly by the next forced run of the hourly retry job with no
manual intervention needed: `trade_time` 09:47:00 → 09:47:58, `exit_time` 10:30:00
→ 10:30:03, `mfe_points` 231.75 → 201.00, `mae_points` -12.00 (a physically
impossible negative) → 18.75, `drawdown_seconds` 0 → 255, `excursion_fallback` and
`trade_time_unverified` both `false`. This is the case for the general lesson: a
"couldn't verify" flag can mean the trader mislogged something as easily as it can
mean a genuine market-data gap, and the fix in that case is just fixing the log
entry, not touching the pipeline.

### trade_time/exit_time's own logged second can be corrected, separately from MFE/MAE

`137c4594`'s correction above was done by hand because the discrepancy was a
whole ~10 minutes - a real "the trader mislogged this" case needing a human
decision, not something to automate. But the much smaller, universal version of
that problem - the *second* within an otherwise-correct logged minute being
untrustworthy (a TimePicker default, not a real observation - see the
`excursion_fallback` comment above and schema.sql's) - doesn't need a human
per trade. If the trader is trusted to have logged the right minute, and their
entry/exit price actually traded at some point during that exact minute, the
real trade print that touched it *is* the real second.

`lib/tradeExcursions.js`'s `findVerifiedMinuteFill`/`deriveVerifiedTimes` do
that: for each of entry and every exit leg, search the *already-fetched* trade
prints (no extra Databento call) for the earliest one touching that leg's
price, bounded strictly to that leg's own logged minute - not the wider
±`FILL_SEARCH_PAD_MINUTES` window `findFillTick`/`deriveFillTicks` use for MFE/
MAE windowing, since that window exists to tolerate a somewhat-off instant, not
to license relabeling which minute a logged time belongs to. When a leg's
price never actually traded during its own logged minute, that field is left
exactly as logged rather than guessed at, and the whole trade gets
`trade_time_unverified = true` - unlike `excursion_fallback`, this is shown to
the trader (trade detail page, log table's expand row), since it's a claim
about what *they* logged, not an internal computation detail.

Wired into all three places that already compute MFE/MAE from trade prints -
the live route (`app/api/backfill-trade-excursion/route.js`), the hourly retry
job, and the one-time recompute script - so `trade_time`/`exit_time` (and each
`additional_exits` leg) get corrected going forward for every new trade, and
were corrected in bulk for every existing `complete` trade in the same
`scripts/recompute-trade-excursions.js` run that shipped this (see that run's
own log for exactly how many trades' times actually changed vs. how many got
flagged unverified).

### A fallback-derived MFE/MAE is hidden, not shown as a real number

`7e8616fb`'s displayed MAE (`+170.00pts`, bigger than its own 55pt stop distance -
physically impossible for a trade that wasn't stopped out) is what led to it being
re-investigated in the first place. That number came from `excursion_fallback`
being true (the fill-tick search couldn't verify entry or an exit leg, so
`computeExcursion` ran over a window anchored to the raw, unverified logged
instant instead) - a real, working safety mechanism, but one that only recorded
the uncertainty in a developer-only column while still rendering a normal-looking
number to the trader.

`excursionStatusMessage` (`lib/tradeExcursions.js`) now treats `market_data_status
= 'complete'` with `excursion_fallback = true` the same as any other
not-yet-trustworthy state, returning `'Unverified'` instead of null - both
`excursionCell` implementations (trade detail page, log table's expand row) check
this before falling through to the real number. A future roll-window mismatch (or
any other fill-verification failure) now shows "Unverified" immediately rather
than a concrete-but-possibly-wrong figure making it all the way to the trader's
screen unflagged.

### A transient Databento fetch error could permanently discard excursion data

Found investigating a user report of a trade whose MFE/MAE/Time in drawdown
never filled in. Trade `471db32c-4be5-4fbc-9014-7c59db1f5326` (2026-08-25,
short, entry 29398, exit 29268) correctly went `pending` at save time (still
within the ~8h Databento access embargo), but was later found stuck on
`market_data_status = 'unavailable'` - a status the hourly retry job
(`scripts/retry-trade-excursions.js`) never revisits. A live re-fetch of the
exact same window found Databento had perfectly good data the whole time (20
bars, clean fill-instant match on both legs, no fallback needed) - so the
data was never actually unrecoverable.

Root cause: both `app/api/backfill-trade-excursion/route.js` and
`scripts/retry-trade-excursions.js` treated *any* non-embargo error from the
Databento fetch call as a permanent miss, identical to a genuinely
deterministic one (unsupported instrument, no bars returned). A one-off
network hiccup, transient 5xx, or rate limit during a single hourly retry was
enough to permanently bury a trade's data with no way back. Fixed in both
places to leave the trade `pending` instead on a non-embargo fetch error, so
the hourly retry job keeps trying - the same treatment an embargo holdover
past its expected clear time already got. See `schema.sql`'s comment above
`market_data_status` for the corrected state semantics.

This one trade was manually corrected afterward using the same logic the
fixed code now runs automatically (`mfe_points=137.75`, `mae_points=16.75`,
`drawdown_seconds=120`, `excursion_fallback=false`) - no other trades were
found in this state at the time, but any future occurrence should now
self-heal within an hour instead of getting stuck.

### MFE/MAE/drawdown are computed from real trade prints, not 1-minute bars

The formula's history, in order:

1. Originally: 1-minute-bar (`ohlcv-1m`) high/low over the entry-to-exit
   window, uncapped.
2. Briefly: MFE capped at the target and MAE capped at the stop whenever
   the trade's final exit leg actually landed on that level - specified
   against two worked examples (entry 1000, runs to 1100, manual close at
   1090 -> MFE is the full 100, uncapped, since neither level was touched;
   entry 1000, stop 950, runs to 1050 in profit then reverses and stops
   out -> MFE stays the real highest point reached (uncapped), MAE is
   capped exactly at the 50-point stop distance rather than whatever the
   closing bar's low showed, since a resting stop order closes the
   position the instant price reaches it - any bar movement beyond that
   within the same minute is intra-bar noise the trade was never actually
   exposed to).
3. **Current**: superseded (2) entirely. Live access to Databento's
   `trades` (tick-level) and `ohlcv-1s` schemas was confirmed for this
   account's plan - not just `ohlcv-1m` - which removes the reason (2)
   existed in the first place: a real trade print has no coarse-minute
   ambiguity to correct for, so there's nothing to cap. It's also more
   robust than (2) was, independent of a concern raised directly: `stop`/
   `target` are ordinary, freely-editable fields with no history of what
   they were when a trade was actually live, so capping by them trusted
   values that could have been changed after the fact. `entry`/`exit_price`
   don't have that problem - they're tied to real price action via the
   fill-tick matching itself.

`computeExcursion` (`lib/tradeExcursions.js`) now takes real trade prints
already sliced to `[entryInstant, exitInstant]`: MFE/MAE are the true
highest/lowest traded price in that window, full stop, and drawdown_seconds
walks consecutive prints to total real elapsed underwater time (the price a
print establishes persists until the next one) rather than multiplying a
bar count by 60. `findFillTick`/`deriveFillTicks` replace the old
`findFillInstant`/`deriveFillInstants`: same idea (match the trade's
logged entry/exit price against real market data near the logged time,
falling back to the raw wall-clock instant if nothing matches), but
picking the *earliest* qualifying match rather than checking a priority-
ordered set of minute buckets, since a tick doesn't need bucket alignment
the way a bar did (see the correction below for why "earliest," not
"closest in time," is the right rule).

Every existing `complete` trade's `mfe_points`/`mae_points`/
`drawdown_seconds` was recomputed under this rule
(`scripts/recompute-trade-excursions.js`, run live via a temporary GitHub
Actions workflow) - except the two trades flagged above under "Known
excursion data issues," which are excluded from every automated recompute
until a human looks at them directly.

### Fill matching picks the *first* touch of the price, not the closest-in-time one

The initial tick-level version above still had a bug: `findFillTick`
picked whichever matching tick was closest in time to the trade's logged
(only ~1-minute-accurate) clock time, not the first one chronologically.
Those aren't the same thing, and the difference matters: if price touched
the entry level, moved adverse, recovered, and touched it again nearer the
logged time, closest-in-time would anchor the window at the *later*
touch - silently missing the real adverse move in between. This is exactly
what a trader's report of some trades showing `mae = 0` traced back to,
and is also what produced trade `076af9b3`'s negative MAE (investigated
below).

The correct rule: MAE/MFE should count from the exact moment the market
*first* reached the price the trader entered at - a limit order fills on
first touch, and a market/stop order's fill price is whatever price was
current the instant it triggered. Given logged times are only accurate to
about a minute, the fix is to pick the earliest matching tick within the
already-fetched, padded window, not the nearest-in-time one. Chained
forward per leg (`afterInstant` in `findFillTick`) so a price level
touched more than once can't accidentally match an exit leg to an earlier
occurrence than the one that actually closed it (the same failure mode
`7e8616fb`/`137c4594` hit, applied here to prevent it happening for the
tick-level path too).

Live-recomputed again after this fix - see the numbers below for what
changed.

**Follow-up bug in the fix above:** the "earliest at or after the previous
anchor" rule had no upper bound, so a leg whose price coincides with an
*earlier* anchor's price - most commonly a breakeven trade, where the exit
price equals the entry price - would trivially re-match the entry fill's
own tick (which of course also "touches" that same price), collapsing the
whole window to ~0 duration and erasing every minute of real price action
in between. A trader reported exactly this: a 50-minute breakeven trade
showing MFE, MAE, and Time in drawdown all reading 0.
`findFillTick` now bounds each leg's search to `roughInstant ±
FILL_SEARCH_PAD_MINUTES` (its *own* logged time), not just "anywhere after
the previous anchor" - so a same-price exit 50 minutes later correctly
searches near the real logged exit time instead of immediately re-matching
entry. Verified against three scenarios before going live again: the
original first-touch case, this breakeven case, and the multi-touch
(`7e8616fb`-style) case that motivated the `afterInstant` floor in the
first place - all three had to hold together, not just the one being
fixed.

`scripts/backfill_trade_excursions_from_dbn.py` (the one-time, already-run
DBN-file backfill) was **not** upgraded to tick-level - it only ever reads
whatever schema its one already-downloaded file contains (`ohlcv-1s`, one
step coarser than the live path now, but still finer than `ohlcv-1m`), and
there's no tick-level DBN file available to re-verify against. Its
stop/target-capping was reverted back to the plain bar-derived formula for
consistency with the rest of the codebase, since that heuristic is gone
everywhere else - it should not be re-run without a matching tick-level
file if it's ever needed again.

## Removing an instrument

The kebab menu next to the title on each per-instrument page (Overview, Trade Log,
Strategies - `components/InstrumentMenu.js`) can "remove" an instrument. It's a soft
hide, not a delete: `instruments.archived` flips to `true`, and every `instruments`
query across the app filters on it, so the instrument and everything under it
(trades, strategies, stats) disappears everywhere - the sidebar switcher, the
all-instruments Overview, the all-trades log, direct links to its own pages - without
touching a single trade or strategy row. `unique(user_id, symbol)` means there's only
ever one row per symbol per user regardless of archived state, so re-adding the same
symbol from "+ Add instrument" (`lib/instruments.js`'s `addOrRestoreInstrument()`,
shared by that button and onboarding) un-archives the same row instead of inserting a
fresh one - the trades and strategies still point at that same `instrument_id`, so
they come back exactly as they were, not re-created.
`lib/contractRollover.json`'s per-underlying rollover dates are still hand-maintained,
though - extend or regenerate it once the last listed date per symbol gets close.

## Database

`schema.sql` is meant to be the full, runnable description of the database. When a
column is added by hand in the Supabase SQL editor, **add it to `schema.sql` in the
same pull request**, otherwise the file drifts and rebuilding from it silently loses
features. Changes made after the original v1 schema live in the "changes since v1"
block at the bottom of that file, written as `alter table ... if not exists` so the
file stays safe to re-run.

Database edits should be additive (`add column`, `add constraint`). Avoid `drop`.

## UI conventions

- Section titles are `<h2 className="section-heading">` and sit **above** the card
  they describe (see Overview → "Strategy performance", "Monthly P&L").
- Cards/panels use `.panel`. Dark-mode card background is `#141d30`.
- Inline SVG icons need an explicit size in CSS or they collapse to 0px wide.
  See `.theme-toggle-btn svg` and `.calendar-nav-btn svg` for the pattern.
- Numbers: dollars come from the optional `trades.pnl` column, R multiples from
  `trades.r_multiple`. Where both are shown, dollars lead and R is the sub-value;
  if no trade in view has a dollar value, fall back to showing R only.
- All styling lives in `app/globals.css`. It is long — add new rules at the end
  under a comment banner naming the feature.

## Editing this repo through the GitHub web editor

Notes for browser-based editing, where these have caused real breakages:

- **Paste, do not type.** Typing multi-line text into the editor triggers
  auto-indent, which compounds indentation on every line and silently destroys
  YAML and nested JSX. Pasting inserts text verbatim.
- Very large typed blocks have occasionally had stray characters injected at the
  start of line 1. After any big edit, re-read line 1 before committing.
- To verify a committed file, read it from `raw.githubusercontent.com`. Note that
  page-text extraction collapses leading whitespace, so check indentation from the
  raw text itself rather than a summarised reading.
- Deleting a page also means removing its sidebar link and its icon import in
  `app/app/[instrument]/layout.js`. Search the repo for the route afterwards.
