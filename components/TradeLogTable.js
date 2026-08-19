'use client'

import { useState, useEffect, useCallback, Fragment } from 'react'
import { Pencil, Trash2, X, Filter, ChevronLeft, ChevronRight } from 'lucide-react'
import { supabase } from '../lib/supabaseClient'
import { hasResult, planAdherence, tradeDurationMinutes, formatDuration, formatTime12h } from '../lib/tradeMath'
import { useConfirm } from '../lib/useConfirm'
import { useClickOutside } from '../lib/useClickOutside'
import ColumnFilter from './ColumnFilter'
import ErrorBanner from './ErrorBanner'

const DIRECTION_LABELS = { long: 'Long', short: 'Short' }
const RESULT_LABELS = { win: 'Win', loss: 'Loss', breakeven: 'Breakeven', open: 'Open' }
const UNCLASSIFIED = 'unclassified'

// Checkbox-style filter button + dropdown above the table, same interaction
// pattern as EconomicCalendarCard's impact filter (independent checkboxes,
// applied immediately, closes on outside click/scroll) - not shared code
// since the two live in different feature areas, but deliberately the same
// shape so a "checkbox filter" looks and behaves the same everywhere it
// shows up in the app.
function TagFilterMenu({ options, selected, onChange }) {
  const [open, setOpen] = useState(false)
  const close = useCallback(() => setOpen(false), [])
  const wrapRef = useClickOutside(open, close)

  useEffect(() => {
    if (!open) return
    const dismiss = () => setOpen(false)
    // capture:true is what lets this see the dropdown's own scrollbar
    // scrolling (a native 'scroll' event doesn't bubble, so a plain
    // bubble-phase listener would never see it) - but that means it has to
    // explicitly ignore scrolls that originate inside the dropdown itself
    // (.col-filter-menu scrolls internally once there are enough tags to
    // exceed its max-height), or scrolling the list would close the very
    // list being scrolled. Same fix as TradeForm.js's tag-suggestions
    // dropdown, which hit the identical bug.
    const dismissOnScroll = (e) => {
      if (wrapRef.current && wrapRef.current.contains(e.target)) return
      dismiss()
    }
    window.addEventListener('scroll', dismissOnScroll, true)
    window.addEventListener('resize', dismiss)
    return () => {
      window.removeEventListener('scroll', dismissOnScroll, true)
      window.removeEventListener('resize', dismiss)
    }
  }, [open])

  function toggle(value) {
    onChange(selected.includes(value) ? selected.filter((v) => v !== value) : [...selected, value])
  }

  return (
    <div className="trade-tag-filter" ref={wrapRef}>
      <button type="button" className="calendar-strategy-filter trade-tag-filter-btn" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <Filter size={14} />
        Filter
      </button>
      {open && (
        <div className="col-filter-menu trade-tag-filter-menu">
          {options.map((o) => (
            <label key={o.value} className="col-filter-option">
              <input type="checkbox" checked={selected.includes(o.value)} onChange={() => toggle(o.value)} />
              {o.label}
            </label>
          ))}
        </div>
      )}
    </div>
  )
}

// Full week: futures sessions open Sunday evening, and a stray Saturday date
// should still render a day name rather than blank.
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

