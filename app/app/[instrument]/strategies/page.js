'use client'

import { useState, useEffect, use } from 'react'
import { catalogEntryFor } from '@/lib/instrumentCatalog'
import { usePageTitle } from '@/lib/usePageTitle'
import { loadStrategyIndex, STRATEGY_INDEX_ERRORS } from '@/lib/strategyIndexData'
import StrategyList from '@/components/StrategyList'
import PageLoading from '@/components/PageLoading'
import PageError from '@/components/PageError'
import EmptyState from '@/components/EmptyState'

// The strategies index.
//
// This route did not exist until now, which is why the mobile tab bar
// opened a bottom sheet instead - see lib/mobileTabs.js. Three
// consequences of not having it, all of which this fixes: Strategies was
// the only tab that was not a destination, a strategy's detail page had
// no way back to a list, and the same list was being rendered three
// separate ways (sidebar, sheet, dashboard table) with no single page
// that was simply "your strategies".
//
// Not linked from the desktop sidebar, which keeps its own expandable
// list; the route renders fine at any width regardless.
export default function StrategiesPage({ params }) {
  usePageTitle('Strategies')
  const symbol = use(params).instrument
  const displayName = catalogEntryFor(symbol)?.display_name || symbol

  const [state, setState] = useState({ status: 'loading' })
  // Bumped to force a reload on retry, since the effect is keyed on it.
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    // `cancelled` rather than the id-counter guard the older pages use:
    // same job (a slower earlier load must not overwrite a newer one),
    // but it is the effect's own cleanup, so React handles the ordering
    // instead of a ref. loadStrategyIndex sets no state itself - this
    // callback does - which is exactly the shape
    // react-hooks/set-state-in-effect asks for.
    let cancelled = false
    loadStrategyIndex(symbol).then((result) => {
      if (cancelled) return
      setState(result.error ? { status: 'error', error: result.error } : { status: 'ready', ...result })
    })
    return () => { cancelled = true }
  }, [symbol, attempt])

  if (state.status === 'loading') return <PageLoading />
  if (state.status === 'error') {
    return (
      <div className="page-container">
        <PageError
          message={`Couldn't load your strategies — ${STRATEGY_INDEX_ERRORS[state.error] || STRATEGY_INDEX_ERRORS.failed}`}
          onRetry={() => { setState({ status: 'loading' }); setAttempt((n) => n + 1) }}
        />
      </div>
    )
  }

  const { strategies, trades } = state
  // Creation order, matching strategyColor's own requirement that a
  // strategy's colour comes from its position in the creation-ordered
  // list - so a dot here is the same colour as the sidebar's and the
  // dashboard's for the same strategy.
  const colorIndexById = {}
  strategies.forEach((s, i) => { colorIndexById[s.id] = i })
  const sorted = strategies.slice().sort((a, b) => a.name.localeCompare(b.name))
  const unclassifiedCount = trades.filter((t) => !t.strategy_id).length

  return (
    <div className="page-container content-fade-in">
      <h1 className="page-title">Strategies</h1>
      <p className="page-subtitle page-subtitle-tight">
        {strategies.length === 0
          ? `No strategies for ${displayName} yet.`
          : `${strategies.length} ${strategies.length === 1 ? 'strategy' : 'strategies'} on ${displayName}.`}
      </p>

      {strategies.length === 0 ? (
        <div className="panel">
          <EmptyState
            title="No strategies yet"
            message={`Strategies are how ${displayName} trades get grouped, so you can see which of your setups actually works. You can add one while logging a trade.`}
            actionHref={`/app/${symbol}/log/new`}
            actionLabel="Log new trade"
          />
        </div>
      ) : (
        <StrategyList
          strategies={sorted}
          trades={trades}
          symbol={symbol}
          colorIndexById={colorIndexById}
          unclassifiedCount={unclassifiedCount}
        />
      )}
    </div>
  )
}
