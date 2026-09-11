// Shape and vocabulary of a Forex Factory calendar event, plus the pure
// functions that turn one raw feed record into a row we store.
//
// .mjs, not .js, on purpose - this is the one module that has to be read
// from BOTH sides of this repo's module divide. The app imports it like
// any other lib file, and scripts/fetch-economic-calendar.js (a plain
// `node scripts/...` CommonJS file, like every other script here) pulls it
// in with a dynamic import(). package.json has no "type": "module", so a
// bare .js file with `export` in it is parsed as CommonJS by Node and
// throws; the .mjs extension is what makes Node read it as ESM without
// that ambiguity. That's what lets the classifier below exist once instead
// of being duplicated into the script the way the other scripts duplicate
// their small bits of shared logic (see fetch-daily-market-stats.js's
// header) - a ten-category keyword classifier is far too much surface to
// keep in sync by hand across two copies.

// Forex Factory's own four impact levels, in its own colour order: red,
// orange, yellow, grey. The fourth covers both "Holiday" and
// "Non-Economic" in the feed - FF paints them the same grey and they mean
// the same thing to a trader (nothing is being released), so they collapse
// into one filterable level here rather than two that always travel
// together.
export const IMPACT_LEVELS = [
  { value: 'high', label: 'High' },
  { value: 'medium', label: 'Medium' },
  { value: 'low', label: 'Low' },
  { value: 'holiday', label: 'Non-economic' },
]

// FF's own event-type taxonomy, in the order its own filter panel lists
// them. Stored per row by classifyEventType below, so the filter is a
// plain equality check against a column rather than re-deriving a category
// from the title on every render.
export const EVENT_TYPES = [
  'Growth',
  'Inflation',
  'Employment',
  'Central Bank',
  'Bonds',
  'Housing',
  'Consumer Surveys',
  'Business Surveys',
  'Speeches',
  'Misc',
]

// The nine currencies FF's calendar covers. Not derived from whatever
// happens to be in the table, so the filter list stays put across a quiet
// week that happens to carry no CHF events at all.
export const CURRENCIES = ['AUD', 'CAD', 'CHF', 'CNY', 'EUR', 'GBP', 'JPY', 'NZD', 'USD']

// FF files events with no single home currency - OPEC meetings, G20
// summits - under country "All", which normalizeFeedEvent upper-cases
// along with every other code. Confirmed live: one showed up in the first
// week's payload.
//
// It is deliberately NOT in CURRENCIES above. It briefly was, and reading
// "ALL" at the top of a list of currency checkboxes made it look like a
// select-all toggle rather than a value in its own right. The card instead
// exempts these events from the currency filter entirely (see its own
// comment) - which is also the truer behaviour, since a global event isn't
// one currency's news and shouldn't disappear because you unticked EUR.
export const GLOBAL_CURRENCY = 'ALL'

