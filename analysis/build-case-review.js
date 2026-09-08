// Builds the blind case-review list.
//
// Every attempt so far has tried to reverse-engineer the trader's rule from
// 24 winning outcomes with no counter-examples: no record of what they LOOKED
// at and passed on. A rule can't be recovered from its positives alone.
//
// So this inverts it. Take the mechanical poc5 fills from the year scan,
// stratify them by what actually happened, strip every outcome field, shuffle,
// and hand over date + time only. The trader reviews each one on their own
// chart and says take or pass. Their pass decisions are the missing half of
// the data, and their stated reasons become the candidate feature list.
//
// Selection rules that matter for it to be a fair test:
//   - 9:35-11:30 ET only. Their window, minus the first five minutes they
//     have said they never trade - otherwise five of twenty cases would be
//     free passes on a rule already known.
//   - One case per date, so no case can be inferred from a neighbour.
//   - Stratified 7 "ran" / 6 "stopped fast" / 7 "went nowhere", then shuffled,
//     so neither the order nor the mix leaks which is which.
//   - Exploration set only (through 2026-06-04). The holdout stays sealed.
//
// Outcome classes are measured against a 3-ATR(1m) stop, from the excursion
// grid the scan already records:
//   ran       - reached >= 100 points favourable before that stop
//   stopfast  - stop touched within 12 bars with nothing much favourable first
//   nowhere   - everything else
//
// The answer key is written base64-encoded (analysis/case-review-key.b64) for
// one reason only: so it can't be read by accident while the review is still
// open. It is not a secret - `base64 -d` reveals it - it just shouldn't be
// glanced at before the answers are in.
//
// Usage: node analysis/build-case-review.js <events.json> [outdir]

const fs = require('fs')
const path = require('path')

const EXCURSION_ATR_GRID = [1, 1.5, 2, 3, 4, 5, 6, 8, 10, 12, 15, 20, 25, 30]
const STOP_GRID_INDEX = 3 // 3 x ATR(1m)
const WINDOW_START_MIN = 9 * 60 + 35
const WINDOW_END_MIN = 11 * 60 + 30
const RAN_POINTS = 100
const STOP_FAST_BARS = 12
const WANT = { ran: 7, stopfast: 6, nowhere: 7 }
const SEED = 987654321

function nyParts(iso) {
  const s = new Date(iso).toLocaleString('en-US', {
    timeZone: 'America/New_York',
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
  const [date, time] = s.split(', ')
  const [hh, mm] = time.split(':').map(Number)
  return { date, time, minutes: hh * 60 + mm }
}

function classify(event) {
  const stopBar = event.adv[STOP_GRID_INDEX]
  const stopped = stopBar !== null && stopBar !== undefined
  let bestRung = -1
  for (let k = 0; k < EXCURSION_ATR_GRID.length; k++) {
    const touch = event.fav[k]
    if (touch === null || touch === undefined) continue
    if (!stopped || touch < stopBar) bestRung = k
  }
  const favourablePoints = bestRung >= 0 ? EXCURSION_ATR_GRID[bestRung] * event.atr1m : 0
  let cls
  if (favourablePoints >= RAN_POINTS) cls = 'ran'
  else if (stopped && stopBar <= STOP_FAST_BARS && favourablePoints < 1.5 * event.atr1m) cls = 'stopfast'
  else cls = 'nowhere'
  return { cls, favourablePoints, stopBar: stopped ? stopBar : null, stopPoints: STOP_GRID_INDEX >= 0 ? EXCURSION_ATR_GRID[STOP_GRID_INDEX] * event.atr1m : null }
}

function shuffler(seed) {
  let s = seed
  const rnd = () => {
    s = (s * 1103515245 + 12345) % 2147483648
    return s / 2147483648
  }
  return (list) => {
    const out = list.slice()
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1))
      ;[out[i], out[j]] = [out[j], out[i]]
    }
    return out
  }
}

function main() {
  const eventsPath = process.argv[2]
  const outDir = process.argv[3] || path.dirname(__filename)
  if (!eventsPath) {
    console.error('usage: node analysis/build-case-review.js <events.json> [outdir]')
    process.exit(1)
  }
  const events = JSON.parse(fs.readFileSync(eventsPath, 'utf8'))
  const shuffle = shuffler(SEED)

  const pool = []
  for (const event of events) {
    if (event.levelType !== 'poc5') continue
    const when = nyParts(event.time)
    if (when.minutes < WINDOW_START_MIN || when.minutes > WINDOW_END_MIN) continue
    const outcome = classify(event)
    pool.push({
      date: when.date,
      time: when.time,
      direction: event.direction,
      entry: event.entry,
      class: outcome.cls,
      favourablePoints: Math.round(outcome.favourablePoints),
      stopBar: outcome.stopBar,
      stopPoints: Math.round(outcome.stopPoints),
    })
  }

  const buckets = { ran: [], stopfast: [], nowhere: [] }
  for (const row of pool) buckets[row.class].push(row)

  const usedDates = new Set()
  const picked = []
  for (const cls of Object.keys(WANT)) {
    let taken = 0
    for (const row of shuffle(buckets[cls])) {
      if (taken >= WANT[cls]) break
      if (usedDates.has(row.date)) continue
      usedDates.add(row.date)
      picked.push(row)
      taken++
    }
    if (taken < WANT[cls]) console.error(`warning: only ${taken}/${WANT[cls]} available for "${cls}"`)
  }

  const key = shuffle(picked).map((row, i) => ({ n: i + 1, ...row }))
  const blind = key.map((row) => ({ n: row.n, date: row.date, time: row.time }))

  fs.writeFileSync(path.join(outDir, 'case-review-blind.json'), `${JSON.stringify(blind, null, 1)}\n`)
  fs.writeFileSync(
    path.join(outDir, 'case-review-key.b64'),
    `${Buffer.from(`${JSON.stringify(key, null, 1)}\n`).toString('base64').replace(/(.{100})/g, '$1\n')}\n`
  )

  const counts = Object.fromEntries(Object.entries(buckets).map(([k, v]) => [k, v.length]))
  console.log(`pool: ${pool.length} events in window`, counts)
  console.log(`wrote ${blind.length} blind cases and a sealed key to ${outDir}`)
}

main()
