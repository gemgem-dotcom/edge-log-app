'use client'

import { useState, useEffect, Fragment } from 'react'
import { Pencil, Trash2 } from 'lucide-react'
import { supabase } from '../lib/supabaseClient'

function timeToMinutes(t) {
      const [h, m] = t.split(':').map(Number)
      return h * 60 + m
}

function fmtDuration(mins) {
      if (mins === null || mins === undefined) return '—'
      if (mins < 60) return `${mins}m`
      const h = Math.floor(mins / 60)
      const m = mins % 60
      return `${h}h ${m}m`
}

export default function TradeLogTable({ trades, strategyNameById, showStrategyColumn = false, showDurationColumn = false, symbol }) {
      const [rows, setRows] = useState(trades)
      const [expandedId, setExpandedId] = useState(null)
      const [previewUrl, setPreviewUrl] = useState(null)
      const [durationByTrade, setDurationByTrade] = useState({})

  useEffect(() => {
          setRows(trades)
  }, [trades])

  useEffect(() => {
          if (!showDurationColumn) return
          loadDurations()
  }, [trades, showDurationColumn])

  async function loadDurations() {
        const result = {}
                for (const t of trades) {
                          if (t.exit_time) {
                                      let diff = timeToMinutes(t.exit_time) - timeToMinutes(t.trade_time)
                                      if (diff < 0) diff += 24 * 60
                                      result[t.id] = diff
                          }
                }
          setDurationByTrade(result)
  }

  function toggleExpand(trade) {
          if (expandedId === trade.id) {
                    setExpandedId(null)
                    return
          }
          setExpandedId(trade.id)
  }

  async function handleDelete(e, trade) {
          e.stopPropagation()
          if (!confirm('Delete this trade? This cannot be undone.')) return
          const { error } = await supabase.from('trades').delete().eq('id', trade.id)
          if (!error) {
                    setRows((prev) => prev.filter((t) => t.id !== trade.id))
                    if (expandedId === trade.id) setExpandedId(null)
          } else {
                    alert(error.message)
          }
  }

  if (rows.length === 0) {
          return <div className="empty">No trades match this view yet.</div>
  }

  return (
          <div id="tableWrap">
            <table>
              <thead>
                <tr>
                  <th>Trade ID</th>
                <th>Date</th>
    {showStrategyColumn && <th>Strategy</th>}
                 <th>Dir</th>
                 <th>Result</th>
     {showDurationColumn && <th>Time in Trade</th>}
                  <th className="actions-col-header"></th>
         </tr>
         </thead>
              <tbody>
     {rows.map((t) => {
                     const rClass = t.r_multiple > 0 ? 'r-pos' : t.r_multiple < 0 ? 'r-neg' : 'r-zero'
                     const isExpanded = expandedId === t.id
                     return (
                                       <Fragment key={t.id}>
                               <tr className="clickable-row" onClick={() => toggleExpand(t)}>
                      <td className="trade-id-cell">{t.id.slice(0, 8)}</td>
                      <td>{t.trade_date}</td>
    {showStrategyColumn && (
                            <td className="tag-cell">{t.strategy_id ? (strategyNameById?.(t.strategy_id) || '—') : <span className="unclassified-tag">Unclassified</span>}</td>
                          )}
                      <td style={{ color: t.direction === 'long' ? 'var(--win)' : 'var(--loss)' }}>
{t.direction.toUpperCase()}
</td>
                  <td><span className={`r-pill ${rClass}`}>{(t.r_multiple >= 0 ? '+' : '') + t.r_multiple}R</span></td>
{showDurationColumn && <td>{fmtDuration(durationByTrade[t.id])}</td>}
                  <td className="row-actions">
                        <span className="row-actions-inner">
                          <a
                        href={`/app/${symbol}/log/${t.id}/edit`}
                        className="row-action-btn"
                        onClick={(e) => e.stopPropagation()}
                        title="Edit trade"
                      >
                                                    <Pencil size={15} />
                            </a>
                      <span
                        className="row-action-btn row-action-danger"
                        onClick={(e) => handleDelete(e, t)}
                        title="Delete trade"
                      >
                                                    <Trash2 size={15} />
                            </span>
                            </span>
                            </td>
                            </tr>
{isExpanded && (
                      <tr className="expand-row">
                        <td colSpan={5 + (showStrategyColumn ? 1 : 0) + (showDurationColumn ? 1 : 0)}>
                      <div className="detail-grid" style={{ padding: '16px 4px' }}>
                        <div><label>Entry time</label><div>{t.trade_time}</div></div>
                        <div><label>Entry price</label><div>{t.entry}</div></div>
                        <div><label>Stop price</label><div>{t.stop}{t.stop_distance != null ? ` (${t.stop_distance} ${t.distance_unit || 'points'})` : ''}</div></div>
                        <div><label>Target (TP)</label><div>{t.target ?? '—'}{t.target_distance != null ? ` (${t.target_distance} ${t.distance_unit || 'points'})` : ''}</div></div>
                        <div><label>Exit price</label><div>{t.exit_price ?? '—'}</div></div>
                        <div><label>Exit time</label><div>{t.exit_time ?? '—'}</div></div>
                        <div><label>In-plan</label><div>{t.in_plan ? 'Yes' : 'No — off-plan'}</div></div>
                        <div><label>Contracts</label><div>{t.contracts ?? '—'}</div></div>
                            </div>

{t.reasoning && (
                            <div style={{ marginTop: '12px' }}>
                          <label className="detail-sublabel">Reasoning</label>
                          <p style={{ marginTop: '4px', lineHeight: 1.5, fontSize: '13px' }}>{t.reasoning}</p>
    </div>
                      )}

{t.screenshot_url && (
                            <div style={{ marginTop: '12px' }}>
                          <img
                            src={t.screenshot_url}
                            alt="Trade screenshot"
                            className="thumb"
                            style={{ width: '70px', height: '70px' }}
                            onClick={(e) => { e.stopPropagation(); setPreviewUrl(t.screenshot_url) }}
                          />
                              </div>
                      )}
</td>
                          </tr>
                )}
</Fragment>
            )
})}
</tbody>
    </table>

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
