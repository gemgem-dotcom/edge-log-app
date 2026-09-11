#!/usr/bin/env node

// Read-only check on Forex Factory's calendar feeds. Writes nothing,
// touches no database - run it from the "Run a diagnostic script" workflow
// (.github/workflows/run-diagnostic.yml, Actions -> Run workflow).
//
// This exists because the sandbox this app is developed in can't reach
// nfs.faireconomy.media at all (its egress policy refuses the connect), so
// the feed's live shape can't be confirmed while writing the code that
// parses it. It has already earned its keep: the first real run found that
// ff_calendar_lastweek.json and ff_calendar_nextweek.json both 404, that
// the feed carries no `actual` field at all, that FF files some events
// under country "All", and that "Leading Indicators" was falling into Misc.
//
// Two jobs:
//   1. PROBE every plausible feed URL, so the question "is there a feed
//      with more than one week of coverage?" is answered by one run rather
//      than one merge-and-dispatch cycle per guess. Only thisweek is known
//      to exist; if a monthly feed turns up here, add it to FEEDS in
//      scripts/fetch-economic-calendar.js.
//   2. ANALYSE whatever comes back: real field names, impact and currency
//      values, how the classifier distributes, and every title landing in
//      Misc (the one bucket that silently absorbs a classifier gap).
//
// Exit code tracks the PRIMARY feed only. The probe URLs are expected to
// 404 and must not fail the run, or the diagnostic cries wolf every time.
//
// Usage: node scripts/smoke-test-forexfactory-feed.js

const BASE = 'https://nfs.faireconomy.media'

// The one confirmed-published feed - what scripts/fetch-economic-calendar.js
// actually reads, and the only one whose health decides this script's exit
// code.
const PRIMARY = { name: 'thisweek', url: `${BASE}/ff_calendar_thisweek.json` }

// Everything else worth asking about. A 404 here is information, not a
// failure. The .xml entry is deliberate: FF's XML feed historically
// carried fields the JSON one doesn't, and `actual` is the one this app
// would most like to have.
const PROBES = [
  { name: 'lastweek', url: `${BASE}/ff_calendar_lastweek.json` },
  { name: 'nextweek', url: `${BASE}/ff_calendar_nextweek.json` },
  { name: 'thismonth', url: `${BASE}/ff_calendar_thismonth.json` },
  { name: 'lastmonth', url: `${BASE}/ff_calendar_lastmonth.json` },
  { name: 'nextmonth', url: `${BASE}/ff_calendar_nextmonth.json` },
  { name: 'today', url: `${BASE}/ff_calendar_today.json` },
  { name: 'tomorrow', url: `${BASE}/ff_calendar_tomorrow.json` },
  { name: 'thisweek.xml', url: `${BASE}/ff_calendar_thisweek.xml` },
]

const USER_AGENT = 'EdgeLog/1.0 (trading journal; +https://github.com/gemgem-dotcom/edge-log-app)'

function tally(values) {
  const counts = new Map()
  for (const v of values) counts.set(v, (counts.get(v) || 0) + 1)
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([v, n]) => `${v}=${n}`).join('  ')
}

