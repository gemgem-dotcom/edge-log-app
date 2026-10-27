// The economic-outlook half of the per-instrument dashboard's "Today's
// brief" card.
//
// WHAT THIS REPLACES. The card used to read "CPI lands at 08:30." as a
// hardcoded string - every day, on every instrument, whether or not CPI was
// anywhere near the calendar. It was placeholder copy that looked like a
// fact, which is worse than an empty card: a trader who believed it twice
// and was wrong twice has no reason to believe anything else on the page.
//
// WHAT IT SAYS NOW, and the rules it keeps:
//
//   - USD, high and medium impact only. Low and no-impact releases never
//     appear. That matches lib/useUpcomingEconEvents.js's filter and the
//     Economic calendar card's own default, so the three surfaces agree
//     about what is worth interrupting someone for. The table holds
//     roughly fourteen releases a day; a card that lists all of them says
//     nothing.
//   - TODAY only, in the viewer's own local day, not a rolling 24 hours.
//     "Today's brief" is a claim about a day, and a 24-hour window would
//     put tomorrow's 07:00 release in today's brief at 22:00.
//   - Nothing to say means nothing is said. No high or medium USD release
//     today returns null and the card renders its streak sentence alone,
//     rather than printing "no events", which is a line nobody needs daily.
//
// WHAT IT DELIBERATELY DOES NOT DO. It does not report market sentiment
// gathered from news coverage. Doing that honestly needs a licensed news
// source and something to summarise it, neither of which this repo has -
// see the PR this shipped under. Everything below is derived from the
// release's own forecast and previous figures, which the economic_events
// table already stores, and is framed so both readings of a surprise are
// stated rather than one being picked. Nothing here predicts a print.
import { cleanFigure } from './econCalendarEvents.mjs'

const CURRENCY = 'USD'
const IMPACTS = ['high', 'medium']

// What each release is, and what it actually moves. Keyed on a pattern
// against FF's own title, longest/most specific first, because FF titles
// are stable strings ("Core CPI m/m", "Non-Farm Employment Change") and
// matching them beats re-deriving a taxonomy that lib/econCalendarEvents
// already owns for a coarser purpose.
//
// `what` finishes the sentence "<Title> is ..."; `affects` finishes
// "It moves ...". Kept to one clause each: this card sits above the fold
// on a phone, and a trader checking it before the open is not reading
// three paragraphs about PPI.
const MEANINGS = [
  [/\bcore\s+cpi\b/i, {
    what: 'the month-on-month change in consumer prices with food and energy stripped out',
    affects: 'rate expectations more than the headline does, since the Fed watches the core trend rather than the parts that swing on oil',
  }],
  [/\bcpi\b/i, {
    what: 'the headline change in what consumers pay for a basket of goods and services',
    affects: 'the whole curve - it is the single most-watched inflation print, and a surprise reprices how soon the Fed can cut',
  }],
  [/\bcore\s+pce\b/i, {
    what: "the Fed's own preferred inflation gauge, excluding food and energy",
    affects: 'policy expectations directly, because this is the series the committee actually targets',
  }],
  [/\bpce\b/i, {
    what: 'the price index for personal consumption, the broadest measure of what households pay',
    affects: 'rate expectations, though usually less violently than CPI because it lands later in the month',
  }],
  [/\bcore\s+ppi\b/i, {
    what: 'the change in prices producers receive, excluding food and energy',
    affects: 'the inflation outlook one step upstream - producer costs tend to reach consumers later',
  }],
  [/\bppi\b/i, {
    what: 'the change in prices producers receive for their output',
    affects: 'inflation expectations early, since it leads the consumer-price picture',
  }],
  [/non-?farm\s+employment|\bnfp\b/i, {
    what: 'the number of jobs added outside farming last month',
    affects: 'everything - it is the month\'s highest-volatility release, and it sets the tone for growth and policy at once',
  }],
  [/\bunemployment\s+rate\b/i, {
    what: 'the share of the labour force without work and looking',
    affects: 'the policy debate about how much slack the economy has left',
  }],
  [/average\s+hourly\s+earnings/i, {
    what: 'the change in what workers are paid per hour',
    affects: 'the inflation side of the jobs report - wage growth is the part that feeds back into prices',
  }],
  [/unemployment\s+claims|jobless\s+claims/i, {
    what: 'the weekly count of new claims for unemployment benefits',
    affects: 'the near-term read on the labour market, as the highest-frequency jobs data there is',
  }],
  [/\bjolts\b/i, {
    what: 'the number of unfilled job openings',
    affects: 'the read on labour demand, and how tight the market still is',
  }],
  [/\badp\b/i, {
    what: 'a private payroll processor\'s estimate of jobs added',
    affects: 'expectations going into the official payrolls number later that week, though the two often disagree',
  }],
  [/federal\s+funds\s+rate|fomc\s+statement/i, {
    what: "the Fed's rate decision and the language it chooses to explain it",
    affects: 'every asset priced off the dollar - and the wording usually moves more than the decision, which is normally known in advance',
  }],
  [/fomc\s+press\s+conference/i, {
    what: 'the Chair taking questions after the decision',
    affects: 'the tape in real time, often reversing whatever the statement did half an hour earlier',
  }],
  [/fomc\s+(meeting\s+)?minutes/i, {
    what: 'the full account of the last meeting, three weeks after the fact',
    affects: 'expectations where it reveals disagreement the statement smoothed over',
  }],
  [/\bism\s+manufacturing/i, {
    what: 'a survey of factory purchasing managers, where 50 divides expansion from contraction',
    affects: 'the growth outlook, and it is timely enough to lead the harder data',
  }],
  [/\bism\s+services/i, {
    what: 'the same survey for services, which is the larger share of the economy',
    affects: 'the growth picture more than the manufacturing version does, for that reason',
  }],
  [/core\s+retail\s+sales/i, {
    what: 'retail spending excluding autos, which are volatile enough to mask the trend',
    affects: 'the read on consumer demand, which is most of GDP',
  }],
  [/retail\s+sales/i, {
    what: 'the change in total retail spending',
    affects: 'the growth outlook, as the most direct monthly read on the consumer',
  }],
  [/\bgdp\b/i, {
    what: 'the change in total economic output',
    affects: 'the growth picture, though it lands late enough that much of it is already priced',
  }],
  [/consumer\s+confidence|consumer\s+sentiment/i, {
    what: 'a survey of how households feel about their finances and the economy',
    affects: 'the outlook for spending, and the inflation-expectations component gets its own attention',
  }],
  [/durable\s+goods/i, {
    what: 'orders for goods meant to last years, like aircraft and machinery',
    affects: 'the read on business investment, though single large orders distort it',
  }],
]

