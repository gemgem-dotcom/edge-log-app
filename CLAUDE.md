# EdgeLog

A trading journal: log futures trades against named strategies, and see win rate,
R-multiple and P&L statistics per instrument and per strategy.

Next.js 16 App Router (JavaScript, no TypeScript) + Supabase (Postgres, auth,
storage), deployed on Vercel. Imports use the `@/` alias for anything more than
one directory away — see `jsconfig.json`. One deliberate exception:
`lib/supabaseClient` is always imported via `@/lib/supabaseClient`, even from
files one directory away, so `next.config.js`'s single mock-DB Turbopack alias
(see its own comment) covers every import site with one entry.

`NOTES.md` is the full working-notes file — read it for anything below that needs
more detail. `README.md` is the first-time setup guide.

## Non-negotiables

1. **Never commit to `main`.** `main` deploys straight to production. Branch, open
   a PR, wait for the Build check (`.github/workflows/ci.yml`, runs `npm run build`)
   and the Vercel preview, then merge. Always branch from the latest `origin/main`,
   not from another PR's still-open head branch, unless intentionally stacking one
   PR on another on purpose — stacking by accident has shipped a merge to the wrong
   branch before.
2. **Vercel previews use the production database.** Preview deployments inherit the
   project's env vars, so anything logged while testing a preview is a real row in
   the real journal. Delete test data afterwards.
3. **Schema changes go in `schema.sql` in the same PR.** That file is meant to be
   runnable top-to-bottom; post-v1 changes live in the "changes since v1" block at
   the bottom, written `add column if not exists` so re-running is safe. Prefer
   additive changes — avoid `drop`.
4. **A schema change is not live until it is run in Supabase by hand.** There is no
   migration runner. Merging code that writes a new column breaks production until
   the SQL is run, so call this out when handing over.

## Project map

