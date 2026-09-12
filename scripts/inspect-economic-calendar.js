#!/usr/bin/env node

// Diagnostic / research script - NOT part of the app's runtime, NOT
// scheduled. Run manually via the "Run a diagnostic script" GitHub Action.
//
// Answers "is the economic calendar actually healthy?" against the real
// database, which nothing else could do: the dev sandbox cannot reach
// Supabase or forexfactory.com, the fetch job's own log says only what one
// run wrote, and the card shows one week at a time. After a backfill, a
// schema change, or a suspected parser regression, this is the report that
// says whether the table is right.
//
// Read-only. It issues selects and nothing else, and prints no trade data
// or user data - economic_events is public reference data shared by every
// account, so unlike scripts/list-strategy-screenshots.js there is nothing
// private to leak into the job log.
//
// What it checks, and why each one is here rather than assumed:
//
//   COVERAGE     row count, date span, rows per month. A backfill that
//                silently fetched nothing looks identical to one that
//                worked, unless someone counts.
//   ACTUALS      what share of already-printed releases carry a figure.
//                This is the single number that says the actuals pipeline
//                is alive - it is the whole reason the source moved from
//                the JSON feed to the page.
//   PRECISION    how many rows have a null time_precision. Those predate
//                the column and will render a clock time they cannot
//                justify (see the column's comment in schema.sql).
//   KEY SHAPE    every event_key's day must equal the event's own day in
//                FF's display timezone. That invariant is what stopped an
//                evening release colliding with the next morning's, and a
//                regression in it would be invisible in the card.
//   LOCK         econ_refresh_lock exists, holds exactly one row, and is
//                movable - the on-demand refresh is a no-op without it.
//   RLS          that row level security is really enabled in production.
//                Supabase grants anon and authenticated full table rights
//                by default, so RLS with no policies is the only thing
//                stopping a signed-out visitor truncating the lock table.
//                Needs the anon key; skipped with a note if absent.
//
// Env: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//      NEXT_PUBLIC_SUPABASE_ANON_KEY  optional - only the RLS probe needs it
//
// Usage: node scripts/inspect-economic-calendar.js

const { createClient } = require('@supabase/supabase-js')

// PostgREST caps an unbounded select at 1000 rows and returns that first
// page with no error and no flag - the same trap lib/fetchAllRows.js
// exists for. That module is ESM and this file is CommonJS (no "type":
// "module" in package.json), so the windowing is repeated here rather than
// imported, matching the other scripts in this directory.
const PAGE_SIZE = 1000
const MAX_PAGES = 200

function log(...args) {
  console.log(...args)
}

function pct(n, total) {
  return total === 0 ? 'n/a' : `${((n / total) * 100).toFixed(1)}%`
}

function ago(iso) {
  if (!iso) return 'never'
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000)
  if (mins < 60) return `${mins}m ago`
  if (mins < 1440) return `${(mins / 60).toFixed(1)}h ago`
  return `${(mins / 1440).toFixed(1)}d ago`
}

// Descending count, so the long tail doesn't bury the interesting head.
function tally(rows, key) {
  const counts = new Map()
  for (const r of rows) {
    const v = r[key] === null || r[key] === undefined ? 'NULL' : String(r[key])
    counts.set(v, (counts.get(v) || 0) + 1)
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])
}

function line(label, value) {
  log(`  ${String(label).padEnd(34)}${value}`)
}

async function fetchAll(admin) {
  const all = []
  for (let page = 0; page < MAX_PAGES; page++) {
    const from = page * PAGE_SIZE
    const { data, error } = await admin
      .from('economic_events')
      .select('*')
      .order('event_time', { ascending: true })
      .order('event_key', { ascending: true })
      .range(from, from + PAGE_SIZE - 1)
    if (error) throw new Error(`economic_events read failed: ${error.message}`)
    const rows = data || []
    all.push(...rows)
    if (rows.length < PAGE_SIZE) break
  }
  return all
}

function reportCoverage(rows) {
  log('\nCOVERAGE')
  line('rows', rows.length)
  if (rows.length === 0) {
    line('', 'table is EMPTY - the card will show "No events in this range."')
    return
  }
  const first = rows[0].event_time
  const last = rows[rows.length - 1].event_time
  line('earliest event', first)
  line('latest event', last)
  const days = Math.round((new Date(last) - new Date(first)) / 86400000)
  line('span', `${days} days`)

  const freshest = rows.reduce((max, r) => (r.fetched_at > max ? r.fetched_at : max), '')
  line('freshest fetched_at', `${freshest} (${ago(freshest)})`)

  log('\n  per month')
  const byMonth = tally(rows.map((r) => ({ m: r.event_time.slice(0, 7) })), 'm')
  for (const [month, n] of byMonth.sort((a, b) => a[0].localeCompare(b[0]))) {
    const daysSeen = new Set(rows.filter((r) => r.event_time.startsWith(month)).map((r) => r.event_time.slice(0, 10)))
    log(`    ${month}   ${String(n).padStart(5)} events   ${String(daysSeen.size).padStart(2)} days`)
  }
}

