# EdgeLog

A trading journal: log futures trades against named strategies, and see win rate,
R-multiple and P&L statistics per instrument and per strategy.

Next.js 14 App Router (JavaScript, no TypeScript) + Supabase (Postgres, auth,
storage), deployed on Vercel. Imports use the `@/` alias for anything more than
one directory away — see `jsconfig.json`.

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
  marketContextMock.js         placeholder volatility/key-levels/econ-event data (not live)
schema.sql                    tables + row level security
storage-setup.sql             screenshots storage bucket
scripts/
  update-css-toc.js           regenerates globals.css's table of contents - see below
next.config.js                only exists for the mock-DB dev alias - see below
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

## Environment

`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` are safe to expose.
`SUPABASE_SERVICE_ROLE_KEY` is **server only** — full admin access, bypasses row
level security, used solely by the two API routes. Never import it into a page or
give it a `NEXT_PUBLIC_` prefix.

All three live in `.env.local` locally and in Vercel's project settings. The CI
build uses placeholders, since nothing during a build talks to the database.

The Overview pages' "Economic calendar" card (`components/EconomicCalendarCard.js`)
currently renders mock data from `lib/marketContextMock.js` — the earlier BLS/FRED/
FOMC live-fetch version was pulled out in favor of a paid market-data provider, not
yet wired up. Same story for the volatility and key-levels cards on those pages.

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
- **`npm run css:toc`** regenerates `globals.css`'s table of contents from the
  file's actual `/* ---------- Section ---------- */` banners. Run it after any CSS
  edit that adds, removes, or moves a section — `npm run css:toc:check` reports
  (without writing) whether it's currently stale, for a sanity check before a commit.
