#!/usr/bin/env node

// Read-only check that Forex Factory's calendar feeds still look the way
// scripts/fetch-economic-calendar.js expects. Writes nothing, touches no
// database - run it from the "Run a diagnostic script" workflow
// (.github/workflows/run-diagnostic.yml, Actions -> Run workflow).
//
// This exists because the sandbox the app is developed in can't reach
// nfs.faireconomy.media at all (its egress policy refuses the connect), so
// the feed's live shape can't be confirmed while writing the code that
// parses it. Everything in lib/econCalendarEvents.mjs is unit-tested
// against the documented shape; this is what confirms the real one agrees,
// and prints enough to fix the parser quickly if it ever doesn't.
//
// Specifically it answers the three things the parser reads defensively:
//   - is the currency column `country` or `currency`?
//   - is `actual` present in the feed, or only forecast/previous?
//   - which exact impact strings appear (High/Medium/Low/Holiday/
//     Non-Economic, or something else)?
//
// Usage: node scripts/smoke-test-forexfactory-feed.js

const FEEDS = [
  { name: 'lastweek', url: 'https://nfs.faireconomy.media/ff_calendar_lastweek.json' },
  { name: 'thisweek', url: 'https://nfs.faireconomy.media/ff_calendar_thisweek.json' },
  { name: 'nextweek', url: 'https://nfs.faireconomy.media/ff_calendar_nextweek.json' },
]

const USER_AGENT = 'EdgeLog/1.0 (trading journal; +https://github.com/gemgem-dotcom/edge-log-app)'

function tally(values) {
  const counts = new Map()
  for (const v of values) counts.set(v, (counts.get(v) || 0) + 1)
  return [...counts.entries()].sort((a, b) => b[1] - a[1])
}

async function main() {
  const { normalizeFeed, EVENT_TYPES } = await import('../lib/econCalendarEvents.mjs')
  let failures = 0

  for (const feed of FEEDS) {
    console.log(`\n${'='.repeat(60)}\n${feed.name}  ${feed.url}\n${'='.repeat(60)}`)
    try {
      const res = await fetch(feed.url, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
        signal: AbortSignal.timeout(20000),
      })
      console.log(`HTTP ${res.status} ${res.headers.get('content-type') || ''}`)
      const body = await res.text()
      if (!res.ok) {
        console.log(`body starts: ${body.slice(0, 200)}`)
        failures++
        continue
      }

      let raw
      try {
        raw = JSON.parse(body)
      } catch {
        console.log(`NOT JSON - body starts: ${body.slice(0, 200)}`)
        failures++
        continue
      }

      if (!Array.isArray(raw)) {
        console.log(`Expected an array, got ${typeof raw}: ${JSON.stringify(raw).slice(0, 200)}`)
        failures++
        continue
      }

      console.log(`records: ${raw.length}`)
      // The whole point of the diagnostic - the real field names, verbatim.
      console.log(`first record verbatim:\n${JSON.stringify(raw[0], null, 2)}`)
      console.log(`keys present across the payload: ${[...new Set(raw.flatMap((r) => Object.keys(r || {})))].sort().join(', ')}`)
      console.log(`records carrying a non-empty "actual": ${raw.filter((r) => r && r.actual !== undefined && r.actual !== '').length}`)
      console.log(`impact values: ${tally(raw.map((r) => r?.impact)).map(([v, n]) => `${v}=${n}`).join('  ')}`)
      console.log(`currency values: ${tally(raw.map((r) => r?.country ?? r?.currency)).map(([v, n]) => `${v}=${n}`).join('  ')}`)

      const { events, skipped } = normalizeFeed(raw)
      console.log(`\nparsed: ${events.length} usable, ${skipped} skipped`)
      console.log(`event types: ${tally(events.map((e) => e.event_type)).map(([v, n]) => `${v}=${n}`).join('  ')}`)

      // A type the classifier can produce that isn't in the filter list
      // would be invisible in the UI - cheap to assert here.
      const unknown = events.map((e) => e.event_type).filter((t) => !EVENT_TYPES.includes(t))
      if (unknown.length) {
        console.log(`UNEXPECTED event types not in EVENT_TYPES: ${[...new Set(unknown)].join(', ')}`)
        failures++
      }

      // Everything landing in Misc is what a silently-broken classifier
      // looks like, as opposed to a genuinely quiet week.
      const misc = events.filter((e) => e.event_type === 'Misc').length
      if (events.length > 20 && misc === events.length) {
        console.log('SUSPICIOUS: every event classified as Misc')
        failures++
      }

      console.log('\nfirst 5 parsed rows:')
      for (const e of events.slice(0, 5)) console.log(`  ${JSON.stringify(e)}`)
    } catch (err) {
      console.log(`FAILED: ${err.message}`)
      failures++
    }
  }

  console.log(`\n${failures === 0 ? 'All feeds look healthy.' : `${failures} problem(s) found - see above.`}`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
