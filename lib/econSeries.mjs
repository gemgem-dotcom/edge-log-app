// The BLS series behind the brief's "Read" line, and the pure arithmetic
// over them.
//
// .mjs so the CommonJS scripts under scripts/ can import() it too, the
// same reason econCalendarEvents.mjs is one.
//
// WHY THESE SERIES AND NOT OTHERS. The Read line's job is to say what is
// underneath a headline, and each of these is a specific thing most
// coverage of that headline leaves out:
//
//   - CPI shelter, and inside it owners' equivalent rent. OER is the
//     single largest component of the index and it is IMPUTED - it is an
//     estimate of what an owner would pay to rent their own home, which
//     nobody actually pays. It is surveyed on a long cycle, so it tracks
//     leases signed months ago. A hot CPI driven by OER and a hot CPI
//     driven by petrol are different facts about the economy, and the
//     headline cannot tell you which you are looking at.
//   - Total nonfarm. Not for the level, which the calendar already has,
//     but because BLS flags its own prints preliminary and then revises
//     them. The figure traded on the morning is routinely not the figure
//     that stands.
//
// WHAT IS NOT HERE, and will not be without a source: relative
// importance weights. Converting "shelter rose 0.39%" into "shelter
// contributed 0.17 of the 0.3" needs the weight of shelter in the index,
// and that lives in a table on www.bls.gov, which refuses us (403, every
// path, measured - see scripts/probe-econ-sources.js). So this module
// computes month-on-month changes, which the index levels fully
// determine, and the Read line talks about rates rather than
// contributions. A contribution figure would have to be half invented,
// and half invented is invented.

// seriesId -> what it is. The ids are BLS's own and are stable; the
// prefixes encode the survey and the seasonal adjustment:
//   CUUR  CPI, urban, NOT seasonally adjusted
//   CUSR  CPI, urban, seasonally adjusted
//   CES   Current Employment Statistics
export const SERIES = {
  CUUR0000SA0: { label: 'CPI, all items', unit: 'index', seasonal: false },
  CUSR0000SAH1: { label: 'CPI, shelter', unit: 'index', seasonal: true },
  CUSR0000SEHC: { label: "CPI, owners' equivalent rent", unit: 'index', seasonal: true },
  CES0000000001: { label: 'Total nonfarm payrolls', unit: 'thousands', seasonal: true },
}

// Which series a calendar release wants, keyed on a pattern against FF's
// own title - the same matching MEANINGS in econBriefing.js uses, and for
// the same reason: FF's titles are stable strings and re-deriving a
// taxonomy would be a second source of truth.
const WANTS = [
  [/\bcore\s+cpi\b/i, ['CUSR0000SAH1', 'CUSR0000SEHC']],
  [/\bcpi\b/i, ['CUUR0000SA0', 'CUSR0000SAH1', 'CUSR0000SEHC']],
  [/non-?farm|nfp|employment\s+change/i, ['CES0000000001']],
]

// Same guard, same reason, as lib/econStructure.mjs's NOT_US: these are
// US series and `\bcpi\b` matches a German print. Duplicated rather than
// shared because the two modules are deliberately independent - this one
// is pure BLS plumbing and that one is prose - and a one-line regex is a
// cheaper coupling than an import either way.
const NOT_US = /\b(german|france|french|spanish|italian|euro|eurozone|ez|uk|british|japan|japanese|china|chinese|canada|canadian|australia|australian|new\s+zealand|swiss|switzerland|mexican|indian|korean|brazil)/i

export function seriesFor(title) {
  if (NOT_US.test(String(title || ''))) return []
  for (const [pattern, ids] of WANTS) if (pattern.test(String(title || ''))) return ids
  return []
}

// BLS periods are "M01".."M12", plus "M13" for an annual average, which
// is not a month and must never be treated as one.
export function isMonthly(period) {
  return /^M(0[1-9]|1[0-2])$/.test(String(period || ''))
}

