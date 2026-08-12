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
  tradeMath.js                     stop/target distance → price, R-multiple and R:R calc
  tradeForm.js                     trade-form validation + currency parse/format
  screenshots.js                   screenshot upload, throws so callers word their own errors
  timezone.js                      UTC offset list + timestamp formatting
  useClickOutside.js               close a dropdown on outside click / Escape
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
| `FMP_API_KEY` | **server only** | free key from Financial Modeling Prep (site.financialmodelingprep.com). Powers `app/api/economic-calendar` (the Overview dashboard's calendar card). Optional — missing it just shows a "not configured" message on that one card. |

All four must exist locally in `.env.local` and in Vercel (Project Settings →
Environment Variables). The CI build uses harmless placeholder values, because
nothing during a build talks to the database.

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
