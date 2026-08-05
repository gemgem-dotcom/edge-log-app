// Fixed set of instruments a user can add to their journal. data_symbol
// groups mini/micro contracts that track identical price movement (just
// different contract sizes) onto one underlying series, so future
// market-data lookups have a single symbol to key off regardless of which
// contract size the trader actually logs.
//
// Distances (stop loss / take profit) are entered in "points", which the
// platform treats as a raw decimal price difference for every instrument —
// e.g. entry 21050.00 with a 15 point stop puts the stop at 21035.00.
// There is deliberately no per-instrument tick multiplier: a point is
// always just a price difference, so the same arithmetic holds everywhere.
// point_value is the dollar move of one contract per 1.00 of price, used to
// auto-fill the $ Profit/Loss field on the trade form. Because a point here
// is a raw price difference, P&L is simply
// (exit − entry) × point_value × contracts, signed by direction.
export const INSTRUMENT_CATALOG = [
  { symbol: 'ES', display_name: 'E-mini S&P 500', data_symbol: 'ES', point_value: 50 },
  { symbol: 'MES', display_name: 'Micro S&P 500', data_symbol: 'ES', point_value: 5 },
  { symbol: 'NQ', display_name: 'E-mini Nasdaq 100', data_symbol: 'NQ', point_value: 20 },
  { symbol: 'MNQ', display_name: 'Micro Nasdaq 100', data_symbol: 'NQ', point_value: 2 },
  { symbol: 'YM', display_name: 'E-mini Dow', data_symbol: 'YM', point_value: 5 },
  { symbol: 'MYM', display_name: 'Micro Dow', data_symbol: 'YM', point_value: 0.5 },
  { symbol: 'GC', display_name: 'Gold', data_symbol: 'GC', point_value: 100 },
  { symbol: 'MGC', display_name: 'Micro Gold', data_symbol: 'GC', point_value: 10 },
  { symbol: 'CL', display_name: 'Crude Oil', data_symbol: 'CL', point_value: 1000 },
  { symbol: 'MCL', display_name: 'Micro Crude Oil', data_symbol: 'CL', point_value: 100 },
  { symbol: 'BTC', display_name: 'Bitcoin futures', data_symbol: 'BTC', point_value: 5 },
  { symbol: 'MBT', display_name: 'Micro Bitcoin', data_symbol: 'BTC', point_value: 0.5 },
]

export function catalogEntryFor(symbol) {
  return INSTRUMENT_CATALOG.find((i) => i.symbol === symbol) || null
}

// Null for a symbol that isn't in the catalog, which leaves the P&L field
// alone rather than auto-filling it with a wrong number.
export function pointValueFor(symbol) {
  return catalogEntryFor(symbol)?.point_value ?? null
}