```
app/
  globals.css                 all styling for the whole app, one stylesheet
  layout.js                   root layout
  page.js                     login
  signup/, forgot-password/, reset-password/
  auth/callback/page.js       finishes Google sign-in (client component - see below)
  api/record-login/route.js   sign-in history (server only)
  api/delete-account/route.js deletes a user and their data (server only)
  api/economic-calendar/refresh/route.js
                              on-demand Forex Factory re-read (server only)
  app/page.js                 first-run instrument + strategy setup
  app/account/page.js         account settings, devices, 2FA, danger zone
  app/[instrument]/
    layout.js                 app shell, sidebar, instrument switcher
    dashboard/page.js         Overview: stats, strategy performance, P&L calendar
    log/page.js               trade log
    log/new/page.js           log a trade
    log/[tradeId]/edit/page.js edit a trade
    strategies/               strategy manager + per-strategy pages
    insights/                 placeholder
components/
  TradeForm.js                the whole trade form, shared by new + edit pages
  TradeLogTable.js            the trade table, owns its own column filters
  ColumnFilter.js             chevron filter menu used by the table headers
  FieldTooltip.js             "?" tooltip beside a form label
  PageLoading.js               shared full-page loading screen (animated bars)
  OAuthIcons.js                Google mark for the login/signup buttons
  WinRateGauge.js
  account/                    one component per account-settings concern
lib/
  supabaseClient.js           the one browser Supabase client (flowType: 'pkce' for OAuth)
  supabaseClient.mock.js      in-memory stand-in, dev/agent-only - see "Local dev tooling"
  supabaseConfig.js           raw url/anon key, no client - see app/auth/callback/page.js
  instrumentCatalog.js        the 12 supported instruments, data_symbol, point_value
  tradeMath.js                distance → price, R-multiple, R:R, $ P&L
  tradeForm.js                trade-form validation + currency parse/format
  screenshots.js              uploads screenshots, throws so callers word errors
  timezone.js                 UTC offset list + timestamp formatting
  useClickOutside.js          close a menu on outside click / Escape
  strategyColor.js            strategy colour assignment
  validatePassword.js         signup password rules
  greeting.js                  time-of-day-aware greeting phrases for the Overview page
  streak.js                    current win/loss streak from a list of trades
  marketContextMock.js         placeholder volatility/key-levels data + the econ
                               events the per-instrument upcoming list still uses
                               (not live)
  econCalendarEvents.mjs       Forex Factory event vocabulary + normalise/classify,
                               plus FF's display timezone and the day/key helpers
                               both sources share. .mjs so the CommonJS scripts can
                               import() it too
  econCalendarHtml.mjs         parses forexfactory.com/calendar's own HTML - the
                               primary source. Pure functions over a string, so it
                               is tested against real captured markup
  econCalendarQuery.js         reads economic_events for a local-day date range
schema.sql                    tables + row level security
storage-setup.sql             screenshots storage bucket
scripts/
  update-css-toc.js           regenerates globals.css's table of contents - see below
  fetch-economic-calendar.js  Forex Factory calendar -> economic_events. Scope by
                              env: this week (hourly), months -1..+1 (daily), or a
                              manual backfill over a chosen span
  inspect-economic-calendar.js   read-only health report on economic_events:
                              coverage, what share of past releases carry an
                              actual, event_key/timezone invariants, the
                              refresh lock, and an anon-key RLS probe
  probe-forexfactory-sources.js  read-only recon on FF's page + feed
  smoke-test-forexfactory-feed.js  read-only health check on the fallback feed
next.config.js                only exists for the mock-DB dev alias - see below
vitest.config.mjs             unit test runner - `lib/*.test.js` sit next to the module
                               they cover; see NOTES.md's "Testing and error tracking"
instrumentation.js            Sentry init entry points (optional, no-ops without a DSN)
instrumentation-client.js     - see NOTES.md's "Testing and error tracking" for the
sentry.server.config.js       full picture
sentry.edge.config.js
```

## Domain rules that are easy to get wrong

- **A "point" is a raw decimal price difference, for every instrument.** There is
  deliberately no tick concept and no per-instrument multiplier. Entry 21050.00
  with a 15 point stop puts the stop at 21035.00, on NQ and on CL alike.
- **Stop and take profit are entered as distances, stored as both.** The form takes
  a distance from entry; `stop`/`target` hold the derived absolute prices (used for
  R and future market-data matching), `stop_distance`/`target_distance` hold what
  the trader typed. `distance_unit` is vestigial and always `'points'`.
- **R-multiple and R:R are derived, never entered.** Both route through
  `calcRMultiple` in `lib/tradeMath.js` so a displayed figure can't drift from the
  stored one. `calcRiskReward` is a thin wrapper over it, not a second formula.
- **Exit price is mandatory**, so every trade has an R. `r_multiple` is still
  nullable in the database because rows predating that rule may hold null, and the
  stats functions still skip them via `hasResult`. Don't assume non-null.
- **`instruments.data_symbol` groups mini/micro contracts** onto the underlying
  series (MNQ → NQ). Future market-data lookups key off `data_symbol`, not `symbol`.
- **`point_value`** is dollars per 1.00 of price per contract — per *point*, not per
  tick. The two coincide for MYM and differ for most others.

## UI conventions

- Section titles are `<div className="section-heading">` and sit **above** the card
  they describe.
- Cards use `.panel`. All styling lives in `app/globals.css` — add new rules at the
  end under a `/* ---------- Feature ---------- */` banner, then run
  `npm run css:toc` to regenerate the table of contents at the top of that file
  (it recomputes every section's line number from the actual banners — don't hand-edit
  it, and don't skip it, since a stale ToC is worse than no ToC).
- Inline SVG icons need an explicit size in CSS or they collapse to 0px wide. See
  `.theme-toggle-btn svg` for the pattern.
- Trade forms carry no "required" markers. Mandatory fields are enforced on submit
  with inline `.field-error` messages, and the form uses `noValidate` to suppress
  the browser's own tooltips.
- Where both are shown, dollars lead and R is the sub-value; if no trade in view has
  a dollar figure, show R only.

## Gotchas

- **`display:flex` on a `<td>` breaks table column alignment.** It removes the cell
  from the table's column-width algorithm, so body columns stop matching the header.
  Use inline layout inside the cell instead.
- **`#tableWrap` has `overflow-x:auto`**, which clips absolutely-positioned menus.
  `ColumnFilter` works around this with `position:fixed` and closes on scroll.
- **Deleting a page** also means removing its sidebar link and icon import in
  `app/app/[instrument]/layout.js`.
- Editing through the GitHub web editor has caused real breakages — see the last
  section of `NOTES.md` before doing that.

## Testing and error tracking

