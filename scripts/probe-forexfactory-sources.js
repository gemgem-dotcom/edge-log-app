#!/usr/bin/env node

// Read-only reconnaissance on where fuller Forex Factory calendar data
// could come from. Writes nothing, touches no database. Run it from the
// "Run a diagnostic script" workflow (Actions -> Run workflow).
//
// Why this exists: the published JSON feed
// (ff_calendar_thisweek.json) is confirmed to carry ONE week and NO
// `actual` column. Backfilling history, filling forward, and showing what
// a release actually printed all need a source that has those, and the
// dev sandbox cannot reach forexfactory.com or faireconomy.media at all
// to find out which candidates do. Rather than guess-and-deploy once per
// candidate - which is how the last round burned two cycles - this asks
// every question at once and prints the answers.
//
// It answers:
//   1. Which JSON feed variants exist at all (monthly? daily? XML?).
//   2. Whether forexfactory.com/calendar's own HTML is fetchable from a
//      runner, for an arbitrary past or future week, and whether what
//      comes back is the real calendar or a bot-check interstitial.
//   3. If it is the real calendar, whether the markup carries actual
//      values - the field the JSON feed lacks.
//
// On the HTML request it tries two User-Agents and reports both: this
// app's own honest identifier, and a stock browser string. That is a
// deliberate boundary. Knowing whether a site serves a plain, truthful
// request is legitimate reconnaissance, and if the honest UA works there
// is no dilemma at all. What this script does NOT do, and what should not
// be added to it, is anything that defeats a bot check that is actually
// refusing us - TLS/fingerprint spoofing, challenge solving, headless
// evasion. If the answer below is "challenged", the answer is to use a
// different source, not a sneakier request.
//
// Usage: node scripts/probe-forexfactory-sources.js

const FEED_BASE = 'https://nfs.faireconomy.media'
const HONEST_UA = 'EdgeLog/1.0 (trading journal; +https://github.com/gemgem-dotcom/edge-log-app)'
const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36'

// Marker strings that say what kind of page came back. Cloudflare and
// friends are recognisable without parsing; so is FF's own calendar table,
// whose row/cell classes have been stable for years.
const CHALLENGE_MARKERS = ['just a moment', 'cf-browser-verification', '__cf_chl', 'attention required', 'enable javascript and cookies', 'checking your browser']
const CALENDAR_MARKERS = ['calendar__row', 'calendar__cell', 'calendar table', 'calendar__event']

function feedUrl(name) {
  return `${FEED_BASE}/ff_calendar_${name}`
}

// Weeks either side of today, in FF's own ?week=sep7.2026 form, to prove
// (or disprove) that arbitrary history and future are addressable.
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
function ffDateParam(d) {
  return `${MONTHS[d.getUTCMonth()]}${d.getUTCDate()}.${d.getUTCFullYear()}`
}
function weeksFromNow(n) {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() + n * 7)
  return d
}

