#!/usr/bin/env node

// Safeguard for the "duplicate rather than import" choice in
// scripts/retry-trade-excursions.js's WELFORD MATH section: runs both
// copies of buildExcursionRow (the real one in lib/edgeBeliefs.js, and
// the standalone duplicate in the retry script) against the same set of
// representative inputs and fails if they ever disagree. Catches a
// forgotten mirror edit at CI time, on the PR that introduced it, rather
// than as a silent, hard-to-notice divergence in production depending on
// which of the two backfill paths (the instant route vs. the hourly
// retry) happened to touch a given trade.
//
// Usage: node scripts/check-excursion-math-parity.js

async function main() {
  const { buildExcursionRow: realBuildExcursionRow, PSEUDO_COUNT: realPseudoCount } = await import('../lib/edgeBeliefs.js')
  const { buildExcursionRow: dupBuildExcursionRow, PSEUDO_COUNT: dupPseudoCount } = require('./retry-trade-excursions.js')

  const failures = []

  function check(label, args) {
    const a = realBuildExcursionRow(...args)
    const b = dupBuildExcursionRow(...args)
    const aStr = JSON.stringify(a)
    const bStr = JSON.stringify(b)
    if (aStr !== bStr) {
      failures.push(`${label}:\n  lib/edgeBeliefs.js  -> ${aStr}\n  retry script copy   -> ${bStr}`)
    }
  }

  if (realPseudoCount !== dupPseudoCount) {
    failures.push(`PSEUDO_COUNT mismatch: lib/edgeBeliefs.js=${realPseudoCount} retry script=${dupPseudoCount}`)
  }

  const nowIso = '2026-01-01T00:00:00.000Z'
  const parentWithData = { mfe_r_mean: 1.2, mae_r_mean: -0.3, drawdown_seconds_mean: 45 }
  const tradeWithExcursion = { mfe_points: 24, mae_points: -6, drawdown_seconds: 90, stop_distance: 12 }
  const tradeNoExcursion = { mfe_points: null, mae_points: null, drawdown_seconds: null, stop_distance: 12 }
  const existingFresh = { user_id: 'u1', slice_key: 'overall', excursion_n: 0, mfe_r_mean: 0, mfe_r_m2: 0, mae_r_mean: 0, mae_r_m2: 0, drawdown_seconds_mean: 0, drawdown_seconds_m2: 0 }
  const existingPopulated = { user_id: 'u1', slice_key: 'overall', excursion_n: 3, mfe_r_mean: 1.8, mfe_r_m2: 2.1, mae_r_mean: -0.5, mae_r_m2: 0.4, drawdown_seconds_mean: 60, drawdown_seconds_m2: 500 }
  const existingOneReal = { user_id: 'u1', slice_key: 'overall', excursion_n: 1, mfe_r_mean: 0.5, mfe_r_m2: 0.1, mae_r_mean: -0.2, mae_r_m2: 0.05, drawdown_seconds_mean: 30, drawdown_seconds_m2: 10 }

  check('brand-new row, seeded from a real parent, add', [existingFresh, parentWithData, tradeWithExcursion, 1, nowIso])
  check('brand-new row, no parent, add', [existingFresh, null, tradeWithExcursion, 1, nowIso])
  check('existing populated row, add', [existingPopulated, null, tradeWithExcursion, 1, nowIso])
  check('existing row with one real contribution, remove (should revert to seed)', [existingOneReal, parentWithData, tradeWithExcursion, -1, nowIso])
  check('existing row at excursion_n=0, remove (nothing to remove)', [existingFresh, parentWithData, tradeWithExcursion, -1, nowIso])
  check('no existing row at all', [null, parentWithData, tradeWithExcursion, 1, nowIso])
  check('trade with no excursion data', [existingPopulated, parentWithData, tradeNoExcursion, 1, nowIso])

  if (failures.length > 0) {
    console.error('Excursion math parity check FAILED - lib/edgeBeliefs.js and scripts/retry-trade-excursions.js have drifted apart:\n')
    console.error(failures.join('\n\n'))
    process.exit(1)
  }

  console.log(`Excursion math parity check passed (${7} scenarios, PSEUDO_COUNT=${realPseudoCount}).`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
