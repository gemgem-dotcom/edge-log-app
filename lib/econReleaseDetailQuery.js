'use client'

import { useState, useEffect } from 'react'
import { supabase } from '@/lib/supabaseClient'
import { SERIES, monthlyDesc, monthOverMonth } from '@/lib/econSeries.mjs'

// Reads econ_release_detail / econ_release_revision and reduces them to
// the shape lib/econStructure.mjs wants: seriesId -> a month-on-month
// figure, plus the most recent revision.
//
// THE DASHBOARD NEVER TALKS TO BLS. Everything here is a Supabase read
// against what scripts/fetch-econ-release-detail.js stored on its own
// schedule. That separation is the whole reason the fetcher can promise
// one request per series per day no matter how many people open the page
// - see that script's CONDUCT note.
//
// A missing table is a missing table, not an error worth surfacing. The
// schema change ships in the same PR but has to be run by hand in
// Supabase (CLAUDE.md non-negotiable 4), so between merge and that SQL
// being run every read here fails. The structural line degrades to
// standing methodology in that window, which is still true, so the
// failure is swallowed rather than shown.

// Enough months to see the latest print, its predecessor, and the window
// a revision can land in. Not "all of it": the table grows forever and
// the card reads two rows.
const MONTHS = 8

export async function fetchReleaseDetail() {
  const ids = Object.keys(SERIES)

  const [detail, revisions] = await Promise.all([
    supabase
      .from('econ_release_detail')
      .select('series_id, year, period, period_name, value, footnote_codes')
      .in('series_id', ids)
      .order('year', { ascending: false })
      .order('period', { ascending: false })
      .limit(ids.length * MONTHS),
    // Payrolls only, and deliberately. `detail.revision` is read by the
    // payrolls branch of lib/econStructure.mjs alone, so handing it the
    // newest revision across ALL series would let a CPI restatement be
    // printed as "August payrolls was already revised". Scoped at the
    // query rather than filtered later, so there is no unscoped row in
    // hand to misuse.
    supabase
      .from('econ_release_revision')
      .select('series_id, year, period, period_name, value_from, value_to, detected_at')
      .eq('series_id', 'CES0000000001')
      .order('detected_at', { ascending: false })
      .limit(1),
  ])

  if (detail.error || !Array.isArray(detail.data)) return {}

  const byId = new Map()
  for (const row of detail.data) {
    if (!byId.has(row.series_id)) byId.set(row.series_id, [])
    byId.get(row.series_id).push({
      year: String(row.year),
      period: String(row.period),
      periodName: row.period_name || null,
      value: row.value,
      // footnote_codes is the stored form of what isPreliminary reads off
      // the API's own rows, so it is mapped back to that shape rather than
      // giving the structural module a second thing to understand.
      footnotes: (row.footnote_codes || []).map((code) => ({ code })),
    })
  }

  const out = {}
  for (const [seriesId, rows] of byId) {
    const mom = monthOverMonth(monthlyDesc(rows))
    if (mom) out[seriesId] = mom
  }

  const rev = !revisions.error && revisions.data?.[0]
  if (rev) {
    out.revision = {
      seriesId: rev.series_id,
      year: String(rev.year),
      period: String(rev.period),
      periodName: rev.period_name || null,
      from: Number(rev.value_from),
      to: Number(rev.value_to),
    }
  }

  return out
}

// The hook form, for the two dashboards that render the brief.
//
// It returns `{}` until the read lands, so the structural line starts as
// standing methodology and gains its figures when they arrive, rather
// than the card popping into existence a beat late. No loading flag: a
// spinner over one sentence of a seven-line card is worse than the
// sentence appearing.
export function useEconReleaseDetail() {
  const [detail, setDetail] = useState({})

  useEffect(() => {
    let live = true
    fetchReleaseDetail()
      .then((d) => { if (live) setDetail(d) })
      .catch(() => { if (live) setDetail({}) })
    return () => { live = false }
  }, [])

  return detail
}
