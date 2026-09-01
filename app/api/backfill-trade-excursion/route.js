// Computes and stores MFE/MAE/drawdown for one trade - server only, since
// it needs DATABENTO_API_KEY (never exposed to the browser) and writes
// past RLS with SUPABASE_SERVICE_ROLE_KEY, the same pattern the other two
// routes in app/api/ already use. Called fire-and-forget from the trade
// save/edit flows (app/app/[instrument]/log/new/page.js and .../edit/
// page.js) right after a successful write - never blocks the trade save
// itself, and always recomputes fresh rather than checking prior status,
// so an edit that changes entry/exit correctly overwrites stale values.
//
// See schema.sql's comment above `mfe_points` and lib/tradeExcursions.js
// for the full picture (the embargo, the three market_data_status values,
// and why this reads real trade prints via fetchTrades rather than
// ohlcv-1m bars).
import { createClient } from '@supabase/supabase-js'
import * as Sentry from '@sentry/nextjs'
import { fetchTrades, NQ_CONTINUOUS_SYMBOL, isNearRollover, sessionBoundsFor, resolveFrontMonthByVolume } from '@/lib/databento'
import { excursionWindow, computeExcursion, isEmbargoError, deriveFillTicks, sliceTicksForWindow, deriveVerifiedTimes, instantToWallClockTime, FILL_SEARCH_PAD_MINUTES } from '@/lib/tradeExcursions'

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

// Thin wrapper so an unexpected throw anywhere in handlePost - a Supabase
// outage, a bug in the fill-matching math, anything not already one of the
// deliberately-handled embargo/transient-fetch paths below - gets reported
// rather than silently producing a bare 500 with nothing recorded anywhere.
// The deliberately-handled paths (embargo, transient fetch failure, zero
// ticks) are NOT routed through here - those are expected operating states
// (see NOTES.md), not bugs, and would just be noise in Sentry.
export async function POST(req) {
  try {
    return await handlePost(req)
  } catch (err) {
    Sentry.captureException(err)
    return json({ error: err?.message || 'Could not backfill trade excursion.' }, 500)
  }
}

