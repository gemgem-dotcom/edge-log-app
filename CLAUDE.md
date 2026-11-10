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
4. **A schema change is not live until it is run in Supabase.** There is no
   migration runner in the repo. Merging code that writes a new column breaks
   production until the SQL is run, so call this out when handing over.
   Everything in `schema.sql` as of 2026-11-07 **has been run** against the
   production project, and the policy gate was verified live afterwards (see
   "Assurance at the data layer" below).
   **Check the syntax by running it, not by reading it.** The restrictive-policy
   block was merged reading `as restrictive to authenticated for all`, which is a
   syntax error - Postgres wants `AS RESTRICTIVE`, then `FOR`, then `TO`. It was
   caught only because the statement was actually executed; a hand-run would have
   failed halfway through the block, after the table and function were already
   created.

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
  useUpcomingEconEvents.js     the per-instrument dashboard's "Next calendar
                               event" card - real economic_events, USD and
                               high/medium only, with its own ticking clock
  econCalendarEvents.mjs       Forex Factory event vocabulary + normalise/classify,
                               plus FF's display timezone and the day/key helpers
                               both sources share. .mjs so the CommonJS scripts can
                               import() it too
  econCalendarHtml.mjs         parses forexfactory.com/calendar's own HTML - the
                               primary source. Pure functions over a string, so it
                               is tested against real captured markup
  econCalendarZone.mjs         which timezone FF rendered a page in, inferred from
                               evidence and never named - see "The instant of a
                               release" below. Withholds a day rather than guess
  econRefreshBackoff.mjs       what the on-demand route does when FF declines:
                               back off, report once per outage
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
  probe-forexfactory-datelines.js  read-only: does each day's dateline agree with
                              the date FF prints beside it? The measurement the
                              parser's time logic now rests on
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

## Two-factor authentication

- **There are deliberately no recovery codes.** They are a lot of machinery to
  put in front of a non-technical user, and most are lost before they are ever
  needed. Completing a password reset is the single way back into an account
  whose authenticator is gone. Don't add codes back without revisiting the whole
  design — the reset flow depends on being the only route.
- **A completed password reset clears every factor**, after an explicit
  confirmation on `/reset-password`. Without that, the reset is a lockout rather
  than a rescue: the user sets a new password, is asked for a code they can't
  produce, and is finished. The clearing happens in `app/api/clear-2fa/route.js`
  because Supabase requires aal2 to unenroll and a recovery session is aal1 by
  construction — the user cannot remove their own factor, which is the entire
  problem.
- **`/api/clear-2fa` is the most dangerous route in the app.** Its gate is
  `isRecoverySession` in `lib/authAssurance.js`: aal must be present and say
  `aal1`, and `amr` must be exactly one method from `RECOVERY_AMR_METHODS`. That
  value is **measured, not assumed** — `scripts/probe-recovery-session.js` mints
  a real recovery session and prints the claims (2026-11-07: `aal1`,
  `[{"method":"otp"}]`). It is only safe while EdgeLog issues no other one-time
  password. **If email-code sign-in or a magic link is ever added, `otp` stops
  identifying a recovery and this route needs a different proof.**
- **Assurance is enforced in `proxy.js`, not just at the login form.** It used to
  be checked only in `app/login/page.js`, which meant a recovery-link session
  could navigate straight to `/app` and never be asked for a code. A bounced
  session is sent to `/login?step=2fa`; that parameter only decides whether to
  *look* at the real assurance level, never what the answer is.
- **Verification attempts are rate limited by EdgeLog, and by nothing else.**
  Measured 2026-11-07 with `scripts/probe-auth-rate-limits.js`: twenty failing
  MFA-verify attempts from one IP drew **no 429 and no server-side refusal**.
  So `lib/mfaRateLimit.js` + `app/api/mfa-attempt/route.js` are the only layer,
  not a second one — five wrong codes in fifteen minutes, counted in
  `mfa_attempt` because a serverless instance's memory counts to one forever.
- **The limiter cannot prevent an attempt, only refuse to continue.**
  `supabase.auth.mfa.verify()` runs in the *browser* against the auth server;
  EdgeLog is not in that path. It raises the cost of attacking through the app
  and does nothing about someone scripting the public API. Don't claim more than
  that — in the guide or anywhere else.
- **The limiter fails open, on purpose.** If `mfa_attempt` is unreachable, a
  user gets more guesses at a six-digit code. If it failed closed, one table
  hiccup would lock every 2FA account out of the app — likelier and far worse.
  A lockout is a denial of service you build deliberately, and the person most
  likely to trip it is the real owner with a phone whose clock has drifted:
  hence the short window, the success-clears-the-count rule, and messages that
  always say when the wait ends.