// Fallback by event_type when no title pattern matches, so a release this
// module has never seen still gets a sentence rather than a blank.
const TYPE_MEANINGS = {
  Inflation: { what: 'an inflation reading', affects: 'rate expectations' },
  Employment: { what: 'a labour-market reading', affects: 'the growth and policy outlook' },
  'Central Bank': { what: 'a central-bank event', affects: 'rate expectations across the curve' },
  Growth: { what: 'a growth reading', affects: 'the outlook for output' },
  Housing: { what: 'a housing-market reading', affects: 'the rate-sensitive side of the economy' },
  'Consumer Surveys': { what: 'a survey of household sentiment', affects: 'the outlook for consumer spending' },
  'Business Surveys': { what: 'a survey of business conditions', affects: 'the forward read on activity' },
  Bonds: { what: 'a government debt auction', affects: 'yields, and through them everything priced off them' },
  Speeches: { what: 'a scheduled appearance by a policymaker', affects: 'rate expectations, where the remarks break new ground' },
  Misc: { what: 'a scheduled economic release', affects: 'the macro picture' },
}

export function meaningFor(event) {
  const title = String(event?.title || '')
  for (const [pattern, meaning] of MEANINGS) {
    if (pattern.test(title)) return meaning
  }
  return TYPE_MEANINGS[event?.event_type] || TYPE_MEANINGS.Misc
}

// A figure like "3.1%" or "-0.2%" reduced to a number for comparison, or
// null when it is not comparable. FF prints units inline (%, K, M, B) and
// they are not consistent between series, so this only ever compares a
// forecast against the PREVIOUS OF THE SAME SERIES - never across series,
// where the units would not line up.
export function figureValue(raw) {
  const cleaned = cleanFigure(raw)
  if (cleaned === null) return null
  // Strip everything but sign, digits and point. "1.2M" and "1.2%" both
  // become 1.2, which is fine because the comparison is same-series.
  const match = cleaned.replace(/,/g, '').match(/-?\d+(\.\d+)?/)
  if (!match) return null
  const n = Number(match[0])
  return Number.isFinite(n) ? n : null
}