async function get(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json, application/xml;q=0.9, */*;q=0.8' },
    signal: AbortSignal.timeout(20000),
  })
  return { status: res.status, contentType: res.headers.get('content-type') || '', body: await res.text() }
}

// Returns the parsed array, or null if this isn't a usable JSON payload.
function asArray(body) {
  try {
    const parsed = JSON.parse(body)
    return Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

async function analysePrimary(mod) {
  const { normalizeFeed, EVENT_TYPES, CURRENCIES, GLOBAL_CURRENCY } = mod
  console.log(`\n${'='.repeat(64)}\nPRIMARY  ${PRIMARY.name}  ${PRIMARY.url}\n${'='.repeat(64)}`)

  let problems = 0
  let res
  try {
    res = await get(PRIMARY.url)
  } catch (err) {
    console.log(`FAILED: ${err.message}`)
    return 1
  }

  console.log(`HTTP ${res.status} ${res.contentType}`)
  const raw = res.status === 200 ? asArray(res.body) : null
  if (!raw) {
    console.log(`body starts: ${res.body.slice(0, 200)}`)
    return 1
  }

  console.log(`records: ${raw.length}`)
  console.log(`first record verbatim:\n${JSON.stringify(raw[0], null, 2)}`)
  const keys = [...new Set(raw.flatMap((r) => Object.keys(r || {})))].sort()
  console.log(`keys present across the payload: ${keys.join(', ')}`)
  console.log(`records carrying a non-empty "actual": ${raw.filter((r) => r && r.actual !== undefined && r.actual !== '').length}`)
  console.log(`impact values  : ${tally(raw.map((r) => r?.impact))}`)
  console.log(`currency values: ${tally(raw.map((r) => r?.country ?? r?.currency))}`)

  const { events, skipped } = normalizeFeed(raw)
  console.log(`\nparsed: ${events.length} usable, ${skipped} skipped`)
  console.log(`event types: ${tally(events.map((e) => e.event_type))}`)

  // A currency the feed ships that the filter doesn't list is an event no
  // checkbox can match - invisible in the UI, with nothing on screen to
  // say so. This is exactly how the "All" value was found.
  //
  // GLOBAL_CURRENCY is the one deliberate exception: it has no checkbox on
  // purpose, and the card shows those events regardless of the currency
  // filter rather than hiding them.
  const unlistedCurrencies = [...new Set(events.map((e) => e.currency))]
    .filter((c) => c !== GLOBAL_CURRENCY && !CURRENCIES.includes(c))
  if (unlistedCurrencies.length) {
    console.log(`\nPROBLEM: currencies in the feed that CURRENCIES does not list (their events can never be shown): ${unlistedCurrencies.join(', ')}`)
    problems++
  }

  const unknownTypes = [...new Set(events.map((e) => e.event_type))].filter((t) => !EVENT_TYPES.includes(t))
  if (unknownTypes.length) {
    console.log(`\nPROBLEM: event types not in EVENT_TYPES: ${unknownTypes.join(', ')}`)
    problems++
  }

  // Misc is a real category, but it's also where a classifier gap goes to
  // hide. Printing the titles is what makes tuning it possible from a log.
  const misc = events.filter((e) => e.event_type === 'Misc')
  console.log(`\nclassified Misc (${misc.length}/${events.length}) - check for anything that belongs elsewhere:`)
  for (const e of misc.slice(0, 40)) console.log(`  ${e.currency}  ${e.title}`)
  if (events.length > 20 && misc.length === events.length) {
    console.log('\nPROBLEM: every event classified as Misc - the classifier is not matching anything')
    problems++
  }

  console.log('\nfirst 3 parsed rows:')
  for (const e of events.slice(0, 3)) console.log(`  ${JSON.stringify(e)}`)

  return problems
}

async function runProbes() {
  console.log(`\n${'='.repeat(64)}\nPROBES  (a 404 here is information, not a failure)\n${'='.repeat(64)}`)
  for (const probe of PROBES) {
    try {
      const res = await get(probe.url)
      const rows = res.status === 200 ? asArray(res.body) : null
      const detail = rows
        ? `${rows.length} records - USABLE, consider adding to FEEDS`
        : res.status === 200
          ? `200 but not a JSON array; starts: ${res.body.slice(0, 120).replace(/\s+/g, ' ')}`
          : ''
      console.log(`  ${String(probe.name).padEnd(14)} HTTP ${res.status}  ${detail}`)
    } catch (err) {
      console.log(`  ${String(probe.name).padEnd(14)} FAILED  ${err.message}`)
    }
  }
}

async function main() {
  const mod = await import('../lib/econCalendarEvents.mjs')
  const problems = await analysePrimary(mod)
  await runProbes()

  console.log(`\n${problems === 0
    ? 'Primary feed looks healthy.'
    : `${problems} problem(s) with the primary feed - see above.`}`)
  process.exit(problems === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