`npm test` (Vitest) runs `lib/*.test.js` - pure-function coverage for the trade
math, fill-tick matching, and stats-engine logic most likely to silently break.
CI runs it as a parallel `test` job alongside the build check. Sentry error
tracking (`NEXT_PUBLIC_SENTRY_DSN`, optional) reports unexpected failures from
the API routes and the two Databento scheduled scripts. See NOTES.md's "Testing
and error tracking" for the full picture of both.

## Environment

`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` are safe to expose.
`SUPABASE_SERVICE_ROLE_KEY` is **server only** — full admin access, bypasses row
level security, used only by the routes under `app/api` that need to bypass RLS.
Never import it into a page or
give it a `NEXT_PUBLIC_` prefix. `NEXT_PUBLIC_SENTRY_DSN` (optional) is also safe
to expose - a DSN can only send events in, never read anything back out.

All three (plus the optional Sentry DSN) live in `.env.local` locally and in
Vercel's project settings. The CI build uses placeholders, since nothing during a
build talks to the database.

The Overview's "Economic calendar" card (`components/EconomicCalendarCard.js`) is
live: it reads the `economic_events` table, which
`scripts/fetch-economic-calendar.js` fills from **forexfactory.com/calendar's own
HTML**, parsed by `lib/econCalendarHtml.mjs` (`lib/econCalendarEvents.mjs` holds the
vocabulary and classifying both sources share). The page is the source because FF's
published JSON feed covers one week and carries **no `actual` column at all** — both
confirmed live. The feed is kept only as a fallback for the hourly run, and it
deliberately omits the columns it can't speak to so it never overwrites a stored
actual.

