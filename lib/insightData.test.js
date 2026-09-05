import { describe, it, expect } from 'vitest'
import { strategyInsightData } from './insightData'

// Everything these functions return is handed straight to Claude and comes
// back as prose the trader reads as fact, so the two things worth pinning
// are: a number the UI itself refuses to display must never reach the model,
// and a statistic that is 0 purely by construction must not be presented as
// a measurement.

function trade(over = {}) {
  return {
    r_multiple: 1,
    session: 'ny_am',
    trade_date: '2026-03-02',
    trade_time: '09:30:00',
    exit_time: '10:00:00',
    stop_distance: 10,
    mfe_points: 20,
    mae_points: 5,
    drawdown_seconds: 60,
    market_data_status: 'complete',
    excursion_fallback: false,
    discipline_tags: [],
    ...over,
  }
}

describe('excursion data handed to the model', () => {
  it('includes a verified excursion', () => {
    const out = strategyInsightData([trade()], 'S')
    expect(out.excursion).not.toBeNull()
    expect(out.excursion.sampleSize).toBe(1)
    expect(out.excursion.avgMfeR).toBeCloseTo(2, 10) // 20 points / 10 point stop
  })

  // The UI shows "Unverified" for exactly this row (excursionCell in
  // components/TradeLogTable.js). It must not be averaged into advice
  // either - a known real trade carries mae_points +170 against a 55 point
  // stop, which is physically impossible and worth 3.09R on its own.
  it('excludes an unverified fill, even when the numbers are present', () => {
    expect(strategyInsightData([trade({ excursion_fallback: true })], 'S').excursion).toBeNull()
  })

  it('excludes a trade whose market data never completed', () => {
    expect(strategyInsightData([trade({ market_data_status: 'pending' })], 'S').excursion).toBeNull()
    expect(strategyInsightData([trade({ market_data_status: null })], 'S').excursion).toBeNull()
  })

  it('averages only the verified rows when a set is mixed', () => {
    const out = strategyInsightData([
      trade({ mfe_points: 20 }),
      trade({ mfe_points: 400, excursion_fallback: true }),
    ], 'S')
    expect(out.excursion.sampleSize).toBe(1)
    expect(out.excursion.avgMfeR).toBeCloseTo(2, 10)
  })
})

describe('loss-only breakdowns', () => {
  const losses = [
    trade({ r_multiple: -1, session: 'ny_am' }),
    trade({ r_multiple: -1.2, session: 'ny_am' }),
  ]

  // Over a set already filtered to losses these are 0 and 0 by definition.
  // Sending them invited "your NY AM win rate is 0%" as a finding.
  it('omit winRate and profitFactor, which would be 0 by construction', () => {
    const out = strategyInsightData(losses, 'S')
    expect(out.lossesBySession.length).toBeGreaterThan(0)
    for (const row of [...out.lossesBySession, ...out.lossesByDayOfWeek]) {
      expect(row).not.toHaveProperty('winRate')
      expect(row).not.toHaveProperty('profitFactor')
      expect(row).toHaveProperty('sampleSize')
      expect(row).toHaveProperty('avgR')
    }
  })

  // The unfiltered breakdowns still carry a real, meaningful win rate.
  it('are the only breakdowns with it stripped', () => {
    const out = strategyInsightData([trade({ r_multiple: 1 }), trade({ r_multiple: -1 })], 'S')
    expect(out.bySession[0]).toHaveProperty('winRate')
    expect(out.overall).toHaveProperty('winRate')
  })
})