- **"Remember this browser" does not make a session aal2.** Supabase won't mint
  aal2 without a code, so a remembered browser is still aal1 — the cookie tells
  `proxy.js`'s gate to let it through anyway. That makes the cookie as powerful
  as the second factor for anything EdgeLog protects, which is why the token is
  stored only as a SHA-256, the row is matched on `token_hash` **and** `user_id`
  in one query, expiry comes from the row rather than the cookie's max-age, and
  `/api/clear-2fa` deletes every trusted device along with the factors.
- **Minting a trusted device requires aal2.** `/api/trusted-device` POST refuses
  an aal1 caller — otherwise it would be a route that converts "I know the
  password" into "I never need the code again", which is worse than no second
  factor because the user would believe they had one.
- **Assurance is enforced at the data layer too, via RLS.** Until this, 2FA
  protected the pages and not the rows: `auth.uid()` is satisfied by any valid
  token, so a password-only session could read the whole journal from PostgREST
  with the public anon key. Five **restrictive** policies now AND
  `public.session_meets_assurance()` onto the existing ones — the originals are
  untouched, so dropping those five policies undoes the whole thing.
- **`mfa_assurance_grant` is what keeps "remember this browser" working.** A
  remembered browser is aal1 and Postgres cannot see the cookie, so a naive
  aal2 policy would load the app and show an empty journal. Postgres *can* see
  `session_id`, so `proxy.js` records the session when it validates the cookie
  and the policy reads the same table. The grant is server-written, capped by
  the device row's own expiry, and deleted wherever trust is revoked
  (`/api/clear-2fa`, forgetting a device, changing a password).
- **That SQL is at the bottom of `schema.sql` and must be run by hand.** Nothing
  in the code depends on it, so the app behaves identically before and after —
  which also means merging it changes nothing until you run it. Afterwards, run
  `scripts/verify-rls-assurance.js`; the check that matters is that an account
  with **no** factor can still read its rows, because that branch is the one
  that locks out everybody if it is wrong.
- Note the two different safe defaults for a missing `aal` claim.
  `sessionNeedsSecondFactor` treats it as aal1 (fail-closed: challenge them);
  `isRecoverySession` refuses it outright, because there aal1 is the permissive
  answer and the same default would be fail-open.

## Security beyond 2FA

- **`/api/generate-insights` spend is limited by `insight_call`, server-side.** The
  old limit read `edge_insights.generated_at` — a row this route never writes and
  the caller owns under a `for all` policy. A caller who never wrote had no
  cooldown at all, and one PATCH reset it anyway. Signup is open, so that was an
  unmetered paid endpoint. The row is written **before** the model call
  (claim-not-check, as `econ_refresh_lock` does), and the table has RLS on with no
  policies.
- **The caller does not write any part of the system prompt.** `previousNarrative`
  used to come off the request body and was concatenated into `system` — a free
  LLM proxy on the owner's Anthropic key. The continuity text is now read from
  `edge_insights` server-side and length-capped.
- **Every service-role route must call `serviceRouteNeedsSecondFactor`.**
  `proxy.js` does not run for `/api`, and the restrictive RLS policies are `to
  authenticated` so they do not apply to the service role. A route that
  authenticates with `getUser()` and then acts with the service key punches
  through both layers unless it asks the question itself.
- **Security headers live in `next.config.js`.** The app previously shipped with
  none. `'unsafe-eval'` is in `script-src` **in development only** — Turbopack's
  HMR needs it and the production bundle does not, which was verified by building,
  serving with `next start` and walking the pages, not assumed. The font hosts
  must stay in `style-src`/`font-src`: the first version of the policy omitted them
  and silently blocked every page's typography.
