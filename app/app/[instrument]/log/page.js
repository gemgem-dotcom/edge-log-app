'use client'

import { useState, useEffect } from 'react'
import { supabase } from '../../../../lib/supabaseClient'

export default function LogPage({ params }) {
  const symbol = params.instrument

  const [loading, setLoading] = useState(true)
  const [strategies, setStrategies] = useState([])
  const [activeStrategy, setActiveStrategy] = useState('all')
  const [trades, setTrades] = useState([])

  useEffect(() => {
    // Read ?strategy=... from the URL manually, client-side only —
    // avoids needing a Suspense boundary that useSearchParams requires.
    const urlParams = new URLSearchParams(window.location.search)
    const initial = urlParams.get('strategy')
    if (initial) setActiveStrategy(initial)
    loadData()
  }, [symbol])

  async function loadData() {
    setLoading(true)
    const { data: { user } } = await supabase.auth.getUser()
    const { data: instrument } = await supabase
      .from('instruments')
      .select('*')
      .eq('user_id', user.id)
      .eq('symbol', symbol)
      .single()

    if (!instrument) {
      setLoading(false)
      return
    }

    const { data: stratData } = await supabase
      .from('strategies')
      .select('*')
      .eq('instrument_id', instrument.id)
      .order('created_at', { ascending: true })

    const { data: tradeData } = await supabase
      .from('trades')
      .select('*')
      .eq('instrument_id', instrument.id)
      .order('trade_date', { ascending: false })
      .order('trade_time', { ascending: false })

    setStrategies(stratData || [])
    setTrades(tradeData || [])
    setLoading(false)
  }

  if (loading) return <div className="page-loading">Loading…</div>

  const visibleTrades = activeStrategy === 'all'
    ? trades
    : trades.filter((t) => t.strategy_id === activeStrategy)

  const strategyName = (id) => strategies.find((s) => s.id === id)?.name || '—'

  return (
    <div className="page-container">
      <h1 className="page-title">{symbol} — Trade Log</h1>

      <div className="tabs">
        <div
          className={`tab ${activeStrategy === 'all' ? 'tab-active' : ''}`}
          onClick={() => setActiveStrategy('all')}
        >
          All
        </div>
        {strategies.map((s) => (
          <div
            key={s.id}
            className={`tab ${activeStrategy === s.id ? 'tab-active' : ''}`}
            onClick={() => setActiveStrategy(s.id)}
          >
            {s.name}
          </div>
        ))}
      </div>

      <div className="panel">
        {visibleTrades.length === 0 ? (
          <div className="empty">No trades logged {activeStrategy !== 'all' ? 'for this strategy' : ''} yet.</div>
        ) : (
          <div id="tableWrap">
            <table>
              <thead>
                <tr>
                  <th>Date / Time</th><th>Strategy</th><th>Dir</th><th>Entry</th>
                  <th>Stop</th><th>Result</th><th>Plan</th><th>Shot</th>
                </tr>
              </thead>
              <tbody>
                {visibleTrades.map((t) => {
                  const rClass = t.r_multiple > 0 ? 'r-pos' : t.r_multiple < 0 ? 'r-neg' : 'r-zero'
                  return (
                    <tr
                      key={t.id}
                      className="clickable-row"
                      onClick={() => window.location.href = `/app/${symbol}/log/${t.id}`}
                    >
                      <td>{t.trade_date}<br /><span style={{ color: 'var(--muted)' }}>{t.trade_time}</span></td>
                      <td className="tag-cell">{strategyName(t.strategy_id)}</td>
                      <td style={{ color: t.direction === 'long' ? 'var(--win)' : 'var(--loss)' }}>
                        {t.direction.toUpperCase()}
                      </td>
                      <td>{t.entry}</td>
                      <td>{t.stop}</td>
                      <td><span className={`r-pill ${rClass}`}>{(t.r_multiple >= 0 ? '+' : '') + t.r_multiple}R</span></td>
                      <td>{t.in_plan ? '✓' : <span style={{ color: 'var(--loss)' }}>✕</span>}</td>
                      <td>
                        {t.screenshot_url ? (
                          <img src={t.screenshot_url} alt="" className="thumb" onClick={(e) => e.stopPropagation()} />
                        ) : '—'}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
