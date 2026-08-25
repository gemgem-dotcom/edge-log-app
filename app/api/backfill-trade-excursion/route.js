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
// for the full picture (the embargo, the three market_data_status values).
import { createClient } from '@supabase/supabase-js'
import { fetchOhlcv1m, NQ_CONTINUOUS_SYMBOL } from '@/lib/databento'
import { excursionWindow, computeExcursion, isEmbargoError, deriveFillInstants, sliceBarsForWindow, FILL_SEARCH_PAD_MINUTES } from '@/lib/tradeExcursions'

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

export async function POST(req) {
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

  // Padded well beyond findFillInstant's own ±1-minute search margin, so
  // this fetch's start/end boundary handling can never be the reason a bar
  // the search actually needs gets clipped - see FILL_SEARCH_PAD_MINUTES.
  const padMs = FILL_SEARCH_PAD_MINUTES * 60000
  let bars
  try {
    bars = await fetchOhlcv1m({
      symbol: NQ_CONTINUOUS_SYMBOL,
      start: new Date(rawWindow.entryInstant.getTime() - padMs).toISOString(),
      end: new Date(rawWindow.exitInstant.getTime() + padMs).toISOString(),
    })
  } catch (err) {
    if (isEmbargoError(err)) {
      await admin.from('trades').update({ market_data_status: 'pending' }).eq('id', tradeId)
      return json({ status: 'pending' })
    }
    await admin.from('trades').update({ market_data_status: 'unavailable' }).eq('id', tradeId)
    return json({ status: 'unavailable', reason: err.message })
  }

  if (bars.length === 0) {
    await admin.from('trades').update({ market_data_status: 'unavailable' }).eq('id', tradeId)
    return json({ status: 'unavailable', reason: 'no bars returned' })
  }

  const { entryInstant, exitInstant, usedFallback } = deriveFillInstants({ rawWindow, entryPrice: trade.entry, bars })
  const windowBars = sliceBarsForWindow(bars, entryInstant, exitInstant)
  if (windowBars.length === 0) {
    await admin.from('trades').update({ market_data_status: 'unavailable' }).eq('id', tradeId)
    return json({ status: 'unavailable', reason: 'no bars in derived window' })
  }

  const { mfePoints, maePoints, drawdownSeconds } = computeExcursion({ bars: windowBars, entry: trade.entry, direction: trade.direction })
  await admin.from('trades').update({
    mfe_points: mfePoints,
    mae_points: maePoints,
    drawdown_seconds: drawdownSeconds,
    market_data_status: 'complete',
    excursion_fallback: usedFallback,
  }).eq('id', tradeId)

  return json({ status: 'complete', usedFallback })
}
