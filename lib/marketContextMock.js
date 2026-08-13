// Placeholder market-context data for the Overview and strategy-detail "at
// a glance" cards (volatility, key levels, economic events), until a paid
// market-data API replaces it. Every function returns the same shape the
// real version will need, so swapping the implementation out later
// shouldn't require touching the cards that call it.

// Deterministic 0-1 fraction seeded by a string, so a given instrument's
// mock volatility stays stable across renders instead of jumping around
// on every reload - still clearly a placeholder, just not a distracting one.
// djb2-style hash with bit-shifting (not a plain rolling sum) so short
// strings like "NQ" or "ES" still spread across the range instead of
// clustering near 0 - a plain `hash*31+code` sum stays small for 2-3
// character symbols and rounds every instrument to the same ~0.8x floor.
function seededFraction(key) {
  let hash = 5381
  for (const c of String(key)) hash = ((hash << 5) + hash + c.charCodeAt(0)) | 0
  return (Math.abs(hash) % 10000) / 10000
}

export function mockVolatility(symbol) {
  const multiplier = Math.round((0.8 + seededFraction(symbol) * 1.6) * 10) / 10
  return { multiplier, elevated: multiplier >= 1.4 }
}

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
