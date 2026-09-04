'use client'

import { useState, useEffect, use } from 'react'
import Link from 'next/link'
import { Plus } from 'lucide-react'
import { supabase } from '@/lib/supabaseClient'
import { catalogEntryFor } from '@/lib/instrumentCatalog'
import { usePageTitle } from '@/lib/usePageTitle'
import { fetchTradePage, fetchDistinctTags, EMPTY_FILTERS } from '@/lib/tradeQuery'
import TradeLogTable from '@/components/TradeLogTable'
import TradeLogSkeleton from '@/components/TradeLogSkeleton'
import EmptyState from '@/components/EmptyState'
import PageError from '@/components/PageError'

// Real DB-side pagination and filtering (lib/tradeQuery.js) rather than
// fetching every trade this instrument has ever logged and slicing it in
// the browser - see the systems-map audit's follow-up on this page's own
// unbounded fetch. `strategies` is still fetched in full (a small,
// per-instrument table); trades are the growing one.
const PAGE_SIZE = 25

export default function LogPage({ params }) {
  usePageTitle('Trade Log')
  const symbol = use(params).instrument
  const displayName = catalogEntryFor(symbol)?.display_name || symbol

  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [strategies, setStrategies] = useState([])
  const [instrumentId, setInstrumentId] = useState(null)
  const [trades, setTrades] = useState([])
  const [totalCount, setTotalCount] = useState(0)
  const [tagOptions, setTagOptions] = useState([])
  const [page, setPage] = useState(0)
  const [filters, setFilters] = useState(EMPTY_FILTERS)

  useEffect(() => {
    loadStatic()
  }, [symbol])

  // Fires on the initial load (once loadStatic resolves instrumentId) and
  // again on every page/filter change - loadStatic deliberately never
  // clears `loading` on its own success path, so the skeleton stays up
  // through both fetches instead of flashing an empty table in between.
  useEffect(() => {
    if (instrumentId) loadPage()
  }, [instrumentId, page, filters])

  async function loadStatic() {
    setLoading(true)
    setError(null)
    try {
      const { data: { user } } = await supabase.auth.getUser()
      const { data: instrument } = await supabase
        .from('instruments').select('*').eq('user_id', user.id).eq('symbol', symbol).eq('archived', false).single()
      if (!instrument) { setLoading(false); return }

      const { data: stratData, error: stratError } = await supabase
        .from('strategies').select('*').eq('instrument_id', instrument.id).order('created_at', { ascending: true })
      if (stratError) throw stratError

      setStrategies(stratData || [])
      setPage(0)
      setFilters(EMPTY_FILTERS)
      fetchDistinctTags([instrument.id]).then((tags) => setTagOptions(tags.map((t) => ({ value: t, label: t }))))
      setInstrumentId(instrument.id)
    } catch {
      setError('something went wrong.')
      setLoading(false)
    }
  }

  async function loadPage() {
    setLoading(true)
    setError(null)
    try {
      const { trades: pageTrades, totalCount: count, error: tradeError } = await fetchTradePage({
        instrumentIds: [instrumentId], page, pageSize: PAGE_SIZE, filters,
      })
      if (tradeError) throw tradeError
      setTrades(pageTrades)
      setTotalCount(count)
    } catch {
      setError('something went wrong.')
    } finally {
      setLoading(false)
    }
  }

  if (loading && trades.length === 0 && !error) return <TradeLogSkeleton />
  if (error) return <div className="page-container"><PageError message={`Couldn't load your trades — ${error}`} onRetry={instrumentId ? loadPage : loadStatic} /></div>

  const strategyName = (id) => strategies.find((s) => s.id === id)?.name || '—'

  return (
    <div className="page-container content-fade-in">
      <div className="strategy-header-row">
        <h1 className="page-title">Trade log</h1>
        <Link href={`/app/${symbol}/log/new`} className="new-trade-btn"><Plus size={16} /> Log new trade</Link>
      </div>
      <p className="page-subtitle">All trades logged for {displayName}, across every strategy.</p>

      <div className="panel">
        <TradeLogTable
          trades={trades}
          strategies={strategies}
          strategyNameById={strategyName}
          showStrategyColumn={true}
          showFilters={true}
          symbol={symbol}
          pageSize={PAGE_SIZE}
          remote={{
            filters,
            // Resets page to 0 in the same handler, synchronously - not
            // left for TradeLogTable's own "filters changed, reset page"
            // effect to do a moment later, which would otherwise fire this
            // effect twice in a row (once with the new filters but the
            // still-stale page, once with both corrected) with no
            // guarantee the second, correct fetch's response is the one
            // that actually lands last.
            onFilterChange: (patch) => { setFilters((prev) => ({ ...prev, ...patch })); setPage(0) },
            page,
            totalCount,
            onPageChange: setPage,
            tagOptions,
            onTradeDeleted: loadPage,
          }}
          emptyState={
            <EmptyState
              title="No trades yet"
              message={`No trades logged yet for ${displayName}. Log your first one to start tracking your stats.`}
              actionHref={`/app/${symbol}/log/new`}
              actionLabel="Log new trade"
            />
          }
        />
      </div>
    </div>
  )
}
