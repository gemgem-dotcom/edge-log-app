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

Two trades' `mfe_points`/`mae_points`/`drawdown_seconds` were deliberately left
un-recomputed by PR #122's fix and excluded from its bulk recompute, rather than
silently "fixed" or silently left stale:

- **`7e8616fb-334b-4465-8a2f-e572b634df5a`** - two independent, unrelated corrections
  (fill-instant precision, and volume-based front-month resolution near a quarterly
  roll) both failed to find real price action matching this trade's logged entry/exit
  levels nearby its logged times, on either candidate contract. The trade's own logged
  fields are internally consistent (correct stop/target sides for a short, exact
  target hit, `r_multiple` matching entry/stop/exit exactly) - so this isn't a garbled
  entry. Most likely explanation: a timestamp off by more than the ~1-minute margin
  either fix searches, or the wrong calendar day - something a human needs to check
  against whatever the trader actually remembers about this trade, not something
  either automated fix could reasonably guess at.
- **`137c4594-c6d0-40f1-904f-acb9e71d9ef6`** - also failed to find a matching bar for
  at least one leg (`excursion_fallback = true`) under the fill-instant fix, same as
  `7e8616fb`, but *not* near any quarterly roll - so the front-month question doesn't
  apply here. Flagged during PR #122's diagnostic and deliberately not investigated
  further per that PR's own scope - noted here so it isn't quietly forgotten once the
  PR closes.

Both trades keep whatever `mfe_points`/`mae_points`/`drawdown_seconds`/
`excursion_fallback` values they already had before this note was written - nothing
in PR #122 touched them.

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
