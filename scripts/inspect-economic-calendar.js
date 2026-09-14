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
//   KEY SHAPE    event_key should be FF's own event id. Day-based keys
//                are the JSON fallback's alone now; a pile of them means
//                the migration has not run or the feed has been carrying
//                the table. Those that exist still get the old day check.
//   DUPLICATES   the same release stored twice under two keys. Shape
//                alone cannot see this, and it is the actual damage the
//                2026-09-12 mis-keying did.
//   LOCK         econ_refresh_lock exists and holds exactly one row, with
//                a claim that is not stamped in the future - the on-demand
//                refresh is a no-op without it. Read only: it does not
//                prove the row is movable.
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
// The key's day cannot be re-derived from a stored row, because the row
// does not record which timezone FF served the page in - and FF does not
// always use the same one. So this reports the SHAPE of the relationship
// between the key's day and the event's UTC date rather than asserting one
// right answer, which is what a Chicago-shaped assumption did before, and
// what made it both miss a real bug and stand ready to invent false ones.
//
// A key day within a day of the event's UTC date is normal: a release in
// the small hours UTC belongs to the previous day on a calendar displayed
// west of Greenwich, and to the same day east of it. Anything further
// apart than that is not a timezone, it is corruption.
//
// What to watch is the distribution moving. A run where the -1 bucket
// suddenly swells is the signature of the bug found on 2026-09-12: FF
// served month pages from a zone ahead of UTC, the dateline landed at
// 23:00Z on the previous UTC day, and every key on the page came out a day
// early while event_time stayed correct - which silently duplicates a row
// the next time the same release is fetched from a behind-UTC page.
async function reportKeyShape(rows) {
  log('\nEVENT KEY SHAPE')
  let idKeys = 0
  let dayKeys = 0
  let malformed = 0
  let impossible = 0
  const offsets = new Map()
  const examples = []
  for (const r of rows) {
    const key = String(r.event_key)

    // The expected form: FF's own event id. It is the only identity on the
    // page that survives FF serving a different timezone to a different
    // caller, which is what duplicated 174 releases under day-based keys.
    if (/^ff\|\d+$/.test(key)) {
      idKeys++
      // The id in the key and the id in the column must be the same, or an
      // upsert would update a row that is not the one it matched.
      if (r.ff_event_id && key !== `ff|${r.ff_event_id}`) {
        malformed++
        if (examples.length < 5) examples.push(`key/column id disagree: ${key} vs ${r.ff_event_id}`)
      }
      continue
    }

    // day|currency|title, optionally |#N for the second and later
    // occurrences of one title in a day. Written only by the JSON fallback
    // feed now, which carries no event id - so a large count here means
    // either the migration has not been run or the feed has been carrying
    // the table, and both are worth knowing.
    const parts = key.split('|')
    const hasSeq = parts.length === 4 && /^#\d+$/.test(parts[3])
    if ((parts.length !== 3 && !hasSeq) || !/^\d{4}-\d{2}-\d{2}$/.test(parts[0])) {
      malformed++
      if (examples.length < 5) examples.push(`malformed: ${key}`)
      continue
    }
    dayKeys++
    const diffDays = Math.round(
      (Date.parse(`${parts[0]}T00:00:00Z`) - Date.parse(`${r.event_time.slice(0, 10)}T00:00:00Z`)) / 86400000,
    )
    offsets.set(diffDays, (offsets.get(diffDays) || 0) + 1)
    if (Math.abs(diffDays) > 1) {
      impossible++
      if (examples.length < 5) {
        examples.push(`key day ${diffDays > 0 ? '+' : ''}${diffDays}d from event: ${key} at ${r.event_time}`)
      }
    }
  }
  line('keyed on FF event id', idKeys)
  line('keyed on day|currency|title', dayKeys === 0 ? '0  (none - good)' : `${dayKeys}  <- feed-written or un-migrated`)
  line('malformed', malformed)
  line('further than a day from the event', impossible === 0 ? '0  (none - good)' : `${impossible}  <- CORRUPTION`)
  if (offsets.size > 0) {
    log('\n  day-keyed rows: key day relative to the event\'s UTC date')
    for (const [d, n] of [...offsets].sort((a, b) => a[0] - b[0])) {
      const label = d === 0 ? 'same day' : `${d > 0 ? '+' : ''}${d} day`
      log(`    ${label.padEnd(10)} ${String(n).padStart(5)}${Math.abs(d) > 1 ? '   <- impossible' : ''}`)
    }
  }
  for (const e of examples) log(`    ${e}`)
  return malformed + impossible
}

