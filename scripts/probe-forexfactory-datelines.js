#!/usr/bin/env node

// Read-only: does each day's data-day-dateline agree with the date Forex
// Factory PRINTS beside it? Writes nothing, touches no database. Run it
// from the "Run a diagnostic script" workflow.
//
// WHY THIS EXISTS. The parser stores `dateline + the row's clock time` as
// the instant of a release, and for months that was treated as exact. On
// 2026-11-09 the November month page handed back datelines 23 hours late
// for every day on it, while October's and December's - same runner, same
// seconds - were correct. 214 of November's 411 events were stored on the
// wrong day, and the first anybody heard of it was a removal guard
// refusing "17 vanished rows" in December that were really November's.
//
// The sandbox cannot reach forexfactory.com, so the only way to know what
// a page really says is to ask from a runner. This prints the answer per
// day rather than a verdict, because the next disagreement will not look
// like this one.
//
// For each day it prints:
//   label     the date cell's own text, what a person reads
//   dateline  the attribute, as a UTC instant
//   offset    dateline minus 00:00Z of the labelled date. A real local
//             midnight is between -14h and +12h; anything else cannot be
//             midnight of that date in any timezone on Earth.
//   gap       seconds to the next dateline on the page
//   first     the first event row of the day, to cross-check by eye
//
// PROBE_WEEKS / PROBE_MONTHS override the targets, comma-separated, in
// FF's own spelling (nov1.2026 / nov.2026).

const USER_AGENT = 'EdgeLog/1.0 (trading journal; +https://github.com/gemgem-dotcom/edge-log-app)'
const GAP_MS = 2500
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function monthParam(offset) {
  const now = new Date()
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1, 12))
  return `${MONTHS[d.getUTCMonth()]}.${d.getUTCFullYear()}`
}

function strip(html) {
  return String(html || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim()
}

function cell(row, cls) {
  const m = new RegExp(`<td[^>]*calendar__${cls}[^>]*>([\\s\\S]*?)</td>`, 'i').exec(row)
  return m ? m[1] : ''
}

// "Mon Nov 30" -> the UTC midnight of that date, in the year nearest the
// dateline (a label carries no year).
function labelMidnightUtc(label, dateline) {
  const m = /([A-Za-z]{3})\s+(\d{1,2})\b/.exec(String(label).replace(/^[A-Za-z]{3}\s+/, ''))
  if (!m) return null
  const month = MONTHS.indexOf(m[1].toLowerCase())
  if (month < 0) return null
  const near = new Date(dateline * 1000).getUTCFullYear()
  let best = null
  for (const year of [near - 1, near, near + 1]) {
    const t = Date.UTC(year, month, Number(m[2])) / 1000
    if (best === null || Math.abs(t - dateline) < Math.abs(best - dateline)) best = t
  }
  return best
}

async function probe(kind, param) {
  const url = `https://www.forexfactory.com/calendar?${kind}=${param}`
  console.log(`\n=== ${kind} ${param}`)
  let html
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' },
      signal: AbortSignal.timeout(30000),
    })
    console.log(`    HTTP ${res.status}`)
    if (!res.ok) return
    html = await res.text()
  } catch (err) {
    console.log(`    FAILED: ${err.message}`)
    return
  }
  console.log(`    ${html.length} bytes`)

  const rows = [...html.matchAll(/<tr[^>]*calendar__row[^>]*>[\s\S]*?<\/tr>/gi)].map((m) => m[0])
  const days = []
  let current = null
  for (const row of rows) {
    const dl = /data-day-dateline="(\d+)"/i.exec(row)
    if (dl) {
      current = { dateline: Number(dl[1]), label: strip(cell(row, 'date')), first: null, raw: row.slice(0, 260).replace(/\s+/g, ' ') }
      days.push(current)
    }
    if (!current || /day-breaker/i.test(row)) continue
    const title = strip(/calendar__event-title[^>]*>([\s\S]*?)<\/span>/i.exec(row)?.[1] || '')
    if (title && !current.first) {
      current.first = `${strip(cell(row, 'time')) || '(blank)'} ${strip(cell(row, 'currency'))} ${title}`
    }
  }

  let bad = 0
  for (const [i, d] of days.entries()) {
    const labelAt = labelMidnightUtc(d.label, d.dateline)
    const offsetH = labelAt === null ? null : (d.dateline - labelAt) / 3600
    const plausible = offsetH !== null && offsetH >= -14 && offsetH <= 12
    if (!plausible) bad++
    const gap = i + 1 < days.length ? days[i + 1].dateline - d.dateline : null
    console.log(
      `    ${plausible ? 'ok ' : 'BAD'}  label="${d.label}"  dateline=${new Date(d.dateline * 1000).toISOString().slice(0, 16)}Z`
      + `  offset=${offsetH === null ? '?' : `${offsetH >= 0 ? '+' : ''}${offsetH}h`}`
      + `  gap=${gap === null ? '-' : gap}  first="${d.first || ''}"`,
    )
  }
  console.log(`    ${days.length} day(s), ${bad} whose dateline cannot be midnight of the printed date`)
  // The markup itself, for the first day and for the first bad one, so a
  // test fixture can be cut from what FF really sent.
  if (days[0]) console.log(`    raw first day: ${days[0].raw}`)
}

async function main() {
  const months = (process.env.PROBE_MONTHS || [monthParam(-1), monthParam(0), monthParam(1)].join(','))
    .split(',').map((s) => s.trim()).filter(Boolean)
  // Both US clock changes of 2026 by default: the 25-hour day that broke
  // November, and the 23-hour one in March for the other direction.
  const weeks = (process.env.PROBE_WEEKS || 'nov1.2026,nov29.2026,mar8.2026')
    .split(',').map((s) => s.trim()).filter(Boolean)

  let first = true
  for (const [kind, list] of [['month', months], ['week', weeks]]) {
    for (const param of list) {
      if (!first) await sleep(GAP_MS)
      first = false
      await probe(kind, param)
    }
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
