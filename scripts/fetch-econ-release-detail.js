#!/usr/bin/env node

// Fills econ_release_detail from api.bls.gov, and records any revision it
// finds on the way through.
//
// WHY THE API AND NOT A PAGE. Every path on www.bls.gov answers 403 to an
// honest User-Agent, and so does the whole of download.bls.gov - a
// different host whose entire purpose is serving bulk files. Both were
// measured, twice, by scripts/probe-econ-sources.js. The API is the only
// route the agency leaves open, and it is the one they publish FOR
// programmatic use. api.bls.gov/robots.txt disallows all agents; that is
// a crawling directive rather than a statement about the API, and taking
// it that way was an explicit decision - the reasoning is in that probe
// script's header, including that it was the repo owner's call.
//
// CONDUCT, since that decision was taken. One request per series per run,
// v2 GET without a registered key (confirmed working on 2026-10-28), an
// honest User-Agent, a gap between requests, and a schedule measured in
// days. Nothing a user does on the dashboard reaches BLS: the card reads
// this table, never the API. If that stops being true, this comment is
// the thing that was broken.
//
// WHAT IT WRITES. One row per (series_id, year, period) in
// econ_release_detail, upserted - so a restated month overwrites in place
// and the table always reflects what BLS currently says. Before that
// overwrite happens, the incoming values are compared against what is
// already stored, and anything that MOVED is written to
// econ_release_revision first. That order matters: once the detail row is
// overwritten the old value is gone, so the comparison has exactly one
// chance to happen.
//
// Env: SUPABASE_SERVICE_ROLE_KEY, NEXT_PUBLIC_SUPABASE_URL
// Usage: node scripts/fetch-econ-release-detail.js

const { createClient } = require('@supabase/supabase-js')

const API = 'https://api.bls.gov/publicAPI/v2/timeseries/data'
const UA = 'EdgeLog/1.0 (trading journal; +https://github.com/gemgem-dotcom/edge-log-app)'
const GAP_MS = 1500
const TIMEOUT_MS = 20000

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function fetchSeries(seriesId) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(`${API}/${seriesId}`, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
      signal: ctrl.signal,
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}

async function main() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl || !serviceKey) {
    throw new Error('NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set')
  }
  const supabase = createClient(supabaseUrl, serviceKey)

  const { SERIES, parseSeriesResponse, monthlyDesc, revisionsBetween } = await import('../lib/econSeries.mjs')
  const ids = Object.keys(SERIES)
  console.log(`Fetching ${ids.length} series from api.bls.gov`)

  let written = 0
  let revisions = 0

  for (const seriesId of ids) {
    let parsed
    try {
      parsed = parseSeriesResponse(await fetchSeries(seriesId))
    } catch (err) {
      // One series failing is not a reason to lose the others. The table
      // keeps whatever it already had for this id.
      console.error(`  ${seriesId}: fetch failed - ${err.message}`)
      await sleep(GAP_MS)
      continue
    }
    if (!parsed || !parsed[seriesId]) {
      console.error(`  ${seriesId}: request did not succeed`)
      await sleep(GAP_MS)
      continue
    }

    const rows = monthlyDesc(parsed[seriesId])
    if (!rows.length) {
      console.error(`  ${seriesId}: no monthly observations`)
      await sleep(GAP_MS)
      continue
    }

    // Read what we already hold BEFORE upserting over it - this is the
    // only moment the previous values still exist.
    const { data: stored, error: readErr } = await supabase
      .from('econ_release_detail')
      .select('year, period, period_name, value')
      .eq('series_id', seriesId)
    if (readErr) throw new Error(`Supabase read failed: ${readErr.message}`)

    const found = revisionsBetween(
      (stored || []).map((r) => ({ year: r.year, period: r.period, periodName: r.period_name, value: r.value })),
      rows,
    )
    if (found.length) {
      const { error } = await supabase.from('econ_release_revision').insert(
        found.map((r) => ({
          series_id: seriesId,
          year: r.year,
          period: r.period,
          period_name: r.periodName,
          value_from: r.from,
          value_to: r.to,
        })),
      )
      if (error) throw new Error(`Supabase revision insert failed: ${error.message}`)
      revisions += found.length
      for (const r of found) {
        console.log(`  ${seriesId}: ${r.periodName || r.period} ${r.year} revised ${r.from} -> ${r.to} (${r.delta > 0 ? '+' : ''}${r.delta})`)
      }
    }

    const now = new Date().toISOString()
    const { error: upErr } = await supabase.from('econ_release_detail').upsert(
      rows.map((r) => ({
        series_id: seriesId,
        year: r.year,
        period: r.period,
        period_name: r.periodName,
        value: Number(r.value),
        footnote_codes: (r.footnotes || []).map((f) => f.code).filter(Boolean),
        fetched_at: now,
      })),
      { onConflict: 'series_id,year,period' },
    )
    if (upErr) throw new Error(`Supabase upsert failed: ${upErr.message}`)

    written += rows.length
    console.log(`  ${seriesId}: ${rows.length} observations, latest ${rows[0].periodName || rows[0].period} ${rows[0].year} = ${rows[0].value}`)
    await sleep(GAP_MS)
  }

  console.log(`\n${written} observations written, ${revisions} revisions recorded.`)
}

main().catch((err) => {
  console.error('fetch-econ-release-detail failed:', err)
  process.exit(1)
})
