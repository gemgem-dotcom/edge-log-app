// Preloaded with `node --require` to answer search-strategies.js's Databento
// calls from a synthetic series instead of the network.
//
// This exists SEPARATELY from _stub-databento.js, which the rejection scan's
// smoke test pins an exact event count against, and which must not move.
//
// ---------- why the generator quality matters here ----------
//
// This stub is not a convenience, it is the control for the whole search. The
// claim it has to support is: "run the search on a series with no edge and it
// finds nothing." That claim is only worth something if the series really has
// no edge.
//
// The first attempt reused _stub-databento.js's LCG (x = 1103515245x + 12345
// mod 2^31) and the search promptly reported momentum rules at z = 6. That was
// not a bug in the search - it was the generator. Measured over 200k draws,
// that LCG's increments carry autocorrelation of -0.012 to -0.015 at lags 1,
// 2, 5 and 15, against a white-noise band of +/-0.0045. Serial correlation IS
// an edge, so the "control" contained exactly the thing it was supposed to
// rule out.
//
// So: xoshiro128** seeded through splitmix32, with Box-Muller normal
// increments, and assertUncorrelated() below to prove the property rather than
// assume it. Run this file directly (`node scripts/_stub-random-walk.js`) to
// see the self-test.

const PRICE_SCALE = 1e9

function splitmix32(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x9e3779b9) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 16), 0x21f0aaad)
    t = Math.imul(t ^ (t >>> 15), 0x735a2d97)
    return (t ^ (t >>> 15)) >>> 0
  }
}

function rotl(x, k) {
  return ((x << k) | (x >>> (32 - k))) >>> 0
}

// xoshiro128** - passes the standard statistical batteries, unlike the LCG it
// replaces, and is still just a handful of integer ops per draw.
function xoshiro128ss(seed) {
  const seeder = splitmix32(seed)
  const s = new Uint32Array([seeder(), seeder(), seeder(), seeder()])
  return () => {
    const result = Math.imul(rotl(Math.imul(s[1], 5) >>> 0, 7), 9) >>> 0
    const t = (s[1] << 9) >>> 0
    s[2] ^= s[0]
    s[3] ^= s[1]
    s[1] ^= s[2]
    s[0] ^= s[3]
    s[2] ^= t
    s[3] = rotl(s[3], 11)
    return result / 4294967296
  }
}

function makeNormal(uniform) {
  let spare = null
  return () => {
    if (spare !== null) {
      const value = spare
      spare = null
      return value
    }
    let u = 0
    let v = 0
    let s = 0
    do {
      u = uniform() * 2 - 1
      v = uniform() * 2 - 1
      s = u * u + v * v
    } while (s === 0 || s >= 1)
    const factor = Math.sqrt((-2 * Math.log(s)) / s)
    spare = v * factor
    return u * factor
  }
}

// A driftless walk in log price. Highs and lows are drawn independently of the
// next increment, so the bar's extremes carry no information about where price
// goes afterwards - the property a momentum or breakout rule would otherwise
// exploit for free.
function barsFor(startMs, endMs, seedBase) {
  const uniform = xoshiro128ss(seedBase >>> 0)
  const normal = makeNormal(uniform)
  const out = []
  let price = 20000
  const stepSd = 3.5
  for (let t = Math.floor(startMs / 60000) * 60000; t <= endMs; t += 60000) {
    const open = price
    const close = open + normal() * stepSd
    const high = Math.max(open, close) + Math.abs(normal()) * stepSd * 0.6
    const low = Math.min(open, close) - Math.abs(normal()) * stepSd * 0.6
    price = close
    out.push({
      ts_event: String(BigInt(t) * 1000000n),
      hd: { instrument_id: 42, ts_event: String(BigInt(t) * 1000000n) },
      open: Math.round(open * PRICE_SCALE),
      high: Math.round(high * PRICE_SCALE),
      low: Math.round(low * PRICE_SCALE),
      close: Math.round(close * PRICE_SCALE),
      volume: Math.floor(50 + uniform() * 400),
    })
  }
  return out
}

// The self-test. Autocorrelation of the increments at every lag a signal in
// the catalogue could see must sit inside the white-noise band; anything else
// means the control has an edge baked into it.
function assertUncorrelated({ draws = 400000, maxLag = 30, verbose = false } = {}) {
  const uniform = xoshiro128ss(20260908)
  const normal = makeNormal(uniform)
  const r = new Float64Array(draws)
  for (let i = 0; i < draws; i++) r[i] = normal()
  let sum = 0
  for (let i = 0; i < draws; i++) sum += r[i]
  const m = sum / draws
  let den = 0
  for (let i = 0; i < draws; i++) den += (r[i] - m) * (r[i] - m)
  const band = 3 / Math.sqrt(draws)
  const failures = []
  for (let lag = 1; lag <= maxLag; lag++) {
    let num = 0
    for (let i = 0; i < draws - lag; i++) num += (r[i] - m) * (r[i + lag] - m)
    const ac = num / den
    if (verbose) console.log(`lag ${String(lag).padStart(2)}  autocorr ${ac.toFixed(6)}`)
    if (Math.abs(ac) > band) failures.push({ lag, ac })
  }
  return { band, failures, draws, maxLag }
}

if (require.main === module) {
  const report = assertUncorrelated({ verbose: process.argv.includes('--verbose') })
  console.log(`checked lags 1..${report.maxLag} over ${report.draws} draws, 3-sigma band +/-${report.band.toFixed(6)}`)
  if (report.failures.length > 0) {
    console.error('CONTROL IS NOT A MARTINGALE:', report.failures)
    process.exit(1)
  }
  console.log('OK - increments are serially uncorrelated, safe to use as a null control')
} else {
  global.fetch = async (url) => {
    const u = new URL(url)
    const start = Date.parse(u.searchParams.get('start'))
    const end = Date.parse(u.searchParams.get('end'))
    const body = barsFor(start, end, Math.floor(start / 60000)).map((r) => JSON.stringify(r)).join('\n')
    return { ok: true, status: 200, statusText: 'OK', text: async () => body }
  }
}

module.exports = { xoshiro128ss, makeNormal, barsFor, assertUncorrelated }
