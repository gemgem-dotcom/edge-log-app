// Fixed set of instruments a user can add to their journal. data_symbol
// groups mini/micro contracts that track identical price movement (just
// different contract sizes) onto one underlying series, so future
// market-data lookups have a single symbol to key off regardless of which
// contract size the trader actually logs.
export const INSTRUMENT_CATALOG = [
  { symbol: 'ES', display_name: 'E-mini S&P 500', data_symbol: 'ES' },
  { symbol: 'MES', display_name: 'Micro S&P 500', data_symbol: 'ES' },
  { symbol: 'NQ', display_name: 'E-mini Nasdaq 100', data_symbol: 'NQ' },
  { symbol: 'MNQ', display_name: 'Micro Nasdaq 100', data_symbol: 'NQ' },
  { symbol: 'YM', display_name: 'E-mini Dow', data_symbol: 'YM' },
  { symbol: 'MYM', display_name: 'Micro Dow', data_symbol: 'YM' },
  { symbol: 'RTY', display_name: 'E-mini Russell 2000', data_symbol: 'RTY' },
  { symbol: 'M2K', display_name: 'Micro Russell 2000', data_symbol: 'RTY' },
  { symbol: 'GC', display_name: 'Gold', data_symbol: 'GC' },
  { symbol: 'MGC', display_name: 'Micro Gold', data_symbol: 'GC' },
  { symbol: 'CL', display_name: 'Crude Oil', data_symbol: 'CL' },
  { symbol: 'MCL', display_name: 'Micro Crude Oil', data_symbol: 'CL' },
  { symbol: 'SI', display_name: 'Silver', data_symbol: 'SI' },
  { symbol: 'SIL', display_name: 'Micro Silver', data_symbol: 'SI' },
  { symbol: 'BTC', display_name: 'Bitcoin futures', data_symbol: 'BTC' },
  { symbol: 'MBT', display_name: 'Micro Bitcoin', data_symbol: 'BTC' },
]

export function catalogEntryFor(symbol) {
  return INSTRUMENT_CATALOG.find((i) => i.symbol === symbol) || null
}
