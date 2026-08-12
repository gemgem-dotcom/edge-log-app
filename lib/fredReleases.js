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
export const FRED_RELEASES = {
  53: { name: 'Gross Domestic Product', impact: 'high', time: '08:30' },
  54: { name: 'Personal Income and Outlays', impact: 'high', time: '08:30' },
  9: { name: 'Retail Sales', impact: 'high', time: '08:30' },
  27: { name: 'Housing Starts', impact: 'medium', time: '08:30' },
  148: { name: 'Building Permits', impact: 'medium', time: '08:30' },
  97: { name: 'New Home Sales', impact: 'medium', time: '10:00' },
  95: { name: 'Durable Goods Orders', impact: 'medium', time: '08:30' },
  229: { name: 'Construction Spending', impact: 'medium', time: '10:00' },
  180: { name: 'Initial Jobless Claims', impact: 'medium', time: '08:30' },
  291: { name: 'Existing Home Sales', impact: 'medium', time: '10:00' },
  91: { name: 'Michigan Consumer Sentiment', impact: 'medium', time: '10:00' },
}
