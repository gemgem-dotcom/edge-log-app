'use client'

import { useState, useEffect } from 'react'
import { supabase } from '@/lib/supabaseClient'
import { strategyColor } from '@/lib/strategyColor'
import AppShell from '@/components/AppShell'
import { usePageTitle } from '@/lib/usePageTitle'
import { fetchTradePage, fetchDistinctTags, EMPTY_FILTERS } from '@/lib/tradeQuery'
import TradeLogTable from '@/components/TradeLogTable'
import TradeLogSkeleton from '@/components/TradeLogSkeleton'
import EmptyState from '@/components/EmptyState'
import PageError from '@/components/PageError'

// Real DB-side pagination and filtering (lib/tradeQuery.js) rather than
// fetching every trade across every instrument and slicing it in the
// browser - see app/app/[instrument]/log/page.js's identical comment; this
// page is the same shape, just scoped to every instrument id instead of one.
const PAGE_SIZE = 25

export default function AllTradesPage() {
  usePageTitle('Trade Log')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [instruments, setInstruments] = useState([])
  const [strategies, setStrategies] = useState([])
  const [trades, setTrades] = useState([])
  const [totalCount, setTotalCount] = useState(0)
  const [tagOptions, setTagOptions] = useState([])
  const [page, setPage] = useState(0)
  const [filters, setFilters] = useState(EMPTY_FILTERS)

  useEffect(() => {
    loadStatic()
  }, [])

  // See app/app/[instrument]/log/page.js's identical effect for why
  // loadStatic never clears `loading` on its own success path.
  useEffect(() => {
    if (instruments.length > 0) loadPage()
  }, [instruments, page, filters])

  async function loadStatic() {
    setLoading(true)
    setError(null)
    try {
      const { data: { user } } = await supabase.auth.getUser()
      const { data: instrumentData, error: instError } = await supabase
        .from('instruments').select('*').eq('user_id', user.id).eq('archived', false).order('created_at', { ascending: true })
      if (instError) throw instError
      const ids = (instrumentData || []).map((i) => i.id)

      const { data: stratData, error: stratError } = await supabase
        .from('strategies').select('*').in('instrument_id', ids).eq('archived', false)
        .order('created_at', { ascending: true })
      if (stratError) throw stratError

      setInstruments(instrumentData || [])
      setStrategies(stratData || [])
      setPage(0)
      setFilters(EMPTY_FILTERS)
      if (ids.length > 0) {
        fetchDistinctTags(ids).then((tags) => setTagOptions(tags.map((t) => ({ value: t, label: t }))))
      } else {
        setLoading(false)
      }
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
        instrumentIds: instruments.map((i) => i.id), page, pageSize: PAGE_SIZE, filters,
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

  if (loading && trades.length === 0 && !error) return (
    <AppShell instruments={instruments} strategies={strategies} active="trades">
      <TradeLogSkeleton showInstrumentColumn showHeaderButton={false} />
    </AppShell>
  )
  if (error) {
    return (
      <AppShell instruments={instruments} strategies={strategies} active="trades">
        <div className="page-container"><PageError message={`Couldn't load your trades — ${error}`} onRetry={instruments.length > 0 ? loadPage : loadStatic} /></div>
      </AppShell>
    )
  }

  const instrumentById = {}
  instruments.forEach((inst, i) => { instrumentById[inst.id] = { ...inst, color: strategyColor(i) } })
  const strategyName = (id) => strategies.find((s) => s.id === id)?.name || '—'

  return (
    <AppShell instruments={instruments} strategies={strategies} active="trades">
      <div className="page-container">
        <h1 className="page-title">Trade log</h1>
        <p className="page-subtitle">Every trade you&apos;ve logged, across all instruments.</p>

        <div className="panel">
          <TradeLogTable
            trades={trades}
            strategies={strategies}
            strategyNameById={strategyName}
            showStrategyColumn
            showFilters
            showInstrumentColumn
            instrumentSymbolFor={(t) => instrumentById[t.instrument_id]?.symbol}
            instrumentColorFor={(t) => instrumentById[t.instrument_id]?.color}
            pageSize={PAGE_SIZE}
            remote={{
              filters,
              // See app/app/[instrument]/log/page.js's identical handler
              // for why page resets here, synchronously, rather than
              // relying on TradeLogTable's own filter-changed effect to do
              // it a moment later.
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
                message="Log your first trade to see it here."
                actionHref={instruments[0] ? `/app/${instruments[0].symbol}/log/new` : '/app'}
                actionLabel="Log new trade"
              />
            }
          />
        </div>
      </div>
    </AppShell>
  )
}