function reportActuals(rows) {
  log('\nACTUALS')
  const now = new Date().toISOString()
  const past = rows.filter((r) => r.event_time < now)
  const future = rows.filter((r) => r.event_time >= now)
  const withActual = past.filter((r) => r.actual !== null && r.actual !== '')

  line('past events', past.length)
  line('  with an actual', `${withActual.length}  (${pct(withActual.length, past.length)})`)
  line('  without', past.length - withActual.length)
  line('future events', future.length)

  // Not every release has a figure - bank holidays, speeches and summits
  // legitimately never print one - so a gap here is a smell to look at,
  // not a failure on its own. Excluding the grey holiday level makes the
  // number mean more.
  const pastReal = past.filter((r) => r.impact !== 'holiday')
  const realWith = pastReal.filter((r) => r.actual !== null && r.actual !== '')
  line('past, excluding holidays', pastReal.length)
  line('  with an actual', `${realWith.length}  (${pct(realWith.length, pastReal.length)})`)

  const missing = pastReal.filter((r) => !r.actual).slice(-5)
  if (missing.length) {
    log('\n  most recent past events with no actual (speeches and summits are normal here)')
    for (const r of missing) log(`    ${r.event_time}  ${r.currency}  ${r.impact.padEnd(7)}  ${r.title}`)
  }

  const statuses = tally(past.filter((r) => r.actual), 'actual_status')
  log('\n  beat/miss marking on printed figures')
  for (const [k, n] of statuses) log(`    ${k.padEnd(8)} ${n}`)
}

function reportPrecision(rows) {
  log('\nTIME PRECISION')
  for (const [k, n] of tally(rows, 'time_precision')) {
    const note = k === 'NULL'
      ? '   <- predates the column; renders a clock time it cannot justify'
      : ''
    log(`  ${k.padEnd(12)} ${String(n).padStart(5)}${note}`)
  }
}

// The invariant that keeps an evening release from colliding with the next
// morning's: event_key's day half must be the event's own day in FF's
// display timezone, not the UTC day.
async function reportKeyShape(rows) {
  log('\nEVENT KEY SHAPE')
  const { ffLocalDay } = await import('../lib/econCalendarEvents.mjs')
  let malformed = 0
  let dayMismatch = 0
  const examples = []
  const direction = new Map()
  const hours = new Map()
  const precisions = new Map()
  const fetched = new Map()
  for (const r of rows) {
    const parts = String(r.event_key).split('|')
    if (parts.length !== 3 || !/^\d{4}-\d{2}-\d{2}$/.test(parts[0])) {
      malformed++
      if (examples.length < 5) examples.push(`malformed: ${r.event_key}`)
      continue
    }
    const expected = ffLocalDay(r.event_time)
    if (parts[0] !== expected) {
      dayMismatch++
      const dir = parts[0] < expected ? 'key-earlier' : 'key-later'
      direction.set(dir, (direction.get(dir) || 0) + 1)
      const hour = r.event_time.slice(11, 13)
      hours.set(hour, (hours.get(hour) || 0) + 1)
      precisions.set(r.time_precision, (precisions.get(r.time_precision) || 0) + 1)
      fetched.set(String(r.fetched_at).slice(0, 16), (fetched.get(String(r.fetched_at).slice(0, 16)) || 0) + 1)
      if (examples.length < 8) {
        examples.push(`key=${parts[0]} ffday=${expected} time=${r.event_time} prec=${r.time_precision} fetched=${r.fetched_at} :: ${r.event_key}`)
      }
    }
  }
  line('well-formed day|currency|title', rows.length - malformed)
  line('malformed', malformed)
  line("key day disagrees with FF's day", dayMismatch)
  if (dayMismatch > 0) {
    line('', 'stale rows from before the key changed, or a regression - see NOTES.md')
  }
  for (const e of examples) log(`    ${e}`)
  if (dayMismatch > 0) {
    log('\n  mismatch direction'); for (const [k, n] of direction) log(`    ${k.padEnd(14)} ${n}`)
    log('  UTC hour of event_time'); for (const [k, n] of [...hours].sort()) log(`    ${k}:00  ${n}`)
    log('  time_precision'); for (const [k, n] of precisions) log(`    ${String(k).padEnd(10)} ${n}`)
    log('  fetched_at minute (which run wrote them)'); for (const [k, n] of [...fetched].sort()) log(`    ${k}  ${n}`)
  }
}

