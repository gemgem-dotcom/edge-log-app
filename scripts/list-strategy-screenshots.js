#!/usr/bin/env node

// Diagnostic / research script - NOT part of the app's runtime, NOT
// scheduled. Run manually via the "Run a diagnostic script" GitHub Action.
//
// Prints one JSON line per trade logged under one strategy (STRATEGY_NAME,
// scoped to one instrument's INSTRUMENT_SYMBOL), each carrying a short-
// lived signed URL for every screenshot attached to that trade - so the
// actual charts behind a strategy's trades can be reviewed directly,
// alongside the numeric market-context pulled by
// scripts/pull-strategy-market-context.js.
//
// SECURITY NOTE - read before running this: unlike the app itself (which
// signs a screenshot URL only when the owning user is logged in and
// rendering it, per lib/screenshots.js/storage-setup.sql's whole private-
// bucket design), this script signs every URL up front and writes them
// into the GitHub Actions job log. That log is readable by anyone with
// read access to this repository for as long as it's retained - the URLs
// themselves expire (SIGNED_URL_EXPIRY_SECONDS below), but the fact that
// they were reachable during that window is a real, if narrow, exposure
// of otherwise-private trade screenshots. Only run this with the trade
// owner's explicit go-ahead, and only for a strategy/user they've chosen.
//
// This is a data-gathering step, not a finished indicator: it does not
// write anything back to Supabase or anywhere else, and does not touch
// the images themselves - just the storage paths already on each trade.
//
// Deliberately standalone rather than importing lib/screenshots.js - this
// repo has no "type": "module" in package.json, so that file's `export`/
// `import` syntax isn't reliably loadable from a plain `node scripts/...`
// invocation (same reason scripts/fetch-daily-market-stats.js already
// duplicates similar logic instead of importing from lib/).
//
// Usage: node scripts/list-strategy-screenshots.js
// Env: SUPABASE_SERVICE_ROLE_KEY, NEXT_PUBLIC_SUPABASE_URL,
//      STRATEGY_NAME, INSTRUMENT_SYMBOL, USER_EMAIL

const { createClient } = require('@supabase/supabase-js')

// Long enough to comfortably survive "run the workflow, then come back and
// read the log a few minutes later," short enough that the exposure
// described above is bounded rather than open-ended.
const SIGNED_URL_EXPIRY_SECONDS = 60 * 60

function log(...args) {
  console.error(new Date().toISOString(), ...args)
}

async function findUserIdByEmail(admin, email) {
  let page = 1
  const perPage = 1000
  for (;;) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage })
    if (error) throw error
    const match = data.users.find((u) => u.email?.toLowerCase() === email.toLowerCase())
    if (match) return match
    if (data.users.length < perPage) return null
    page++
  }
}

// A trade's screenshot paths, newest-shape first - screenshot_urls (array)
// is what every current trade writes; screenshot_url (singular) is the
// pre-migration legacy column, still readable on a trade whose backfill
// (schema.sql's own one-time update) never ran. Same fallback order
// lib/screenshots.js's callers use.
function screenshotPathsFor(trade) {
  if (trade.screenshot_urls && trade.screenshot_urls.length > 0) return trade.screenshot_urls
  if (trade.screenshot_url) return [trade.screenshot_url]
  return []
}

// A legacy path can already be a full http(s) URL (pre-migration objects,
// same distinction lib/screenshots.js's getScreenshotUrls draws) - signing
// one of those would fail, so it's passed through unchanged instead.
//
// The URL comes back base64-encoded, not plain - GitHub Actions
// automatically masks any log line containing the literal value of a
// secret it has in scope, and every signed URL's origin is exactly
// NEXT_PUBLIC_SUPABASE_URL (also a secret here), so a plain signedUrl
// printed to the job log comes back as "***" and is unrecoverable from
// there. Base64 never contains that literal substring, so it survives the
// log and is decoded back on the reading end instead.
async function signPath(admin, path) {
  if (/^https?:\/\//.test(path)) return { path, signedUrlBase64: Buffer.from(path).toString('base64'), legacy: true }
  const { data, error } = await admin.storage.from('screenshots').createSignedUrl(path, SIGNED_URL_EXPIRY_SECONDS)
  if (error || !data?.signedUrl) return { path, signedUrlBase64: null, error: error?.message || 'no signed URL returned' }
  return { path, signedUrlBase64: Buffer.from(data.signedUrl).toString('base64') }
}

async function main() {
  const strategyName = process.env.STRATEGY_NAME || 'HVZ rejection'
  const instrumentSymbol = process.env.INSTRUMENT_SYMBOL || 'NQ'
  const userEmail = process.env.USER_EMAIL
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl || !serviceKey) throw new Error('NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set')
  if (!userEmail) throw new Error('USER_EMAIL is not set')

  const admin = createClient(supabaseUrl, serviceKey)

  const user = await findUserIdByEmail(admin, userEmail)
  if (!user) throw new Error(`No user found for email ${userEmail}`)
  log(`User ${userEmail} -> ${user.id}`)

  const { data: instrument, error: instrumentError } = await admin
    .from('instruments')
    .select('id, symbol')
    .eq('user_id', user.id)
    .eq('symbol', instrumentSymbol)
    .maybeSingle()
  if (instrumentError) throw instrumentError
  if (!instrument) throw new Error(`No instrument ${instrumentSymbol} for this user`)

  const { data: strategy, error: strategyError } = await admin
    .from('strategies')
    .select('id, name')
    .eq('instrument_id', instrument.id)
    .eq('name', strategyName)
    .maybeSingle()
  if (strategyError) throw strategyError
  if (!strategy) throw new Error(`No strategy "${strategyName}" for ${instrumentSymbol}`)

  const { data: trades, error: tradesError } = await admin
    .from('trades')
    .select('id, trade_date, trade_time, direction, r_multiple, screenshot_urls, screenshot_url')
    .eq('strategy_id', strategy.id)
    .order('trade_date', { ascending: true })
  if (tradesError) throw tradesError
  if (!trades || trades.length === 0) {
    log(`No trades found under "${strategyName}" (${instrumentSymbol}).`)
    return
  }

  let tradesWithScreenshots = 0
  let totalScreenshots = 0

  for (const trade of trades) {
    const paths = screenshotPathsFor(trade)
    if (paths.length === 0) continue

    const signed = await Promise.all(paths.map((p) => signPath(admin, p)))
    tradesWithScreenshots++
    totalScreenshots += signed.length

    console.log('TRADE_SCREENSHOTS:' + JSON.stringify({
      tradeId: trade.id,
      tradeDate: trade.trade_date,
      tradeTime: trade.trade_time,
      direction: trade.direction,
      rMultiple: trade.r_multiple,
      screenshots: signed,
    }))
  }

  console.log('SUMMARY:' + JSON.stringify({
    strategyName,
    instrumentSymbol,
    totalTrades: trades.length,
    tradesWithScreenshots,
    totalScreenshots,
    signedUrlExpirySeconds: SIGNED_URL_EXPIRY_SECONDS,
  }))
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