// Checked in order, first match wins - the order matters as much as the
// keywords do:
//
// - Speeches sits above Central Bank because almost every speech title
//   also names a central bank ("FOMC Member Williams Speaks", "BOE Gov
//   Bailey Speaks"), and the speech is the more specific fact about it.
// - Inflation sits above Consumer Surveys because "Consumer Price Index"
//   would otherwise read as a consumer survey. The survey patterns below
//   are deliberately whole phrases ("Consumer Confidence") rather than a
//   bare "Consumer" for the same reason - "Consumer Credit" is neither.
// - Growth sits last of the real categories because its members are the
//   broadest ("Sales", "Production", "Orders") and would otherwise
//   swallow more specific ones like Retail-adjacent housing releases.
const TYPE_PATTERNS = [
  ['Speeches', [/\bspeaks?\b/i, /\btestifies\b/i, /\btestimony\b/i, /\bpress conference\b/i, /\bspeech\b/i]],
  ['Central Bank', [
    /\bfomc\b/i, /\brate statement\b/i, /\bmonetary policy\b/i, /\bbank rate\b/i,
    /\bfederal funds rate\b/i, /\bcash rate\b/i, /\binterest rate\b/i, /\brate decision\b/i,
    /\bbeige book\b/i, /\bmeeting minutes\b/i, /\bpolicy rate\b/i, /\brefinancing rate\b/i,
    /\bmpc\b/i, /\beconomic projections\b/i,
  ]],
  ['Inflation', [
    /\bcpi\b/i, /\bppi\b/i, /\brpi\b/i, /\bhicp\b/i, /\bpce\b/i, /\binflation\b/i,
    /\bprice index\b/i, /\bimport prices\b/i, /\bexport prices\b/i, /\bdeflator\b/i,
    /\bwage price\b/i,
  ]],
  ['Employment', [
    /\bemployment\b/i, /\bunemployment\b/i, /\bjobless\b/i, /\bpayrolls?\b/i, /\bjobs?\b/i,
    /\bnon-farm\b/i, /\bnonfarm\b/i, /\badp\b/i, /\bjolts\b/i, /\bclaimant count\b/i,
    /\bhourly earnings\b/i, /\blabor cost\b/i, /\blabour cost\b/i, /\bparticipation rate\b/i,
    /\bjob cuts\b/i,
  ]],
  ['Housing', [
    /\bhousing\b/i, /\bhome sales\b/i, /\bbuilding permits\b/i, /\bbuilding approvals\b/i,
    /\bhouse price\b/i, /\bhpi\b/i, /\bmortgage\b/i, /\bconstruction spending\b/i,
    /\bnahb\b/i, /\bcase-?shiller\b/i,
  ]],
  ['Bonds', [/\bauction\b/i, /\bbond purchases\b/i, /\bgilt\b/i, /\bbund\b/i, /\bjgb\b/i]],
  ['Consumer Surveys', [
    /\bconsumer confidence\b/i, /\bconsumer sentiment\b/i, /\bconsumer climate\b/i,
    /\bconsumer survey\b/i, /\bconsumer expectations\b/i,
  ]],
  ['Business Surveys', [
    /\bpmi\b/i, /\bism\b/i, /\bbusiness confidence\b/i, /\bbusiness climate\b/i,
    /\bbusiness survey\b/i, /\bbusiness outlook\b/i, /\bmanufacturing index\b/i,
    /\bempire state\b/i, /\bphilly fed\b/i, /\bzew\b/i, /\bifo\b/i, /\btankan\b/i,
    /\bsentix\b/i, /\bnfib\b/i, /\bbusiness barometer\b/i,
  ]],
  ['Growth', [
    /\bgdp\b/i, /\bretail sales\b/i, /\bindustrial production\b/i, /\btrade balance\b/i,
    /\bcurrent account\b/i, /\bfactory orders\b/i, /\bdurable goods\b/i, /\bmachinery orders\b/i,
    // Qualified rather than a bare /inventories/: "Crude Oil Inventories"
    // and "Natural Gas Storage" are energy reports that happen to share
    // the word, and belong in Misc alongside the rest of the weekly
    // energy numbers rather than being read as growth indicators.
    /\b(business|wholesale|retail) inventories\b/i,
    // "leading indicat" rather than "leading index" - FF ships both
    // "Leading Index" and "Leading Indicators", and the narrower pattern
    // was dropping the plural into Misc (caught live, in the first real
    // payload).
    /\bproduction\b/i, /\bleading indic/i, /\bleading index\b/i, /\beconomic activity\b/i,
  ]],
]

// Which of EVENT_TYPES a title belongs to. Always returns one of them -
// anything unmatched is 'Misc', which is a real category in FF's own
// filter, not a failure case.
export function classifyEventType(title) {
  if (typeof title !== 'string') return 'Misc'
  for (const [type, patterns] of TYPE_PATTERNS) {
    if (patterns.some((p) => p.test(title))) return type
  }
  return 'Misc'
}

// The feed's impact strings ("High"/"Medium"/"Low"/"Holiday"/
// "Non-Economic") down to one of IMPACT_LEVELS' values. Anything
// unrecognised is treated as 'holiday' rather than dropped or guessed
// upward: the grey level is the one that says "nothing is being released
// here", which is the safer reading of a value we don't understand than
// claiming it's market-moving.
export function normalizeImpact(raw) {
  const value = String(raw || '').trim().toLowerCase()
  if (value === 'high') return 'high'
  if (value === 'medium') return 'medium'
  if (value === 'low') return 'low'
  return 'holiday'
}