async function handlePost(req) {
  const authHeader = req.headers.get('authorization') || ''
  const token = authHeader.replace('Bearer ', '').trim()
  if (!token) return json({ error: 'Not authenticated' }, 401)

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  const admin = createClient(supabaseUrl, serviceKey)

  const { data: userData, error: userError } = await admin.auth.getUser(token)
  if (userError || !userData?.user) return json({ error: 'Invalid session' }, 401)

  const { tradeId } = await req.json().catch(() => ({}))
  if (!tradeId) return json({ error: 'tradeId required' }, 400)

  const { data: trade } = await admin.from('trades').select('*').eq('id', tradeId).eq('user_id', userData.user.id).single()
  if (!trade) return json({ error: 'Trade not found' }, 404)

  const { data: instrument } = await admin.from('instruments').select('data_symbol').eq('id', trade.instrument_id).single()
  // Only NQ-family instruments have a Databento symbol resolved anywhere in
  // this app (lib/databento.js is hardcoded to NQ.c.0) - a trade on
  // anything else is a genuine, permanent miss, not a "try later" case.
  if (instrument?.data_symbol !== 'NQ') {
    await admin.from('trades').update({ market_data_status: 'unavailable' }).eq('id', tradeId)
    return json({ status: 'unavailable', reason: 'unsupported instrument' })
  }

  const timezoneOffset = parseFloat(userData.user.user_metadata?.timezone)
  const rawWindow = Number.isNaN(timezoneOffset) ? null : excursionWindow(trade, timezoneOffset)
  if (!rawWindow) {
    await admin.from('trades').update({ market_data_status: 'unavailable' }).eq('id', tradeId)
    return json({ status: 'unavailable', reason: 'no timezone or exit window' })
  }

  // Padding around the logged instants - see FILL_SEARCH_PAD_MINUTES.
  const padMs = FILL_SEARCH_PAD_MINUTES * 60000

  // Within ROLL_PROXIMITY_DAYS of a quarterly roll, NQ_CONTINUOUS_SYMBOL's
  // own resolution was confirmed (live, PR #122) to disagree with which
  // contract actually traded that session - resolve by volume instead in
  // that window. Outside it, trust the continuous symbol as before; if
  // volume resolution itself comes up empty, fall back to the continuous
  // symbol too rather than fail the trade over this.
  let symbol = NQ_CONTINUOUS_SYMBOL
  let stypeIn = 'continuous'
  if (isNearRollover(instrument.data_symbol, trade.trade_date)) {
    const { start: sessionStart, end: sessionEnd } = sessionBoundsFor(rawWindow.entryInstant)
    const frontMonthId = await resolveFrontMonthByVolume({ sessionStart, sessionEnd })
    if (frontMonthId !== null) {
      symbol = String(frontMonthId)
      stypeIn = 'instrument_id'
    }
  }

  let ticks
  try {
    ticks = await fetchTrades({
      symbol,
      stypeIn,
      start: new Date(rawWindow.entryInstant.getTime() - padMs).toISOString(),
      end: new Date(rawWindow.exitInstant.getTime() + padMs).toISOString(),
    })
  } catch (err) {
    if (isEmbargoError(err)) {
      await admin.from('trades').update({ market_data_status: 'pending' }).eq('id', tradeId)
      return json({ status: 'pending' })
    }
    // A fetch-level failure here (network hiccup, transient 5xx, rate
    // limit) isn't reliably distinguishable from isEmbargoError's own two
    // known cases without deeper Databento-specific error taxonomy -
    // default to retryable rather than silently and permanently
    // discarding data that's actually recoverable (confirmed happened to
    // a real trade - see NOTES.md). The hourly retry job
    // (scripts/retry-trade-excursions.js) picks 'pending' rows back up;
    // the deterministic misses above (unsupported instrument, no
    // timezone/window) are genuinely permanent and still go straight to
    // 'unavailable'.
    await admin.from('trades').update({ market_data_status: 'pending' }).eq('id', tradeId)
    return json({ status: 'pending', reason: err.message })
  }

  // A real NQ session window this narrow (roughly the trade's own
  // duration ± FILL_SEARCH_PAD_MINUTES) essentially never has zero real
  // trade prints during market hours - every trade checked this way so
  // far has had thousands. Confirmed live: a trade that returned zero
  // ticks here once resolved cleanly (24k+ ticks, clean fill match) on a
  // simple re-fetch of the exact same window moments later - the same
  // "transient, not deterministic" lesson the fetch-error handling above
  // already learned, just for a successful-but-empty response instead of
  // a thrown error. Left 'pending' for the hourly retry rather than
  // marked 'unavailable', so a Databento hiccup can't permanently discard
  // data that's actually there.
  if (ticks.length === 0) {
    await admin.from('trades').update({ market_data_status: 'pending' }).eq('id', tradeId)
    return json({ status: 'pending', reason: 'no trade prints returned' })
  }

  const { entryInstant, exitInstant, usedFallback } = deriveFillTicks({ rawWindow, entryPrice: trade.entry, ticks })
  const windowTicks = sliceTicksForWindow(ticks, entryInstant, exitInstant)
  if (windowTicks.length === 0) {
    await admin.from('trades').update({ market_data_status: 'pending' }).eq('id', tradeId)
    return json({ status: 'pending', reason: 'no trade prints in derived window' })
  }

  const { mfePoints, maePoints, drawdownSeconds } = computeExcursion({
    ticks: windowTicks,
    entry: trade.entry,
    direction: trade.direction,
  })

  // Separate, stricter minute-bounded search over the same already-fetched
  // `ticks` - see deriveVerifiedTimes for why this can't just reuse
  // entryInstant/exitInstant above. Only overwrites a field whose logged
  // price actually verified against a real print in its own logged
  // minute; anything that didn't stays exactly as logged, flagged via
  // trade_time_unverified for the trader to double-check.
  const verifiedTimes = deriveVerifiedTimes({ rawWindow, entryPrice: trade.entry, ticks })
  const correctedTradeTime = verifiedTimes.entry.matched
    ? instantToWallClockTime(verifiedTimes.entry.instant, timezoneOffset)
    : trade.trade_time
  const correctedExitTime = verifiedTimes.legs[0]?.matched
    ? instantToWallClockTime(verifiedTimes.legs[0].instant, timezoneOffset)
    : trade.exit_time
  const correctedAdditionalExits = (trade.additional_exits || []).map((exit, i) => {
    const legFill = verifiedTimes.legs[i + 1]
    return legFill?.matched ? { ...exit, exit_time: instantToWallClockTime(legFill.instant, timezoneOffset) } : exit
  })

  await admin.from('trades').update({
    mfe_points: mfePoints,
    mae_points: maePoints,
    drawdown_seconds: drawdownSeconds,
    market_data_status: 'complete',
    excursion_fallback: usedFallback,
    trade_time: correctedTradeTime,
    exit_time: correctedExitTime,
    additional_exits: correctedAdditionalExits,
    trade_time_unverified: verifiedTimes.anyUnverified,
  }).eq('id', tradeId)

  return json({ status: 'complete', usedFallback, timeUnverified: verifiedTimes.anyUnverified })
}
