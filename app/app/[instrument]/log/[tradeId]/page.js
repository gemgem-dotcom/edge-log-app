'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '../../../../../lib/supabaseClient'
import { hasResult, calcRiskReward } from '../../../../../lib/tradeMath'

export default function TradeDetailPage({ params }) {
  const symbol = params.instrument
  const tradeId = params.tradeId
  const router = useRouter()

  const [loading, setLoading] = useState(true)
  const [trade, setTrade] = useState(null)
  const [strategyName, setStrategyName] = useState('')
  const [previewUrl, setPreviewUrl] = useState(null)

  useEffect(() => {
    loadTrade()
  }, [tradeId])

  async function loadTrade() {
    setLoading(true)
    const { data: t } = await supabase.from('trades').select('*').eq('id', tradeId).single()
    if (!t) { setLoading(false); return }
    setTrade(t)

    const { data: s } = await supabase.from('strategies').select('name').eq('id', t.strategy_id).single()
    setStrategyName(s?.name || '—')

    setLoading(false)
  }

  async function handleDelete() {
    if (!confirm('Delete this trade? This cannot be undone.')) return
    await supabase.from('trades').delete().eq('id', tradeId)
    router.push(`/app/${symbol}/log`)
  }

  if (loading) return <div className="page-loading">Loading…</div>
  if (!trade) return <div className="page-container"><div className="empty">Trade not found.</div></div>

  const closed = hasResult(trade)
  const rClass = !closed ? 'r-zero' : trade.r_multiple > 0 ? 'r-pos' : trade.r_multiple < 0 ? 'r-neg' : 'r-zero'
  const shots = trade.screenshot_urls?.length ? trade.screenshot_urls : (trade.screenshot_url ? [trade.screenshot_url] : [])
  const riskReward = calcRiskReward(trade.target_distance, trade.stop_distance)

  return (
    <div className="page-container">
      <a href={`/app/${symbol}/log`} className="back-link">← Back to log</a>
      <h1 className="page-title">Trade Detail</h1>

      <div className="panel">
        <div className="section-label">Technical</div>
        <div className="detail-grid">
          <div><label>Instrument</label><div>{symbol}</div></div>
          <div><label>Date</label><div>{trade.trade_date}</div></div>
          <div><label>Entry time</label><div>{trade.trade_time}</div></div>
          <div><label>Direction</label><div style={{ color: trade.direction === 'long' ? 'var(--win)' : 'var(--loss)' }}>{trade.direction.toUpperCase()}</div></div>
          <div><label>Entry price</label><div>{trade.entry}</div></div>
          <div><label>Stop loss</label><div>{trade.stop}{trade.stop_distance != null ? ` (${trade.stop_distance} pts)` : ''}</div></div>
          <div><label>Take profit</label><div>{trade.target ?? '—'}{trade.target_distance != null ? ` (${trade.target_distance} pts)` : ''}</div></div>
          <div><label>Risk-to-Reward</label><div>{riskReward === null ? '—' : riskReward.toFixed(2)}</div></div>
          <div><label>Exit price</label><div>{trade.exit_price ?? '—'}</div></div>
          <div><label>Exit time</label><div>{trade.exit_time ?? '—'}</div></div>
          <div><label>Result</label><div>{closed ? <span className={`r-pill ${rClass}`}>{(trade.r_multiple >= 0 ? '+' : '') + trade.r_multiple}R</span> : <span className="r-pill r-open">Open</span>}</div></div>
        </div>
      </div>

      <div className="panel">
        <div className="section-label">Strategy</div>
        <div className="detail-grid">
          <div><label>Model</label><div>{strategyName}</div></div>
        </div>
      </div>

      <div className="panel">
        <div className="section-label">Context</div>
        <div className="detail-grid">
          <div><label>Contracts</label><div>{trade.contracts ?? '—'}</div></div>
        </div>
        <div style={{ marginTop: '14px' }}>
          <label style={{ fontSize: '10.5px', color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.06em' }}>Reasoning</label>
          <p style={{ marginTop: '6px', lineHeight: 1.5 }}>{trade.reasoning || '—'}</p>
        </div>
        {shots.length > 0 && (
          <div className="screenshot-grid" style={{ marginTop: '14px' }}>
            {shots.map((url, i) => (
              <img
                key={url}
                src={url}
                alt={`Trade screenshot ${i + 1}`}
                className="thumb"
                style={{ width: '80px', height: '80px' }}
                onClick={() => setPreviewUrl(url)}
              />
            ))}
          </div>
        )}
      </div>

      <div className="submit-row" style={{ display: 'flex', gap: '10px' }}>
        <span className="del" style={{ fontSize: '13px' }} onClick={handleDelete}>Delete this trade</span>
      </div>

      {previewUrl && (
        <div className="modal-overlay" onClick={() => setPreviewUrl(null)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="modal-close" onClick={() => setPreviewUrl(null)}>✕</div>
            <img src={previewUrl} alt="Trade screenshot full view" />
          </div>
        </div>
      )}
    </div>
  )
}