// Which direction of surprise is the HAWKISH one for a given release.
//
// Inflation and wages: hotter is hawkish. Growth, jobs and demand: stronger
// is hawkish, because it buys the Fed room to stay restrictive. Claims are
// inverted - more people filing is a WEAKER labour market, so a higher
// number is the dovish side. Unemployment rate likewise.
//
// Anything not confidently classified returns null and gets no hawkish/
// dovish framing at all, rather than a guessed one.
function hawkishOnHigher(event) {
  const title = String(event?.title || '')
  if (/unemployment\s+claims|jobless\s+claims|\bunemployment\s+rate\b/i.test(title)) return false
  if (/\bcpi\b|\bppi\b|\bpce\b|hourly\s+earnings|price\s+index|\binflation\b/i.test(title)) return true
  if (/non-?farm|\bnfp\b|\badp\b|\bjolts\b|retail\s+sales|\bgdp\b|\bism\b|durable\s+goods|employment\s+change/i.test(title)) return true
  const type = event?.event_type
  if (type === 'Inflation') return true
  if (type === 'Growth' || type === 'Employment') return true
  // Sentiment and activity surveys read as demand: a stronger number is
  // room for policy to stay restrictive, the same direction as the hard
  // data they lead. Included because they are a large share of the medium
  // -impact calendar and they do carry a forecast, so leaving them out
  // dropped the two-sided read from days that have nothing else on them.
  if (type === 'Consumer Surveys' || type === 'Business Surveys') return true
  // Housing is deliberately absent. Starts and sales fall when rates rise,
  // so a strong print is as readily "the economy can take it" as "easing
  // is already working" - the direction does not map onto policy cleanly
  // enough to frame without picking a side, which is the one thing this
  // must not do. Bonds and Speeches likewise.
  return null
}

// The balanced read. States what the forecast implies relative to the last
// print, then BOTH sides of the surprise - never one.
//
// This is the piece that most wants to become an opinion, so it is built so
// it cannot: the hawkish and dovish clauses are generated from the same
// template with the direction flipped, so neither can acquire more hedging,
// more evidence or more words than the other. Returns null when there is
// no forecast to anchor on, or when the release is not one whose direction
// maps cleanly onto policy (a bond auction, most speeches).
export function framingFor(event) {
  const forecast = figureValue(event?.forecast)
  const previous = figureValue(event?.previous)
  const hawkHigh = hawkishOnHigher(event)
  if (forecast === null || hawkHigh === null) return null

  // Same length, same shape, same verb. econBriefing.test.js asserts the
  // word counts match, which caught these two differing by one word on the
  // first attempt - small, but it is the thin end of the card developing
  // an opinion, and the whole value of this clause is that it has none.
  const hawkish = 'strengthens the case for policy staying restrictive'
  const dovish = 'strengthens the case for policy easing sooner'
  const above = hawkHigh ? hawkish : dovish
  const below = hawkHigh ? dovish : hawkish

  let lede
  if (previous === null) {
    lede = `Forecast ${cleanFigure(event.forecast)}.`
  } else if (forecast > previous) {
    lede = `Forecast ${cleanFigure(event.forecast)}, above the previous ${cleanFigure(event.previous)}.`
  } else if (forecast < previous) {
    lede = `Forecast ${cleanFigure(event.forecast)}, below the previous ${cleanFigure(event.previous)}.`
  } else {
    lede = `Forecast ${cleanFigure(event.forecast)}, level with the previous print.`
  }

  return `${lede} A print above it ${above}; below it ${below}. Both readings are live until the number lands.`
}

// How many past prints the consensus-bias line reads. Six is two quarters
// of a monthly release - long enough for a run of beats to mean something,
// short enough that it is still describing the current regime rather than
// last year's.
const BIAS_WINDOW = 6

// Whether each past print came in above, below or on its own forecast.
//
// THIS IS NOT NEWS SENTIMENT, and the card must not imply it is. It is the
// one honest, verifiable positioning signal this repo can actually produce:
// how the surveyed consensus has been BIASED on this exact release lately,
// read from actual-vs-forecast on rows the calendar job already stores. A
// run of upside surprises is a real fact about how economists have been
// reading this series, and a trader can use it. It is not a claim about
// what anyone thinks will happen next.
export function consensusBias(history) {
  const prints = (history || [])
    .map((row) => ({ actual: figureValue(row?.actual), forecast: figureValue(row?.forecast) }))
    .filter((p) => p.actual !== null && p.forecast !== null)
    .slice(0, BIAS_WINDOW)
  if (prints.length < 3) return null

  const above = prints.filter((p) => p.actual > p.forecast).length
  const below = prints.filter((p) => p.actual < p.forecast).length
  const inline = prints.length - above - below

  let verdict
  if (above === prints.length) verdict = `all ${prints.length} came in above forecast`
  else if (below === prints.length) verdict = `all ${prints.length} came in below forecast`
  else if (above > below) verdict = `${above} of ${prints.length} came in above forecast`
  else if (below > above) verdict = `${below} of ${prints.length} came in below forecast`
  else verdict = `${above} above, ${below} below, ${inline} on forecast`

  return { prints: prints.length, above, below, inline, verdict }
}

