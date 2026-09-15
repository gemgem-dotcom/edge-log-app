'use client'

import { useState, useEffect } from 'react'
import AppShell from '@/components/AppShell'
import { usePageTitle } from '@/lib/usePageTitle'
import { loadAllStrategies, STRATEGY_INDEX_ERRORS } from '@/lib/strategyIndexData'
import StrategyList from '@/components/StrategyList'
import PageLoading from '@/components/PageLoading'
import PageError from '@/components/PageError'
import EmptyState from '@/components/EmptyState'

// Strategies at scope "All instruments" - the instrument-less form of
// /app/[instrument]/strategies, exactly as /app/log is the
// instrument-less form of /app/[instrument]/log.
//
// It exists because without it the Strategies tab had nowhere to go on
// the three screens with no instrument in view, and fell back to /app -
// which is where the Overview tab already goes. Two of five tabs
// resolving to one URL is a dead tab, and it is the sort of thing that
// is invisible until something asserts it, so lib/mobileTabs.test.js now
// does.
export default function AllStrategiesPage() {
  usePageTitle('Strategies')
  const [state, setState] = useState({ status: 'loading' })
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    // loadAllStrategies sets no state itself - this callback does - which
    // is the shape react-hooks/set-state-in-effect asks for, and keeps
    // this page off the repo's lint ratchet.
    let cancelled = false
    loadAllStrategies().then((result) => {
      if (cancelled) return
      setState(result.error ? { status: 'error', error: result.error } : { status: 'ready', ...result })
    })
    return () => { cancelled = true }
  }, [attempt])

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

  const { instruments, strategies, trades } = state
  const symbolByInstrument = {}
  instruments.forEach((i) => { symbolByInstrument[i.id] = i.symbol })
  // Creation order across the whole set, so a strategy's dot is the same
  // colour here as on its own instrument's page - see strategyColor.
  const colorIndexById = {}
  strategies.forEach((s, i) => { colorIndexById[s.id] = i })
  const sorted = strategies.slice().sort((a, b) => a.name.localeCompare(b.name))

  // active="strategies" deliberately matches no sidebar item: the desktop
  // sidebar has Overview and Trade Log, and its strategies are an
  // expandable list rather than a link to this page. Nothing lights up,
  // which is correct - this route exists for the mobile tab bar.
  return (
    <AppShell instruments={instruments} strategies={strategies} active="strategies">
      <div className="page-container content-fade-in">
        <h1 className="page-title">Strategies</h1>
        <p className="page-subtitle page-subtitle-tight">
          {strategies.length === 0
            ? 'No strategies yet.'
            : `${strategies.length} ${strategies.length === 1 ? 'strategy' : 'strategies'} across every instrument.`}
        </p>

        {strategies.length === 0 ? (
          <div className="panel">
            <EmptyState
              title="No strategies yet"
              message="Strategies are how your trades get grouped, so you can see which of your setups actually works. You can add one while logging a trade."
              actionHref="/app"
              actionLabel="Choose an instrument"
            />
          </div>
        ) : (
          <StrategyList
            strategies={sorted}
            trades={trades}
            symbolFor={(s) => symbolByInstrument[s.instrument_id]}
            colorIndexById={colorIndexById}
            showInstrument={true}
          />
        )}
      </div>
    </AppShell>
  )
}
