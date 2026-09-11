#!/usr/bin/env node

// Fetches Forex Factory's economic calendar and stores it in
// economic_events - see .github/workflows/refresh-economic-calendar.yml
// (the schedule this runs under) and the comment above `create table
// economic_events` in schema.sql.
//
// Reads FF's own published JSON feeds rather than scraping the calendar
// page's HTML. This is deliberate and worth stating plainly, because
// "scrape Forex Factory" usually means the HTML route:
//   - forexfactory.com/calendar sits behind Cloudflare, which serves an
//     interstitial to anything that doesn't look like a real browser. The
//     usual way around that is a headless browser plus fingerprint
//     evasion, which is both fragile (it breaks whenever the challenge
//     changes) and a deliberate circumvention of an access control.
//   - These feeds are the same calendar data, published by FF itself for
//     exactly this purpose, in a stable documented shape, with no
//     challenge to get around. They carry every column the calendar's own
//     list view shows: event, currency, impact, scheduled time, forecast,
//     previous, and actual once a release is out.
// The one thing the HTML has that the feed doesn't is the per-event detail
// popup (source, "measures", "usual effect", revision history). Each row
// stores FF's own detail_url so that page is one click away, rather than
// fighting Cloudflare on an hourly schedule to mirror it.
//
// ONE feed: this week's. The lastweek/nextweek variants this originally
// also fetched both return 404 - confirmed live by
// scripts/smoke-test-forexfactory-feed.js, which is what that diagnostic
// exists for. Only ff_calendar_thisweek.json is actually published.
//
// That is less of a loss than it sounds, because rows accumulate. Nothing
// here ever deletes, and every row upserts on a day+currency+title key
// (see eventKey in lib/econCalendarEvents.mjs), so each week's events stay
// in the table once fetched and the history behind the card grows on its
// own from the day this starts running. What it genuinely cannot do is
// backfill the weeks before that, or see further ahead than the current
// week - if FF ever publishes a monthly feed, adding it here is the fix,
// and the smoke test probes for exactly that.
//
// Why still hourly, now that there's one small file to fetch: NOT for
// `actual` figures. This feed carries none - confirmed against a real
// payload (see normalizeFeedEvent's comment). What does change through the
// week is the calendar itself: FF adds speeches, reschedules releases, and
// revises forecasts, and an hourly refresh keeps all of that current for
// one small request.
//
// Failure policy: with a single feed there's nothing to fall back on, so a
// failure that survives all three retry attempts exits non-zero and the
// workflow goes red - the right signal for "the feed moved, FF blocked us,
// or the network is down", rather than quietly storing nothing every hour
// forever.
//
// Usage: node scripts/fetch-economic-calendar.js
// Env: SUPABASE_SERVICE_ROLE_KEY, NEXT_PUBLIC_SUPABASE_URL

const { createClient } = require('@supabase/supabase-js')
const Sentry = require('@sentry/node')

// Same "one env var, read server-side too" convention as
// fetch-daily-market-stats.js - no-ops if the secret isn't set.
Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  tracesSampleRate: 0,
  enabled: !!process.env.NEXT_PUBLIC_SENTRY_DSN,
})

const FEEDS = [
  { name: 'thisweek', url: 'https://nfs.faireconomy.media/ff_calendar_thisweek.json' },
]

// Identifies this app rather than pretending to be a browser. A feed
// that's published for programmatic use has no reason to want a spoofed
// UA, and if it ever does start refusing us, a truthful one is what makes
// that a conversation rather than an arms race.
const USER_AGENT = 'EdgeLog/1.0 (trading journal; +https://github.com/gemgem-dotcom/edge-log-app)'
const FETCH_TIMEOUT_MS = 20000
const FETCH_ATTEMPTS = 3
// Supabase rejects an over-large single request body; a week of FF's
// calendar is only a few hundred rows, so this only ever splits the batch
// on an unusually busy stretch, but it keeps the request size bounded
// regardless of what the feed returns.
const UPSERT_CHUNK = 200