// The next release still to come, for the prose sentence at the top of the
// card. Looks past today when today's are done, because "always show the
// real upcoming event" means the next one that exists, not the next one
// that happens to share a calendar day with the viewer.
export function nextUpcomingEvent(events, now = new Date()) {
  const t = now.getTime()
  const future = (events || [])
    .filter((e) => e && e.currency === CURRENCY && IMPACTS.includes(e.impact))
    .map((e) => ({ event: e, timestamp: new Date(e.event_time).getTime() }))
    .filter(({ timestamp }) => Number.isFinite(timestamp) && timestamp > t)
    .sort((a, b) => a.timestamp - b.timestamp)
  return future[0] || null
}

// "CPI m/m lands at 08:30." - the clause the brief's own sentence ends on.
//
// Replaces a hardcoded "CPI drops at 08:30" that printed every day on every
// instrument whether or not CPI was anywhere near the calendar. Which means
// the one thing this must never do is state a time it has not read off a
// row, so it returns null when there is no upcoming release and the
// sentence simply ends earlier.
export function nextEventSentence(events, now = new Date()) {
  const next = nextUpcomingEvent(events, now)
  if (!next) return null
  const { event, timestamp } = next
  const when = new Date(timestamp)

  const sameLocalDay = when.toDateString() === now.toDateString()
  const tomorrow = new Date(now)
  tomorrow.setDate(tomorrow.getDate() + 1)
  const isTomorrow = when.toDateString() === tomorrow.toDateString()

  // Midnight in the viewer's zone is how an all-day row lands here, and
  // there is no clock time to quote for one.
  const allDay = when.getHours() === 0 && when.getMinutes() === 0
  const clock = when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

  if (allDay) {
    if (sameLocalDay) return `${event.title} is on the calendar today.`
    if (isTomorrow) return `${event.title} is on the calendar tomorrow.`
    return `${event.title} is on the calendar ${when.toLocaleDateString([], { weekday: 'long' })}.`
  }
  if (sameLocalDay) return `${event.title} lands at ${clock}.`
  if (isTomorrow) return `${event.title} lands tomorrow at ${clock}.`
  return `${event.title} lands ${when.toLocaleDateString([], { weekday: 'long' })} at ${clock}.`
}

// Local-day bounds for `now`, in the viewer's own zone. Deliberately not
// UTC and deliberately not FF's display zone: the card says "today", and
// the only "today" the person reading it has is their own.
function localDayBounds(now) {
  const start = new Date(now)
  start.setHours(0, 0, 0, 0)
  const end = new Date(start)
  end.setDate(end.getDate() + 1)
  return [start.getTime(), end.getTime()]
}

// Today's USD high/medium releases, soonest first, each with its meaning
// and framing attached. Pure, so lib/econBriefing.test.js can drive it with
// a fixed clock.
export function buildTodaysBrief({ events, now = new Date(), history = [] } = {}) {
  if (!Array.isArray(events) || events.length === 0) return null
  const [dayStart, dayEnd] = localDayBounds(now)

  // Past prints bucketed by the title they belong to, so each release
  // reads only its own record. fetchReleaseHistory returns them already
  // newest-first across every title at once.
  const historyByTitle = new Map()
  for (const row of history || []) {
    if (!row?.title) continue
    if (!historyByTitle.has(row.title)) historyByTitle.set(row.title, [])
    historyByTitle.get(row.title).push(row)
  }

  const todays = events
    .filter((e) => e && e.currency === CURRENCY && IMPACTS.includes(e.impact))
    .map((e) => ({ event: e, timestamp: new Date(e.event_time).getTime() }))
    .filter(({ timestamp }) => Number.isFinite(timestamp) && timestamp >= dayStart && timestamp < dayEnd)
    .sort((a, b) => a.timestamp - b.timestamp)

  if (todays.length === 0) return null

  return {
    events: todays.map(({ event, timestamp }) => ({
      event,
      timestamp,
      meaning: meaningFor(event),
      framing: framingFor(event),
      bias: consensusBias(historyByTitle.get(event.title)),
    })),
    // High-impact count drives the card's lede, since "two high-impact
    // releases" is a different kind of day from "one medium".
    highCount: todays.filter(({ event }) => event.impact === 'high').length,
  }
}
