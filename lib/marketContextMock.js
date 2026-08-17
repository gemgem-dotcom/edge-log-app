// Placeholder market-context data for the Overview and strategy-detail "at
// a glance" cards (key levels, economic events), until a paid market-data
// API replaces it. Every function returns the same shape the real version
// will need, so swapping the implementation out later shouldn't require
// touching the cards that call it.

// Rough, made-up reference prices per underlying - only used to make mock
// key levels look plausible for whichever instrument is on screen, not
// sourced from any real quote.
const MOCK_BASE_PRICE = {
  ES: 5700, MES: 5700, NQ: 21400, MNQ: 21400, YM: 40000, MYM: 40000,
  GC: 2400, MGC: 2400, CL: 75, MCL: 75, BTC: 65000, MBT: 65000,
}

export function mockKeyLevels(symbol) {
  const base = MOCK_BASE_PRICE[symbol] || 100
  const spread = base * 0.008
  return {
    priorHigh: base + spread,
    priorLow: base - spread * 1.2,
    sessionOpen: base - spread * 0.3,
  }
}

// A week's worth of mock events, `day` being 0=Monday..4=Friday within
// whatever week EconomicCalendarCard is showing. Shape matches what a real
// provider (ForexFactory-style: time, event, impact, forecast, previous)
// would return, so that component doesn't need to change when this is
// replaced with a live source - only the mapping from `day` to an actual
// calendar date is real (computed in the component from the browser
// clock); this same event list repeats every week since there's no live
// source yet to vary it.
export const MOCK_ECON_WEEK = [
  { day: 0, time: '10:00', event: 'Fed Chair Powell Speaks', impact: 'medium', forecast: null, previous: null },
  { day: 1, time: '10:00', event: 'CB Consumer Confidence', impact: 'medium', forecast: '98.5', previous: '97.2' },
  { day: 2, time: '08:30', event: 'CPI m/m', impact: 'high', forecast: '0.3%', previous: '0.2%' },
  { day: 2, time: '10:30', event: 'Crude Oil Inventories', impact: 'low', forecast: '-1.2M', previous: '2.4M' },
  { day: 3, time: '08:30', event: 'Unemployment Claims', impact: 'medium', forecast: '224K', previous: '221K' },
  { day: 3, time: '14:00', event: '30-Year Bond Auction', impact: 'low', forecast: null, previous: null },
  { day: 4, time: '08:30', event: 'Retail Sales m/m', impact: 'high', forecast: '0.4%', previous: '0.6%' },
  { day: 4, time: '10:00', event: 'UoM Consumer Sentiment', impact: 'medium', forecast: '68.5', previous: '67.8' },
]

// Which of MOCK_ECON_WEEK's entries fall on a given calendar date - used
// by the Monthly P&L calendar's news badge, so a day cell can tell whether
// to show the icon without duplicating the weekday-offset math itself.
// Weekends always come back empty (MOCK_ECON_WEEK only defines Mon-Fri).
export function mockEventsForDate(dateStr) {
  const d = new Date(dateStr + 'T00:00:00')
  const weekday = d.getDay()
  const offset = weekday === 0 ? 6 : weekday - 1
  return MOCK_ECON_WEEK.filter((e) => e.day === offset)
}

// The chronologically nearest upcoming event from `fromDate` - not mocked
// itself, it's real day/time arithmetic over MOCK_ECON_WEEK's list (which
// is the mocked part, and repeats every week - see the comment above).
// Searches this week and next, since once every event in the current
// week has passed, the next occurrence is next week's repeat of the same
// list. Returns null only if MOCK_ECON_WEEK is empty.
export function nextEconEvent(fromDate = new Date()) {
  const monday = new Date(fromDate)
  const weekday = monday.getDay()
  monday.setDate(monday.getDate() + (weekday === 0 ? -6 : 1 - weekday))
  monday.setHours(0, 0, 0, 0)

  let best = null
  for (const weekOffset of [0, 1]) {
    for (const e of MOCK_ECON_WEEK) {
      const [hh, mm] = e.time.split(':').map(Number)
      const timestamp = new Date(monday)
      timestamp.setDate(timestamp.getDate() + e.day + weekOffset * 7)
      timestamp.setHours(hh, mm, 0, 0)
      if (timestamp > fromDate && (!best || timestamp < best.timestamp)) {
        best = { ...e, timestamp }
      }
    }
  }
  return best
}