// A blank string and a literal "N/A" both mean "this release has no such
// figure" in the feed, and both should read as an em dash rather than as
// text. Stored as null so the UI has one empty case to handle, not three.
export function cleanFigure(raw) {
  if (raw === null || raw === undefined) return null
  const value = String(raw).trim()
  if (value === '' || value.toLowerCase() === 'n/a') return null
  return value
}

const FF_MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

// Forex Factory's own calendar URL for the day an event falls on, in the
// `?day=sep7.2026` form its site uses. Built rather than read from the
// feed: the feed carries no url field at all (confirmed live), so the
// alternative is a column that is null on every row forever. This at least
// lands the reader on the right day of the real calendar, where the
// per-event detail popup (source, usual effect, revision history) lives.
//
// Deliberately built from the event's UTC date, matching the day half of
// eventKey below, so the two never disagree about which day a row is on.
export function detailUrlFor(eventTime) {
  const d = eventTime instanceof Date ? eventTime : new Date(eventTime)
  if (Number.isNaN(d.getTime())) return null
  return `https://www.forexfactory.com/calendar?day=${FF_MONTHS[d.getUTCMonth()]}${d.getUTCDate()}.${d.getUTCFullYear()}`
}

// Stable identity for an event across refetches, so the hourly job
// upserts rather than duplicating. Deliberately keyed on the UTC calendar
// DAY and not the full timestamp: FF revises an event's scheduled time
// fairly often (and moves it by minutes when a release slips), and keying
// on the exact instant would turn each of those revisions into a second
// row for the same release rather than an update of the first.
export function eventKey({ eventTime, currency, title }) {
  const day = eventTime instanceof Date ? eventTime.toISOString().slice(0, 10) : String(eventTime).slice(0, 10)
  return `${day}|${String(currency || '').toUpperCase()}|${String(title || '').trim()}`
}

// One raw feed record -> the row shape economic_events stores, or null if
// the record is unusable (no title, no parseable date). Returning null
// rather than throwing is what lets one malformed record be skipped and
// counted without losing the rest of the week's fetch.
//
// Field names are read defensively - `country` is what the feed calls the
// currency column, confirmed live, but reading `currency` as a fallback
// costs nothing if that ever changes.
//
// `actual` is NOT in this feed. Confirmed against a real payload: the only
// keys present are country, date, forecast, impact, previous and title,
// and zero records carried an actual even for releases that had already
// printed. It's still read here (and still a nullable column) because the
// cost is one line and the alternative - a schema change - is the
// expensive way to find out FF added it later. Nothing in the app should
// claim an actual will appear.
export function normalizeFeedEvent(raw) {
  if (!raw || typeof raw !== 'object') return null
  const title = typeof raw.title === 'string' ? raw.title.trim() : ''
  if (!title) return null

  const parsed = new Date(raw.date)
  if (Number.isNaN(parsed.getTime())) return null

  const currency = String(raw.country ?? raw.currency ?? '').trim().toUpperCase()

  return {
    event_key: eventKey({ eventTime: parsed, currency, title }),
    title,
    currency,
    event_time: parsed.toISOString(),
    impact: normalizeImpact(raw.impact),
    event_type: classifyEventType(title),
    forecast: cleanFigure(raw.forecast),
    previous: cleanFigure(raw.previous),
    actual: cleanFigure(raw.actual),
    detail_url: typeof raw.url === 'string' && raw.url ? raw.url : detailUrlFor(parsed),
  }
}

// Every usable row from one feed payload, de-duplicated by event_key so a
// single upsert call can't fail on "ON CONFLICT DO UPDATE command cannot
// affect row a second time" - the week feeds overlap at their edges, and
// Postgres rejects a batch that names the same key twice.
export function normalizeFeed(rawList) {
  if (!Array.isArray(rawList)) return { events: [], skipped: 0 }
  const byKey = new Map()
  let skipped = 0
  for (const raw of rawList) {
    const row = normalizeFeedEvent(raw)
    if (!row) { skipped++; continue }
    byKey.set(row.event_key, row)
  }
  return { events: [...byKey.values()], skipped }
}