// Sortable key for a (year, period) pair, so "2026 M09" orders after
// "2026 M08" and after "2025 M12" without parsing a date.
export function periodKey(row) {
  const y = Number(row?.year)
  const m = Number(String(row?.period || '').slice(1))
  if (!Number.isFinite(y) || !Number.isFinite(m)) return null
  return y * 100 + m
}

// Newest monthly observation first. Annual averages are dropped rather
// than sorted around: M13 would sort after December and silently become
// "the latest month".
export function monthlyDesc(rows) {
  return (rows || [])
    .filter((r) => isMonthly(r?.period) && Number.isFinite(Number(r?.value)))
    .slice()
    .sort((a, b) => periodKey(b) - periodKey(a))
}

// Month-on-month percent change, from index levels.
//
// Rounded to two places because that is the precision the releases
// themselves are quoted at, and carrying more would imply the series
// supports it. Returns null rather than 0 when there is nothing to
// compare, so a caller cannot print "unchanged" for "unknown".
export function monthOverMonth(rows) {
  const m = monthlyDesc(rows)
  if (m.length < 2) return null
  const latest = Number(m[0].value)
  const prior = Number(m[1].value)
  if (!Number.isFinite(latest) || !Number.isFinite(prior) || prior === 0) return null
  return {
    period: m[0].period,
    year: m[0].year,
    periodName: m[0].periodName || null,
    value: latest,
    priorValue: prior,
    percent: Math.round(((latest - prior) / prior) * 10000) / 100,
    preliminary: isPreliminary(m[0]),
  }
}

// BLS marks a print it expects to revise with footnote code "P". That
// flag is the whole reason the payrolls series is fetched at all, so it
// is read from the data rather than assumed from the month.
export function isPreliminary(row) {
  return (row?.footnotes || []).some((f) => f && f.code === 'P')
}

// What changed between what we stored before and what BLS serves now.
//
// This is the honest way to report a revision: not by trusting a
// footnote, but by having kept the earlier number and comparing. A row
// whose value moved is a revision; a row that is new is not. Returns
// them newest first.
//
// `stored` and `fetched` are both arrays of {year, period, value}. Only
// periods present in BOTH are compared - a period that has dropped out of
// the fetch window is not a revision, it is just out of view.
export function revisionsBetween(stored, fetched) {
  const before = new Map()
  for (const r of monthlyDesc(stored)) before.set(periodKey(r), r)
  const out = []
  for (const r of monthlyDesc(fetched)) {
    const prev = before.get(periodKey(r))
    if (!prev) continue
    const from = Number(prev.value)
    const to = Number(r.value)
    if (!Number.isFinite(from) || !Number.isFinite(to) || from === to) continue
    out.push({
      year: r.year,
      period: r.period,
      periodName: r.periodName || prev.periodName || null,
      from,
      to,
      delta: Math.round((to - from) * 1000) / 1000,
    })
  }
  return out
}

// The BLS v2 response, flattened. Shape confirmed live from a runner
// (scripts/probe-econ-sources.js, 2026-10-28):
//   {"status":"REQUEST_SUCCEEDED","Results":{"series":[{"seriesID":...,
//     "data":[{"year","period","periodName","value","footnotes":[{}]}]}]}}
// Anything that is not REQUEST_SUCCEEDED returns null rather than an
// empty array, so a caller can tell "the request failed" from "the
// series is empty".
export function parseSeriesResponse(json) {
  if (!json || json.status !== 'REQUEST_SUCCEEDED') return null
  const series = json?.Results?.series
  if (!Array.isArray(series)) return null
  const out = {}
  for (const s of series) {
    if (!s?.seriesID) continue
    out[s.seriesID] = (Array.isArray(s.data) ? s.data : []).map((d) => ({
      year: String(d.year),
      period: String(d.period),
      periodName: d.periodName || null,
      value: d.value,
      footnotes: Array.isArray(d.footnotes) ? d.footnotes.filter((f) => f && f.code) : [],
    }))
  }
  return out
}
