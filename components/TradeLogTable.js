'use client'

import { useState, useEffect, Fragment } from 'react'
import { Pencil, Trash2, X } from 'lucide-react'
import { supabase } from '../lib/supabaseClient'
import { hasResult, tradeDurationMinutes, formatDuration } from '../lib/tradeMath'
import { useConfirm } from '../lib/useConfirm'
import ColumnFilter from './ColumnFilter'
import ErrorBanner from './ErrorBanner'

const DIRECTION_LABELS = { long: 'Long', short: 'Short' }
const RESULT_LABELS = { win: 'Win', loss: 'Loss', breakeven: 'Breakeven', open: 'Open' }
const UNCLASSIFIED = 'unclassified'

// Full week: futures sessions open Sunday evening, and a stray Saturday date
// should still render a day name rather than blank.
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

function fmtPnl(value) {
  if (value === null || value === undefined) return '—'
  const sign = value >= 0 ? '+' : '-'
  return `${sign}$${Math.abs(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

// Plain thousands-grouped number, no sign/currency, no forced decimals -
// for raw prices and point distances, which unlike P&L aren't always
// entered to 2 decimal places and shouldn't gain fake trailing zeros.
function fmtNum(value) {
  if (value === null || value === undefined) return '—'
  return Number(value).toLocaleString('en-US', { maximumFractionDigits: 4 })
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
  // The dashboard's calendar-day table opts out of these so it keeps the
  // exact column set it had before.
  showDayColumn = true,
  showPnlColumn = true,
  showFilters = false,
  symbol,
  // The all-instruments trades page has no single symbol - it shows an
  // Instrument column instead and resolves each row's own symbol/color
  // through these two functions rather than the fixed `symbol` prop above.
  showInstrumentColumn = false,
  instrumentSymbolFor = null,
  instrumentColorFor = null,
  // Overrides the default "no trades at all" message below - callers pass
  // a tailored EmptyState (with a page-appropriate call to action) instead
  // of this component hardcoding one copy for every context it's reused in.
  emptyState = null,
}) {
  const [rows, setRows] = useState(trades)
  const [expandedId, setExpandedId] = useState(null)
  const [previewUrl, setPreviewUrl] = useState(null)
  const [deleteError, setDeleteError] = useState(null)
  const { confirm, modal: confirmModal } = useConfirm()

  // Filters open from a chevron on each column heading. Day and Strategy
  // take any combination of values; an empty array means unfiltered.
  const [filterDays, setFilterDays] = useState([])
  const [filterStrategies, setFilterStrategies] = useState([])
  const [filterDirection, setFilterDirection] = useState('all')
  const [filterResult, setFilterResult] = useState('all')

  useEffect(() => {
    setRows(trades)
  }, [trades])

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
    const sure = await confirm({ title: 'Delete Trade', message: 'This action cannot be undone.', confirmLabel: 'Delete trade', danger: true })
    if (!sure) return
    setDeleteError(null)
    const { error } = await supabase.from('trades').delete().eq('id', trade.id)
    if (!error) {
      setRows((prev) => prev.filter((t) => t.id !== trade.id))
      if (expandedId === trade.id) setExpandedId(null)
    } else {
      setDeleteError(`Couldn't delete that trade — ${error.message}`)
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
    return emptyState || <div className="empty">No trades match this view yet.</div>
  }

  // Each filter offers its full set of values rather than only the ones the
  // current trades happen to use, so the options stay put as trades come and
  // go. Picking a value with no matches simply yields an empty table.
  const present = (fn) => new Set(rows.map(fn))
  const dayOptions = DAY_NAMES.map((d) => ({ value: d, label: d }))
  // Every strategy the user has created, plus any a trade still points at
  // (an archived one, say) and Unassigned when some trade has no strategy.
  const strategyKeys = [
    ...strategies.map((s) => s.id),
    ...[...present(strategyKey)].filter((key) => !strategies.some((s) => s.id === key)),
  ]
  const strategyOptions = strategyKeys.map((key) => ({
    value: key,
    label: key === UNCLASSIFIED ? 'Unassigned' : (strategyNameById?.(key) || '—'),
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
      label: `Strategy: ${s === UNCLASSIFIED ? 'Unassigned' : (strategyNameById?.(s) || '—')}`,
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
    + (showInstrumentColumn ? 1 : 0)

  return (
    <div id="tableWrap">
      <ErrorBanner message={deleteError} />
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
            {showInstrumentColumn && <th>Instrument</th>}
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
            const rowSymbol = showInstrumentColumn ? instrumentSymbolFor?.(t) : symbol
            return (
              <Fragment key={t.id}>
                <tr className="clickable-row" onClick={() => toggleExpand(t)}>
                  <td>{t.trade_date}</td>
                  {showInstrumentColumn && (
                    <td>
                      <span className="strategy-dot" style={{ background: instrumentColorFor?.(t), marginRight: '8px', verticalAlign: 'middle' }} />
                      {rowSymbol || '—'}
                    </td>
                  )}
                  {showDayColumn && <td>{dayOf(t)}</td>}
                  {showStrategyColumn && (
                    <td>{t.strategy_id ? (strategyNameById?.(t.strategy_id) || '—') : <span className="unclassified-tag">Unassigned</span>}</td>
                  )}
                  <td style={{ color: t.direction === 'long' ? 'var(--win)' : 'var(--loss)' }}>
                    {t.direction.toUpperCase()}
                  </td>
                  <td>
                    {closed
                      ? <span className={`r-pill ${rClass}`}>{(t.r_multiple >= 0 ? '+' : '') + t.r_multiple.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}R</span>
                      : <span className="r-pill r-open">Open</span>}
                  </td>
                  {showPnlColumn && (
                    <td className={t.pnl == null ? '' : t.pnl >= 0 ? 'pnl-pos' : 'pnl-neg'}>{fmtPnl(t.pnl)}</td>
                  )}
                  <td className="row-actions">
                    <span className="row-actions-inner">
                      <a
                        href={`/app/${rowSymbol}/log/${t.id}/edit`}
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
                        <div><label>Entry price</label><div>{fmtNum(t.entry)}</div></div>
                        <div><label>Stop loss</label><div>{fmtNum(t.stop)}{t.stop_distance != null ? ` (${fmtNum(t.stop_distance)} pts)` : ''}</div></div>
                        <div><label>Take profit</label><div>{fmtNum(t.target)}{t.target_distance != null ? ` (${fmtNum(t.target_distance)} pts)` : ''}</div></div>
                        <div><label>Exit price</label><div>{fmtNum(t.exit_price)}</div></div>
                        <div><label>Trade duration</label><div>{formatDuration(tradeDurationMinutes(t))}</div></div>
                        <div><label>Contracts</label><div>{t.contracts == null ? '—' : t.contracts.toLocaleString('en-US')}</div></div>
                        {/* No data source until Phase 2 captures excursions. */}
                        <div><label>MFE</label><div>—</div></div>
                        <div><label>MAE</label><div>—</div></div>
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
      {confirmModal}
    </div>
  )
}