- **Passwords are 12–128 characters and need all four character classes** —
  uppercase, lowercase, a number and a symbol. One rule, no branches. The old
  rule was 8–15 from a restricted charset with no complexity requirement, which
  accepted `password` and blocked every password manager; an interim rule took
  12+ on length alone or 10+ with three of four classes.
  **The maximum is 128, not 16.** "12 to 16" in the user-facing text is advice
  about a good length, not a cap — capping at 16 would block generated
  passphrases and password managers, which is the exact bug the 8–15 rule had.
  The trade is recorded in `lib/validatePassword.js`: requiring all four classes
  rejects a bare passphrase (`correct horse battery staple` is 28 characters,
  genuinely strong, and fails) while `Passw0rd!123` passes at 12. That is a
  deliberate choice of one requirement everybody recognises over a rule that is
  stronger on paper and confusing to read — and the floor went up from 10 to 12
  in the same move.
  Errors name **what is missing** ("Add an uppercase letter, a number and a
  symbol.") rather than reprinting the rule. The full sentence lives in the "?"
  beside the field on Account settings, and as a visible one-liner on signup and
  `/reset-password`, which are the two places somebody picks a password for the
  first time.

## Assurance at the data layer

- **Every RLS policy used to key on `auth.uid()` alone, and `auth.uid()` is
  satisfied by any valid token for that user — aal1 included.** So 2FA protected
  the pages and not the rows: a password-only session could skip the app and read
  the whole journal from PostgREST with the public anon key. Five restrictive
  policies plus `session_meets_assurance()` close that. They are **restrictive**,
  so they AND onto the original permissive ones, which are untouched and still
  decide whose rows these are; undoing the block is dropping the policies.
- **`mfa_assurance_grant` is the bridge, and it exists because of trusted
  devices.** Supabase will not mint aal2 without a code, so a remembered browser
  stays aal1 and Postgres cannot see the cookie. A naive aal2 policy would have
  loaded the app and then shown an **empty journal** — which looks like data loss,
  not like a security control. `proxy.js` records the `session_id` when it
  validates the cookie; the function reads the same table. Server-written only.
- **The branch that matters is the one that lets people IN.** `not exists (verified
  factor)` is what keeps every password-only and Google-only account working. Get
  that wrong and the gate locks out everybody rather than letting anybody in, which
  is the failure this design is most likely to produce.
- **Verified live on 2026-11-07, not reasoned about:** no-2FA account reads and
  writes its own rows at aal1; aal2 reads; aal1 + a valid grant reads; aal1 with no
  grant reads **nothing**; a token with **no `aal` claim at all** reads nothing
  (fails closed). The last two are the attack, and both are shut.
- **`exit_legs` carries the policy too, although it did not need it.** Its
  permissive policy's `EXISTS` reads `trades`, and RLS applies inside that
  subquery, so a blocked caller already saw no legs — measured, not assumed. But
  that is a side effect of how the policy is written. Denormalise a `user_id` onto
  that table (the obvious optimisation) and every exit price goes public with
  nothing failing to say so.

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
(`.github/workflows/refresh-economic-calendar.yml`): the current week on the
hourly cron, months −1..+1 on the daily one, and a manual backfill via
`CALENDAR_MONTHS_BACK`/`CALENDAR_MONTHS_FORWARD`.

**"Hourly" is what the cron asks for, not what happens.** Measured 2026-09-14
over the preceding 67 hours: 19 scheduled runs, one every **3.7 hours** on
average, gaps from 2.1h to 5.9h, and not one of them at `:07`. GitHub delays and
drops scheduled workflows under load, and this repo gets roughly a quarter of
what it asks for. Don't quote "hourly" as a freshness guarantee — the floor for a
release printing while nobody has the dashboard open is several hours, not one.
What actually keeps the card fresh for someone watching is the on-demand refresh
below, which is not on the cron at all. How far back that reaches is **not currently known**: a "two months" limit was
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
pages we requested most. Nothing here disguises a request, and nothing that does
should be added.

**FF declining the on-demand route is an outcome, not an error.** FF refuses Vercel's
addresses a good deal of the time. The route used to send every refusal to Sentry and
ask again ten minutes later: 85 events in a fortnight, none a fault in this app, burying
the three issues in the same list that were real. It now backs off - doubling per
refusal, capped at six hours, held in `econ_refresh_lock.not_before` - and reports
**once per outage** (`lib/econRefreshBackoff.mjs`). Only a fault of ours (a failed write,
a page that arrived and broke the handler) still reaches Sentry. `not_before` is a
column of its own because `inspect-economic-calendar.js` reads a future `claimed_at` as
a wedged lock, correctly.

**The de-duplication pass only removes a row FF has stopped serving.** It used to treat
any two rows sharing instant, currency and title as a re-listing and drop the older.
FF also lists genuinely separate rows that collide, and every run refreshes both - so
the pass dropped one, the next run restored it, and it was dropped again: 21 Sentry
warnings, all the same row. A re-listing has a signature a double listing does not:
the old id stops being refreshed. `planIdentityDedupe(rows, liveSince)` acts only then.

**The instant of a release comes from what FF PRINTS, not from `data-day-dateline`.**
This is the third version of this paragraph and the first that was measured rather
than reasoned. The parser used to store `dateline + clock time`, on the understanding
that the dateline is the epoch of local midnight. `scripts/probe-forexfactory-datelines.js`
showed on 2026-11-10 that it is not reliably that:

- FF stamps the page's **first-day** offset onto every day. Every gap between
  consecutive datelines is exactly 86400s, on every page, including the ones that
  contain a clock change. `?week=mar8.2026` carries 05:00Z all week; true local
  midnight from the 9th is 04:00Z. One hour out, every row, all week.
- On a page that **starts** on the autumn changeover, every dateline is also a whole
  day late. `?week=nov1.2026` and `?month=nov.2026` both print "Mon Nov 2" beside
  `2026-11-03T04:00Z`.

The second put **214 of November 2026's 411 events on the wrong day** in production.
`Chicago PMI`, filed by FF under Nov 30, was stored at `2026-12-01T13:45Z`. Nothing
reported it; the first sign was the removal guard refusing "17 December rows FF has
removed" that were November's.

What FF gets right on every page checked is the printed date label and the printed
clock time: true local wall time, clock changes included. So those are the authority,
and the dateline is demoted to evidence of **which timezone the page was rendered in**
(`lib/econCalendarZone.mjs`).

**A correction that never ran, twice.** The first DST fix asked a named zone and the
name was wrong for most callers. Its replacement waited for a 23- or 25-hour gap
between consecutive datelines - reasoned from how a dateline ought to behave, tested
against fixtures built to behave that way. FF has never emitted such a gap, so it never
fired either. `lib/econCalendarDatelines.test.js` is built from FF's real labels and
datelines for exactly this reason; **do not add a synthetic DST fixture and call it
coverage.**

**Still no named zone - and now no assumed one either.** FF picks its display zone from
the client's IP (a GitHub runner in Wyoming is served Denver, one in Virginia New York,
Vercel `iad1` New York), so no fixed name can be right. Every timezone the runtime knows
is a candidate; the evidence eliminates the ones that could not have produced the page;
and a day is stored **only when every surviving candidate puts its midnight at the same
instant**. When they disagree the rows are *withheld*, loudly, and keep whatever was
stored before. An unknown time is a gap; a wrong one is a lie.