// The failure the key-shape check exists to prevent, checked directly.
//
// Shape tells you a key is well-formed; it cannot tell you the same
// release is sitting in the table twice under two different keys. That is
// what actually happened when month pages were served from a zone on the
// other side of UTC: the day half moved, so a refetch INSERTED rather than
// updated. 181 rows were mis-keyed that way, and a report that only
// checked shape called the table healthy throughout.
//
// Two independent tests, because each catches what the other cannot:
//   - FF's own event id appearing under more than one key. Decisive when
//     present, but it is null on rows the JSON fallback wrote and on
//     anything stored before the column existed.
//   - the same (title, currency, instant) under more than one key. Works
//     on every row, including those.
function reportDuplicates(rows) {
  log('\nDUPLICATES')

  const byFfId = new Map()
  for (const r of rows) {
    if (!r.ff_event_id) continue
    if (!byFfId.has(r.ff_event_id)) byFfId.set(r.ff_event_id, new Set())
    byFfId.get(r.ff_event_id).add(r.event_key)
  }
  const idDupes = [...byFfId.entries()].filter(([, keys]) => keys.size > 1)

  const byIdentity = new Map()
  for (const r of rows) {
    const id = `${r.event_time}|${r.currency}|${r.title}`
    if (!byIdentity.has(id)) byIdentity.set(id, new Set())
    byIdentity.get(id).add(r.event_key)
  }
  const identityDupes = [...byIdentity.entries()].filter(([, keys]) => keys.size > 1)

  const withoutFfId = rows.filter((r) => !r.ff_event_id).length
  line('rows carrying FF\'s event id', `${rows.length - withoutFfId} of ${rows.length}`)
  line('one FF id under several keys', idDupes.length === 0 ? '0  (none - good)' : `${idDupes.length}  <- DUPLICATED`)
  line('same time+currency+title, 2 keys', identityDupes.length === 0 ? '0  (none - good)' : `${identityDupes.length}  <- DUPLICATED`)

  for (const [id, keys] of idDupes.slice(0, 5)) log(`    ff_event_id ${id}: ${[...keys].join('  ')}`)
  for (const [id, keys] of identityDupes.slice(0, 5)) log(`    ${id}\n      ${[...keys].join('\n      ')}`)

  return idDupes.length + identityDupes.length
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
    return 1
  }
  line('rows', data.length)
  if (data.length !== 1) {
    line('', 'expected exactly one row (id = 1) - the claim matches on id')
    line('', 'with no seed row the claim matches nothing, so every refresh')
    line('', "reports a cooldown it is not in and FF is never fetched")
    return 1
  }
  line('claimed_at', `${data[0].claimed_at} (${ago(data[0].claimed_at)})`)
  // A claim stamped in the future never expires, so on-demand refresh
  // would be wedged until the clock caught up.
  if (Date.parse(data[0].claimed_at) > Date.now() + 60_000) {
    line('', 'claimed_at is in the FUTURE - on-demand refresh is wedged until it passes')
    return 1
  }
  return 0
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
    // The workflow already passes this through; what is missing is the
    // repository secret behind it, so GitHub substitutes an empty string.
    // The old wording sent the reader to a file where the work was done.
    line('', 'add the repository secret (Settings -> Secrets and variables')
    line('', '-> Actions) - run-diagnostic.yml already passes it through')
    return 0
  }
  if (adminRowCount === 0) {
    line('skipped', 'economic_events is empty, so a blocked read and an')
    line('', 'empty table would look identical')
    return 0
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
  return failures
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
  let problems = 0
  reportCoverage(rows)
  if (rows.length === 0) {
    // An empty table is not a healthy one, whatever else reads clean.
    problems++
  } else {
    reportActuals(rows)
    reportPrecision(rows)
    problems += await reportKeyShape(rows)
    problems += reportDuplicates(rows)
    reportDistributions(rows)
  }
  problems += await reportLock(admin)
  problems += await reportRls(url, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, rows.length)

  log('')
  log(problems === 0
    ? 'OK - no problems found'
    : `${problems} PROBLEM(S) FOUND - see the sections above`)
  log('')
  // Exit code, not just ink. This used to print "<- CORRUPTION" and
  // "row level security is OFF" and still exit 0, so a green "Run a
  // diagnostic script" job meant only that the script ran - which is
  // exactly how someone glancing at the Actions list reads it as "healthy".
  // scripts/smoke-test-forexfactory-feed.js already ends this way; this is
  // the same pattern, applied.
  process.exitCode = problems === 0 ? 0 : 1
}

main().catch((err) => {
  console.error(err.message)
  process.exit(1)
})