Three jobs run off that one script, scoped by env var
(`.github/workflows/refresh-economic-calendar.yml`): hourly for the current week,
daily for months −1..+1, and a manual backfill via
`CALENDAR_MONTHS_BACK`/`CALENDAR_MONTHS_FORWARD`. How far back that reaches is **not currently known**: a "two months" limit was
recorded here on 2026-09-12 and was wrong — the 403s it rested on were
cold-connection rejections of whichever page led each run, not an archive
horizon (see `fetchPage`'s comment). Don't restate a limit until one is measured
with the retry in place. On top of those,
`app/api/economic-calendar/refresh/route.js` re-reads the current week on demand so
an actual appears while someone is watching, within about **ten minutes** rather
than instantly. It is rate-limited by a claim on the single-row
`econ_refresh_lock` table, not by a per-user cooldown. That ten minutes is
deliberate restraint, not caution: at the original 60s one open dashboard asked
FF for the same page sixty times an hour, and FF started returning 403 for the
pages we requested most. Nothing here retries a 403 or disguises a request, and
nothing that does should be added.

**Times are never assumed, and FF's timezone is never named.** FF prints wall-clock
times in its own display timezone, and each day's first row carries
`data-day-dateline`, the epoch of local midnight. Midnight plus the row's
wall-clock minutes is the exact instant on any ordinary day, in any zone, with
nothing assumed — and `dayFor` reads FF's calendar day off the dateline without a
zone either, which is what makes `event_key` and `detail_url` agree with FF about
which day an evening release belongs to.

**Don't reintroduce a named zone.** `FF_DISPLAY_TIMEZONE` used to be
`'America/Chicago'`, with a guard that fell back when a page's dateline wasn't
midnight in it. The guard worked; the constant didn't. **FF picks its display zone
from the client's IP** — a GitHub runner in Azure `westcentralus` (Wyoming) is served
`America/Denver`, confirmed live on 2026-09-14 — so no fixed name can be right for
every caller, and the DST correction the guard protected never ran anywhere. The two
changeover days a year were an hour out, silently, despite a comment claiming the
caller was told. The correction now comes from the page's own shape: consecutive
datelines are 86400s apart on an ordinary day and 82800/90000 across a changeover, so
the day's own length *is* the offset shift. The only remaining assumption is that the
change happens at 02:00 local, and that is stated at `instantFor` rather than buried.

**`event_key` is `ff|<FF's event id>`, and the day is not an identity.** This is the
second thing FF's IP-derived timezone broke, and the more expensive one. A release
near local midnight has *no single correct day*: 2026-08-03T06:00:00Z is Aug 3 for a
runner served Mountain time and Aug 2 for one served Pacific, and FF showed each
caller exactly that. Both are right. So a `day|currency|title` key had two answers and
stored two rows — **174 duplicated releases in production, climbing by ~16 per
fetch**, with a `+1 day` bucket appearing in the diagnostic the first time a run came
from a region east of Greenwich. `ff_event_id` doesn't move, every page row carries
one, and a partial unique index on it now makes a regression fail the write instead of
silently adding a row.

Don't try to fix this by deriving the day more cleverly — that was the instinct, and
it cannot work, because neither day is wrong.

The old `day|currency|title` form (optionally `|#N` for the same title twice in a day,
which FF does whenever an official speaks morning and evening) survives for the JSON
fallback feed alone, since the feed carries no event id. A feed row written during an
HTML outage can therefore be orphaned when the page recovers under a different key —
bounded, rare, and visible in the diagnostic as a non-zero `keyed on
day|currency|title` count.

This sandbox cannot reach either FF host. Run `scripts/probe-forexfactory-sources.js`
(the page) or `scripts/smoke-test-forexfactory-feed.js` (the fallback feed) from the
"Run a diagnostic script" workflow to answer anything about their real shape.

The **Monthly P&L calendar's news badge** (`components/CalendarNewsBadge.js`) is live
too: `lib/useCalendarNewsByDay.js` fetches the visible month once and hands each day
cell its own events, rather than the badge querying per cell. It shows high and
medium impact only — the table holds roughly fourteen releases a day, and a badge on
every weekday says nothing, which was the real fault of the mock week it replaced.

Still on mock data from `lib/marketContextMock.js`: the per-instrument dashboard's
upcoming-events list (`upcomingEconEvents`) and the volatility/key-levels cards.
Pointing the upcoming list at `economic_events` is the natural next step.

## Local dev tooling

- **`npm run dev:mock`** runs the dev server against `lib/supabaseClient.mock.js` (an
  in-memory fake client — instruments/strategies/trades kept in a JS array, no real
  network calls) instead of the real database. `next.config.js` does this by
  redirecting every import of `lib/supabaseClient` when `NEXT_PUBLIC_USE_MOCK_DB=true`
  — nothing about `lib/supabaseClient.js` itself changes, so there's no file to swap
  back afterward. Use this to verify a UI change actually renders correctly before
  calling it done, without touching a real row in the production database (see the
  Non-negotiables above on why that matters). `.env.local` still needs *some* value
  for `NEXT_PUBLIC_SUPABASE_URL`/`NEXT_PUBLIC_SUPABASE_ANON_KEY` in mock mode (they're
  never actually read, but `lib/supabaseConfig.js` and the build both expect them to
  exist) — a placeholder string is fine. Edit `lib/supabaseClient.mock.js`'s
  `MOCK_TRADES` directly for whatever a specific change needs to exercise (a
  multi-exit trade, a trade with screenshots, an open trade, and so on).

  **The mock resolves instantly, so it cannot show you a timing bug — and it
  will make a broken fix look verified.** Loading states, spinner flashes, and
  any race between two in-flight loads simply do not exist against it. A
  perceived-slowness fix was once confirmed this way and shipped having changed
  nothing measurable. Set `NEXT_PUBLIC_MOCK_LATENCY_MS` (and
  `NEXT_PUBLIC_MOCK_LATENCY_PER_ROW_MS`, so a heavier query genuinely takes
  longer than a lighter one) before concluding anything about how fast
  something feels:

  ```
  NEXT_PUBLIC_MOCK_LATENCY_MS=150 NEXT_PUBLIC_MOCK_LATENCY_PER_ROW_MS=25 npm run dev:mock
  ```

  And when a fix is meant to remove a visible behaviour, check that the test
  actually fails without the fix before trusting that it passes with it.
- **`npm run css:toc`** regenerates `globals.css`'s table of contents from the
  file's actual `/* ---------- Section ---------- */` banners. Run it after any CSS
  edit that adds, removes, or moves a section — `npm run css:toc:check` reports
  (without writing) whether it's currently stale, for a sanity check before a commit.
- **`npm run lint:ci`** is what CI runs: `eslint .` capped at the current warning
  baseline via `--max-warnings`. Plain `npm run lint` exits 0 no matter how many
  warnings accumulate, which is how forty-nine of them built up unnoticed. Clear
  warnings and lower the number in `package.json`; never raise it.
- **Need to run a script that requires real credentials?** Use the "Run a
  diagnostic script" workflow (`.github/workflows/run-diagnostic.yml`,
  Actions → Run workflow) rather than putting a production key in a terminal.
  It already has this repo's Databento and Supabase secrets in scope.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