That matters in practice in the two weeks a year the clocks change. New York and Puerto
Rico are both UTC-4 on the Sunday and an hour apart from the Monday, and one page cannot
tell them apart. What settles it is the first day of **another page from the same
caller** - which is the one dateline FF's bug does not corrupt. The daily sweep's three
month pages lend each other theirs for free; the hourly run and the on-demand route
fetch the following week's page, once, only when a page says it needs it.

- **A withheld day gates removal for the whole page.** Its rows were not refreshed, and
  if an earlier run stored them at the wrong instant they sit inside a *neighbouring*
  day's window, where they read as events FF removed.
- **A day with no readable date label is stored but not vouched for.** Dropping every
  row because a label moved would turn a cosmetic markup change into an outage; but it
  has not been cross-checked, so the page may not speak for absence on it.
- **`CALENDAR_DRY_RUN=1`** (the workflow's `dry_run` input) parses and reports which
  stored rows would move and by how much, writing nothing. Use it before any change to
  how an instant is derived. "It passes its tests" was true of both corrections above.
- **Untimed rows are anchored to the caller's local midnight**, so an All Day row's
  `event_time` moves by an hour or two depending on which region fetched last. That is
  expected and harmless - the day lives in `detail_url` - and it is why a dry run always
  reports a few dozen small moves.

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

The per-instrument dashboard's **"Next calendar event"** card is live too, via
`lib/useUpcomingEconEvents.js`. It filters to **USD, high and medium impact** —
every instrument in the catalog is a US-listed future, so a Swiss PPI print is not
what moves the chart the trader is looking at, and USD matches the Economic
calendar card's own default filter. All-day rows are listed rather than dropped (a
US bank holiday is exactly what a futures dashboard should say) and labelled "All
day", since there is no instant to count down to. The card owns a one-minute
ticking clock: a countdown computed once at render stops being true the moment
after it renders, and the day strings derived from that clock are what re-query
across midnight.

`lib/marketContextMock.js` is **gone** — nothing imported it once that card went
live. The volatility and key-levels cards it was once documented as feeding never
actually read from it; they render a hardcoded "Not available yet" and still do,
pending a paid market-data source.

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
  warnings accumulate, which is how forty-nine of them built up unnoticed
  (forty-two now, and the ceiling in `package.json` came down with them). Clear
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
