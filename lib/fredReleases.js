// Curated whitelist of FRED release IDs this app cares about, confirmed
// against a real fred/releases response (not guessed) - id -> {name, impact}.
// Deliberately excludes anything BLS already gives us directly (CPI, PPI,
// Employment Situation, Employment Cost Index, JOLTS) to avoid duplicate
// entries from two sources for the same release. Also excludes ISM and
// Conference Board Consumer Confidence, which aren't tracked as releases
// in FRED at all (see lib/computedReleases.js), and anything FRED sources
// from a private third party without being certain that party's own
// licensing permits this kind of redistribution (Case-Shiller, Housing
// Affordability Index).
// FRED's release_dates endpoint returns a date only, no time of day, so
// `time` here is our own general knowledge of each agency's standard
// release hour (ET) - not something FRED itself provided - included since
// it's still more useful than omitting it, but worth knowing it's an
// assumption rather than sourced data.
//
// `name` matches ForexFactory's naming/impact convention where there's a
// clean 1:1 mapping (Retail Sales m/m, Unemployment Claims, etc.). Where
// FF splits one government report into several named sub-indicators (their
// "Personal Income and Outlays" row becomes three FF rows - Core PCE Price
// Index m/m, Personal Income m/m, Personal Spending m/m; GDP becomes
// Advance/Second/Third GDP q/q depending which revision it is) this can't
// be replicated exactly: FRED's release_dates gives one date per whole
// report, not per sub-indicator or per revision, so this uses the single
// headline figure traders actually watch from that report rather than
// fabricating rows this data can't actually distinguish.
export const FRED_RELEASES = {
  53: { name: 'GDP q/q', impact: 'high', time: '08:30' },
  54: { name: 'Core PCE Price Index m/m', impact: 'high', time: '08:30' },
  9: { name: 'Retail Sales m/m', impact: 'high', time: '08:30' },
  27: { name: 'Housing Starts', impact: 'medium', time: '08:30' },
  148: { name: 'Building Permits', impact: 'medium', time: '08:30' },
  97: { name: 'New Home Sales', impact: 'medium', time: '10:00' },
  95: { name: 'Durable Goods Orders m/m', impact: 'medium', time: '08:30' },
  229: { name: 'Construction Spending m/m', impact: 'medium', time: '10:00' },
  180: { name: 'Unemployment Claims', impact: 'medium', time: '08:30' },
  291: { name: 'Existing Home Sales', impact: 'medium', time: '10:00' },
  91: { name: 'UoM Consumer Sentiment', impact: 'medium', time: '10:00' },
}