function fmtPnl(value) {
  if (value === null || value === undefined) return '—'
  const sign = value >= 0 ? '+' : '-'
  return `${sign}$${Math.abs(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

// Plain thousands-grouped number, no sign/currency - for raw prices and
// point distances, which are now stored to two decimal places (see
// toDecimalString in lib/tradeForm.js) and always display at that same
// precision, e.g. "32" -> "32.00".
function fmtNum(value) {
  if (value === null || value === undefined) return '—'
  return Number(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
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
  // The Overview page's Recent trades list has no Day column (so the date
  // needs to carry the time itself) - every other caller leaves this off
  // and gets the plain date, unchanged.
  showTimeInDate = false,
  // Overrides the default "no trades at all" message below - callers pass
  // a tailored EmptyState (with a page-appropriate call to action) instead
  // of this component hardcoding one copy for every context it's reused in.
  emptyState = null,
}) {
  const [rows, setRows] = useState(trades)
  const [expandedId, setExpandedId] = useState(null)
  // Holds both the clicked row's screenshot array and the index within it -
  // unlike the single trade detail page, every row here has its own shots
  // array computed inline in the map below, so the modal needs a reference
  // to the right one, not just a bare URL.
  const [preview, setPreview] = useState(null)
  const [deleteError, setDeleteError] = useState(null)
  const { confirm, modal: confirmModal } = useConfirm()

  // Filters open from a chevron on each column heading. Day and Strategy
  // take any combination of values; an empty array means unfiltered.
  const [filterDays, setFilterDays] = useState([])
  const [filterStrategies, setFilterStrategies] = useState([])
  const [filterDirection, setFilterDirection] = useState('all')
  const [filterResult, setFilterResult] = useState('all')
  // Tags aren't a column (they only show in the expand row), so this lives
  // in the toolbar above the table instead of a column-header chevron. A
  // trade matches if it has any one of the selected tags.
  const [filterTags, setFilterTags] = useState([])

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
        if (filterTags.length > 0 && !(t.tags || []).some((tag) => filterTags.includes(tag.toLowerCase()))) return false
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
  const strategyOptions = strategyKeys
    .map((key) => ({
      value: key,
      label: key === UNCLASSIFIED ? 'Unassigned' : (strategyNameById?.(key) || '—'),
    }))
    .sort((a, b) => a.label.localeCompare(b.label))
  const directionOptions = [
    { value: 'all', label: 'All' },
    ...['long', 'short'].map((d) => ({ value: d, label: DIRECTION_LABELS[d] })),
  ]
  const resultOptions = [
    { value: 'all', label: 'All' },
    ...['breakeven', 'loss', 'win'].map((r) => ({ value: r, label: RESULT_LABELS[r] })),
  ]
  // Case-insensitive, same dedup as the tag-suggestions dropdown on the
  // trade form (lib/tradeForm.js) - "FOMC" and "fomc" are one option, kept
  // under whichever casing was seen first.
  const tagOptionMap = new Map()
  for (const t of rows) {
    for (const tag of t.tags || []) {
      const key = tag.toLowerCase()
      if (!tagOptionMap.has(key)) tagOptionMap.set(key, tag)
    }
  }
  const tagOptions = [...tagOptionMap.entries()]
    .map(([value, label]) => ({ value, label }))
    .sort((a, b) => a.label.localeCompare(b.label))

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
    ...filterTags.map((v) => ({
      key: `tag-${v}`, label: tagOptionMap.get(v) || v,
      clear: () => setFilterTags((prev) => prev.filter((val) => val !== v)),
    })),
  ]

  function clearAllFilters() {
    setFilterDays([])
    setFilterStrategies([])
    setFilterDirection('all')
    setFilterResult('all')
    setFilterTags([])
  }

  const colCount = 4
    + (showDayColumn ? 1 : 0)
    + (showPnlColumn ? 1 : 0)
    + (showStrategyColumn ? 1 : 0)
    + (showInstrumentColumn ? 1 : 0)

  return (
    <div id="tableWrap">
      <ErrorBanner message={deleteError} />
      {/* Only rendered once there's at least one tag to filter by - an
          always-empty dropdown would just be clutter for traders who
          haven't tagged anything yet. */}
      {showFilters && tagOptions.length > 0 && (
        <div className="trade-log-toolbar">
          <TagFilterMenu options={tagOptions} selected={filterTags} onChange={setFilterTags} />
        </div>
      )}
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
            {showInstrumentColumn && <th>Instrument</th>}
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
            const adherence = planAdherence(t)
            const adherenceLabel = { target: 'Target hit', stop: 'Stop hit', breakeven: 'Breakeven', deviated: 'Deviated' }[adherence]
            const adherenceClass = { target: 'r-pos', stop: 'r-neg', breakeven: 'r-zero', deviated: 'r-open' }[adherence]
            const shots = t.screenshot_urls?.length ? t.screenshot_urls : (t.screenshot_url ? [t.screenshot_url] : [])
            const isExpanded = expandedId === t.id
            const rowSymbol = showInstrumentColumn ? instrumentSymbolFor?.(t) : symbol
            return (
              <Fragment key={t.id}>
                <tr className="clickable-row" onClick={() => toggleExpand(t)}>
                  <td>{t.trade_date}{showTimeInDate && t.trade_time ? ` ${t.trade_time}` : ''}</td>
                  {showDayColumn && <td>{dayOf(t).toUpperCase()}</td>}
                  {showInstrumentColumn && (
                    <td>
                      <span className="strategy-dot" style={{ background: instrumentColorFor?.(t), marginRight: '8px', verticalAlign: 'middle' }} />
                      {rowSymbol || '—'}
                    </td>
                  )}
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
                        <div><label>Entry time</label><div>{formatTime12h(t.trade_time)}</div></div>
                        <div><label>Entry price</label><div>{fmtNum(t.entry)}</div></div>
                        <div><label>Stop loss</label><div>{fmtNum(t.stop)}{t.stop_distance != null && <div className="detail-subvalue">{fmtNum(t.stop_distance)} pts</div>}</div></div>
                        <div><label>Take profit</label><div>{fmtNum(t.target)}{t.target_distance != null && <div className="detail-subvalue">{fmtNum(t.target_distance)} pts</div>}</div></div>
                        <div><label>Exit price</label><div>{fmtNum(t.exit_price)}</div></div>
                        <div><label>Trade duration</label><div>{formatDuration(tradeDurationMinutes(t))}</div></div>
                        <div><label>Contracts</label><div>{t.contracts == null ? '—' : t.contracts.toLocaleString('en-US')}</div></div>
                        {/* No data source until Phase 2 captures excursions. */}
                        <div><label>MFE</label><div>—</div></div>
                        <div><label>MAE</label><div>—</div></div>
                        <div><label>Plan Adherence</label><div>{adherence === null ? '—' : <span className={`r-pill ${adherenceClass}`}>{adherenceLabel}</span>}</div></div>
                      </div>

                      {t.tags?.length > 0 && (
                        <div style={{ marginTop: '12px' }}>
                          <label className="detail-sublabel">Tags</label>
                          <div className="tag-row" style={{ marginTop: '4px' }}>
                            {t.tags.map((tag) => <span className="trade-tag" key={tag}>{tag}</span>)}
                          </div>
                        </div>
                      )}

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
                              onClick={(e) => { e.stopPropagation(); setPreview({ shots, index: i }) }}
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

      {preview && (
        <div className="modal-overlay" onClick={() => setPreview(null)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="modal-close" onClick={() => setPreview(null)}>✕</div>
            {preview.shots.length > 1 && (
              <>
                <div
                  className="modal-nav modal-nav-prev"
                  onClick={() => setPreview((p) => ({ ...p, index: (p.index - 1 + p.shots.length) % p.shots.length }))}
                  aria-label="Previous screenshot"
                >
                  <ChevronLeft size={20} />
                </div>
                <div
                  className="modal-nav modal-nav-next"
                  onClick={() => setPreview((p) => ({ ...p, index: (p.index + 1) % p.shots.length }))}
                  aria-label="Next screenshot"
                >
                  <ChevronRight size={20} />
                </div>
              </>
            )}
            <img src={preview.shots[preview.index]} alt={`Trade screenshot ${preview.index + 1} of ${preview.shots.length}`} />
          </div>
        </div>
      )}
      {confirmModal}
    </div>
  )
}
