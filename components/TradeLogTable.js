'use client'

import { useState, useEffect, Fragment } from 'react'
import { Pencil, Trash2, X } from 'lucide-react'
import { supabase } from '../lib/supabaseClient'
import { hasResult } from '../lib/tradeMath'
import ColumnFilter from './ColumnFilter'

const DIRECTION_LABELS = { long: 'Long', short: 'Short' }
const RESULT_LABELS = { win: 'Win', loss: 'Loss', breakeven: 'Breakeven', open: 'Open' }
const UNCLASSIFIED = 'unclassified'

// Full week: futures sessions open Sunday evening, and a stray Saturday date
// should still render a day name rather than blank.
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

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

function fmtPnl(value) {
  if (value === null || value === undefined) return '—'
  const sign = value >= 0 ? '+' : '-'
  return `${sign}$${Math.abs(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function dayOf(trade) {
  return DAY_NAMES[new Date(trade.trade_date + 'T00:00:00').getDay()]
}

function resultOf(trade) {
  if (!hasResult(trade)) return 'open'
  if (trade.r_multiple > 0) return 'win'
  if (trade.r_multiple < 0) return 'loss'
  return 'breakeven'
}

export default function TradeLogTable({
  trades,
  strategies = [],
  strategyNameById,
  showStrategyColumn = false,
  showDurationColumn = false,
  // The dashboard's calendar-day table opts out of these so it keeps the
  // exact column set it had before.
  showDayColumn = true,
  showPnlColumn = true,
  showFilters = false,
  symbol,
}) {
  const [rows, setRows] = useState(trades)
  const [expandedId, setExpandedId] = useState(null)
  const [previewUrl, setPreviewUrl] = useState(null)
  const [durationByTrade, setDurationByTrade] = useState({})

  // Filters open from a chevron on each column heading. Day and Strategy
  // take any combination of values; an empty array means unfiltered.
  const [filterDays, setFilterDays] = useState([])
  const [filterStrategies, setFilterStrategies] = useState([])
  const [filterDirection, setFilterDirection] = useState('all')
  const [filterResult, setFilterResult] = useState('all')

  useEffect(() => {
    setRows(trades)
  }, [trades])

  useEffect(() => {
    if (!showDurationColumn) return
    const result = {}
    for (const t of rows) {
      if (t.exit_time) {
        let diff = timeToMinutes(t.exit_time) - timeToMinutes(t.trade_time)
        if (diff < 0) diff += 24 * 60
        result[t.id] = diff
      }
    }
    setDurationByTrade(result)
  }, [rows, showDurationColumn])

  // Support deep links like /log?strategy=<id> from the dashboard table.
  useEffect(() => {
    if (!showFilters || !showStrategyColumn) return
    const initial = new URLSearchParams(window.location.search).get('strategy')
    if (initial) setFilterStrategies([initial])
  }, [showFilters, showStrategyColumn])

  function toggleExpand(trade) {
    setExpandedId((prev) => (prev === trade.id ? null : trade.id))
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

  const strategyKey = (t) => t.strategy_id || UNCLASSIFIED

  const visible = showFilters
    ? rows.filter((t) => {
        if (filterDays.length > 0 && !filterDays.includes(dayOf(t))) return false
        if (filterStrategies.length > 0 && !filterStrategies.includes(strategyKey(t))) return false
        if (filterDirection !== 'all' && t.direction !== filterDirection) return false
        if (filterResult !== 'all' && resultOf(t) !== filterResult) return false
        return true
      })
    : rows

  if (rows.length === 0) {
    return <div className="empty">No trades match this view yet.</div>
  }

  // Each filter offers its full set of values rather than only the ones the
  // current trades happen to use, so the options stay put as trades come and
  // go. Picking a value with no matches simply yields an empty table.
  const present = (fn) => new Set(rows.map(fn))
  const dayOptions = DAY_NAMES.map((d) => ({ value: d, label: d }))
  // Every strategy the user has created, plus any a trade still points at
  // (an archived one, say) and Unclassified when some trade has no strategy.
  const strategyKeys = [
    ...strategies.map((s) => s.id),
    ...[...present(strategyKey)].filter((key) => !strategies.some((s) => s.id === key)),
  ]
  const strategyOptions = strategyKeys.map((key) => ({
    value: key,
    label: key === UNCLASSIFIED ? 'Unclassified' : (strategyNameById?.(key) || '—'),
  }))
  const directionOptions = [
    { value: 'all', label: 'All' },
    ...['long', 'short'].map((d) => ({ value: d, label: DIRECTION_LABELS[d] })),
  ]
  const resultOptions = [
    { value: 'all', label: 'All' },
    ...['breakeven', 'loss', 'win'].map((r) => ({ value: r, label: RESULT_LABELS[r] })),
  ]

  // One chip per selected value, whichever column it came from.
  const chips = [
    ...filterDays.map((d) => ({
      key: `day-${d}`, label: `Day: ${d}`,
      clear: () => setFilterDays((prev) => prev.filter((v) => v !== d)),
    })),
    ...filterStrategies.map((s) => ({
      key: `strategy-${s}`,
      label: `Strategy: ${s === UNCLASSIFIED ? 'Unclassified' : (strategyNameById?.(s) || '—')}`,
      clear: () => setFilterStrategies((prev) => prev.filter((v) => v !== s)),
    })),
    ...(filterDirection !== 'all' ? [{
      key: 'direction', label: `Direction: ${DIRECTION_LABELS[filterDirection] || filterDirection}`,
      clear: () => setFilterDirection('all'),
    }] : []),
    ...(filterResult !== 'all' ? [{
      key: 'result', label: `Result: ${RESULT_LABELS[filterResult] || filterResult}`,
      clear: () => setFilterResult('all'),
    }] : []),
  ]

  function clearAllFilters() {
    setFilterDays([])
    setFilterStrategies([])
    setFilterDirection('all')
    setFilterResult('all')
  }

  const colCount = 4
    + (showDayColumn ? 1 : 0)
    + (showPnlColumn ? 1 : 0)
    + (showStrategyColumn ? 1 : 0)
    + (showDurationColumn ? 1 : 0)

  return (
    <div id="tableWrap">
      {showFilters && chips.length > 0 && (
        <div className="active-filters">
          {chips.map((chip) => (
            <span key={chip.key} className="filter-chip">
              {chip.label}
              <button type="button" onClick={chip.clear} aria-label={`Remove filter ${chip.label}`}>
                <X size={12} />
              </button>
            </span>
          ))}
          <span className="filter-clear-all" onClick={clearAllFilters}>Clear all</span>
        </div>
      )}
      {showFilters && (
        <div className="table-count">{visible.length} of {rows.length} trades</div>
      )}
      <table>
        <thead>
          <tr>
            <th>Date</th>
            {showDayColumn && (
              <th>
                <span className="th-label">Day</span>
                {showFilters && (
                  <ColumnFilter mode="multi" options={dayOptions} value={filterDays} onChange={setFilterDays} />
                )}
              </th>
            )}
            {showStrategyColumn && (
              <th>
                <span className="th-label">Strategy</span>
                {showFilters && (
                  <ColumnFilter mode="multi" options={strategyOptions} value={filterStrategies} onChange={setFilterStrategies} />
                )}
              </th>
            )}
            <th>
              <span className="th-label">Direction</span>
              {showFilters && (
                <ColumnFilter mode="single" options={directionOptions} value={filterDirection} onChange={setFilterDirection} />
              )}
            </th>
            <th>
              <span className="th-label">Result</span>
              {showFilters && (
                <ColumnFilter mode="single" options={resultOptions} value={filterResult} onChange={setFilterResult} />
              )}
            </th>
            {showPnlColumn && <th>P&amp;L</th>}
            {showDurationColumn && <th>Time in Trade</th>}
            <th className="actions-col-header"></th>
          </tr>
        </thead>
        <tbody>
          {visible.length === 0 && (
            <tr>
              <td colSpan={colCount}>
                <div className="empty">No trades match these filters.</div>
              </td>
            </tr>
          )}
          {visible.map((t) => {
            const closed = hasResult(t)
            const rClass = !closed ? 'r-zero' : t.r_multiple > 0 ? 'r-pos' : t.r_multiple < 0 ? 'r-neg' : 'r-zero'
            const shots = t.screenshot_urls?.length ? t.screenshot_urls : (t.screenshot_url ? [t.screenshot_url] : [])
            const isExpanded = expandedId === t.id
            return (
              <Fragment key={t.id}>
                <tr className="clickable-row" onClick={() => toggleExpand(t)}>
                  <td>{t.trade_date}</td>
                  {showDayColumn && <td>{dayOf(t)}</td>}
                  {showStrategyColumn && (
                    <td>{t.strategy_id ? (strategyNameById?.(t.strategy_id) || '—') : <span className="unclassified-tag">Unclassified</span>}</td>
                  )}
                  <td style={{ color: t.direction === 'long' ? 'var(--win)' : 'var(--loss)' }}>
                    {t.direction.toUpperCase()}
                  </td>
                  <td>
                    {closed
                      ? <span className={`r-pill ${rClass}`}>{(t.r_multiple >= 0 ? '+' : '') + t.r_multiple.toFixed(2)}R</span>
                      : <span className="r-pill r-open">Open</span>}
                  </td>
                  {showPnlColumn && (
                    <td className={t.pnl == null ? '' : t.pnl >= 0 ? 'pnl-pos' : 'pnl-neg'}>{fmtPnl(t.pnl)}</td>
                  )}
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
                    <td colSpan={colCount}>
                      <div className="detail-grid" style={{ padding: '16px 4px' }}>
                        <div><label>Entry time</label><div>{t.trade_time}</div></div>
                        <div><label>Entry price</label><div>{t.entry}</div></div>
                        <div><label>Stop loss</label><div>{t.stop}{t.stop_distance != null ? ` (${t.stop_distance} pts)` : ''}</div></div>
                        <div><label>Take profit</label><div>{t.target ?? '—'}{t.target_distance != null ? ` (${t.target_distance} pts)` : ''}</div></div>
                        <div><label>Exit price</label><div>{t.exit_price ?? '—'}</div></div>
                        <div><label>Exit time</label><div>{t.exit_time ?? '—'}</div></div>
                        <div><label>Contracts</label><div>{t.contracts ?? '—'}</div></div>
                      </div>

                      {t.reasoning && (
                        <div style={{ marginTop: '12px' }}>
                          <label className="detail-sublabel">Reasoning</label>
                          <p style={{ marginTop: '4px', lineHeight: 1.5, fontSize: '13px' }}>{t.reasoning}</p>
                        </div>
                      )}

                      {shots.length > 0 && (
                        <div className="screenshot-grid" style={{ marginTop: '12px' }}>
                          {shots.map((url, i) => (
                            <img
                              key={url}
                              src={url}
                              alt={`Trade screenshot ${i + 1}`}
                              className="thumb"
                              style={{ width: '70px', height: '70px' }}
                              onClick={(e) => { e.stopPropagation(); setPreviewUrl(url) }}
                            />
                          ))}
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
