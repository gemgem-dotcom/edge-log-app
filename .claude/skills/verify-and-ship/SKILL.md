---
name: verify-and-ship
description: Repo-specific workflow for shipping a code change in the EdgeLog codebase (Next.js 14 + Supabase, deployed on Vercel) - branching correctly, verifying against mock data before calling anything done, committing, and opening a PR. Use this whenever making and shipping a change to this repo, not just when explicitly asked to "ship" or "open a PR" - reach for it as soon as a code change is about to be made, since the branching step happens before the change itself. Especially relevant for anything touching app/globals.css (table-of-contents regeneration), anything UI-visible (needs verification against the mock DB, not the real one), or anything touching schema.sql (a schema change needs an explicit callout that it isn't live until run by hand in Supabase).
---

# Verify and ship (EdgeLog)

The sequence below is what actually shipping a change in this repo looks like, distilled
from doing it repeatedly. Skipping a step is usually where something goes wrong - a stale
CSS table of contents, a change that looked right in code but rendered wrong, a PR that
silently landed on the wrong base branch. Read `CLAUDE.md` at the repo root before
starting, if it hasn't already been read this session - it holds the actual rules (schema
change handling, Vercel preview data, UI conventions); this skill is only the sequence.

## 1. Branch from the latest `origin/main`

```
git fetch origin main
git checkout -B <descriptive-branch-name> origin/main
```

Branch from `origin/main`, not from whatever branch happens to be checked out - stacking a
new branch on another PR's still-open head branch has actually shipped a merge to the wrong
place before. The only exception is when the task is explicitly a continuation of an
existing open PR (someone asks for a follow-up change to a PR that's still under review) -
then check out that PR's actual branch instead of starting fresh.

## 2. Make the change

Ordinary editing. The two things worth flagging here rather than leaving as a surprise
later:

- **Touching `app/globals.css`?** Don't hand-edit the "TABLE OF CONTENTS" block at the top
  of the file - run `npm run css:toc` once the CSS edit is done, and let it recompute every
  section's line number from the actual `/* ---------- Section ---------- */` banners.
  `npm run css:toc:check` reports (without writing) whether it's currently stale, useful as
  a last check before committing.
- **Touching `schema.sql`?** `CLAUDE.md`'s Non-negotiables cover the how (additive,
  `add column if not exists`, runnable top-to-bottom). The part that's easy to forget under
  time pressure: merging the PR does not make the change live. Say so explicitly when
  reporting the work as done - the SQL still needs to be run by hand in Supabase's SQL
  editor.

## 3. Build

```
rm -rf .next
NEXT_PUBLIC_SUPABASE_URL=https://placeholder.supabase.co NEXT_PUBLIC_SUPABASE_ANON_KEY=placeholder SUPABASE_SERVICE_ROLE_KEY=placeholder npm run build
```

Catches syntax errors, missing imports, and the like before spending time on UI
verification. The CI build (`.github/workflows/ci.yml`) uses the same placeholder pattern,
since nothing during a build actually talks to the database.

## 4. Verify anything UI-visible against the mock DB, not the real one

Don't call a UI change done on the strength of reading the code - render it. `CLAUDE.md`'s
Non-negotiables are explicit that Vercel previews use the *production* database, so this
step exists precisely to avoid needing a preview (or a local run against the real database)
to see whether a change actually looks right.

```
cat > .env.local <<'EOF'
NEXT_PUBLIC_SUPABASE_URL=https://placeholder.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=placeholder
SUPABASE_SERVICE_ROLE_KEY=placeholder
EOF
npm run dev:mock -- -p <a-free-port>
```

`dev:mock` runs the app against `lib/supabaseClient.mock.js`, an in-memory fake client, via
a `next.config.js` Turbopack resolveAlias keyed on `NEXT_PUBLIC_USE_MOCK_DB=true` - nothing about
`lib/supabaseClient.js` itself changes, so there's no file to swap back afterward and no
risk of a session ending with the real client still replaced. If the change needs a
specific data shape to exercise (a multi-exit trade, a trade with screenshots, an open
trade with no exit yet), edit `lib/supabaseClient.mock.js`'s `MOCK_TRADES` array directly -
that's what it's there for.

Drive the running app with Playwright. Chromium is pre-installed:

```js
const { chromium } = require('playwright')
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--no-sandbox'] })
```

Navigate to the relevant page, interact with whatever the change touches, and either
screenshot it for a visual check or assert against specific values/text - whichever fits
what's actually being verified. When done:

```
kill %1   # or the dev server's actual job/PID
rm -f .env.local
rm -rf .next
```

## 5. Build again, clean

```
rm -rf .next
NEXT_PUBLIC_SUPABASE_URL=https://placeholder.supabase.co NEXT_PUBLIC_SUPABASE_ANON_KEY=placeholder SUPABASE_SERVICE_ROLE_KEY=placeholder npm run build
```

The mock-mode dev server exercises a different code path (`next dev`, resolveAlias active)
than what actually deploys (`next build`, alias inactive) - this catches anything that
verification step wouldn't. Clean `.next` afterward either way.

## 6. Commit

Message describes the *why*, not a restatement of the diff. End every commit with:

```
Co-Authored-By: Claude <noreply@anthropic.com>
```

Add a `Claude-Session: <url>` line too, if the current session actually has one available -
don't fabricate one if it doesn't.

## 7. Push and open a PR

```
git push -u origin <branch-name>
```

Open a PR targeting `main` (GitHub MCP tools, `create_pull_request`). Body structure:

```
## Summary
- bullet points, the why, not a re-statement of the diff

## Test plan
- [x] `npm run build` passes
- [x] Verified against the mock DB + Playwright: <what was actually checked>
```

If the change touched `schema.sql`, add an explicit line calling out that the SQL still
needs to be run by hand in Supabase before it's live - don't bury that in the summary
prose.

## 8. Poll checks, report, and stop

Poll the PR's check runs (the Build check, and the Vercel preview) until they resolve.
Report the result - checks green, link to the PR - and stop there.

**Never merge the PR.** That's the repo owner's call. Unless explicitly told otherwise for
a given task, this skill's job ends at "PR open, checks green, here's the link."
