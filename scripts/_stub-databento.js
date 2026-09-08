// Preloaded with `node --require` so the scan script's own `fetch` calls
// are answered from a synthetic random walk instead of Databento. Lets the
// REAL main loop run end to end with no API key - which is what catches
// ReferenceErrors and crashes that `node -c` and eslint miss.
const PRICE_SCALE = 1e9

function barsFor(startMs, endMs) {
  const out = []
  let price = 20000
  // Deterministic PRNG so runs are reproducible.
  let seed = Math.floor(startMs / 60000) % 100000
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648
    return seed / 2147483648
  }
  for (let t = Math.floor(startMs / 60000) * 60000; t <= endMs; t += 60000) {
    const drift = (rnd() - 0.5) * 12
    const o = price
    const c = price + drift
    const h = Math.max(o, c) + rnd() * 6
    const l = Math.min(o, c) - rnd() * 6
    price = c
    out.push({
      ts_event: String(BigInt(t) * 1000000n),
      hd: { instrument_id: 42, ts_event: String(BigInt(t) * 1000000n) },
      open: Math.round(o * PRICE_SCALE),
      high: Math.round(h * PRICE_SCALE),
      low: Math.round(l * PRICE_SCALE),
      close: Math.round(c * PRICE_SCALE),
      volume: Math.floor(50 + rnd() * 400),
    })
  }
  return out
}

global.fetch = async (url) => {
  const u = new URL(url)
  const start = Date.parse(u.searchParams.get('start'))
  const end = Date.parse(u.searchParams.get('end'))
  const body = barsFor(start, end).map((r) => JSON.stringify(r)).join('\n')
  return { ok: true, status: 200, statusText: 'OK', text: async () => body }
}
