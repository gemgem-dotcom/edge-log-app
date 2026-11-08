'use client'

import { useState, useEffect, useRef } from 'react'
import { supabase } from '@/lib/supabaseClient'
import { strategyColor } from '@/lib/strategyColor'
import AppShell from '@/components/AppShell'
import { usePageTitle } from '@/lib/usePageTitle'
import { fetchTradePage, fetchDistinctTags, EMPTY_FILTERS } from '@/lib/tradeQuery'
import TradeLogTable from '@/components/TradeLogTable'
import { useIsMobile } from '@/lib/useIsMobile'
import MobileTradeList from '@/components/mobile/MobileTradeList'
import MobileFilterSheet, { countActiveFilters } from '@/components/mobile/MobileFilterSheet'
import MobilePager from '@/components/mobile/MobilePager'
import TradeLogSkeleton from '@/components/TradeLogSkeleton'
import EmptyState from '@/components/EmptyState'
import PageError from '@/components/PageError'
import { getInstruments, peekReferenceData } from '@/lib/referenceDataCache'
import { readTradePage, writeTradePage, readLogStrategies, writeLogStrategies } from '@/lib/tradesCache'

// Real DB-side pagination and filtering (lib/tradeQuery.js) rather than
// fetching every trade across every instrument and slicing it in the
// browser - see app/app/[instrument]/log/page.js's identical comment; this
// page is the same shape, just scoped to every instrument id instead of one.
const PAGE_SIZE = 25
// Archived strategies are filtered out of this page's query, unlike the
// per-instrument log's - so the two cannot share a cache key.
const STRATEGIES_VARIANT = 'all-log-unarchived'

export default function AllTradesPage() {
  usePageTitle('Trade Log')
  // Seeded from the last-known page-0 result, so returning to this tab
  // paints the real table on the first frame instead of a skeleton that a
  // round-trip then replaces. Stale-while-revalidate: the loadPage effect
  // below runs regardless and overwrites this, so a stale row lasts one
  // request rather than until a reload - see lib/tradesCache.js.
  //
  // `instruments` has to be seeded in the same breath. The skeleton gate
  // keys on `trades.length === 0`, so seeding rows without the instruments
  // they belong to would render the table with no way to resolve each
  // row's symbol for the instrument column.
  const [warm] = useState(() => {
    const ref = peekReferenceData()
    if (!ref) return null
    const ids = ref.instruments.map((i) => i.id)
    const hit = readTradePage({ instrumentIds: ids, page: 0, pageSize: PAGE_SIZE, filters: EMPTY_FILTERS })
    // BOTH, or neither - each row's strategy name comes from this list,
    // and rows without it paint a column of em-dashes. Read from this
    // page's own cache rather than peekReferenceData's strategies, which
    // are keyed per instrument and may be only partly warm.
    const strats = readLogStrategies(ids, STRATEGIES_VARIANT)
    if (!hit || !strats) return null
    return { instruments: ref.instruments, strategies: strats, ...hit }
  })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [instruments, setInstruments] = useState(warm?.instruments ?? [])
  const [strategies, setStrategies] = useState(warm?.strategies ?? [])
  const [trades, setTrades] = useState(warm?.trades ?? [])
  const [totalCount, setTotalCount] = useState(warm?.totalCount ?? 0)
  const [tagOptions, setTagOptions] = useState([])
  const [page, setPage] = useState(0)
  const [filters, setFilters] = useState(EMPTY_FILTERS)
  const [filtersOpen, setFiltersOpen] = useState(false)
  const isMobile = useIsMobile()

  useEffect(() => {
    loadStatic()
  }, [])

  // See app/app/[instrument]/log/page.js's identical effect for why
  // loadStatic never clears `loading` on its own success path.
  useEffect(() => {
    if (instruments.length > 0) loadPage()
  }, [instruments, page, filters])

  // Identifies the most recent load of each kind - see the identical note in
  // app/app/[instrument]/log/page.js. Clicking Next twice quickly used to
  // leave the earlier page's rows under the later page's pager.
  const staticIdRef = useRef(0)
  const pageIdRef = useRef(0)

  async function loadStatic() {
    const loadId = ++staticIdRef.current
    const superseded = () => loadId !== staticIdRef.current
    setLoading(true)
    setError(null)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const user = session?.user
      if (!user) throw new Error('no session')
      // The sidebar's own cache, so this is a hit on any navigation
      // within /app - see referenceDataCache. Same query as before,
      // same filters and order.
      const instrumentData = await getInstruments(supabase, user.id)
      if (superseded()) return
      const ids = instrumentData.map((i) => i.id)

      // Set BEFORE awaiting the strategies: `instruments` is what the
      // trade-page effect keys on, so the rows and the strategies now
      // load concurrently instead of the table waiting on a dropdown.
      setInstruments(instrumentData)
      setPage(0)
      setFilters(EMPTY_FILTERS)
      if (ids.length > 0) {
        fetchDistinctTags(ids).then((tags) => setTagOptions(tags.map((t) => ({ value: t, label: t }))))
      } else {
        setLoading(false)
      }

      const { data: stratData, error: stratError } = await supabase
        .from('strategies').select('*').in('instrument_id', ids).eq('archived', false)
        .order('created_at', { ascending: true })
      if (stratError) throw stratError
      if (superseded()) return
      setStrategies(stratData || [])
      writeLogStrategies(ids, stratData || [], STRATEGIES_VARIANT)
    } catch {
      if (superseded()) return
      setError('something went wrong.')
      setLoading(false)
    }
  }

  async function loadPage() {
    const loadId = ++pageIdRef.current
    const superseded = () => loadId !== pageIdRef.current
    setLoading(true)
    setError(null)
    try {
      const { trades: pageTrades, totalCount: count, error: tradeError } = await fetchTradePage({
        instrumentIds: instruments.map((i) => i.id), page, pageSize: PAGE_SIZE, filters,
      })
      if (tradeError) throw tradeError
      if (superseded()) return
      setTrades(pageTrades)
      setTotalCount(count)
      writeTradePage({ instrumentIds: instruments.map((i) => i.id), page, pageSize: PAGE_SIZE, filters }, pageTrades, count)
    } catch {
      if (superseded()) return
      setError('something went wrong.')
    } finally {
      if (!superseded()) setLoading(false)
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

        {isMobile ? (
          <>
            {/* Same .panel the desktop table gets - see the
                per-instrument log's copy of this. */}
            <div className="panel m-trade-panel">
            <MobileTradeList
              trades={trades}
              strategyNameById={strategyName}
              // No single symbol on this page - each card resolves its own
              // instrument, and Edit links have to follow the trade rather
              // than a page-level symbol that does not exist here.
              symbol={null}
              instrumentSymbolFor={(t) => instrumentById[t.instrument_id]?.symbol}
              totalCount={totalCount}
              onOpenFilters={() => setFiltersOpen(true)}
              activeFilterCount={countActiveFilters(filters)}
              onTradeDeleted={loadPage}
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
            <MobilePager page={page} pageSize={PAGE_SIZE} totalCount={totalCount} onPageChange={setPage} />
            <MobileFilterSheet
              open={filtersOpen}
              onClose={() => setFiltersOpen(false)}
              filters={filters}
              onFilterChange={(patch) => { setFilters((prev) => ({ ...prev, ...patch })); setPage(0) }}
              strategies={strategies}
              tagOptions={tagOptions}
            />
          </>
        ) : (
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
        )}
      </div>
    </AppShell>
  )
}
