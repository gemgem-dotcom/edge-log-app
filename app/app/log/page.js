'use client'

import { useState, useEffect } from 'react'
import { supabase } from '@/lib/supabaseClient'
import { strategyColor } from '@/lib/strategyColor'
import AppShell from '@/components/AppShell'
import { usePageTitle } from '@/lib/usePageTitle'
import TradeLogTable from '@/components/TradeLogTable'
import TradeLogSkeleton from '@/components/TradeLogSkeleton'
import EmptyState from '@/components/EmptyState'
import PageError from '@/components/PageError'

export default function AllTradesPage() {
  usePageTitle('Trade Log')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [instruments, setInstruments] = useState([])
  const [strategies, setStrategies] = useState([])
  const [trades, setTrades] = useState([])

  useEffect(() => {
    loadData()
  }, [])

  async function loadData() {
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

      const { data: tradeData, error: tradeError } = await supabase
        .from('trades').select('*').in('instrument_id', ids)
        .order('trade_date', { ascending: false }).order('trade_time', { ascending: false })
      if (tradeError) throw tradeError

      setInstruments(instrumentData || [])
      setStrategies(stratData || [])
      setTrades(tradeData || [])
    } catch (err) {
      setError(err.message || "Couldn't load your trades — something went wrong.")
    } finally {
      setLoading(false)
    }
  }

  if (loading) return (
    <AppShell instruments={instruments} strategies={strategies} active="trades">
      <TradeLogSkeleton showInstrumentColumn showHeaderButton={false} />
    </AppShell>
  )
  if (error) {
    return (
      <AppShell instruments={instruments} strategies={strategies} active="trades">
        <div className="page-container"><PageError message={`Couldn't load your trades — ${error}`} onRetry={loadData} /></div>
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
        <p className="page-subtitle">Every trade you've logged, across all instruments.</p>

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
            pageSize={25}
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
