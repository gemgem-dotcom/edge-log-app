// Fetches every row a query matches, instead of the first page of them.
//
// PostgREST caps an unbounded select at a server-side maximum (1000 rows on
// Supabase by default) and returns that first page with no error, no flag,
// and no indication that anything was left behind. A journal quietly stops
// counting trades past the cap: stats, the calendar, the equity curve and
// the CSV export all just go wrong, and they go wrong silently, which is
// the worst way for a number a trader relies on to be wrong.
//
// The caller passes a function that applies its own filters to a fresh
// query builder and returns it - this adds the .range() windowing and keeps
// requesting until a page comes back short, which is how you know it was
// the last one.
//
//   const trades = await fetchAllRows((from, to) =>
//     supabase.from('trades').select('*').eq('instrument_id', id).range(from, to))
//
// An explicit order is the caller's job where row order matters: without
// one, Postgres makes no promise that successive pages don't overlap or
// skip rows. Every caller here either sorts client-side afterwards or
// passes its own .order().
const PAGE_SIZE = 1000

// Guards against an unbounded loop if a backend ever ignores .range() and
// keeps returning full pages - 200k trades is far beyond any real journal,
// and stopping there beats spinning forever.
const MAX_PAGES = 200

export async function fetchAllRows(buildQuery) {
  const all = []
  for (let page = 0; page < MAX_PAGES; page++) {
    const from = page * PAGE_SIZE
    const { data, error } = await buildQuery(from, from + PAGE_SIZE - 1)
    if (error) return { data: null, error }
    const rows = data || []
    all.push(...rows)
    // A short page means there is nothing after it. An exactly-full page is
    // ambiguous, so it costs one more request to find out.
    if (rows.length < PAGE_SIZE) break
  }
  return { data: all, error: null }
}