async function get(url, userAgent) {
  const started = Date.now()
  const res = await fetch(url, {
    headers: {
      'User-Agent': userAgent,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.8,*/*;q=0.7',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    signal: AbortSignal.timeout(30000),
  })
  const body = await res.text()
  return { status: res.status, contentType: res.headers.get('content-type') || '', body, ms: Date.now() - started }
}

function classify(body) {
  const lower = body.toLowerCase()
  const challenged = CHALLENGE_MARKERS.filter((m) => lower.includes(m))
  const calendar = CALENDAR_MARKERS.filter((m) => lower.includes(m))
  if (calendar.length) return { kind: 'CALENDAR HTML', detail: `markers: ${calendar.join(', ')}` }
  if (challenged.length) return { kind: 'BOT CHECK', detail: `markers: ${challenged.join(', ')}` }
  return { kind: 'UNKNOWN', detail: `starts: ${body.slice(0, 160).replace(/\s+/g, ' ')}` }
}

// Counts how many calendar cells carry a non-empty actual. Deliberately a
// crude regex over the markup rather than a real parser - this only needs
// to answer "are actual values in here at all", and a parser written
// against markup we have never seen would be guessing twice.
function actualSample(body) {
  const cells = body.match(/calendar__actual[^>]*>(.*?)</gis) || []
  const values = cells
    .map((c) => c.replace(/.*>/s, '').replace(/&nbsp;/g, ' ').trim())
    .filter((v) => v && v !== '-')
  return { cellCount: cells.length, nonEmpty: values.length, sample: values.slice(0, 8) }
}

async function probeFeeds() {
  console.log(`\n${'='.repeat(66)}\n1. JSON/XML FEED VARIANTS\n${'='.repeat(66)}`)
  const names = [
    'thisweek.json', 'lastweek.json', 'nextweek.json',
    'thismonth.json', 'lastmonth.json', 'nextmonth.json',
    'today.json', 'tomorrow.json', 'yesterday.json',
    'thisweek.xml', 'thismonth.xml',
  ]
  for (const name of names) {
    try {
      const res = await get(feedUrl(name), HONEST_UA)
      let detail = ''
      if (res.status === 200) {
        try {
          const parsed = JSON.parse(res.body)
          const withActual = Array.isArray(parsed)
            ? parsed.filter((r) => r && r.actual !== undefined && r.actual !== '').length
            : 0
          detail = Array.isArray(parsed)
            ? `${parsed.length} records, ${withActual} with a non-empty actual`
            : 'JSON but not an array'
        } catch {
          // XML, or something else entirely.
          detail = `non-JSON (${res.body.length}b) starts: ${res.body.slice(0, 100).replace(/\s+/g, ' ')}`
        }
      }
      console.log(`  ${name.padEnd(18)} HTTP ${res.status}  ${detail}`)
    } catch (err) {
      console.log(`  ${name.padEnd(18)} FAILED  ${err.message}`)
    }
  }
}

async function probeHtml() {
  console.log(`\n${'='.repeat(66)}\n2. FOREXFACTORY.COM CALENDAR HTML\n${'='.repeat(66)}`)

  const targets = [
    { label: 'this week', url: 'https://www.forexfactory.com/calendar' },
    { label: 'past week (-6w)', url: `https://www.forexfactory.com/calendar?week=${ffDateParam(weeksFromNow(-6))}` },
    { label: 'future week (+3w)', url: `https://www.forexfactory.com/calendar?week=${ffDateParam(weeksFromNow(3))}` },
    { label: 'a month', url: `https://www.forexfactory.com/calendar?month=${MONTHS[new Date().getUTCMonth()]}.${new Date().getUTCFullYear()}` },
  ]

  for (const ua of [{ name: 'honest UA', value: HONEST_UA }, { name: 'browser UA', value: BROWSER_UA }]) {
    console.log(`\n--- ${ua.name} ---`)
    for (const target of targets) {
      try {
        const res = await get(target.url, ua.value)
        const verdict = res.status === 200 ? classify(res.body) : { kind: `HTTP ${res.status}`, detail: res.body.slice(0, 120).replace(/\s+/g, ' ') }
        console.log(`  ${target.label.padEnd(18)} HTTP ${res.status} ${String(res.body.length).padStart(7)}b ${String(res.ms).padStart(5)}ms  ${verdict.kind}`)
        console.log(`  ${' '.repeat(18)} ${verdict.detail}`)
        if (verdict.kind === 'CALENDAR HTML') {
          const actuals = actualSample(res.body)
          console.log(`  ${' '.repeat(18)} actual cells: ${actuals.cellCount}, non-empty: ${actuals.nonEmpty}, sample: ${JSON.stringify(actuals.sample)}`)
        }
      } catch (err) {
        console.log(`  ${target.label.padEnd(18)} FAILED  ${err.message}`)
      }
      // Spaced out deliberately - this is someone else's site and a probe
      // has no reason to look like a burst.
      await new Promise((r) => setTimeout(r, 1500))
    }
  }
}

async function main() {
  console.log(`probe run at ${new Date().toISOString()}`)
  await probeFeeds()
  await probeHtml()
  console.log(`
${'='.repeat(66)}
HOW TO READ THIS
${'='.repeat(66)}
- Any feed variant returning 200 with records is a coverage win: add it to
  FEEDS in scripts/fetch-economic-calendar.js.
- Any feed variant reporting records "with a non-empty actual" solves the
  actual column outright - prefer it over the HTML.
- "CALENDAR HTML" on the past/future week URLs means backfill and forward
  fill are both addressable by week, and the actual-cell counts say whether
  the figures are in there.
- "BOT CHECK" means stop: do not add evasion. Go to a different source.
`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