function reportDistributions(rows) {
  log('\nDISTRIBUTIONS')
  for (const field of ['impact', 'event_type', 'currency']) {
    const counts = tally(rows, field)
    log(`  ${field}`)
    for (const [k, n] of counts) log(`    ${k.padEnd(20)} ${n}`)
  }
}

async function reportLock(admin) {
  log('\nREFRESH LOCK')
  const { data, error } = await admin.from('econ_refresh_lock').select('*')
  if (error) {
    line('econ_refresh_lock', `UNREADABLE - ${error.message}`)
    line('', 'the on-demand refresh cannot claim, so it never fetches')
    return
  }
  line('rows', data.length)
  if (data.length !== 1) {
    line('', 'expected exactly one row (id = 1) - the claim matches on id')
    return
  }
  line('claimed_at', `${data[0].claimed_at} (${ago(data[0].claimed_at)})`)
}

// Supabase grants anon and authenticated every table privilege by default,
// so RLS is the only thing standing between a signed-out visitor and this
// data. Proving that from the service role is impossible - it bypasses RLS
// by design - so this re-connects as anon and checks what it is actually
// allowed to do.
// Both probes are reads, and both are decisive, which is why a write probe
// is deliberately absent. Attempting a write that should be refused cannot
// prove anything safely: aimed at a key that does not exist it reports "0
// rows affected" whether RLS stopped it or the row was simply missing, and
// aimed at a real key it would corrupt a row on the one occasion it came
// back positive. Reads have no such problem, because the service-role row
// count above says what SHOULD be visible - anon seeing none of it while
// the table is full is proof, not inference.
async function reportRls(url, anonKey, adminRowCount) {
  log('\nROW LEVEL SECURITY (probed with the anon key)')
  if (!anonKey) {
    line('skipped', 'NEXT_PUBLIC_SUPABASE_ANON_KEY is not set for this job')
    line('', 'add it to run-diagnostic.yml\'s env to enable this check')
    return
  }
  if (adminRowCount === 0) {
    line('skipped', 'economic_events is empty, so a blocked read and an')
    line('', 'empty table would look identical')
    return
  }
  const anon = createClient(url, anonKey)
  let failures = 0

  // economic_events allows select to auth.role() = 'authenticated'. The
  // anon key's role is 'anon', so it must come back empty even though the
  // service role just read every row.
  const { data: events, error: eventsErr } = await anon.from('economic_events').select('event_key').limit(5)
  const eventsSeen = (events || []).length
  if (eventsErr || eventsSeen === 0) {
    line('economic_events, signed out', `refused${eventsErr ? ` (${eventsErr.code || eventsErr.message})` : ' (0 rows)'} - correct`)
  } else {
    failures++
    line('economic_events, signed out', `READABLE - ${eventsSeen} row(s) of ${adminRowCount}`)
    line('', 'the select policy is broader than authenticated-only')
  }

  // econ_refresh_lock has no policy at all, so every role except the
  // service role must see nothing. Reading even one row means RLS is off
  // on it - and since Supabase grants anon full table rights by default,
  // RLS being off there means a signed-out visitor could truncate it.
  const { data: lock, error: lockErr } = await anon.from('econ_refresh_lock').select('id').limit(1)
  const lockSeen = (lock || []).length
  if (lockErr || lockSeen === 0) {
    line('econ_refresh_lock, signed out', `refused${lockErr ? ` (${lockErr.code || lockErr.message})` : ' (0 rows)'} - correct`)
  } else {
    failures++
    line('econ_refresh_lock, signed out', 'READABLE - row level security is OFF')
    line('', 'anon holds insert/update/delete/truncate by default, so this')
    line('', 'is writable too. Run: alter table econ_refresh_lock enable row level security;')
  }

  line('verdict', failures === 0 ? 'both tables correctly closed to signed-out callers' : `${failures} PROBLEM(S) ABOVE`)
}

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) {
    throw new Error('NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set')
  }
  const admin = createClient(url, serviceKey)

  log('economic_events - health report')
  log(`generated ${new Date().toISOString()}`)

  const rows = await fetchAll(admin)
  reportCoverage(rows)
  if (rows.length > 0) {
    reportActuals(rows)
    reportPrecision(rows)
    await reportKeyShape(rows)
    reportDistributions(rows)
  }
  await reportLock(admin)
  await reportRls(url, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, rows.length)
  log('')
}

main().catch((err) => {
  console.error(err.message)
  process.exit(1)
})