function log(...args) {
  console.log(new Date().toISOString(), ...args)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// Retries on network errors and 5xx, not on a 4xx - a 403/404 means the
// feed moved or we're being refused, and hammering it three times over
// doesn't change that answer.
async function fetchFeed(feed) {
  let lastError = null
  for (let attempt = 1; attempt <= FETCH_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(feed.url, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })
      if (res.status >= 400 && res.status < 500) {
        throw new Error(`${feed.url} returned ${res.status} (not retried)`)
      }
      if (!res.ok) throw new Error(`${feed.url} returned ${res.status}`)
      // Parsed from text rather than res.json() so a non-JSON body (a
      // Cloudflare challenge page, say) reports what actually came back
      // instead of an opaque "Unexpected token <".
      const body = await res.text()
      try {
        return JSON.parse(body)
      } catch {
        throw new Error(`${feed.url} returned a non-JSON body (starts with: ${body.slice(0, 60).replace(/\s+/g, ' ')})`)
      }
    } catch (err) {
      lastError = err
      if (/not retried/.test(err.message) || attempt === FETCH_ATTEMPTS) break
      const backoffMs = 1000 * 2 ** (attempt - 1)
      log(`${feed.name}: attempt ${attempt} failed (${err.message}) - retrying in ${backoffMs}ms`)
      await sleep(backoffMs)
    }
  }
  throw lastError
}

async function storeEvents(admin, events) {
  let stored = 0
  for (let i = 0; i < events.length; i += UPSERT_CHUNK) {
    const chunk = events.slice(i, i + UPSERT_CHUNK)
    const { error } = await admin
      .from('economic_events')
      .upsert(chunk.map((e) => ({ ...e, fetched_at: new Date().toISOString() })), { onConflict: 'event_key' })
    if (error) throw new Error(`Supabase upsert failed: ${error.message}`)
    stored += chunk.length
  }
  return stored
}

async function main() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl || !serviceKey) throw new Error('NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set')
  const admin = createClient(supabaseUrl, serviceKey)

  // The one module shared with the app itself - see its own header for why
  // it's .mjs and why this has to be a dynamic import from a CommonJS
  // script.
  const { normalizeFeed } = await import('../lib/econCalendarEvents.mjs')

  let succeeded = 0
  let totalStored = 0

  // Sequential, not Promise.all - three small requests, and one at a time
  // is the politer shape of traffic against someone else's free feed.
  for (const feed of FEEDS) {
    try {
      const raw = await fetchFeed(feed)
      const { events, skipped } = normalizeFeed(raw)
      if (skipped > 0) log(`${feed.name}: skipped ${skipped} unusable record(s)`)
      if (events.length === 0) {
        // Not an error in itself - a quiet holiday week really can come
        // back near-empty - but worth saying out loud, since it's also
        // what a silently-changed feed shape looks like.
        log(`${feed.name}: no usable events in the payload`)
        succeeded++
        continue
      }
      const stored = await storeEvents(admin, events)
      totalStored += stored
      succeeded++
      log(`${feed.name}: stored ${stored} event(s)`)
    } catch (err) {
      Sentry.captureMessage(`Economic calendar feed ${feed.name} failed: ${err.message}`, 'warning')
      log(`${feed.name}: FAILED - ${err.message}`)
    }
  }

  if (succeeded === 0) {
    throw new Error(`No economic calendar feed succeeded (${FEEDS.length} attempted) - see the errors above`)
  }

  log(`Done. ${succeeded}/${FEEDS.length} feed(s) OK, ${totalStored} event row(s) written.`)
}

// Same flush-before-exit reasoning as fetch-daily-market-stats.js: a short
// script can exit before Sentry's async transport has sent anything.
main()
  .then(() => Sentry.flush(2000))
  .catch(async (err) => {
    Sentry.captureException(err)
    await Sentry.flush(2000)
    console.error(err)
    process.exit(1)
  })
