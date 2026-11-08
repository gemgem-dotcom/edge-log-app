'use client'

import { useState, useEffect, useRef, use } from 'react'
import Link from 'next/link'
import { Plus } from 'lucide-react'
import { supabase } from '@/lib/supabaseClient'
import { catalogEntryFor } from '@/lib/instrumentCatalog'
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
// fetching every trade this instrument has ever logged and slicing it in
// the browser - see the systems-map audit's follow-up on this page's own
// unbounded fetch. `strategies` is still fetched in full (a small,
// per-instrument table); trades are the growing one.
const PAGE_SIZE = 25
// This page's strategies query includes archived ones on purpose, so a
// trade tagged with a since-archived strategy still shows its name. The
// all-instruments log filters them out, hence a separate cache key.
const STRATEGIES_VARIANT = 'log-with-archived'

export default function LogPage({ params }) {
  usePageTitle('Trade Log')
  const symbol = use(params).instrument
  const displayName = catalogEntryFor(symbol)?.display_name || symbol

  // Seeded from the last-known page-0 result for THIS instrument, so
  // coming back to it paints the real table on the first frame instead of
  // a skeleton a round-trip then replaces. Stale-while-revalidate: the
  // loadPage effect runs regardless and overwrites this, so a stale row
  // lasts one request rather than until a reload - see lib/tradesCache.js.
  //
  // instrumentId is seeded too, since it is what the table's own queries
  // and the loadPage effect key on.
  const [warm] = useState(() => {
    const ref = peekReferenceData()
    const inst = ref?.instruments.find((i) => i.symbol === symbol)
    if (!inst) return null
    const hit = readTradePage({ instrumentIds: [inst.id], page: 0, pageSize: PAGE_SIZE, filters: EMPTY_FILTERS })
    // BOTH, or neither. Each row's strategy name is resolved from this
    // list, so rows without it paint a column of em-dashes - see
    // readLogStrategies' comment.
    const strats = readLogStrategies([inst.id], STRATEGIES_VARIANT)
    if (!hit || !strats) return null
    return { instrumentId: inst.id, strategies: strats, ...hit }
  })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [strategies, setStrategies] = useState(warm?.strategies ?? [])
  const [instrumentId, setInstrumentId] = useState(warm?.instrumentId ?? null)
  const [trades, setTrades] = useState(warm?.trades ?? [])
  const [totalCount, setTotalCount] = useState(warm?.totalCount ?? 0)
  const [tagOptions, setTagOptions] = useState([])
  const [page, setPage] = useState(0)
  const [filters, setFilters] = useState(EMPTY_FILTERS)
  // Mobile only. The desktop keeps its per-column header menus, which own
  // their own open state inside TradeLogTable.
  const [filtersOpen, setFiltersOpen] = useState(false)
  const isMobile = useIsMobile()

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

  // Identifies the most recent load of each kind, so a slower earlier one
  // can't overwrite a newer one's results. This page stays mounted across a
  // soft nav and across every page/filter change, so two loads genuinely do
  // overlap - clicking Next twice quickly used to leave page 2's rows sitting
  // under a pager that reads 3.
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
      // From the cache the sidebar has already filled, rather than a
      // query per visit. It holds exactly this user's unarchived
      // instruments, so picking the symbol out locally asks the same
      // question the `.eq('symbol').single()` query did - and on any
      // navigation within /app it costs no round-trip at all.
      const instruments = await getInstruments(supabase, user.id)
      if (superseded()) return
      const instrument = instruments.find((i) => i.symbol === symbol)
      if (!instrument) { setError('that instrument could not be found.'); setLoading(false); return }

      // BEFORE awaiting the strategies, deliberately. This is what the
      // trade-page effect keys on, so setting it here lets the rows and
      // the strategies load concurrently. Awaiting first made the two
      // strictly serial, and the rows are the slower and more visible of
      // them - the page was waiting on a dropdown's contents to start
      // fetching the table.
      setPage(0)
      setFilters(EMPTY_FILTERS)
      setInstrumentId(instrument.id)
      fetchDistinctTags([instrument.id]).then((tags) => setTagOptions(tags.map((t) => ({ value: t, label: t }))))

      const { data: stratData, error: stratError } = await supabase
        .from('strategies').select('*').eq('instrument_id', instrument.id).order('created_at', { ascending: true })
      if (stratError) throw stratError
      if (superseded()) return
      setStrategies(stratData || [])
      writeLogStrategies([instrument.id], stratData || [], STRATEGIES_VARIANT)
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
        instrumentIds: [instrumentId], page, pageSize: PAGE_SIZE, filters,
      })
      if (tradeError) throw tradeError
      if (superseded()) return
      setTrades(pageTrades)
      setTotalCount(count)
      writeTradePage({ instrumentIds: [instrumentId], page, pageSize: PAGE_SIZE, filters }, pageTrades, count)
    } catch {
      if (superseded()) return
      setError('something went wrong.')
    } finally {
      if (!superseded()) setLoading(false)
    }
  }

  if (loading && trades.length === 0 && !error) return <TradeLogSkeleton />
  if (error) return <div className="page-container"><PageError message={`Couldn't load your trades — ${error}`} onRetry={instrumentId ? loadPage : loadStatic} /></div>

  const strategyName = (id) => strategies.find((s) => s.id === id)?.name || '—'

  return (
    <div className="page-container content-fade-in">
      <div className="strategy-header-row">
        <h1 className="page-title">Trade log</h1>
        <Link href={`/app/${symbol}/log/new`} className="new-trade-btn m-dup-of-tabbar"><Plus size={16} /> Log new trade</Link>
      </div>
      <p className="page-subtitle">All trades logged for {displayName}, across every strategy.</p>

      {isMobile ? (
        <>
          {/* The same .panel the desktop table sits in. The mobile list
              was rendered bare, so the trade log was the one page whose
              rows floated on the page background while every other
              surface in the app - including the panels that hold this
              same list elsewhere - had a card behind them. */}
          <div className="panel m-trade-panel">
          <MobileTradeList
            trades={trades}
            strategyNameById={strategyName}
            symbol={symbol}
            totalCount={totalCount}
            onOpenFilters={() => setFiltersOpen(true)}
            activeFilterCount={countActiveFilters(filters)}
            onTradeDeleted={loadPage}
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
          <MobilePager
            page={page}
            pageSize={PAGE_SIZE}
            totalCount={totalCount}
            onPageChange={setPage}
          />
          <MobileFilterSheet
            open={filtersOpen}
            onClose={() => setFiltersOpen(false)}
            filters={filters}
            // Same synchronous page reset the desktop path does below, and
            // for the same reason - see its comment there.
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
      )}
    </div>
  )
}
